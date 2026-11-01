"""Run on TEST/CI, never as a local product test: python3 -m unittest discover -s test -p test_deployment_migration.py."""
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("deployment_migration", ROOT / "scripts/deployment_migration.py")
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(value).hexdigest()


# Fixed creation statements from the v1.7.0 storage adapters. The fixture does
# not import the implementation schema allowlist, so a relaxed matcher fails.
DDL = {
    "command-automation.sqlite": "CREATE TABLE policy (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL); CREATE TABLE requests (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, digest TEXT NOT NULL, body TEXT NOT NULL);",
    "agent-cli.sqlite": "CREATE TABLE requests (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, remote_status TEXT);",
    "command-outputs/manifest.sqlite": "CREATE TABLE outputs (id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, charge INTEGER NOT NULL);",
    "maintenance.sqlite": "CREATE TABLE reservation (id INTEGER PRIMARY KEY CHECK(id=1), owner_hash TEXT NOT NULL, baseline TEXT); CREATE TABLE last_release (id INTEGER PRIMARY KEY CHECK(id=1), owner_hash TEXT NOT NULL);",
}


def make_db(root, name):
    path = root / name
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.executescript(DDL[name])
    path.chmod(0o600)
    return db


def job(identifier="a", state="completed", *, raw=False):
    value = {"id": identifier * 48, "kind": "command", "operation": {"kind": "command", "command": "id"},
             "command": "id", "profile": "fixture-write", "targetId": "fixture", "targetRevision": "1" * 64,
             "state": state, "createdAt": 1000, "expiresAt": 3601000}
    if raw:
        value["finishedAt"] = 2000
        value["result"] = {"failed": False, "texts": ["", "이미 마스킹한 결과🙂\r\n", ""], "data": {"fixture": [1, "한글"]}}
    return value


def add_output(root, db, identifier, state):
    item = {"version": 1, "captureSource": "redacted-adapter-outcome", "sshCompleteness": "unknown", "id": identifier * 48,
            "binding": {"executionId": "a" * 48, "targetId": "fixture", "targetRevision": "1" * 64, "profile": "fixture-write"},
            "state": state, "expiresAt": 3500}
    charge = 16 * 1024 * 1024
    if state == "ready":
        outcome = {"failed": False, "texts": ["기존 보존 바이트🙂"]}
        parts = {"json": encode(outcome).encode(), "text": outcome["texts"][0].encode()}
        position = 0
        formats = {}
        for key, data in parts.items():
            formats[key] = {"offset": position, "bytes": len(data), "sha256": digest(data),
                            "chunks": [digest(data[n:n + 16384]) for n in range(0, len(data), 16384)]}
            position += len(data)
        item.update(formats=formats, size=position)
        path = root / "command-outputs" / (item["id"] + ".out")
        path.write_bytes(b"".join(parts.values()))
        path.chmod(0o600)
        charge = position
    elif state == "pending":
        path = root / "command-outputs" / (item["id"] + ".part")
        path.touch(mode=0o600)
    body = encode(item)
    db.execute("INSERT INTO outputs VALUES (?,?,?,?)", (item["id"], body, digest(body.encode()), charge))


def fixture(root, *, partial=False):
    root.mkdir(mode=0o700)
    with closing(make_db(root, "command-automation.sqlite")) as db:
        db.execute("INSERT INTO policy VALUES (1,7,?)", (encode({"targets": []}),))
        for identifier, state, raw in [("a", "completed", True), ("b", "pending", False), ("c", "running", False)]:
            value = job(identifier, state, raw=raw)
            db.execute("INSERT INTO requests VALUES (?,?,?,?)", (value["id"], "fixture:" + identifier, "d" * 64, encode(value)))
        db.commit()
    if partial:
        return
    with closing(make_db(root, "agent-cli.sqlite")) as db:
        value = job("7", "evaluating")
        value["operation"].update(agentCliContract="agent-cli-install-v1", agentCliProvider="codex",
                                  agentCliTargetId="fixture", agentCliTargetRevision="1" * 64,
                                  agentCliProfile="fixture-write", agentCliOperationId="8" * 48)
        db.execute("INSERT INTO requests VALUES (?,?,?,?,?)", (value["id"], "agent-cli:fixture-operation-1234", "e" * 64,
                   encode(value), encode({"provider": "codex", "state": "not_found", "login": "not_checked", "operationId": "8" * 48})))
        db.commit()
    with closing(make_db(root, "command-outputs/manifest.sqlite")) as db:
        add_output(root, db, "d", "ready")
        add_output(root, db, "e", "pending")
        add_output(root, db, "f", "unavailable")
        db.commit()
    with closing(make_db(root, "maintenance.sqlite")) as db:
        db.execute("INSERT INTO reservation VALUES (1,?,NULL)", ("1" * 64,))
        db.execute("INSERT INTO last_release VALUES (1,?)", ("2" * 64,))
        db.commit()


