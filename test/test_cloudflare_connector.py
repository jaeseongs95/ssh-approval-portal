import base64
import contextlib
import copy
import io
import inspect
import json
import os
from pathlib import Path, PurePosixPath
import stat
import struct
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import cloudflare_connector as cc
import cloudflare_provision as cp
import cloudflare_setup as cf
import portal
from test_cloudflare_provision import DocumentedTunnelAccount, config, SECRET


def tunnel_token(identifier, account=None):
    return base64.b64encode(json.dumps({'a': account or config()['accountId'],
        't': str(uuid.UUID(identifier)), 's': base64.b64encode(b'SYNTHETIC_TUNNEL_KEY_'*2).decode()}).encode()).decode()


def credential_is_private(info, acl, uid):
    """systemd grants a named UID read ACL; its mask appears as group mode bits."""
    if not stat.S_ISREG(info.st_mode):
        return False
    if acl is None:
        return info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o400
    if (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o440
            or len(acl) != 44 or struct.unpack_from('<I', acl)[0] != 2):
        return False
    entries = list(struct.iter_unpack('<HHI', acl[4:]))
    return entries == [(1, 4, 0xffffffff), (2, 4, uid), (4, 0, 0xffffffff),
                       (16, 4, 0xffffffff), (32, 0, 0xffffffff)]


class TokenAccount(DocumentedTunnelAccount):
    def __init__(self, journal):
        super().__init__(journal)
        self.token_reads, self.bad_token, self.fail_edge = 0, False, False
    def get(self, path, query=None):
        if path.endswith('/token'):
            self.token_reads += 1
            identifier = path.split('/')[-2]
            return {'result': tunnel_token(identifier, 'f'*32 if self.bad_token else None)}
        if self.fail_edge and path.endswith('/cfd_tunnel/' + self.tunnel_id):
            raise cf.ApiFailure('synthetic read failure')
        return super().get(path, query)


