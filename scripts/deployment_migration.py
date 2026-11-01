"""Explicit, offline state migration. The caller owns quiescence and activation.

Only the four deployed SQLite creation statements below are supported. Identical
statements occur in v1.7.0, v1.6.2-v1.6.6 and the earlier partial stores described
by the deployment design; a release label alone never authorizes an input.
Source connections are read-only, never immutable (which would ignore writers).
"""
from contextlib import closing
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import time

CONTRACT = "explicit-state-migration-v1"
SCHEMAS = {
    "command-automation.sqlite": "CREATE TABLE policy (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL); CREATE TABLE requests (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, digest TEXT NOT NULL, body TEXT NOT NULL);",
    "agent-cli.sqlite": "CREATE TABLE requests (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, remote_status TEXT);",
    "command-outputs/manifest.sqlite": "CREATE TABLE outputs (id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, charge INTEGER NOT NULL);",
    "maintenance.sqlite": "CREATE TABLE reservation (id INTEGER PRIMARY KEY CHECK(id=1), owner_hash TEXT NOT NULL, baseline TEXT); CREATE TABLE last_release (id INTEGER PRIMARY KEY CHECK(id=1), owner_hash TEXT NOT NULL);",
}
ID = re.compile(r"[a-f0-9]{48}\Z")
HEX = re.compile(r"[a-f0-9]{64}\Z")
STATES = {"pending", "running", "evaluating", "completed", "failed", "unknown", "expired", "denied"}
LIMIT = 64 * 1024 * 1024


class MigrationError(ValueError):
    """A deliberate refusal; error messages never contain persisted bodies."""


def _hash(value):
    return hashlib.sha256(value).hexdigest()


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _object(value):
    try:
        def unique(pairs):
            result = {}
            for key, item in pairs:
                if key in result:
                    raise ValueError("Duplicate JSON key")
                result[key] = item
            return result

        result = json.loads(value, object_pairs_hook=unique,
                            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError, UnicodeError):
        raise MigrationError("Invalid persisted JSON") from None
    if not isinstance(result, dict):
        raise MigrationError("Persisted JSON must be an object")
    return result


def _integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 9007199254740991


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _directory(path, uid=None, *, private=True):
    path = Path(os.path.abspath(path))
    for current in (path, *path.parents):
        if current.is_symlink() or not stat.S_ISDIR(current.lstat().st_mode):
            raise MigrationError("Unsafe state directory")
    info = path.lstat()
    if os.name != "nt" and (private and info.st_mode & 0o077 or uid is not None and info.st_uid != uid):
        raise MigrationError("State directory ownership or mode mismatch")
    return path


def _file(path, uid):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise MigrationError("Unsafe state file")
    if os.name != "nt" and (before.st_uid != uid or before.st_mode & 0o077):
        raise MigrationError("State file ownership or mode mismatch")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        if _identity(before) != _identity(os.fstat(fd)):
            raise MigrationError("State file changed while opening")
        digest = hashlib.sha256()
        while block := os.read(fd, 65536):
            digest.update(block)
        if _identity(before) != _identity(os.fstat(fd)) or _identity(before) != _identity(path.lstat()):
            raise MigrationError("State file changed while reading")
    finally:
        os.close(fd)
    return {"size": before.st_size, "sha256": digest.hexdigest(), "identity": _identity(before)}


