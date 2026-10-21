#!/usr/bin/env python3
"""Install only new dedicated OIDC services; leave bridge ENV and private data intact."""
import argparse
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import secrets
import stat
import sys

import cloudflare_connector as files
from cloudflare_provision import ProvisionFailure

spec = importlib.util.spec_from_file_location('oidc_prepare', Path(__file__).with_name('prepare-oidc-proxy.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
UNITS = Path('/etc/systemd/system')
# Public upstream binary digests, independently checked before executing any binary.
BINARIES = {
    prepare.CADDY: (51953826, '678ade3bfc088749c81a681adc603333ee0bb023b6a6cfe3c0f58bef8ff854e9'),
    prepare.PROXY: (42811553, 'ed5063f5a655560048a594974210f1c9e4f539bbfe81a834addb6fc740f3309d'),
}


def private_read(path):
    return files.read_file(path, 0o600, 65536)[0]


def inspect(value):
    config, generated, plan = prepare.render(value)
    directory = Path(plan['directory'])
    files.trusted_path(directory, directory=True)
    if stat.S_IMODE(directory.stat().st_mode) != 0o700:
        raise ValueError('PRIVATE_PREPARATION_REQUIRED')
    observed = {}
    for name, data in generated.items():
        current, ident = files.read_file(directory/name, 0o600, 65536)
        if current != data:
            raise ValueError('PREPARED_CONFIGURATION_CHANGED')
        observed[name] = ident
    for name in ['client-secret', 'cookie-secret', 'owners']:
        data, observed[name] = files.read_file(directory/name, 0o600, 65536)
        if ((name == 'cookie-secret' and len(data) != 32)
                or (name == 'client-secret' and (not 16 <= len(data) <= 4096 or any(b < 33 or b > 126 for b in data)))
                or (name == 'owners' and data != ('\n'.join(config['owners'])+'\n').encode())):
            raise ValueError('PREPARED_CREDENTIAL_FORMAT_CHANGED')
    receipt = json.loads(private_read(directory/'bundle.json'))
    expected = {**plan, 'status':'PREPARED_NOT_INSTALLED',
                'files':{name:files.digest(data) for name,data in generated.items()}}
    if receipt != expected:
        raise ValueError('PREPARATION_RECEIPT_MISMATCH')
    return directory, generated, plan, observed


@contextlib.contextmanager
def locked():
    if not sys.platform.startswith('linux') or os.geteuid() != 0:
        raise ValueError('LINUX_ROOT_REQUIRED')
    import fcntl
    files.trusted_path(prepare.BASE, directory=True)
    path = prepare.BASE/'installation.lock'
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW, 0o600)
    else:
        os.fchmod(fd,0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('UNSAFE_INSTALLATION_LOCK')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def save(directory, state):
    destination = directory/'installation.json'
    if os.path.lexists(destination):
        private_read(destination)
    temporary = directory/('.installation-'+secrets.token_hex(12)+'.tmp')
    files.create_file(temporary, (json.dumps(state, sort_keys=True)+'\n').encode(), 0o600)
    os.replace(temporary, destination)
    files.sync_parent(destination)


def public_binary_directory(path):
    files.trusted_path(path)
    try:
        path.mkdir(mode=0o755)
    except FileExistsError:
        pass
    else:
        path.chmod(0o755)
        files.sync_parent(path)
    files.trusted_path(path, directory=True)
    if any(not parent.stat().st_mode & 0o001 for parent in [path, *path.parents]):
        raise ValueError('PUBLIC_BINARY_DIRECTORY_REQUIRED')


def binary(path, source=None):
    size, sha = BINARIES[str(path)]
    if not os.path.lexists(path):
        if source is None:
            raise ValueError('VERIFIED_BINARY_SOURCE_REQUIRED')
        files.trusted_path(source)
        data, _ = files.read_file(source, 0o755, 128*1024*1024)
        if len(data) != size or files.digest(data) != sha:
            raise ValueError('OFFICIAL_BINARY_MISMATCH')
        public_binary_directory(path.parent.parent)
        public_binary_directory(path.parent)
        files.create_file(path, data, 0o755)
    files.binary_file(path)
    data = path.read_bytes()
    if len(data) != size or files.digest(data) != sha:
        raise ValueError('OFFICIAL_BINARY_MISMATCH')


def record(path, data=None):
    info = path.lstat()
    result = {'device':info.st_dev, 'inode':info.st_ino, 'mode':stat.S_IMODE(info.st_mode)}
    if data is not None:
        result['sha256'] = files.digest(data)
    return result


def wanted(unit):
    return UNITS/'multi-user.target.wants'/unit


def verify_owned(state, generated):
    allowed = {str(UNITS/name):data for name,data in generated.items() if name.endswith('.service')}
    allowed.update({str(wanted(Path(name).name)):None for name in list(allowed)})
    if (not isinstance(state,dict) or set(state) != {'version','status','created'} or type(state['version']) is not int or state['version'] != 1
            or state['status'] not in ['INSTALLING','STARTING','ACTIVE','REMOVING','REMOVED','FAILED_REVIEW_REQUIRED']
            or not isinstance(state['created'],dict) or set(state['created']) - set(allowed)):
        raise ValueError('INVALID_INSTALLATION_RECORD')
    for name, entry in state['created'].items():
        path, expected = Path(name), allowed[name]
        if expected is None:
            if not path.is_symlink() or os.readlink(path) != str(UNITS/path.name) or record(path) != entry:
                raise ValueError('OWNED_START_LINK_CHANGED')
        else:
            data, _ = files.read_file(path, 0o644, 65536)
            if data != expected or record(path,data) != entry:
                raise ValueError('OWNED_SERVICE_UNIT_CHANGED')


def service_guard(unit, allow_missing=False):
    fragment = files.system_value(unit,'FragmentPath')
    missing = files.system_value(unit,'LoadState') == 'not-found'
    if files.system_value(unit,'DropInPaths') or not (fragment == str(UNITS/unit) or allow_missing and missing and not fragment):
        raise ValueError('SERVICE_UNIT_OVERRIDDEN')


def cleanup(directory, generated, state):
    verify_owned(state,generated)
    units = [name for name in generated if name.endswith('.service') and str(UNITS/name) in state['created']]
    # Stop HTTPS before its upstream. Never stop an unowned pre-existing service.
    units.sort(key=lambda name: not name.endswith('-caddy.service'))
    for unit in units:
        service_guard(unit,allow_missing=True)
    state['status'] = 'REMOVING'
    save(directory,state)
    for unit in units:
        if files.system_value(unit,'LoadState') != 'not-found':
            files.checked([files.SYSTEMCTL,'stop',unit])
            if files.system_value(unit,'ActiveState') not in ['inactive','failed'] or files.system_value(unit,'MainPID') != '0':
                raise ValueError('OWNED_SERVICE_NOT_STOPPED')
    verify_owned(state,generated)
    for path in sorted(state['created'],key=lambda name: name.endswith('.service') and '/multi-user.target.wants/' not in name):
        Path(path).unlink()
        files.sync_parent(Path(path))
        del state['created'][path]
        save(directory,state)
    files.checked([files.SYSTEMCTL,'daemon-reload'])
    if any(os.path.lexists(path) for name in generated if name.endswith('.service')
           for path in [UNITS/name,wanted(name)]):
        raise ValueError('UNRECORDED_SERVICE_FILES_REQUIRE_REVIEW')
    state['status'] = 'REMOVED'
    save(directory,state)
    return {'status':'SERVICES_REMOVED', 'bridgeEnvironmentChanged':False, 'privateDataAndCertificatesPreserved':True,
            'versionCachePreserved':True, 'loginVerified':False}


def install(value, sources=None):
    with locked():
        directory, generated, plan, prepared = inspect(value)
        if platform.machine() != 'x86_64':
            raise ValueError('PINNED_LINUX_AMD64_REQUIRED')
        files.trusted_path(UNITS,directory=True)
        unit_names = [name for name in generated if name.endswith('.service')]
        if os.path.lexists(directory/'installation.json'):
            raise ValueError('INSTALLATION_RECORD_ALREADY_EXISTS')
        for unit in unit_names:
            if (os.path.lexists(UNITS/unit) or os.path.lexists(wanted(unit))
                    or files.system_value(unit,'LoadState') != 'not-found'
                    or files.system_value(unit,'DropInPaths')):
                raise ValueError('SERVICE_ALREADY_EXISTS')
        for target in BINARIES:
            binary(Path(target),(sources or {}).get(target))
        state = {'version':1,'status':'INSTALLING','created':{}}
        save(directory,state)
        try:
            for unit in unit_names:
                files.create_file(UNITS/unit,generated[unit],0o644)
                state['created'][str(UNITS/unit)] = record(UNITS/unit,generated[unit])
                save(directory,state)
            files.checked([files.SYSTEMCTL,'daemon-reload'])
            for unit in unit_names:
                service_guard(unit)
            if inspect(value)[3] != prepared:
                raise ValueError('PREPARED_FILES_CHANGED_DURING_INSTALL')
            state['status'] = 'STARTING'
            save(directory,state)
            for unit in unit_names:
                files.checked([files.SYSTEMCTL,'start',unit])
                if files.system_value(unit,'ActiveState') != 'active':
                    raise ValueError('SERVICE_NOT_ACTIVE')
            public_binary_directory(UNITS/'multi-user.target.wants')
            for unit in unit_names:
                os.symlink(str(UNITS/unit),wanted(unit))
                state['created'][str(wanted(unit))] = record(wanted(unit))
                files.sync_parent(wanted(unit))
                save(directory,state)
            files.checked([files.SYSTEMCTL,'daemon-reload'])
            state['status'] = 'ACTIVE'
            save(directory,state)
        except BaseException:
            try:
                cleanup(directory,generated,state)
            except BaseException:
                state['status'] = 'FAILED_REVIEW_REQUIRED'
                save(directory,state)
            raise
        return {'status':'SERVICES_ACTIVE_LOGIN_UNVERIFIED','units':plan['units'], 'bridgeEnvironmentChanged':False,
                'publicCertificateVerified':False,'loginVerified':False}


def remove(value):
    with locked():
        directory, generated, _, _ = inspect(value)
        state = json.loads(private_read(directory/'installation.json'))
        return cleanup(directory,generated,state)


def main(argv=None):
    parser = argparse.ArgumentParser(description='전용 OIDC 서비스 설치·제거. 기존 ENV와 비밀·인증서는 보존합니다.')
    parser.add_argument('--config',required=True,type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--install',action='store_true')
    mode.add_argument('--remove',action='store_true')
    parser.add_argument('--caddy-binary',type=Path)
    parser.add_argument('--proxy-binary',type=Path)
    options = parser.parse_args(argv)
    mutating = options.install or options.remove
    if mutating and (not sys.platform.startswith('linux') or os.geteuid() != 0):
        raise ValueError('LINUX_ROOT_REQUIRED')
    value = prepare.read_config(options.config,privileged=mutating)
    if options.install:
        sources = {prepare.CADDY:options.caddy_binary,prepare.PROXY:options.proxy_binary}
        result = install(value,sources)
    elif options.remove:
        result = remove(value)
    else:
        result = {**prepare.render(value)[2], 'status':'INSTALLATION_PLAN', 'supportedPlatform':'Linux amd64',
                  'servicesWillUsePublicPorts':[80,443]}
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, ProvisionFailure, EOFError, KeyboardInterrupt):
        print('OIDC 서비스 작업을 완료하지 못했습니다. 보호된 설치 기록과 서비스 상태를 확인하세요. 반복 설치하지 마세요.',file=sys.stderr)
        sys.exit(1)