class Systemd:
    """Explicit simulation; native OS token files are real but this is not systemd execution."""
    def __init__(self, units, api):
        self.units, self.api = units, api
        self.calls, self.active, self.loaded, self.enabled = [], False, False, False
        self.failure, self.overrides, self.connected = None, '', True
        self.version = b'cloudflared version 2026.10.1 (fixture)\n'
    def __call__(self, args, capture=False):
        self.calls.append(args)
        if args[0] != cc.SYSTEMCTL:
            return SimpleNamespace(returncode=0, stdout=self.version)
        operation = args[1]
        if operation == 'show':
            unit, name = args[2], args[4]
            values = {'LoadState': 'loaded' if self.loaded else 'not-found',
                      'ActiveState': 'active' if self.active else 'inactive', 'MainPID': '321' if self.active else '0',
                      'DropInPaths': self.overrides, 'FragmentPath': str(self.units/unit) if self.loaded else ''}
            return SimpleNamespace(returncode=0, stdout=values[name].encode())
        if operation == 'daemon-reload':
            self.loaded = bool(list(self.units.glob('ssh-portal-tunnel-*.service')))
        if operation == 'enable':
            if cc.load_state(self.api.journal)['status'] != 'START_REQUESTED':
                raise AssertionError('Durable connector start intent must precede systemctl enable')
            self.active = self.enabled = True
            if self.connected:
                remote = self.api.remote[self.api.tunnel_path]
                remote.update(connections=[], status='healthy')
                self.api.clients = [{'id': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'conns': [{'id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}]}]
        if operation == 'stop':
            self.active = False
            self.api.remote[self.api.tunnel_path].update(connections=[], status='inactive')
            self.api.clients = []
        if operation == 'disable':
            self.enabled = False
        failed = self.failure == operation
        if failed:
            self.failure = None
        return SimpleNamespace(returncode=1 if failed else 0, stdout=b'')


class Portable(unittest.TestCase):
    def test_token_session_metadata_is_public_but_requests_must_require_authentication(self):
        values = config()
        data = (f"BRIDGE_MCP_PORT={values['mcpPort']}\nBRIDGE_ADMIN_PORT={values['adminPort']}\n"
                f"BRIDGE_ADMIN_ORIGIN=https://{values['adminHostname']}\n").encode()
        calls = []
        def response(url, timeout):
            calls.append(url)
            if url.endswith('/api/requests'):
                raise HTTPError(url, 401, 'Unauthorized', {}, io.BytesIO())
            result = io.BytesIO(b'{"mode":"token"}' if url.endswith('/api/session') else b'{"healthy":true}')
            result.status = 200
            return result
        with patch.object(cc, 'read_file', return_value=(data, None)), \
                patch.object(cc, 'build_opener', return_value=SimpleNamespace(open=response)):
            cc.local_ready(values)
        self.assertEqual(calls, [f"http://127.0.0.1:{values['mcpPort']}/health",
                                 f"http://127.0.0.1:{values['adminPort']}/api/requests"])

    def test_credential_acl_oracle_rejects_other_users_groups_write_and_unknown_layout(self):
        uid = 62001
        entries = [(1, 4, 0xffffffff), (2, 4, uid), (4, 0, 0xffffffff),
                   (16, 4, 0xffffffff), (32, 0, 0xffffffff)]
        def acl(items):
            return struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *entry) for entry in items)
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o440, st_uid=0)
        self.assertTrue(credential_is_private(info, acl(entries), uid))
        self.assertTrue(credential_is_private(SimpleNamespace(st_mode=stat.S_IFREG | 0o400, st_uid=uid), None, uid))
        for index, value in [(1, (2, 4, uid+1)), (1, (2, 6, uid)), (2, (4, 4, 0xffffffff)),
                             (4, (32, 4, 0xffffffff))]:
            changed = entries.copy()
            changed[index] = value
            self.assertFalse(credential_is_private(info, acl(changed), uid))
        for data in [None, b'', acl(entries)[:-1], acl(entries + [(2, 4, uid+1)])]:
            self.assertFalse(credential_is_private(info, data, uid))
        for mode in [0o444, 0o640, 0o450, 0o4440]:
            self.assertFalse(credential_is_private(SimpleNamespace(st_mode=stat.S_IFREG | mode, st_uid=0), acl(entries), uid))

    def test_native_flags_forward_and_dry_run_never_opens_state_or_prompts(self):
        for flag in ['--connector', '--remove-connector']:
            with self.subTest(flag=flag), patch.object(cf, 'main', return_value=0) as child:
                self.assertEqual(portal.main(['connect', 'cloudflare', flag, '--state-dir', '/root/new']), 0)
                self.assertEqual(child.call_args.args[0], [flag, '--state-dir', '/root/new'])
            with patch.object(cf.getpass, 'getpass') as getpass, patch.object(cp, 'Journal') as state, \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(cf.main([flag, '--state-dir', '/root/new', '--dry-run']), 0)
                self.assertEqual(json.loads(output.getvalue())['status'], 'DRY_RUN')
                getpass.assert_not_called()
                state.assert_not_called()
        with self.assertRaises(ValueError):
            portal.plan(portal.arguments(['connect', 'access', '--connector']))
        for args in [['--connector'], ['--cloudflared', '/bin/something'],
                     ['--connector', '--state-dir', '/root/a', '--config', 'unused']]:
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cf.main(args), 1)

    def test_token_account_tunnel_endpoint_and_shape_are_bound(self):
        identifier = '1'*32
        cc.token_binding(tunnel_token(identifier), config(), identifier)
        bad = [tunnel_token(identifier, 'f'*32), tunnel_token('2'*32), 'synthetic-not-base64',
               base64.b64encode(b'{"a":1,"a":2}').decode()]
        for token in bad:
            with self.subTest(token_kind=type(token).__name__), self.assertRaisesRegex(cp.ProvisionFailure, 'BINDING'):
                cc.token_binding(token, config(), identifier)
        token = json.loads(base64.b64decode(tunnel_token(identifier)))
        token['e'] = 'unexpected-endpoint'
        with self.assertRaises(cp.ProvisionFailure):
            cc.token_binding(base64.b64encode(json.dumps(token).encode()).decode(), config(), identifier)

    def test_root_and_platform_are_checked_before_secret_input(self):
        for platform, uid in [('win32', 0), ('darwin', 0), ('linux', 1000)]:
            with patch.object(cf.sys, 'platform', platform), patch.object(cf.os, 'geteuid', return_value=uid, create=True), \
                    patch.object(cf.sys.stdin, 'isatty', return_value=True), patch.object(cf.sys.stderr, 'isatty', return_value=True), \
                    patch.object(cf.getpass, 'getpass') as getpass, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cf.main(['--connector', '--state-dir', '/root/a']), 1)
                getpass.assert_not_called()
                with self.assertRaises(cp.ProvisionFailure):
                    cc.root_required(SimpleNamespace(directory=Path('/root/a')))

    def test_unit_contains_paths_not_tokens_and_disables_token_logging(self):
        text = cc.unit_text('/usr/bin/cloudflared', PurePosixPath('/root/run/connector.token')).decode()
        self.assertIn('LoadCredential=tunnel-token:/root/run/connector.token', text)
        self.assertIn('--token-file ${CREDENTIALS_DIRECTORY}/tunnel-token', text)
        self.assertIn('StandardOutput=null', text)
        self.assertNotIn(SECRET, text)
        self.assertNotIn('--token ', text)