def _connect(path):
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def _schema(db):
    return [tuple(row) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name")]


def _reference(sql):
    with closing(sqlite3.connect(":memory:")) as db:
        db.executescript(sql)
        return _schema(db)


def _validate_rows(name, tables):
    if name in ("command-automation.sqlite", "agent-cli.sqlite"):
        cli = name == "agent-cli.sqlite"
        requests = tables["requests"]
        if any(not isinstance(row["body"], str) or len(row["body"].encode("utf-8")) > (65536 if cli else 512 * 1024)
               for row in requests):
            raise MigrationError("Invalid request storage type or size")
        if len(requests) > 10000 or sum(len(row["body"].encode("utf-8")) for row in requests) > LIMIT:
            raise MigrationError("Request preservation budget exceeded")
        for row in requests:
            job = _object(row["body"])
            if not isinstance(row["id"], str) or not ID.fullmatch(row["id"]) or job.get("id") != row["id"]:
                raise MigrationError("Invalid request identity")
            if not isinstance(row["digest"], str) or not HEX.fullmatch(row["digest"]):
                raise MigrationError("Invalid request digest")
            if row["request_key"] is not None and not isinstance(row["request_key"], str):
                raise MigrationError("Invalid request key")
            if job.get("state") not in STATES or job.get("kind") not in ("command", "upload", "download"):
                raise MigrationError("Unsupported request body")
            if not isinstance(job.get("operation"), dict) or job["operation"].get("kind") != job["kind"]:
                raise MigrationError("Unsupported request operation")
            if not isinstance(job.get("profile"), str) or not job["profile"]:
                raise MigrationError("Invalid request profile")
            if not all(_integer(job.get(key), 1) for key in ("createdAt", "expiresAt")):
                raise MigrationError("Invalid request timestamps")
            if job.get("finishedAt") is not None and not _integer(job["finishedAt"], 1):
                raise MigrationError("Invalid request completion timestamp")
            result = job.get("result")
            if result is not None and (not isinstance(result, dict) or type(result.get("failed")) is not bool
                                       or not isinstance(result.get("texts"), list)
                                       or any(not isinstance(text, str) for text in result["texts"])):
                raise MigrationError("Unsupported result body")
            if job["kind"] == "command" and result is not None and "output" not in result:
                if not isinstance(job.get("targetRevision"), str) or not HEX.fullmatch(job["targetRevision"]) or not isinstance(job.get("command", job["operation"].get("command")), str):
                    raise MigrationError("Legacy result requires an explicit target binding")
            if result is not None and "output" in result:
                output = result["output"]
                if not isinstance(output, dict) or output.get("version") != 1 or output.get("captureSource") != "redacted-adapter-outcome" or output.get("sshCompleteness") != "unknown" or output.get("state") not in ("ready", "expired", "unavailable"):
                    raise MigrationError("Unsupported output reference")
                if "id" in output and (not isinstance(output["id"], str) or not ID.fullmatch(output["id"]) or output.get("executionId") != job["id"] or not _integer(output.get("expiresAt"), 1)):
                    raise MigrationError("Invalid output reference identity")
            if cli:
                if not isinstance(row["request_key"], str) or not re.fullmatch(r"agent-cli:[A-Za-z0-9_.:-]{16,128}", row["request_key"]):
                    raise MigrationError("Invalid CLI request key")
                if job["kind"] != "command" or job["operation"].get("agentCliContract") != "agent-cli-install-v1":
                    raise MigrationError("Unsupported CLI contract")
                if row["remote_status"] is not None:
                    _object(row["remote_status"])
        if not cli:
            policies = tables["policy"]
            if len(policies) != 1 or policies[0]["id"] != 1 or not _integer(policies[0]["revision"]):
                raise MigrationError("Invalid policy identity")
            policy = _object(policies[0]["body"])
            if set(policy) != {"targets"} or not isinstance(policy["targets"], list):
                raise MigrationError("Unsupported policy body")
    elif name == "command-outputs/manifest.sqlite":
        if any(not isinstance(row["body"], str) or len(row["body"].encode("utf-8")) > 256 * 1024 for row in tables["outputs"]):
            raise MigrationError("Invalid output storage type or size")
        if len(tables["outputs"]) > 1000 or sum(len(row["body"].encode("utf-8")) for row in tables["outputs"]) > LIMIT:
            raise MigrationError("Output preservation budget exceeded")
        for row in tables["outputs"]:
            body = _object(row["body"])
            if not isinstance(row["id"], str) or not ID.fullmatch(row["id"]) or body.get("id") != row["id"] or _hash(row["body"].encode("utf-8")) != row["digest"]:
                raise MigrationError("Invalid output identity or digest")
            if body.get("state") not in ("pending", "ready", "unavailable") or not _integer(body.get("expiresAt"), 1) or not isinstance(body.get("binding"), dict):
                raise MigrationError("Unsupported output body")
            if body.get("version") != 1 or body.get("captureSource") != "redacted-adapter-outcome" or body.get("sshCompleteness") != "unknown":
                raise MigrationError("Unsupported output capture contract")
            if not _integer(row["charge"]) or row["charge"] > 16 * 1024 * 1024:
                raise MigrationError("Invalid output charge")
    else:
        for table in ("reservation", "last_release"):
            for row in tables[table]:
                if row["id"] != 1 or not isinstance(row["owner_hash"], str) or not HEX.fullmatch(row["owner_hash"]):
                    raise MigrationError("Invalid maintenance reservation")
                if table == "reservation" and row["baseline"] is not None:
                    _object(row["baseline"])


def _read_db(path, name):
    try:
        with closing(_connect(path)) as db:
            db.execute("BEGIN")
            if [tuple(row) for row in db.execute("PRAGMA integrity_check")] != [("ok",)]:
                raise MigrationError("Database integrity check failed")
            if db.execute("PRAGMA journal_mode").fetchone()[0].lower() != "delete":
                raise MigrationError("Only clean DELETE journal mode is supported")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1) or _schema(db) != _reference(SCHEMAS[name]):
                raise MigrationError("Unsupported state schema")
            tables = {row[1]: [dict(value) for value in db.execute('SELECT * FROM "' + row[1] + '" ORDER BY id')]
                      for row in _schema(db) if row[0] == "table"}
            _validate_rows(name, tables)
            return {"version": version, "schema": _hash(_json(_schema(db))), "tables": tables}
    except sqlite3.Error:
        raise MigrationError("State database is corrupt, locked or unreadable") from None


