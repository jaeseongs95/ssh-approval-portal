import base64
import hashlib
import importlib.util
import json
import multiprocessing
import os
import stat
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('agent_cli_helper',HERE.parent/'scripts/manage-agent-cli.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.SYSTEM_BINS=[]  # Fixture never probes host/system CLI installs.
NOW=1000
EXPIRY=1000000

def fixture(home,provider='codex',version='1.2.3',failure=None,gate=None,started=None):
    data=json.dumps({'provider':provider,'version':version}).encode()
    integrity='sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()
    calls=[]
    def download(url,path):
        if failure=='download':raise m.Refused('DOWNLOAD_FAILED')
        path.write_bytes(data if failure!='integrity' else b'changed')
    def install(package,prefix,work):
        calls.append(str(prefix));assert package.read_bytes()==data
        if started:started.set()
        if gate and not gate.wait(10):raise RuntimeError('fixture gate timed out')
        if failure=='npm':raise m.Refused('NPM_FAILED')
        info=json.loads(package.read_bytes());command=m.PROVIDERS[provider][1]
        binary=prefix/'bin'/command;binary.parent.mkdir()
        output=('codex-cli '+version) if provider=='codex' else version+' (Claude Code)'
        if failure=='version':output='not a version'
        binary.write_text("#!/bin/sh\nprintf '%s\\n' '"+output+"'\n",encoding='utf-8');binary.chmod(0o755)
        if failure=='binary-link':
            binary.unlink();binary.symlink_to('/usr/bin/printf')
    manager=m.Installer(home,provider,download,install,now=lambda:NOW)
    return manager,integrity,calls

def child_install(home,operation,revision,gate,started,result):
    try:
        manager,integrity,_=fixture(home,gate=gate,started=started)
        result.put(manager.run('install','1.2.3',integrity,revision,EXPIRY,operation)['state'])
    except m.Refused as error:result.put(error.code)

class AgentCli(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='agent-cli-test-')
        self.home=Path(self.tmp.name);self.home.chmod(0o700)
        self.manager,self.integrity,self.calls=fixture(self.home)
        self.initial=self.manager.inspect()['installationRevision']
    def tearDown(self):self.tmp.cleanup()
    def run_install(self,operation='a'*48,manager=None,integrity=None,expected=None,expires=EXPIRY,action='install',version='1.2.3'):
        return (manager or self.manager).run(action,version,integrity or self.integrity,expected or self.initial,expires,operation)
    def assert_code(self,code,call):
        with self.assertRaises(m.Refused) as caught:call()
        self.assertEqual(caught.exception.code,code)
    def foreign(self,provider='codex',version='1.2.2'):
        binary=self.home/'.local/bin'/provider;binary.parent.mkdir(parents=True,exist_ok=True)
        output='codex-cli '+version if provider=='codex' else version+' (Claude Code)'
        binary.write_text("#!/bin/sh\nprintf '%s\\n' '"+output+"'\n",encoding='utf-8');binary.chmod(0o755)
        auth=self.home/('.codex' if provider=='codex' else '.claude');auth.mkdir(exist_ok=True)
        (auth/'auth-fixture.json').write_bytes(b'SYNTHETIC_AUTH_PRESERVE')
        return binary,auth/'auth-fixture.json'
    def test_non_root_fixed_provider_and_home_boundary(self):
        with patch.object(m.os,'geteuid',return_value=0):self.assert_code('NON_ROOT_REQUIRED',lambda:m.Installer(self.home,'codex'))
        self.assert_code('UNSUPPORTED_PROVIDER',lambda:m.Installer(self.home,'constructor'))
        self.home.chmod(0o777);self.assert_code('UNSAFE_HOME',lambda:m.Installer(self.home,'codex'));self.home.chmod(0o700)
    def test_success_and_exact_completed_request_replay(self):
        result=self.run_install();self.assertEqual(result['state'],'completed');self.assertEqual(result['login'],'not_checked')
        self.assertEqual(self.manager.inspect()['version'],'1.2.3');self.assertEqual(len(self.calls),1)
        self.assertEqual(self.run_install(),result);self.assertEqual(len(self.calls),1)
    def test_same_version_new_request_reuses_verified_install(self):
        self.run_install();revision=self.manager.inspect()['installationRevision']
        result=self.run_install('b'*48,expected=revision);self.assertEqual(result['state'],'reused');self.assertEqual(len(self.calls),1)
    def test_managed_same_version_never_reuses_a_different_release_integrity(self):
        self.run_install();before=self.manager.inspect();wrong='sha512-'+base64.b64encode(b'\x00'*64).decode()
        self.assert_code('INSTALLED_RELEASE_CHANGED',lambda:self.run_install('b'*48,integrity=wrong,expected=before['installationRevision']))
        self.assertEqual(self.manager.inspect(),before);self.assertEqual(len(self.calls),1)
    def test_two_providers_have_separate_versions_and_commands(self):
        self.run_install()
        other,integrity,calls=fixture(self.home,'claude','2.3.4');revision=other.inspect()['installationRevision']
        result=self.run_install('b'*48,other,integrity,revision,version='2.3.4');self.assertEqual(result['state'],'completed')
        self.assertEqual(other.inspect()['version'],'2.3.4');self.assertEqual(self.manager.inspect()['version'],'1.2.3');self.assertEqual(len(calls),1)
    def test_update_preserves_previous_version_and_credentials(self):
        auth=self.home/'.codex';auth.mkdir();secret=auth/'auth.json';secret.write_bytes(b'SYNTHETIC_AUTH_DO_NOT_READ')
        self.run_install();before=self.manager.inspect();prior=self.manager.root/before['active'];prior_binary=(prior/'bin/codex').read_bytes()
        updated,integrity,calls=fixture(self.home,version='1.2.4')
        self.run_install('b'*48,updated,integrity,before['installationRevision'],action='update',version='1.2.4')
        self.assertEqual(updated.inspect()['version'],'1.2.4');self.assertEqual((prior/'bin/codex').read_bytes(),prior_binary)
        self.assertEqual(secret.read_bytes(),b'SYNTHETIC_AUTH_DO_NOT_READ');self.assertEqual(len(calls),1)
    def test_failed_download_and_integrity_never_invoke_npm(self):
        for operation,failure,code in [('d','download','DOWNLOAD_FAILED'),('e','integrity','PACKAGE_INTEGRITY_FAILED')]:
            manager,integrity,calls=fixture(self.home,failure=failure)
            self.assert_code(code,lambda:self.run_install(operation*48,manager,integrity))
            self.assertEqual(calls,[]);self.assertEqual(manager.inspect()['installationRevision'],self.initial)
    def test_npm_version_and_escape_failures_preserve_existing_active(self):
        self.run_install();before=self.manager.inspect();target=os.readlink(self.manager.root/'current')
        for i,failure,code in [(1,'npm','NPM_FAILED'),(2,'version','VERSION_UNAVAILABLE'),(3,'binary-link','UNSAFE_EXECUTABLE')]:
            manager,integrity,_=fixture(self.home,version='1.2.4',failure=failure)
            self.assert_code(code,lambda:self.run_install(str(i)*48,manager,integrity,before['installationRevision'],action='update',version='1.2.4'))
            self.assertEqual(os.readlink(manager.root/'current'),target);self.assertEqual(manager.inspect()['version'],'1.2.3')
    def test_stale_snapshot_conflicting_payload_and_expiry(self):
        self.assert_code('PLAN_EXPIRED',lambda:self.run_install(expires=NOW))
        self.run_install();self.assert_code('STALE_INSTALLATION',lambda:self.run_install('b'*48))
        self.assert_code('REQUEST_CONFLICT',lambda:self.run_install(version='1.2.4'))
        self.assertEqual(len(self.calls),1)
    def test_invalid_integrity_and_identifiers(self):
        for value in ['sha1-aaaa','sha512-YQ==',self.integrity+' ',self.integrity[:-3]+'B==']:
            self.assert_code('INVALID_INTEGRITY',lambda:self.run_install(integrity=value))
        self.assert_code('INVALID_PLAN',lambda:self.run_install('../unsafe'))
        self.assert_code('INVALID_PLAN',lambda:self.run_install(version='1.2.3;id'))
        self.assertFalse(self.manager.root.exists())
    def test_symlink_parent_and_current_never_escape_managed_tree(self):
        outside=self.home/'outside';outside.mkdir();(self.home/'.local').symlink_to(outside,target_is_directory=True)
        self.assert_code('UNSAFE_DIRECTORY',self.manager.inspect)
        self.assert_code('UNSAFE_DIRECTORY',self.run_install);self.assertEqual(list(outside.iterdir()),[])
        (self.home/'.local').unlink();self.manager.initialize();(self.manager.root/'current').symlink_to('/etc')
        self.assert_code('UNSAFE_CURRENT',self.manager.inspect)
    def test_hardlinked_lock_refuses_install(self):
        self.manager.initialize();lock=self.manager.root/'.lock';lock.touch(mode=0o600);os.link(lock,self.home/'foreign-link')
        self.assert_code('UNSAFE_LOCK',self.run_install);self.assertEqual(self.calls,[])
    def test_receipt_extra_fields_and_symlinks_are_not_returned(self):
        self.run_install();work=self.manager.root/'operations'/('a'*48);path=work/'receipt.json'
        value=m.read_json(path);value['private']='SYNTHETIC_SECRET';m.atomic_json(path,value)
        self.assert_code('INVALID_STATE',lambda:self.manager.status('a'*48))
        path.unlink();path.symlink_to(self.home/'foreign.json')
        with self.assertRaises(Exception):self.manager.status('a'*48)
    def test_child_environment_does_not_inherit_credentials(self):
        with patch.dict(os.environ,{'JEV_API_KEY':'SYNTHETIC_SECRET','OPENAI_API_KEY':'SYNTHETIC_SECRET','NPM_TOKEN':'SYNTHETIC_SECRET','NODE_OPTIONS':'--require secret'}):
            env=m.clean_env(self.home)
            self.assertEqual(set(env),{'LANG','LC_ALL','PATH','HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','DISABLE_UPDATES'})
            self.assertNotIn('SYNTHETIC_SECRET',json.dumps(env));self.run_install()
    def test_version_probe_uses_bundled_node_path_without_credentials(self):
        captured=[]
        def child(argv,**options):
            captured.append(options['env']);options['stdout'].write(b'codex-cli 1.2.3\n')
            return type('Result',(),{'returncode':0})()
        with patch.dict(os.environ,{'OPENAI_API_KEY':'SYNTHETIC_SECRET'}), patch.object(m.subprocess,'run',side_effect=child):
            self.assertEqual(m.version_of(self.home/'codex','codex'),'1.2.3')
        self.assertIn('/opt/ssh-approval/node/bin',captured[0]['PATH'].split(':'))
        self.assertNotIn('SYNTHETIC_SECRET',json.dumps(captured))
    def test_npm_uses_distinct_private_empty_config_files(self):
        work=self.home/'npm-work';work.mkdir(mode=0o700);prefix=work/'prefix';prefix.mkdir(mode=0o700);package=work/'package.tgz';package.write_bytes(b'fixture')
        captured=[]
        def spawn(argv,**options):
            captured.append((argv,options));return type('Process',(),{'wait':lambda self,**kwargs:0,'poll':lambda self:0})()
        with patch.object(m.Path,'is_file',return_value=True),patch.object(m.subprocess,'run',return_value=type('Result',(),{'returncode':0,'stdout':b'v24.21.0\n'})()),patch.object(m.subprocess,'Popen',side_effect=spawn):
            m.npm_install(package,prefix,work)
        self.assertEqual(len(captured),1);args,options=captured[0];user=Path(args[args.index('--userconfig')+1]);glob=Path(args[args.index('--globalconfig')+1])
        self.assertNotEqual(user,glob);self.assertEqual(user.parent,work);self.assertEqual(glob.parent,work)
        for path in [user,glob]:self.assertEqual(path.read_bytes(),b'');self.assertEqual(path.stat().st_mode&0o777,0o600);self.assertFalse(path.is_symlink())
        self.assertNotIn('NPM_TOKEN',options['env']);self.assertNotIn('NODE_OPTIONS',options['env'])
    def test_foreign_install_is_reused_but_not_overwritten(self):
        binary=self.home/'.local/bin/codex';binary.parent.mkdir(parents=True)
        data=b"#!/bin/sh\nprintf 'codex-cli 1.2.3\\n'\n";binary.write_bytes(data);binary.chmod(0o755)
        before=self.manager.inspect();self.assertTrue(before['installed']);self.assertFalse(before['managed'])
        result=self.run_install(expected=before['installationRevision']);self.assertEqual(result['state'],'reused');self.assertEqual(self.calls,[]);self.assertEqual(binary.read_bytes(),data)
        self.assertFalse((self.manager.root/'current').exists())
    def test_foreign_different_versions_install_side_by_side_both_providers(self):
        for provider in ['codex','claude']:
            binary,auth=self.foreign(provider);original=binary.read_bytes();mode=binary.stat().st_mode
            manager,integrity,calls=fixture(self.home,provider,version='1.2.4');before=manager.inspect()
            try:result=self.run_install(('b' if provider=='codex' else 'c')*48,manager,integrity,before['installationRevision'],version='1.2.4')
            except m.Refused as error:result={'state':error.code}
            self.assertEqual(result['state'],'completed');self.assertTrue(manager.inspect()['managed']);self.assertEqual(manager.inspect()['version'],'1.2.4')
            self.assertEqual(binary.read_bytes(),original);self.assertEqual(binary.stat().st_mode,mode);self.assertEqual(auth.read_bytes(),b'SYNTHETIC_AUTH_PRESERVE');self.assertEqual(len(calls),1)
    def test_foreign_install_failures_preserve_original_binary_and_auth(self):
        binary,auth=self.foreign();original=binary.read_bytes()
        for op,failure,code in [('b','npm','NPM_FAILED'),('c','version','VERSION_UNAVAILABLE')]:
            manager,integrity,_=fixture(self.home,version='1.2.4',failure=failure);before=manager.inspect()
            self.assert_code(code,lambda:self.run_install(op*48,manager,integrity,before['installationRevision'],version='1.2.4'))
            self.assertEqual(binary.read_bytes(),original);self.assertEqual(auth.read_bytes(),b'SYNTHETIC_AUTH_PRESERVE');self.assertFalse((manager.root/'current').is_symlink());self.assertEqual(manager.inspect()['installationRevision'],before['installationRevision'])
    def test_foreign_drift_during_install_is_preserved_without_publishing(self):
        binary,_=self.foreign();manager,integrity,_=fixture(self.home,version='1.2.4');before=manager.inspect();install=manager.runner
        def changed(*args):
            install(*args);binary.write_bytes(b"#!/bin/sh\nprintf 'codex-cli 1.2.5\\n'\n")
        manager.runner=changed
        self.assert_code('STALE_INSTALLATION',lambda:self.run_install('b'*48,manager,integrity,before['installationRevision'],version='1.2.4'))
        self.assertIn(b'1.2.5',binary.read_bytes());self.assertFalse((manager.root/'current').is_symlink())
    def test_completion_receipt_failure_restores_previous_managed_link(self):
        self.run_install();before=self.manager.inspect();old=(self.manager.root/before['active']/'bin/codex').read_bytes();manager,integrity,_=fixture(self.home,version='1.2.4');atomic=m.atomic_json
        def fail_completed(path,value):
            if path.name=='receipt.json' and value.get('state')=='completed':raise OSError('synthetic storage failure')
            return atomic(path,value)
        with patch.object(m,'atomic_json',side_effect=fail_completed):self.assert_code('INSTALL_FAILED',lambda:self.run_install('b'*48,manager,integrity,before['installationRevision'],action='update',version='1.2.4'))
        self.assertEqual(os.readlink(manager.root/'current'),before['active']);self.assertEqual((manager.root/before['active']/'bin/codex').read_bytes(),old);self.assertEqual(manager.status('b'*48)['state'],'failed')
    def test_first_managed_receipt_failure_restores_external_installation(self):
        binary,auth=self.foreign();original=binary.read_bytes();before=self.manager.inspect();atomic=m.atomic_json
        def fail_completed(path,value):
            if path.name=='receipt.json' and value.get('state')=='completed':raise OSError('synthetic storage failure')
            return atomic(path,value)
        with patch.object(m,'atomic_json',side_effect=fail_completed):self.assert_code('INSTALL_FAILED',lambda:self.run_install(expected=before['installationRevision']))
        self.assertFalse((self.manager.root/'current').exists());self.assertFalse((self.manager.root/'current').is_symlink());self.assertEqual(self.manager.inspect()['installationRevision'],before['installationRevision']);self.assertEqual(binary.read_bytes(),original);self.assertEqual(auth.read_bytes(),b'SYNTHETIC_AUTH_PRESERVE');self.assertEqual(self.manager.status('a'*48)['state'],'failed')
    def test_rollback_preserves_a_replacement_current_link(self):
        self.run_install();before=self.manager.inspect();manager,integrity,_=fixture(self.home,version='1.2.4');atomic=m.atomic_json;foreign='versions/foreign-link-not-owned'
        def replace_completed(path,value):
            if path.name=='receipt.json' and value.get('state')=='completed':
                current=manager.root/'current';current.unlink();current.symlink_to(foreign);raise OSError('synthetic external writer')
            return atomic(path,value)
        with patch.object(m,'atomic_json',side_effect=replace_completed):self.assert_code('RECOVERY_REQUIRED',lambda:self.run_install('b'*48,manager,integrity,before['installationRevision'],action='update',version='1.2.4'))
        self.assertEqual(os.readlink(manager.root/'current'),foreign);self.assertTrue((manager.root/before['active']/'bin/codex').is_file())
    def test_foreign_update_requires_an_explicit_separate_install(self):
        binary,_=self.foreign();before=self.manager.inspect();original=binary.read_bytes()
        self.assert_code('MANAGED_UPDATE_REQUIRED',lambda:self.run_install(expected=before['installationRevision'],action='update'))
        self.assertEqual(binary.read_bytes(),original);self.assertEqual(self.calls,[])
    def test_real_process_claim_has_one_winner(self):
        ctx=multiprocessing.get_context('fork');gate=ctx.Event();started=ctx.Event();results=ctx.Queue()
        first=ctx.Process(target=child_install,args=(str(self.home),'a'*48,self.initial,gate,started,results));second=None
        try:
            first.start();self.assertTrue(started.wait(5))
            self.assertEqual(self.manager.status('a'*48)['state'],'installing')
            second=ctx.Process(target=child_install,args=(str(self.home),'b'*48,self.initial,gate,None,results));second.start();second.join(5)
            self.assertFalse(second.is_alive());self.assertEqual(results.get(timeout=2),'BUSY')
            gate.set();first.join(5);self.assertFalse(first.is_alive());self.assertEqual(results.get(timeout=2),'completed')
            self.assertEqual(self.manager.inspect()['version'],'1.2.3')
        finally:
            gate.set()
            for process in [first,second]:
                if process and process.is_alive():process.terminate();process.join(5)
            results.close();results.join_thread()
    def test_killed_worker_is_unknown_and_never_reexecuted(self):
        ctx=multiprocessing.get_context('fork');gate=ctx.Event();started=ctx.Event();results=ctx.Queue()
        process=ctx.Process(target=child_install,args=(str(self.home),'a'*48,self.initial,gate,started,results))
        try:
            process.start();self.assertTrue(started.wait(5));process.terminate();process.join(5);self.assertFalse(process.is_alive())
            self.assertEqual(self.manager.status('a'*48)['state'],'unknown')
            self.assert_code('RESULT_UNKNOWN',self.run_install);self.assertEqual(self.calls,[])
        finally:
            if process.is_alive():process.terminate();process.join(5)
            results.close();results.join_thread()


    def test_install_deadline_interrupts_slow_download_before_npm(self):
        import time
        manager,integrity,calls=fixture(self.home);manager.now=lambda:int(time.time()*1000)
        original=manager.downloader
        def slow(url,path):time.sleep(1.5);original(url,path)
        manager.downloader=slow;handler=m.signal.getsignal(m.signal.SIGALRM);started=time.monotonic()
        self.assert_code('INSTALL_TIMEOUT',lambda:self.run_install(manager=manager,integrity=integrity,expires=manager.now()+250))
        self.assertLess(time.monotonic()-started,1.0);self.assertEqual(calls,[]);self.assertFalse(manager.inspect()['installed'])
        self.assertEqual(manager.status('a'*48)['state'],'failed');self.assertEqual(m.signal.getitimer(m.signal.ITIMER_REAL),(0.0,0.0));self.assertEqual(m.signal.getsignal(m.signal.SIGALRM),handler)
    def test_install_deadline_preserves_prior_version_and_auth(self):
        import time
        self.run_install();before=self.manager.inspect();binary=self.manager.root/before['active']/'bin/codex';data=binary.read_bytes()
        auth=self.home/'.codex';auth.mkdir();(auth/'auth-fixture').write_bytes(b'SYNTHETIC_PRESERVE')
        manager,integrity,calls=fixture(self.home,version='1.2.4');manager.now=lambda:int(time.time()*1000);runner=manager.runner
        def slow(*args):time.sleep(1.5);return runner(*args)
        manager.runner=slow
        self.assert_code('INSTALL_TIMEOUT',lambda:self.run_install('b'*48,manager,integrity,before['installationRevision'],manager.now()+250,'update','1.2.4'))
        self.assertEqual(manager.inspect(),before);self.assertEqual(binary.read_bytes(),data);self.assertEqual((auth/'auth-fixture').read_bytes(),b'SYNTHETIC_PRESERVE');self.assertEqual(calls,[])
    def test_success_restores_private_timer_and_handler(self):
        handler=m.signal.getsignal(m.signal.SIGALRM);self.run_install()
        self.assertEqual(m.signal.getitimer(m.signal.ITIMER_REAL),(0.0,0.0));self.assertEqual(m.signal.getsignal(m.signal.SIGALRM),handler)
    def test_existing_process_timer_is_not_stolen(self):
        handler=m.signal.getsignal(m.signal.SIGALRM)
        try:
            m.signal.setitimer(m.signal.ITIMER_REAL,10)
            self.assert_code('RUNTIME_TIMER_BUSY',self.run_install)
            self.assertGreater(m.signal.getitimer(m.signal.ITIMER_REAL)[0],8);self.assertEqual(self.calls,[])
        finally:m.signal.setitimer(m.signal.ITIMER_REAL,0);m.signal.signal(m.signal.SIGALRM,handler)
    def test_npm_wait_interruption_kills_and_reaps_only_owned_live_group(self):
        import subprocess
        import sys
        work=self.home/'interrupted-npm';work.mkdir(mode=0o700);prefix=work/'prefix';prefix.mkdir(mode=0o700);package=work/'package.tgz';package.write_bytes(b'fixture')
        worker=work/'owned-worker.py';worker.write_text('import time\ntime.sleep(60)\n',encoding='utf8')
        real_popen=subprocess.Popen;children=[];signals=[];real_killpg=m.os.killpg
        def launch(*args,**kwargs):
            child=real_popen([sys.executable,str(worker)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True);children.append(child)
            class Interrupted:
                pid=child.pid
                first=True
                def poll(self):return child.poll()
                def wait(self,**options):
                    if self.first:self.first=False;raise RuntimeError('synthetic-wait-interruption')
                    return child.wait(**options)
            return Interrupted()
        def kill(group,sig):signals.append((group,sig));return real_killpg(group,sig)
        try:
            with patch.object(m.Path,'is_file',return_value=True),patch.object(m.subprocess,'run',return_value=type('Result',(),{'returncode':0,'stdout':b'v24.21.0\n'})()),patch.object(m.subprocess,'Popen',side_effect=launch),patch.object(m.os,'killpg',side_effect=kill):
                with self.assertRaisesRegex(RuntimeError,'synthetic-wait-interruption'):m.npm_install(package,prefix,work)
            self.assertEqual(len(children),1);self.assertIsNotNone(children[0].poll());self.assertEqual(signals,[(children[0].pid,m.signal.SIGKILL)])
        finally:
            for child in children:
                if child.poll() is None:real_killpg(child.pid,m.signal.SIGKILL);child.wait(timeout=5)


class ForeignProbeBoundary(unittest.TestCase):
    setUp=AgentCli.setUp
    tearDown=AgentCli.tearDown
    foreign=AgentCli.foreign
    def planted(self,mode):
        self.home.chmod(0o755)  # Other accounts can traverse this synthetic home.
        binary,_=self.foreign();marker=self.home/'probe-executed'
        binary.write_text("#!/bin/sh\nprintf 'executed' > '"+str(marker)+"'\nprintf '%s\\n' 'codex-cli 1.2.2'\n",encoding='utf-8');binary.chmod(0o755)
        if mode=='directory':binary.parent.chmod(0o777)
        if mode=='file':binary.chmod(0o775)
        if mode=='symlink':
            other=self.home/'unsafe-native';other.mkdir(mode=0o777);other.chmod(0o777);target=other/'codex';binary.rename(target);binary.symlink_to(target)
        error=None
        try:self.manager.inspect()
        except m.Refused as caught:error=caught.code
        self.assertFalse(marker.exists(),'UNTRUSTED_VERSION_PROBE_EXECUTED')
        self.assertEqual(error,'UNSAFE_EXECUTABLE')
    def test_untrusted_foreign_directory_never_executes(self):self.planted('directory')
    def test_untrusted_foreign_executable_never_executes(self):self.planted('file')
    def test_untrusted_resolved_native_directory_never_executes(self):self.planted('symlink')
    def test_trusted_owned_native_symlink_and_auth_are_preserved(self):
        binary,auth=self.foreign();before=binary.read_bytes();target=self.home/'native'/'codex';target.parent.mkdir(mode=0o700);binary.rename(target);binary.symlink_to(target)
        found=self.manager.inspect();self.assertTrue(found['installed']);self.assertFalse(found['managed']);self.assertEqual(found['version'],'1.2.2');self.assertEqual(target.read_bytes(),before);self.assertEqual(auth.read_bytes(),b'SYNTHETIC_AUTH_PRESERVE');self.assertTrue(binary.is_symlink())

@m.contextlib.contextmanager
def ack_storage_fault(manager, operation, failed='normal', ready=None, gate=None):
    """Real file fsync/replace; inject only the receipt parent-directory ACK."""
    path=manager.root/'operations'/operation/'receipt.json'
    original_atomic=m.atomic_json;original_fsync=m.os.fsync;phase=[None];events=[]
    def write(destination,value):
        state=value.get('state') if destination==path else None
        if state=='failed' and failed=='pre':
            events.append({'boundary':'failed-before-replace','receipt':m.read_json(path)['state']})
            raise OSError('SYNTHETIC_FAILED_BEFORE_REPLACE')
        phase[0]=state
        try:return original_atomic(destination,value)
        finally:phase[0]=None
    def sync(fd):
        state=phase[0]
        if state in ['completed','failed'] and stat.S_ISDIR(os.fstat(fd).st_mode):
            events.append({'boundary':state+'-after-replace','receipt':m.read_json(path)['state'],
                           'active':os.readlink(manager.root/'current') if (manager.root/'current').is_symlink() else None})
            if state=='failed' and failed=='abort':
                ready.set()
                if not gate.wait(10):raise RuntimeError('ACK fixture barrier timed out')
            if state=='completed' or failed in ['post','abort']:
                raise OSError('SYNTHETIC_DIRECTORY_ACK_FAILED')
        return original_fsync(fd)
    with patch.object(m,'atomic_json',side_effect=write),patch.object(m.os,'fsync',side_effect=sync):yield events

def child_ack_boundary(home,provider,expected,prior,mode,ready,gate):
    manager,integrity,_=fixture(Path(home),provider,version='1.2.4')
    switch=manager._switch
    def switched(target,previous):
        switch(target,previous)
        if mode=='rollback' and target==prior:
            ready.set()
            if not gate.wait(10):raise RuntimeError('ACK rollback barrier timed out')
    with patch.object(manager,'_switch',side_effect=switched),ack_storage_fault(manager,'b'*48,'abort' if mode=='failed-abort' else 'normal',ready,gate):
        try:manager.run('update','1.2.4',integrity,expected,EXPIRY,'b'*48)
        except m.Refused:pass

class AckReceiptBoundary(unittest.TestCase):
    setUp=AgentCli.setUp
    tearDown=AgentCli.tearDown
    assert_code=AgentCli.assert_code
    def prepared(self,provider,foreign=False):
        home=self.home/provider;home.mkdir(mode=0o700)
        manager,integrity,calls=fixture(home,provider,version='1.2.3')
        auth=home/('.codex' if provider=='codex' else '.claude');auth.mkdir()
        user=auth/'synthetic-user-file';user.write_bytes(b'SYNTHETIC_AUTH_AND_USER_PRESERVE')
        if foreign:
            binary=home/'.local/bin'/provider;binary.parent.mkdir(parents=True)
            output='codex-cli 1.2.3' if provider=='codex' else '1.2.3 (Claude Code)'
            binary.write_text("#!/bin/sh\nprintf '%s\\n' '"+output+"'\n",encoding='utf8');binary.chmod(0o755)
        else:
            manager.run('install','1.2.3',integrity,manager.inspect()['installationRevision'],EXPIRY,'a'*48)
            binary=manager.root/manager.inspect()['active']/'bin'/provider
        before=manager.inspect();old_bytes=binary.read_bytes();auth_bytes=user.read_bytes()
        updated,integrity,calls=fixture(home,provider,version='1.2.4')
        return updated,integrity,calls,before,binary,old_bytes,user,auth_bytes
    def preserved(self,provider,binary,old_bytes,user,auth_bytes):
        self.assertEqual(binary.read_bytes(),old_bytes);self.assertEqual(user.read_bytes(),auth_bytes)
        self.assertEqual(m.version_of(binary,provider),'1.2.3')
    def observe(self,case,manager,operation,events=None):
        status=manager.status(operation)
        print('ACK_OBSERVATION '+json.dumps({'case':case,'provider':manager.provider,
              'activeVersion':manager.inspect()['version'],'receipt':m.read_json(manager.root/'operations'/operation/'receipt.json')['state'],
              'status':status['state'],'events':events or []},sort_keys=True))
        return status
    def no_replay(self,manager,integrity,before,operation,expected_state=None,action='update',version='1.2.4'):
        fresh,_,calls=fixture(manager.home,manager.provider,version=version)
        def forbidden(*_):self.fail('ACK_AUTOMATIC_REINSTALL')
        fresh.downloader=forbidden;fresh.runner=forbidden
        invoke=lambda:fresh.run(action,version,integrity,before['installationRevision'],EXPIRY,operation)
        if expected_state is None:self.assert_code('RESULT_UNKNOWN',invoke)
        else:self.assertEqual(invoke()['state'],expected_state)
        self.assertEqual(calls,[])
    def double_failure(self,foreign=False):
        for provider in ['codex','claude']:
            with self.subTest(provider=provider):
                manager,integrity,calls,before,binary,old,user,auth=self.prepared(provider,foreign)
                with ack_storage_fault(manager,'b'*48,'pre') as events:
                    self.assert_code('RESULT_UNKNOWN',lambda:manager.run('install' if foreign else 'update','1.2.4',integrity,before['installationRevision'],EXPIRY,'b'*48))
                self.assertEqual([e['boundary'] for e in events],['completed-after-replace','failed-before-replace'])
                self.assertEqual(m.read_json(manager.root/'operations'/('b'*48)/'receipt.json')['state'],'completed')
                self.assertEqual(manager.inspect()['version'],'1.2.4','STALE_COMPLETED_WITH_ROLLED_BACK_CURRENT')
                self.preserved(provider,binary,old,user,auth);self.assertEqual(len(calls),1)
                self.assertEqual(self.observe('completed-postreplace-failed-precommit',manager,'b'*48,events)['state'],'completed')
                self.no_replay(manager,integrity,before,'b'*48,'completed',action='install' if foreign else 'update')
    def test_postreplace_completed_and_failed_precommit_keep_actual_effect_consistent(self):self.double_failure()
    def test_first_managed_postreplace_preserves_external_install_and_auth(self):self.double_failure(True)
    def test_completed_postreplace_failure_with_recorded_failure_restores_old_current(self):
        for provider in ['codex','claude']:
            with self.subTest(provider=provider):
                manager,integrity,calls,before,binary,old,user,auth=self.prepared(provider)
                with ack_storage_fault(manager,'b'*48) as events:
                    self.assert_code('INSTALL_FAILED',lambda:manager.run('update','1.2.4',integrity,before['installationRevision'],EXPIRY,'b'*48))
                self.assertEqual(manager.inspect(),before);self.preserved(provider,binary,old,user,auth)
                self.assertEqual(self.observe('completed-postreplace-rollback',manager,'b'*48,events)['state'],'failed')
                self.no_replay(manager,integrity,before,'b'*48);self.assertEqual(len(calls),1)
    def test_failed_receipt_postreplace_ack_failure_does_not_claim_rollback(self):
        for provider in ['codex','claude']:
            with self.subTest(provider=provider):
                manager,integrity,calls,before,binary,old,user,auth=self.prepared(provider)
                with ack_storage_fault(manager,'b'*48,'post') as events:
                    self.assert_code('RESULT_UNKNOWN',lambda:manager.run('update','1.2.4',integrity,before['installationRevision'],EXPIRY,'b'*48))
                self.assertEqual([e['boundary'] for e in events],['completed-after-replace','failed-after-replace'])
                self.assertEqual(manager.inspect()['version'],'1.2.4');self.preserved(provider,binary,old,user,auth)
                self.assertEqual(self.observe('failed-postreplace-ack-failure',manager,'b'*48,events)['state'],'failed')
                self.no_replay(manager,integrity,before,'b'*48);self.assertEqual(len(calls),1)
    def killed(self,mode):
        for provider in ['codex','claude']:
            with self.subTest(provider=provider):
                manager,integrity,calls,before,binary,old,user,auth=self.prepared(provider)
                ctx=multiprocessing.get_context('fork');ready=ctx.Event();gate=ctx.Event()
                process=ctx.Process(target=child_ack_boundary,args=(str(manager.home),provider,before['installationRevision'],before['active'],mode,ready,gate))
                try:
                    process.start();self.assertTrue(ready.wait(5),'ACK_BARRIER_NOT_REACHED');self.assertTrue(process.is_alive())
                    visible=m.read_json(manager.root/'operations'/('b'*48)/'receipt.json')['state']
                    active=manager.inspect()['version']
                    process.terminate();process.join(5);self.assertFalse(process.is_alive())
                    self.assertEqual(visible,'failed','STALE_COMPLETED_AT_ROLLBACK_KILL')
                    self.assertEqual(active,'1.2.3' if mode=='rollback' else '1.2.4')
                    self.preserved(provider,binary,old,user,auth)
                    self.assertEqual(self.observe(mode+'-worker-terminated',manager,'b'*48)['state'],'failed')
                    self.no_replay(manager,integrity,before,'b'*48);self.assertEqual(calls,[])
                finally:
                    if process.is_alive():process.terminate();process.join(5)
                    self.assertFalse(process.is_alive(),'ACK_OWNED_WORKER_NOT_REAPED')
    def test_worker_termination_immediately_after_rollback_has_no_stale_completion(self):self.killed('rollback')
    def test_worker_termination_after_failed_receipt_replace_preserves_effect(self):self.killed('failed-abort')
    def test_historic_completed_and_reused_survive_later_legitimate_updates(self):
        for provider in ['codex','claude']:
            with self.subTest(provider=provider):
                manager,integrity,calls,before,binary,old,user,auth=self.prepared(provider)
                manager.run('update','1.2.4',integrity,before['installationRevision'],EXPIRY,'b'*48)
                second=manager.inspect();self.assertEqual(manager.run('update','1.2.4',integrity,second['installationRevision'],EXPIRY,'c'*48)['state'],'reused')
                later,new_integrity,later_calls=fixture(manager.home,provider,version='1.2.5')
                later.run('update','1.2.5',new_integrity,second['installationRevision'],EXPIRY,'d'*48)
                self.assertEqual(later.inspect()['version'],'1.2.5')
                self.assertEqual(manager.status('a'*48)['state'],'completed')
                self.assertEqual(manager.status('b'*48)['state'],'completed');self.assertEqual(manager.status('c'*48)['state'],'reused')
                self.no_replay(manager,integrity,before,'b'*48,'completed')
                self.no_replay(manager,integrity,second,'c'*48,'reused')
                self.assertEqual(len(calls),1);self.assertEqual(len(later_calls),1);self.preserved(provider,binary,old,user,auth)
                self.observe('legitimate-superseded-history',manager,'b'*48)
    def test_foreign_reused_history_survives_later_managed_install(self):
        for provider in ['codex','claude']:
            with self.subTest(provider=provider):
                manager,integrity,calls,before,binary,old,user,auth=self.prepared(provider,True)
                existing,existing_integrity,existing_calls=fixture(manager.home,provider,version='1.2.3')
                self.assertEqual(existing.run('install','1.2.3',existing_integrity,before['installationRevision'],EXPIRY,'e'*48)['state'],'reused')
                manager.run('install','1.2.4',integrity,before['installationRevision'],EXPIRY,'b'*48)
                self.assertEqual(manager.inspect()['version'],'1.2.4');self.assertEqual(existing.status('e'*48)['state'],'reused')
                self.no_replay(existing,existing_integrity,before,'e'*48,'reused',action='install',version='1.2.3')
                self.assertEqual(len(calls),1);self.assertEqual(existing_calls,[]);self.preserved(provider,binary,old,user,auth)

if __name__=='__main__':unittest.main(verbosity=2)