@unittest.skipUnless(sys.platform.startswith('linux') and hasattr(os, 'geteuid') and os.geteuid() == 0,
                     'isolated Linux root fixture required')
class Filesystem(unittest.TestCase):
    def setUp(self):
        # Docker test mounts this root-owned private tmpfs; never use the host's systemd directory.
        self.tmp = tempfile.TemporaryDirectory(dir='/fixture')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.units = self.root/'units'
        self.units.mkdir(mode=0o700)
        self.binary = Path('/fixture')/(self.root.name+'-cloudflared')
        self.binary_bytes = Path('/usr/bin/true').read_bytes()
        self.binary.write_bytes(self.binary_bytes)
        self.binary.chmod(0o755)
        self.addCleanup(self.binary.unlink)
        self.journal = cp.Journal(self.root/'run', config())
        self.addCleanup(self.journal.close)
        self.api = TokenAccount(self.journal)
        cp.provision(config(), self.api, self.journal, SECRET)
        self.api.tunnel_id = next(x['id'] for x in self.journal.state['resources'] if x['kind'] == 'tunnel')
        self.api.tunnel_path = '/accounts/' + config()['accountId'] + '/cfd_tunnel/' + self.api.tunnel_id
        self.systemd = Systemd(self.units, self.api)
        self.patchers = [patch.object(cc, 'UNITS', self.units), patch.object(cc, 'command', self.systemd),
                         patch.object(cc, 'local_ready')]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def install(self):
        return cc.install_connector(self.api, self.journal, str(self.binary))

    def test_actual_loopback_health_auth_and_private_env_preconditions(self):
        self.patchers[2].stop()
        class Handler(BaseHTTPRequestHandler):
            admin_status, mcp_status = 401, 200
            def log_message(self, *args):
                pass
            def do_GET(self):
                code = self.admin_status if self.path == '/api/requests' else (200 if self.path == '/api/session' else self.mcp_status)
                self.send_response(code)
                self.send_header('Location', 'http://127.0.0.1:1/never-follow')
                self.end_headers()
                self.wfile.write(b'{"mode":"token"}' if self.path == '/api/session' else b'{"healthy":true}')
        servers = [ThreadingHTTPServer(('127.0.0.1', 0), Handler) for _ in range(2)]
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
        for thread in threads:
            thread.start()
        try:
            values = {**config(), 'mcpPort': servers[0].server_port, 'adminPort': servers[1].server_port}
            env = self.root/'bridge.env'
            data = (f"BRIDGE_MCP_PORT={values['mcpPort']}\nBRIDGE_ADMIN_PORT={values['adminPort']}\n"
                    f"BRIDGE_ADMIN_ORIGIN=https://{values['adminHostname']}\nBRIDGE_MCP_TOKEN={SECRET}\n").encode()
            env.write_bytes(data)
            env.chmod(0o600)
            with patch.object(cc, 'ENV', env):
                cc.local_ready(values)
                for setting, status in [('admin_status', 200), ('admin_status', 302), ('admin_status', 403),
                                        ('admin_status', 503), ('mcp_status', 302), ('mcp_status', 503)]:
                    with self.subTest(setting=setting, status=status), patch.object(Handler, setting, status), \
                            self.assertRaises(cp.ProvisionFailure):
                        cc.local_ready(values)
                with self.assertRaisesRegex(cp.ProvisionFailure, 'LOCAL_CONFIGURATION_MISMATCH'):
                    cc.local_ready({**values, 'adminPort': 1})
                env.chmod(0o644)
                with self.assertRaisesRegex(cp.ProvisionFailure, 'UNSAFE_CONNECTOR_FILE'):
                    cc.local_ready(values)
                self.assertEqual(env.read_bytes(), data)
        finally:
            for server, thread in zip(servers, threads):
                server.shutdown()
                thread.join(timeout=3)
                server.server_close()

    def test_generated_unit_passes_systemd_parser_without_starting_a_service(self):
        self.install()
        state = cc.load_state(self.journal)
        result = subprocess.run(['/usr/bin/systemd-analyze', 'verify', str(self.units/state['unit'])],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    @unittest.skipUnless(sys.platform.startswith('linux') and os.environ.get('CONNECTOR_SYSTEMD_FIXTURE') == '1'
                         and Path('/.dockerenv').is_file() and Path('/proc/1/comm').read_text().strip() == 'systemd',
                         'explicit isolated Docker systemd fixture required')
    def test_real_manager_reads_private_credential_as_dynamic_user_and_removes_only_own_unit(self):
        self.patchers[0].stop()
        self.patchers[1].stop()
        received, observation = threading.Event(), {}
        class Proof(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                observation.update(data)
                self.send_response(204)
                self.end_headers()
                received.set()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Proof)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        script = '''#!/usr/bin/python3
import base64,errno,json,os,signal,stat,struct,sys,urllib.request
PRIVATE_CHECK
if sys.argv[1:]==['--version']:
    print('cloudflared version 2026.10.1 (synthetic credential consumer)')
    sys.exit(0)
p=sys.argv[sys.argv.index('--token-file')+1]
def report(value):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(urllib.request.Request('http://127.0.0.1:PORT/proof',data=json.dumps(value).encode(),method='POST'),timeout=5): pass
try:
    with open(p) as stream: token=stream.read()
except OSError as error:
    metadata={}
    for key,path in [('credentialParent','/run/credentials'),('directory',os.path.dirname(p)),('file',p)]:
        try:
            info=os.stat(path)
            metadata[key]={'uid':info.st_uid,'gid':info.st_gid,'mode':stat.S_IMODE(info.st_mode)}
        except OSError as probe: metadata[key]={'errno':probe.errno}
    directory=os.environ.get('CREDENTIALS_DIRECTORY','')
    # Only the synthetic unit's standard public runtime paths; never credential data or arbitrary environment.
    public_directory=directory if directory.startswith('/run/credentials/') and all(c.isalnum() or c in '/_.-' for c in directory) else 'nonstandard-runtime-path'
    mounts=[]
    with open('/proc/self/mountinfo') as stream:
        for line in stream:
            mount=line.split()[4]
            if mount=='/run/credentials' or mount.startswith('/run/credentials/'): mounts.append(mount)
    report({'failureStage':'credential-open','errno':error.errno,'processUid':os.geteuid(),
            'credentialDirectorySet':bool(os.environ.get('CREDENTIALS_DIRECTORY')),
            'argumentMatchesCredentialDirectory':p==os.environ.get('CREDENTIALS_DIRECTORY','')+'/tunnel-token',
            'publicCredentialDirectory':public_directory,'credentialMountPoints':mounts,'metadata':metadata})
    sys.exit(70)
try: value=json.loads(base64.b64decode(token))
except Exception: sys.exit(71)
try:
    info=os.stat(p)
    try: acl=os.getxattr(p,'system.posix_acl_access')
    except OSError as error:
        if error.errno not in (errno.ENODATA,errno.ENOTSUP): raise
        acl=None
    private=credential_is_private(info,acl,os.geteuid())
except Exception: sys.exit(72)
proof={'credentialReadable':set(value)=={'a','s','t'},'privateMode':private,'nonRoot':os.geteuid()!=0}
if not private:
    report({'failureStage':'credential-access-policy','fileMode':stat.S_IMODE(info.st_mode),
            'fileUid':info.st_uid,'processUid':os.geteuid(),
            'aclEntries':list(struct.iter_unpack('<HHI',acl[4:])) if acl and len(acl)%8==4 else None})
    sys.exit(72)
try:
    report(proof)
except Exception: sys.exit(73)
signal.pause()
'''.replace('PORT', str(server.server_port)).replace('PRIVATE_CHECK', inspect.getsource(credential_is_private))
        compile(script, '<synthetic-credential-consumer>', 'exec')
        self.binary.write_text(script)
        self.binary.chmod(0o755)
        foreign = cc.UNITS/('ssh-portal-existing-fixture-'+self.root.name+'.service')
        self.assertFalse(foreign.exists())
        unrelated = b'[Service]\nType=oneshot\nExecStart=/usr/bin/true\n'
        foreign.write_bytes(unrelated)
        foreign.chmod(0o644)
        try:
            result = self.install()
            self.assertFalse(result['edgeConnected'], 'synthetic consumer does not connect to Cloudflare')
            reported = received.wait(10)
            if not reported:
                state = cc.load_state(self.journal)
                names = ['ActiveState', 'SubState', 'Result', 'ExecMainCode', 'ExecMainStatus', 'NRestarts', 'StatusErrno']
                print(json.dumps({'syntheticServiceFailure': {name: cc.system_value(state['unit'], name) for name in names},
                                  'consumerExitCodes': {'70': 'credential-open', '71': 'credential-parse',
                                                        '72': 'credential-mode', '73': 'loopback-proof'}}))
            self.assertTrue(reported, 'real service must read its credential and report only booleans')
            if 'failureStage' in observation:
                state = cc.load_state(self.journal)
                print(json.dumps({'managerCredentialConfigured': bool(cc.system_value(state['unit'], 'LoadCredential')),
                                  'syntheticSourcePresent': (self.journal.directory/cc.TOKEN_FILE).is_file()}))
            self.assertEqual(observation, {'credentialReadable': True, 'privateMode': True, 'nonRoot': True})
            state = cc.load_state(self.journal)
            self.assertNotEqual(cc.system_value(state['unit'], 'MainPID'), '0')
            self.assertEqual(cc.remove_connector(self.journal)['status'], 'CONNECTOR_REMOVED')
            self.assertEqual(foreign.read_bytes(), unrelated)
            self.assertEqual(cc.system_value(state['unit'], 'MainPID'), '0')
            self.assertFalse((cc.UNITS/state['unit']).exists())
            self.assertFalse((self.journal.directory/cc.TOKEN_FILE).exists())
        finally:
            try:
                state = cc.load_state(self.journal)
                if state and state['status'] != 'REMOVED':
                    cc.remove_connector(self.journal)
            finally:
                foreign.unlink()
                cc.checked([cc.SYSTEMCTL, 'daemon-reload'])
                server.shutdown()
                thread.join(timeout=3)
                server.server_close()

    def test_systemd_parser_matches_explicit_fixture_mount_contract(self):
        results = []
        for binary in [str(self.binary), '/usr/bin/true']:
            unit = self.units/'visibility-probe.service'
            unit.write_bytes(cc.unit_text(binary, self.journal.directory/cc.TOKEN_FILE))
            result = subprocess.run(['/usr/bin/systemd-analyze', 'verify', str(unit)],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, timeout=10, check=False)
            results.append(result.returncode)
        noexec = os.environ.get('CONNECTOR_FIXTURE_NOEXEC', '0') == '1'
        self.assertEqual(results[0], 1 if noexec else 0, 'Parser result must match the explicit exec/noexec test mount')
        self.assertEqual(results[1], 0, 'Public executable proves unit syntax is supported')
        print(json.dumps({'fixtureNoexec': noexec, 'fixtureBinaryParserCode': results[0], 'systemBinaryParserCode': results[1]}))

    def test_install_remove_cleanup_and_durable_reopen_preserve_foreign_files(self):
        foreign = self.units/'cloudflared.service'
        foreign.write_bytes(b'SYNTHETIC_EXISTING_UNIT')
        result = self.install()
        self.assertTrue(result['edgeConnected'])
        self.assertFalse(result['environmentLinked'])
        token_path = self.journal.directory/cc.TOKEN_FILE
        token = tunnel_token(self.api.tunnel_id)
        self.assertEqual(token_path.read_text(), token)
        self.assertEqual(stat.S_IMODE(token_path.stat().st_mode), 0o600)
        record = (self.journal.directory/'connector.json').read_text()
        for secret in [token, SECRET, 'SYNTHETIC_TUNNEL_KEY_']:
            self.assertNotIn(secret, record)
            self.assertNotIn(cc.digest(secret.encode()), record)
            self.assertNotIn(secret, json.dumps(self.systemd.calls))
        with self.assertRaisesRegex(cp.ProvisionFailure, 'REMOVE_LOCAL_CONNECTOR_FIRST'):
            cp.cleanup(self.api, self.journal)
        directory = self.journal.directory
        self.journal.close()
        self.journal = cp.Journal(directory)
        self.addCleanup(self.journal.close)
        self.api.journal = self.journal
        self.assertEqual(cc.remove_connector(self.journal)['status'], 'CONNECTOR_REMOVED')
        self.assertEqual(foreign.read_bytes(), b'SYNTHETIC_EXISTING_UNIT')
        self.assertFalse(token_path.exists())
        self.assertFalse(self.systemd.active)
        self.assertFalse(self.systemd.enabled)
        self.assertEqual(cp.cleanup(self.api, self.journal)['status'], 'CLEANED')

    def test_every_durable_connector_record_contains_only_public_fields(self):
        save = self.journal.write_record
        observations = []
        def observe(name, state):
            save(name, state)
            if name == 'connector.json':
                raw = (self.journal.directory/name).read_text()
                for secret in [tunnel_token(self.api.tunnel_id), SECRET, 'SYNTHETIC_TUNNEL_KEY_']:
                    self.assertNotIn(secret, raw)
                    self.assertNotIn(cc.digest(secret.encode()), raw)
                observations.append(state['status'])
        with patch.object(self.journal, 'write_record', side_effect=observe):
            self.install()
            cc.remove_connector(self.journal)
        self.assertIn('START_REQUESTED', observations)
        self.assertEqual(observations[-1], 'REMOVED')

    def test_unknown_start_outcome_is_not_replayed_and_can_be_explicitly_removed(self):
        self.systemd.failure = 'enable'
        with self.assertRaises(cp.ProvisionFailure):
            self.install()
        self.assertTrue(self.systemd.active)
        before = copy.deepcopy(self.systemd.calls)
        with self.assertRaises(cp.ProvisionFailure):
            self.install()
        self.assertEqual(self.systemd.calls, before)
        self.assertEqual(cc.remove_connector(self.journal)['status'], 'CONNECTOR_REMOVED')
        self.assertFalse(self.systemd.active)

    def test_remote_cleanup_is_blocked_even_before_edge_connection_appears(self):
        self.systemd.connected = False
        self.install()
        before = copy.deepcopy(self.api.writes)
        with self.assertRaisesRegex(cp.ProvisionFailure, 'REMOVE_LOCAL_CONNECTOR_FIRST'):
            cp.cleanup(self.api, self.journal)
        self.assertEqual(self.api.writes, before)

    def test_dedicated_connection_read_failure_keeps_active_without_restart(self):
        original_get = self.api.get
        def unavailable(path, query=None):
            if path.endswith('/connections') and self.systemd.active:
                raise cf.ApiFailure('synthetic dedicated read denied')
            return original_get(path, query)
        self.api.get = unavailable
        result = self.install()
        self.assertEqual(result['status'], 'CONNECTOR_ACTIVE')
        self.assertFalse(result['edgeConnected'])
        self.assertTrue(self.systemd.active)
        self.assertEqual(sum(x[1] == 'enable' for x in self.systemd.calls), 1)
        cc.remove_connector(self.journal)
        def incomplete(path, query=None):
            if path.endswith('/connections') and self.systemd.active:
                return {'result': [], 'result_info': None}
            return original_get(path, query)
        self.api.get = incomplete
        self.assertFalse(self.install()['edgeConnected'])
        self.assertTrue(self.systemd.active)
        self.assertEqual(sum(x[1] == 'enable' for x in self.systemd.calls), 2)
        cc.remove_connector(self.journal)

    def test_local_active_edge_pending_and_record_failure_do_not_trigger_restart(self):
        self.systemd.connected = False
        result = self.install()
        self.assertFalse(result['edgeConnected'])
        self.assertTrue(self.systemd.active)
        cc.remove_connector(self.journal)
        original_get = self.api.get
        def unavailable_edge(path, query=None):
            if path == self.api.tunnel_path and self.systemd.active:
                raise cf.ApiFailure('synthetic edge read unavailable')
            return original_get(path, query)
        self.api.get = unavailable_edge
        self.assertFalse(self.install()['edgeConnected'])
        self.assertEqual(sum(x[1] == 'enable' for x in self.systemd.calls), 2)
        cc.remove_connector(self.journal)
        save, active_writes = self.journal.write_record, []
        def failed_observation_write(name, state):
            if name == 'connector.json' and state['status'] == 'ACTIVE':
                active_writes.append(True)
                if len(active_writes) == 2:
                    raise OSError('synthetic final observation write failure')
            save(name, state)
        with patch.object(self.journal, 'write_record', side_effect=failed_observation_write), self.assertRaises(OSError):
            self.install()
        self.assertTrue(self.systemd.active)
        self.assertEqual(sum(x[1] == 'enable' for x in self.systemd.calls), 3)

    def test_changed_unit_token_binary_or_dropin_is_not_touched(self):
        self.install()
        state = cc.load_state(self.journal)
        unit = self.units/state['unit']
        original = unit.read_bytes()
        cases = [('unit', lambda: unit.write_bytes(original+b'\n# different')),
                 ('binary', lambda: self.binary.write_bytes(b'CHANGED_BINARY')),
                 ('dropin', lambda: setattr(self.systemd, 'overrides', '/synthetic/override.conf')),
                 ('token', lambda: (self.journal.directory/cc.TOKEN_FILE).write_text(tunnel_token('f'*32))),
                 ('token-same-binding-rewritten', lambda: (self.journal.directory/cc.TOKEN_FILE).write_text(tunnel_token(self.api.tunnel_id)))]
        for name, mutate in cases:
            with self.subTest(name=name):
                mutate()
                calls = copy.deepcopy(self.systemd.calls)
                with self.assertRaises(cp.ProvisionFailure):
                    cc.remove_connector(self.journal)
                self.assertFalse(any(x[1] in ['stop', 'disable'] for x in self.systemd.calls[len(calls):]),
                                 'Stop/disable must not run for changed connector files')
                unit.write_bytes(original)
                self.binary.write_bytes(self.binary_bytes)
                self.systemd.overrides = ''
                (self.journal.directory/cc.TOKEN_FILE).write_text(tunnel_token(self.api.tunnel_id))
                token_path = self.journal.directory/cc.TOKEN_FILE
                os.utime(token_path, ns=(token_path.stat().st_atime_ns, state['tokenIdentity']['mtimeNs']))

    def test_root_path_symlinks_bad_token_and_local_readiness_stop_before_files(self):
        self.api.bad_token = True
        with self.assertRaises(cp.ProvisionFailure):
            self.install()
        self.assertFalse((self.journal.directory/'connector.json').exists())
        self.api.bad_token = False
        self.binary.chmod(0o777)
        reads = self.api.token_reads
        with self.assertRaises(cp.ProvisionFailure):
            self.install()
        self.assertEqual(self.api.token_reads, reads)
        self.binary.chmod(0o755)
        private_binary = self.root/'private-cloudflared'
        private_binary.write_bytes(self.binary_bytes)
        private_binary.chmod(0o755)
        with self.assertRaisesRegex(cp.ProvisionFailure, 'TRUSTED_CLOUDFLARED_REQUIRED'):
            cc.install_connector(self.api, self.journal, str(private_binary))
        self.systemd.version = b'cloudflared version 2025.3.9\n'
        with self.assertRaisesRegex(cp.ProvisionFailure, 'TOKEN_FILE_VERSION_REQUIRED'):
            self.install()
        self.systemd.version = b'cloudflared version 2026.10.1\n'
        link = self.root/'linked-binary'
        link.symlink_to(self.binary)
        with self.assertRaises(cp.ProvisionFailure):
            cc.install_connector(self.api, self.journal, str(link))
        with patch.object(cc, 'local_ready', side_effect=cp.ProvisionFailure('LOCAL_CONFIGURATION_MISMATCH')):
            with self.assertRaises(cp.ProvisionFailure):
                self.install()
        self.assertFalse((self.journal.directory/'connector.json').exists())

    def test_remove_failure_and_crash_after_unlink_can_resume_without_start(self):
        self.install()
        self.systemd.failure = 'disable'
        with self.assertRaises(cp.ProvisionFailure):
            cc.remove_connector(self.journal)
        self.assertEqual(cc.load_state(self.journal)['status'], 'STOPPED')
        with patch.object(cc, 'sync_parent', side_effect=OSError('synthetic power cut after unlink')):
            with self.assertRaises(OSError):
                cc.remove_connector(self.journal)
        self.assertEqual(cc.load_state(self.journal)['status'], 'UNIT_REMOVE_REQUESTED')
        self.assertEqual(cc.remove_connector(self.journal)['status'], 'CONNECTOR_REMOVED')
        self.assertEqual(sum(x[1] == 'enable' for x in self.systemd.calls), 1)

    def test_ambiguous_file_creation_is_not_adopted_or_deleted(self):
        save = self.journal.write_record
        def stop_after_unit_file(name, state):
            if name == 'connector.json' and state['status'] == 'UNIT_READY':
                raise OSError('synthetic crash before identity commit')
            save(name, state)
        with patch.object(self.journal, 'write_record', side_effect=stop_after_unit_file), self.assertRaises(OSError):
            self.install()
        self.assertEqual(cc.load_state(self.journal)['status'], 'TOKEN_READY')
        before = copy.deepcopy(self.systemd.calls)
        with self.assertRaises(cp.ProvisionFailure):
            cc.remove_connector(self.journal)
        self.assertEqual(before, self.systemd.calls)
        self.assertEqual(len(list(self.units.glob('ssh-portal-tunnel-*.service'))), 1)


if __name__ == '__main__':
    unittest.main()