def _snapshot(root, uid=None):
    root = _directory(root, uid)
    uid = root.lstat().st_uid if uid is None else uid
    files, directories = {}, {}
    for directory in (root, root / "command-outputs"):
        if not directory.exists():
            continue
        _directory(directory, uid)
        directories[directory.relative_to(root).as_posix()] = _identity(directory.lstat())
        for path in sorted(directory.iterdir()):
            name = path.relative_to(root).as_posix()
            if path.name == "command-outputs" and directory == root:
                _directory(path, uid)
                continue
            known = name in SCHEMAS or any(name == db + suffix for db in SCHEMAS for suffix in ("-journal", "-wal", "-shm"))
            payload = re.fullmatch(r"(?:[a-f0-9]{48}\.part|command-outputs/[a-f0-9]{48}\.(?:part|out))", name)
            if not known and not payload:
                raise MigrationError("Unknown state file or directory")
            files[name] = _file(path, uid)
            if name.startswith("command-outputs/") and payload and files[name]["size"] > 16 * 1024 * 1024:
                raise MigrationError("Output payload size limit exceeded")
    for name in files:
        if name.endswith(("-wal", "-shm")):
            raise MigrationError("WAL and shared-memory sidecars are unsupported")
        if name.endswith("-journal"):
            if name[:-8] not in files:
                raise MigrationError("Orphan database journal")
            # SQLite PERSIST commits by zeroing the header; it is not hot.
            # https://www.sqlite.org/lockingv3.html#the_rollback_journal
            with open(root / name, "rb") as stream:
                header = stream.read(28)
            if header and (len(header) < 28 or any(header)):
                raise MigrationError("Hot or unknown rollback journal is unsupported")
    databases = {name: _read_db(root / name, name) for name in SCHEMAS if name in files}
    _validate_payloads(root, databases, files)
    # Recheck the entire bundle, including sidecars and transfer staging bytes.
    for name, value in files.items():
        if _file(root / name, uid) != value:
            raise MigrationError("Source bundle changed during inspection")
    for name, identity in directories.items():
        if _identity((root / name).lstat()) != identity:
            raise MigrationError("Source directory changed during inspection")
    return {"root": root, "uid": uid, "files": files, "databases": databases,
            "fingerprint": _hash(_json({"files": files, "directories": directories}))}