@unittest.skipIf(os.name == "nt", "Linux deployment execution contract")
class DeploymentMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="deployment-migration-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / "source"
        self.destination = self.base / "destination"
        fixture(self.source)
        node = shutil.which("node")
        self.assertIsNotNone(node, "CI must provide the supported managed Node runtime")
        self.environment = patch.dict(os.environ, {"SSH_PORTAL_MIGRATION_NODE": str(Path(node).resolve())})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def migrate(self):
        return migration.migrate_state(self.source, self.destination, uid=os.getuid(), gid=os.getgid(), now_ms=4000)

    def test_nonempty_v17_all_stores_and_expired_payload_preserved(self):
        before = migration.inspect_state(self.source)
        receipt = self.migrate()
        self.assertEqual(migration.inspect_state(self.source), before)
        self.assertEqual(receipt["verification"]["newLosses"], 0)
        self.assertEqual(receipt["verification"]["terminalizedRequests"], 3)
        self.assertEqual(receipt["verification"]["legacyOutputsConverted"], 1)
        self.assertEqual(receipt["verification"]["baselineUnavailableOutputs"], 1)
        self.assertEqual(receipt["verification"]["interruptedOutputsQuarantined"], 1)
        self.assertEqual(receipt["verification"], migration.verify_migration(self.source, self.destination, receipt))
        self.assertNotIn("이미 마스킹", json.dumps(receipt, ensure_ascii=False))
        for name in DDL:
            with closing(sqlite3.connect(self.destination / name)) as db:
                self.assertEqual(db.execute("PRAGMA user_version").fetchone(), (1,))
        output = "command-outputs/" + "d" * 48 + ".out"
        self.assertEqual((self.source / output).read_bytes(), (self.destination / output).read_bytes())
        with self.assertRaises(migration.MigrationError):
            self.migrate()

    def test_partial_disabled_command_database_and_empty_source(self):
        shutil.rmtree(self.source)
        fixture(self.source, partial=True)
        receipt = self.migrate()
        self.assertEqual(set(receipt["destination"]["databases"]), {"command-automation.sqlite", "command-outputs/manifest.sqlite"})
        self.source = self.base / "empty"
        self.destination = self.base / "empty-destination"
        self.source.mkdir(mode=0o700)
        receipt = self.migrate()
        self.assertEqual(set(receipt["destination"]["databases"]), {"command-outputs/manifest.sqlite"})

    def test_unknown_schema_version_body_digest_and_corruption_refused(self):
        mutations = [
            "PRAGMA user_version=99",
            "CREATE TABLE unknown (id TEXT)",
            "UPDATE requests SET body='{}'",
            "UPDATE requests SET digest='invalid'",
            "UPDATE policy SET body='[]'",
        ]
        for index, sql in enumerate(mutations):
            with self.subTest(sql=sql):
                source = self.base / ("bad-" + str(index))
                fixture(source, partial=True)
                with closing(sqlite3.connect(source / "command-automation.sqlite")) as db:
                    db.execute(sql)
                    db.commit()
                destination = self.base / ("unused-" + str(index))
                with self.assertRaises(migration.MigrationError):
                    migration.migrate_state(source, destination, uid=os.getuid(), gid=os.getgid(), now_ms=4000)
                self.assertFalse(destination.exists())
        (self.source / "command-automation.sqlite").write_bytes(b"corrupt database")
        with self.assertRaises(migration.MigrationError):
            self.migrate()
        self.assertFalse(self.destination.exists())

    def test_unsupported_sidecars_and_zero_header_journal(self):
        path = self.source / "command-automation.sqlite"
        for suffix, data in [("-wal", b""), ("-shm", b""), ("-journal", b"nonzero" + b"\0" * 1024)]:
            sidecar = Path(str(path) + suffix)
            sidecar.write_bytes(data)
            sidecar.chmod(0o600)
            with self.assertRaises(migration.MigrationError):
                migration.inspect_state(self.source)
            sidecar.unlink()
        sidecar = Path(str(path) + "-journal")
        sidecar.write_bytes(b"\0" * 28 + b"old non-hot page data")
        sidecar.chmod(0o600)
        receipt = self.migrate()
        self.assertTrue(sidecar.exists(), "read-only inspection must not recover/remove a journal")
        self.assertFalse((self.destination / sidecar.name).exists())
        self.assertEqual(receipt["verification"]["newLosses"], 0)

    def test_links_space_unknown_files_and_incomplete_destination(self):
        db = self.source / "command-automation.sqlite"
        held = self.base / "held.sqlite"
        db.rename(held)
        db.symlink_to(held)
        with self.assertRaises(migration.MigrationError):
            self.migrate()
        db.unlink()
        os.link(held, db)
        with self.assertRaises(migration.MigrationError):
            self.migrate()
        db.unlink()
        held.rename(db)
        with patch.object(migration.shutil, "disk_usage", return_value=shutil._ntuple_diskusage(100, 99, 1)):
            with self.assertRaises(migration.MigrationError):
                self.migrate()
        self.assertFalse(self.destination.exists())
        unknown = self.source / "unknown.sqlite"
        unknown.touch(mode=0o600)
        with self.assertRaises(migration.MigrationError):
            self.migrate()
        unknown.unlink()
        self.destination.mkdir(mode=0o700)
        with self.assertRaises(migration.MigrationError):
            self.migrate()

    def test_root_transfer_part_is_excluded_but_output_part_preserved(self):
        root_part = self.source / ("9" * 48 + ".part")
        root_part.write_bytes(b"temporary transfer")
        root_part.chmod(0o600)
        orphan = self.source / "command-outputs" / ("8" * 48 + ".part")
        orphan.write_bytes(b"interrupted output")
        orphan.chmod(0o600)
        receipt = self.migrate()
        self.assertFalse((self.destination / root_part.name).exists())
        self.assertEqual(orphan.read_bytes(), (self.destination / "command-outputs" / orphan.name).read_bytes())
        self.assertEqual(receipt["verification"]["excludedTemporaryTransfers"], 1)
        self.assertEqual(receipt["verification"]["orphanOutputsQuarantined"], 1)

    def test_changed_source_and_interruption_do_not_restore_or_retry(self):
        before = migration.inspect_state(self.source)
        with patch.object(migration, "_node_migrate", side_effect=migration.MigrationError("injected interruption")):
            with self.assertRaises(migration.MigrationError):
                self.migrate()
        self.assertTrue(self.destination.exists())
        self.assertEqual(before, migration.inspect_state(self.source))
        with self.assertRaises(migration.MigrationError):
            self.migrate()
        self.destination = self.base / "next-destination"
        original = migration._node_migrate

        def changed(*args):
            report = original(*args)
            with closing(sqlite3.connect(self.source / "command-automation.sqlite")) as db:
                db.execute("UPDATE policy SET revision=revision+1")
                db.commit()
            return report

        with patch.object(migration, "_node_migrate", side_effect=changed):
            with self.assertRaisesRegex(migration.MigrationError, "Source changed"):
                self.migrate()

    def test_new_payload_loss_and_undeclared_extra_output_refused(self):
        receipt = self.migrate()
        payload = self.destination / "command-outputs" / ("d" * 48 + ".out")
        original = payload.read_bytes()
        payload.write_bytes(b"changed" + original)
        with self.assertRaises(migration.MigrationError):
            migration.verify_migration(self.source, self.destination, receipt)
        payload.write_bytes(original)
        # Refreshing a claimed destination hash cannot authorize an extra row.
        with closing(sqlite3.connect(self.destination / "command-outputs/manifest.sqlite")) as db:
            add_output(self.destination, db, "6", "unavailable")
            db.commit()
        receipt["destination"] = migration.inspect_state(self.destination)
        with self.assertRaisesRegex(migration.MigrationError, "Unexpected output row"):
            migration.verify_migration(self.source, self.destination, receipt)

    def test_existing_database_lock_is_not_bypassed(self):
        with closing(sqlite3.connect(self.source / "command-automation.sqlite")) as db:
            db.execute("BEGIN EXCLUSIVE")
            with self.assertRaises(migration.MigrationError):
                migration.inspect_state(self.source)
            db.rollback()

    def test_new_code_refuses_legacy_dormant_and_unknown_versions(self):
        source = str(self.source)
        module = (ROOT / "src/adapters/storage/offline-preservation.mjs").as_uri()
        code = "import {openDormantCommandState} from " + json.dumps(module) + ";openDormantCommandState(" + json.dumps(source) + ");"
        result = subprocess.run([os.environ["SSH_PORTAL_MIGRATION_NODE"], "--input-type=module", "-e", code], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"explicit offline migration", result.stderr)


if __name__ == "__main__":
    unittest.main()