def _validate_payloads(root, databases, files):
    outputs = databases.get("command-outputs/manifest.sqlite", {}).get("tables", {}).get("outputs", [])
    for row in outputs:
        item = _object(row["body"])
        if item["state"] != "ready":
            continue
        name = "command-outputs/" + row["id"] + ".out"
        if not _integer(item.get("size")) or item["size"] > 16 * 1024 * 1024 or name not in files or files[name]["size"] != item["size"]:
            raise MigrationError("Ready output payload missing or invalid")
        formats = item.get("formats")
        if not isinstance(formats, dict) or set(formats) != {"json", "text"}:
            raise MigrationError("Unknown output formats")
        position = 0
        with open(root / name, "rb") as stream:
            for key in ("json", "text"):
                part = formats[key]
                if not isinstance(part, dict) or part.get("offset") != position or not _integer(part.get("bytes")):
                    raise MigrationError("Invalid output format range")
                data = stream.read(part["bytes"])
                if len(data) != part["bytes"] or _hash(data) != part.get("sha256") or [_hash(data[n:n + 16384]) for n in range(0, len(data), 16384)] != part.get("chunks"):
                    raise MigrationError("Output content integrity failed")
                try:
                    data.decode("utf-8")
                    if key == "json":
                        _object(data)
                except UnicodeError:
                    raise MigrationError("Output encoding is invalid") from None
                position += len(data)
        if position != item["size"]:
            raise MigrationError("Output size mismatch")


def _public(snapshot):
    return {"contract": CONTRACT, "fingerprint": snapshot["fingerprint"],
            "files": len(snapshot["files"]), "bytes": sum(value["size"] for value in snapshot["files"].values()),
            "databases": {name: {"userVersion": value["version"], "schemaFingerprint": value["schema"],
                                  "rows": {table: len(rows) for table, rows in value["tables"].items()}}
                          for name, value in snapshot["databases"].items()}}


def inspect_state(root, uid=None):
    """Inspect a stopped state bundle without modifying it; return no body data."""
    return _public(_snapshot(root, uid))


def _sync_directory(path):
    if os.name != "nt":
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _owner(path, uid, gid, directory=False):
    os.chmod(path, 0o700 if directory else 0o600)
    if os.name != "nt":
        os.chown(path, uid, gid, follow_symlinks=False)


def _node_migrate(destination, uid, gid, now_ms):
    node = Path(os.environ.get("SSH_PORTAL_MIGRATION_NODE", ""))
    if not node.is_absolute() or not node.is_file() or node.is_symlink():
        raise MigrationError("Verified absolute migration Node runtime required")
    script = Path(__file__).resolve().with_name("migrate-state.mjs")
    options = {}
    if os.name != "nt":
        if os.geteuid() == 0:
            options = {"user": uid, "group": gid, "extra_groups": []}
        elif os.geteuid() != uid or os.getegid() != gid:
            raise MigrationError("Migration must run as the destination owner")
    try:
        result = subprocess.run([str(node), str(script), str(destination), str(now_ms)],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=180, check=False, env={"PATH": str(node.parent), "NODE_NO_WARNINGS": "1"}, **options)
    except (OSError, subprocess.TimeoutExpired):
        raise MigrationError("Offline result conversion did not complete") from None
    if result.returncode != 0:
        raise MigrationError("Offline result conversion failed; destination is incomplete")
    report = _object(result.stdout)
    if report.get("contract") != CONTRACT or report.get("nowMs") != now_ms:
        raise MigrationError("Invalid offline conversion receipt")
    return report


def migrate_state(source_root, destination_root, *, uid, gid, now_ms):
    """Create one new generation, never overwrite/retry an incomplete destination."""
    if not all(_integer(value) for value in (uid, gid)) or not _integer(now_ms, 1):
        raise MigrationError("Invalid migration ownership or deterministic timestamp")
    source = _snapshot(source_root)
    destination = Path(os.path.abspath(destination_root))
    _directory(destination.parent, private=False)
    if destination.exists() or destination.is_symlink() or destination == source["root"] or source["root"] in destination.parents or destination in source["root"].parents:
        raise MigrationError("A separate absent destination is required")
    total = sum(value["size"] for value in source["files"].values())
    if shutil.disk_usage(destination.parent).free < 3 * total + 20 * 1024 * 1024:
        raise MigrationError("Insufficient migration disk space")
    # A failed generation stays isolated. No automatic deletion or source restore.
    destination.mkdir(mode=0o700)
    _owner(destination, uid, gid, True)
    for name in sorted(source["files"]):
        if name.endswith(("-journal", "-wal", "-shm")) or re.fullmatch(r"[a-f0-9]{48}\.part", name):
            continue
        target = destination / name
        if not target.parent.exists():
            target.parent.mkdir(mode=0o700)
            _owner(target.parent, uid, gid, True)
        if name in source["databases"]:
            with closing(_connect(source["root"] / name)) as old, closing(sqlite3.connect(target)) as new:
                deadline = time.monotonic() + 30

                def progress(status, remaining, pages):
                    if status in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED) or time.monotonic() > deadline:
                        raise MigrationError("Source database busy during backup")

                old.backup(new, pages=256, progress=progress, sleep=0)
                new.execute("PRAGMA user_version=1")
                new.commit()
        else:
            original = source["root"] / name
            fd = os.open(original, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "rb") as old, open(target, "xb") as new:
                if _identity(os.fstat(old.fileno())) != source["files"][name]["identity"]:
                    raise MigrationError("Source file changed before copying")
                shutil.copyfileobj(old, new, 65536)
                new.flush()
                os.fsync(new.fileno())
                if _identity(os.fstat(old.fileno())) != source["files"][name]["identity"] or _identity(original.lstat()) != source["files"][name]["identity"]:
                    raise MigrationError("Source file changed during copying")
        _owner(target, uid, gid)
    report = _node_migrate(destination, uid, gid, now_ms)
    if _snapshot(source["root"])["fingerprint"] != source["fingerprint"]:
        raise MigrationError("Source changed during migration")
    result = {"contract": CONTRACT, "nowMs": now_ms, "source": _public(source),
              "conversion": report, "destination": inspect_state(destination, uid)}
    result["verification"] = verify_migration(source["root"], destination, result)
    for directory in (destination / "command-outputs", destination):
        if directory.exists():
            _sync_directory(directory)
    return result


def verify_migration(source_root, destination_root, receipt):
    """Recompute allowed differences from the source, not from a claimed row count."""
    if receipt.get("contract") != CONTRACT or not _integer(receipt.get("nowMs"), 1):
        raise MigrationError("Invalid migration receipt")
    source, destination = _snapshot(source_root), _snapshot(destination_root)
    if _public(source) != receipt.get("source") or _public(destination) != receipt.get("destination"):
        raise MigrationError("Migration inputs differ from the receipt")
    if any(value["version"] != 1 for value in destination["databases"].values()):
        raise MigrationError("Destination schema version is incomplete")
    # Node verifies byte-exact legacy snapshots using the same serializer that
    # wrote them. All unchanged rows and payloads are independently checked here.
    conversions = receipt.get("conversion", {})
    legacy = conversions.get("legacyOutputs", [])
    if not isinstance(legacy, list) or len({row.get("requestId") for row in legacy}) != len(legacy):
        raise MigrationError("Invalid legacy conversion map")
    if any(not isinstance(row.get("requestId"), str) or not ID.fullmatch(row["requestId"])
           or not isinstance(row.get("outputId"), str) or not ID.fullmatch(row["outputId"]) for row in legacy):
        raise MigrationError("Invalid legacy conversion identity")
    mapping = {row["requestId"]: row for row in legacy}
    if len({row["outputId"] for row in legacy}) != len(legacy):
        raise MigrationError("Duplicate legacy output identity")
    output_name = "command-outputs/manifest.sqlite"
    expected_names = set(source["databases"])
    expected_names.add(output_name)  # Partial stores gain the required empty output journal.
    if set(destination["databases"]) != expected_names:
        raise MigrationError("Database presence changed")
    changed = 0
    for name, old in source["databases"].items():
        current = destination["databases"][name]
        for table, rows in old["tables"].items():
            actual = {row["id"]: row for row in current["tables"][table]}
            for row in rows:
                if row["id"] not in actual:
                    raise MigrationError("Existing row lost")
                expected = copy.deepcopy(row)
                if table == "requests":
                    job = _object(expected["body"])
                    original = copy.deepcopy(job)
                    if job["state"] in ("pending", "running", "evaluating"):
                        job["state"] = "expired" if job["state"] == "pending" else "unknown"
                        job["finishedAt"] = receipt["nowMs"]
                        changed += 1
                    raw = job.get("kind") == "command" and job.get("result") is not None and "output" not in job["result"]
                    if raw:
                        entry = mapping.pop(job["id"], None)
                        if entry is None:
                            raise MigrationError("Legacy result conversion missing")
                        _verify_legacy(destination, actual[row["id"]], original, entry)
                        job["result"] = _object(actual[row["id"]]["body"])["result"]
                    if _object(actual[row["id"]]["body"]) != job:
                        raise MigrationError("Request identity, policy, binding or timestamps changed")
                    expected["body"] = actual[row["id"]]["body"]
                elif table == "outputs":
                    item = _object(expected["body"])
                    if item["state"] == "pending":
                        item["state"] = "unavailable"
                        if _object(actual[row["id"]]["body"]) != item:
                            raise MigrationError("Interrupted output conversion changed metadata")
                        expected["body"] = actual[row["id"]]["body"]
                        expected["digest"] = _hash(expected["body"].encode("utf-8"))
                        expected["charge"] = 16 * 1024 * 1024
                if actual[row["id"]] != expected:
                    raise MigrationError("Existing state row changed")
            if table != "outputs" and len(actual) != len(rows):
                raise MigrationError("Unexpected state row added")
    if mapping or conversions.get("terminalizedRequests") != changed:
        raise MigrationError("Conversion allowance does not match actual source")
    old_outputs = source["databases"].get(output_name, {}).get("tables", {}).get("outputs", [])
    old_ids = {row["id"] for row in old_outputs}
    legacy_ids = {row["outputId"] for row in legacy}
    if old_ids & legacy_ids:
        raise MigrationError("Legacy conversion overwrote an existing output")
    orphan_ids = {Path(name).stem for name in source["files"]
                  if re.fullmatch(r"command-outputs/[a-f0-9]{48}\.(out|part)", name)} - old_ids
    actual_outputs = destination["databases"][output_name]["tables"]["outputs"]
    if {row["id"] for row in actual_outputs} != old_ids | legacy_ids | orphan_ids:
        raise MigrationError("Unexpected output row added or lost")
    for row in actual_outputs:
        if row["id"] in orphan_ids:
            expected = {"version": 1, "captureSource": "redacted-adapter-outcome", "sshCompleteness": "unknown",
                        "id": row["id"], "binding": {"executionId": row["id"], "targetId": None},
                        "state": "unavailable", "expiresAt": receipt["nowMs"] + 3600000}
            if _object(row["body"]) != expected or row["charge"] != 16 * 1024 * 1024:
                raise MigrationError("Orphan output quarantine changed")
    expected_files = {name for name in source["files"] if not name.endswith("-journal")
                      and not re.fullmatch(r"[a-f0-9]{48}\.part", name)}
    expected_files.add(output_name)
    expected_files.update("command-outputs/" + value + ".out" for value in legacy_ids)
    if set(destination["files"]) != expected_files:
        raise MigrationError("Unexpected destination file added or lost")
    for name, value in source["files"].items():
        if name in SCHEMAS or name.endswith("-journal") or re.fullmatch(r"[a-f0-9]{48}\.part", name):
            continue
        actual = destination["files"].get(name)
        if actual is None or (actual["size"], actual["sha256"]) != (value["size"], value["sha256"]):
            raise MigrationError("Existing output bytes lost or changed")
    return {"status": "VERIFIED", "databasesChecked": len(source["databases"]),
            "terminalizedRequests": changed, "legacyOutputsConverted": len(legacy),
            "interruptedOutputsQuarantined": sum(_object(row["body"])["state"] == "pending" for row in old_outputs),
            "orphanOutputsQuarantined": len(orphan_ids),
            "baselineUnavailableOutputs": sum(_object(row["body"])["state"] == "unavailable" for row in old_outputs),
            "excludedTemporaryTransfers": sum(bool(re.fullmatch(r"[a-f0-9]{48}\.part", name)) for name in source["files"]),
            "newLosses": 0, "deterministicNowMs": receipt["nowMs"]}


def _verify_legacy(destination, row, original, entry):
    job = _object(row["body"])
    result = job.get("result", {})
    output = result.get("output", {})
    if set(result) != {"failed", "texts", "output"} or result["failed"] != original["result"]["failed"] or result["texts"] != []:
        raise MigrationError("Legacy result projection changed")
    if output.get("id") != entry.get("outputId") or output.get("executionId") != original["id"]:
        raise MigrationError("Legacy output identity mismatch")
    rows = destination["databases"]["command-outputs/manifest.sqlite"]["tables"]["outputs"]
    item = next((_object(value["body"]) for value in rows if value["id"] == output["id"]), None)
    if item is None or item["state"] != "ready":
        raise MigrationError("Legacy output publication failed")
    binding = item["binding"]
    if binding.get("executionId") != original["id"] or binding.get("targetId") != original.get("targetId", "default") or binding.get("targetRevision") != original.get("targetRevision") or binding.get("profile") != original["profile"]:
        raise MigrationError("Legacy output target binding changed")
    command = original.get("command", original["operation"].get("command"))
    if not isinstance(command, str) or binding.get("operationDigest") != _hash(command.encode("utf-8")):
        raise MigrationError("Legacy operation digest changed")
    expires = (original.get("finishedAt") or original["createdAt"]) + 3600000
    if item["expiresAt"] != expires or output.get("expiresAt") != expires:
        raise MigrationError("Legacy output TTL changed")
    with open(destination["root"] / "command-outputs" / (output["id"] + ".out"), "rb") as stream:
        content = stream.read(item["formats"]["json"]["bytes"])
        text = stream.read(item["formats"]["text"]["bytes"]).decode("utf-8")
    if _object(content) != original["result"]:
        raise MigrationError("Legacy result bytes or structure changed")
    expected_text = "\n".join(original["result"]["texts"])
    if "data" not in original["result"]:
        if text != expected_text:
            raise MigrationError("Legacy text bytes changed")
    else:
        prefix = expected_text + "\n"
        try:
            if not text.startswith(prefix) or json.loads(text[len(prefix):]) != original["result"]["data"]:
                raise MigrationError("Legacy structured text changed")
        except ValueError:
            raise MigrationError("Legacy structured text is invalid") from None
