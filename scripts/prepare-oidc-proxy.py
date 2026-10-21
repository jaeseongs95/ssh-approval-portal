#!/usr/bin/env python3
"""Prepare private native OIDC inputs; never install or start services."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import sys
import warnings
from urllib.parse import urlsplit

SOURCE = Path(__file__).resolve().parents[1]
BASE = Path('/var/lib/ssh-portal-oidc')
CADDY = '/opt/ssh-approval/oidc/caddy-2.11.7'
PROXY = '/opt/ssh-approval/oidc/oauth2-proxy-7.15.5'


def host(value):
    if (not isinstance(value, str) or not 3 <= len(value) <= 253 or '.' not in value
            or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part) for part in value.split('.'))
            or value.endswith(('.localhost', '.local')) or re.fullmatch(r'[0-9.]+', value)):
        raise ValueError('INVALID_PUBLIC_HOST')
    return value


def validate(value):
    required = {'name', 'adminHostname', 'mcpHostname', 'issuer', 'clientId', 'owners'}
    optional = {'adminPort', 'mcpPort', 'proxyPort'}
    if not isinstance(value, dict) or set(value) - required - optional or required - set(value):
        raise ValueError('INVALID_PUBLIC_CONFIGURATION')
    name = value['name']
    if not isinstance(name, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,23}', name):
        raise ValueError('INVALID_INSTANCE_NAME')
    admin, mcp = host(value['adminHostname']), host(value['mcpHostname'])
    if admin == mcp:
        raise ValueError('DISTINCT_PUBLIC_HOSTS_REQUIRED')
    issuer = value['issuer']
    if not isinstance(issuer, str) or len(issuer) > 2048 or not issuer.isascii() or any(ord(c) < 33 for c in issuer):
        raise ValueError('INVALID_ISSUER')
    parsed = urlsplit(issuer)
    if (parsed.scheme != 'https' or parsed.netloc != parsed.hostname or parsed.query or parsed.fragment
            or not re.fullmatch(r'(?:/[A-Za-z0-9._~!$&()*+,;=:@%-]*)?', parsed.path)):
        raise ValueError('INVALID_ISSUER')
    host(parsed.hostname)
    client = value['clientId']
    if not isinstance(client, str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,512}', client):
        raise ValueError('INVALID_CLIENT_ID')
    owners = value['owners']
    if not isinstance(owners, list) or not 1 <= len(owners) <= 32:
        raise ValueError('EXACT_OWNERS_REQUIRED')
    normalized = []
    for owner in owners:
        if (not isinstance(owner, str) or len(owner) > 254 or owner.count('@') != 1
                or not re.fullmatch(r"[A-Za-z0-9.!#$%&'+/=?^_`{|}~-]+@[a-z0-9.-]+", owner)):
            raise ValueError('INVALID_OWNER')
        host(owner.split('@')[1])
        normalized.append(owner.lower())
    if len(set(normalized)) != len(normalized):
        raise ValueError('DUPLICATE_OWNER')
    ports = {key:value.get(key, default) for key, default in [('adminPort',39125), ('mcpPort',39124), ('proxyPort',4180)]}
    if any(type(port) is not int or not 1024 <= port <= 65535 for port in ports.values()) or len(set(ports.values())) != 3:
        raise ValueError('DISTINCT_UNPRIVILEGED_PORTS_REQUIRED')
    return {**value, 'owners':normalized, **ports}


def render(value):
    config = validate(value)
    name = 'ssh-portal-oidc-' + config['name']
    proxy_unit, caddy_unit = name+'-proxy.service', name+'-caddy.service'
    credentials = '/run/credentials/' + proxy_unit + '/'
    destination = PurePosixPath(BASE.as_posix())/config['name']
    proxy = (SOURCE/'deploy/oidc/oauth2-proxy.cfg').read_text(encoding='utf-8')
    replacements = {'https://idp.example.com/realms/portal':config['issuer'], 'portal-client':config['clientId'],
                    'https://approve.example.com':'https://'+config['adminHostname'],
                    '/etc/ssh-portal-oidc/client-secret':credentials+'client-secret',
                    '/etc/ssh-portal-oidc/cookie-secret':credentials+'cookie-secret',
                    '/etc/ssh-portal-oidc/owners':credentials+'owners',
                    '127.0.0.1:4180':'127.0.0.1:'+str(config['proxyPort']),
                    '127.0.0.1:39125':'127.0.0.1:'+str(config['adminPort'])}
    for old in replacements:
        if proxy.count(old) != 1:
            raise ValueError('PROXY_TEMPLATE_CHANGED')
    # Match only the original template, never placeholder-like text inside an input value.
    proxy = re.sub('|'.join(re.escape(old) for old in replacements), lambda match:replacements[match[0]], proxy)
    caddy = ('{\n    admin off\n    servers {\n        protocols h1 h2\n    }\n}\n'
             +config['adminHostname']+' {\n    reverse_proxy 127.0.0.1:'+str(config['proxyPort'])+'\n}\n'
             +config['mcpHostname']+' {\n    reverse_proxy 127.0.0.1:'+str(config['mcpPort'])+'\n}\n')
    common = ('Restart=on-failure\nRestartSec=5\nUMask=0077\nDynamicUser=yes\nNoNewPrivileges=yes\n'
              'PrivateTmp=yes\nProtectHome=yes\nProtectSystem=strict\nProtectKernelTunables=yes\n'
              'ProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\n'
              'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX\nStandardOutput=null\nStandardError=null\n'
              '\n[Install]\nWantedBy=multi-user.target\n')
    unit_header = '[Unit]\nDescription=SSH Portal dedicated OIDC proxy\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\n'
    proxy_text = unit_header+'Type=simple\n'
    for credential, path in [('config','proxy.cfg'), ('client-secret','client-secret'), ('cookie-secret','cookie-secret'), ('owners','owners')]:
        proxy_text += 'LoadCredential='+credential+':'+str(destination/path)+'\n'
    proxy_text += 'ExecStart='+PROXY+' --config=${CREDENTIALS_DIRECTORY}/config\n'+common
    state = name+'-caddy'
    caddy_text = (unit_header.replace('OIDC proxy', 'OIDC HTTPS')+'Type=notify\n'
                  +'LoadCredential=Caddyfile:'+str(destination/'Caddyfile')+'\n'
                  +'ExecStart='+CADDY+' run --config ${CREDENTIALS_DIRECTORY}/Caddyfile --adapter caddyfile\n'
                  +'StateDirectory='+state+'\nStateDirectoryMode=0700\n'
                  +'Environment=XDG_DATA_HOME=/var/lib/'+state+' XDG_CONFIG_HOME=/var/lib/'+state+'\n'
                  +'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n'+common)
    files = {'proxy.cfg':proxy.encode(), 'Caddyfile':caddy.encode(), proxy_unit:proxy_text.encode(), caddy_unit:caddy_text.encode()}
    plan = {'status':'PREPARATION_PLAN', 'directory':str(destination), 'callback':'https://'+config['adminHostname']+'/oauth2/callback',
            'units':[proxy_unit,caddy_unit], 'ownerCount':len(config['owners']), 'servicesInstalled':False,
            'servicesStarted':False, 'networkUsed':False, 'bridgeEnvironmentChanged':False}
    return config, files, plan


def trusted_directory(path):
    if not path.is_absolute():
        raise ValueError('ROOT_OWNED_PRIVATE_PATH_REQUIRED')
    for directory in [*reversed(path.parents), path]:
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('ROOT_OWNED_PRIVATE_PATH_REQUIRED')


def write_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    owned = os.fstat(fd)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as output:
            os.fchmod(fd, 0o600)
            output.write(data)
            output.flush()
            os.fsync(fd)
    except BaseException:
        try:
            current = path.lstat()
            if stat.S_ISREG(current.st_mode) and (current.st_dev,current.st_ino) == (owned.st_dev,owned.st_ino) and current.st_nlink == 1:
                path.unlink()  # Only this call's newly and exclusively created file.
        except OSError:
            pass
        raise
    finally:
        os.close(fd)


def prepare(value, secret_reader=getpass.getpass):
    config, files, plan = render(value)
    if not sys.platform.startswith('linux') or os.geteuid() != 0:
        raise ValueError('LINUX_ROOT_REQUIRED')
    trusted_directory(BASE.parent)
    if os.path.lexists(BASE):
        trusted_directory(BASE)
        if stat.S_IMODE(BASE.stat().st_mode) != 0o700:
            raise ValueError('PRIVATE_BASE_MODE_REQUIRED')
    destination = Path(plan['directory'])
    if os.path.lexists(destination):
        raise ValueError('PREPARATION_PATH_ALREADY_EXISTS')
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        try:
            secret = secret_reader('기존 OAuth client secret (숨김 입력): ')
            confirmation = secret_reader('동일한 client secret 재입력 (숨김 입력): ')
        except getpass.GetPassWarning:
            raise ValueError('ECHO_FREE_INPUT_REQUIRED') from None
    if (secret != confirmation or not isinstance(secret, str) or not 16 <= len(secret) <= 4096
            or not secret.isascii() or any(ord(c) < 33 or ord(c) > 126 for c in secret)):
        raise ValueError('INVALID_OR_MISMATCHED_CLIENT_SECRET')
    # No credential is placed in argv, process environment, or the public receipt.
    private = {'client-secret':secret.encode('ascii'), 'cookie-secret':secrets.token_bytes(32),
               'owners':('\n'.join(config['owners'])+'\n').encode('utf-8')}
    if not BASE.exists():
        BASE.mkdir(mode=0o700)
        BASE.chmod(0o700)
    trusted_directory(BASE)
    destination.mkdir(mode=0o700)
    destination.chmod(0o700)
    try:
        for name, data in {**files, **private}.items():
            write_new(destination/name, data)
        receipt = {**plan, 'status':'PREPARED_NOT_INSTALLED',
                   'files':{name:hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        directory_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        # Publish the receipt only after the prepared entries have been synchronized.
        write_new(destination/'bundle.json', (json.dumps(receipt, indent=2)+'\n').encode())
    except OSError:
        # Preserve this new private partial directory for inspection; never claim it is ready.
        raise ValueError('PREPARATION_INCOMPLETE_PRIVATE_DIRECTORY_RETAINED') from None
    return receipt


def read_config(path, privileged=False):
    if privileged:
        trusted_directory(path.parent)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65536
                or (privileged and (info.st_uid != 0 or info.st_mode & 0o022))):
            raise ValueError('UNSAFE_PUBLIC_CONFIGURATION')
        raw = source.read(65537)
    if len(raw) > 65536:
        raise ValueError('PUBLIC_CONFIGURATION_LIMIT')
    return json.loads(raw)


def main(argv=None):
    parser = argparse.ArgumentParser(description='OIDC 서비스 설정 전용 준비: 설치·재시작하지 않습니다.')
    parser.add_argument('--config', required=True, type=Path, help='비밀값 없는 공개 JSON 설정')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--prepare', action='store_true', help='Linux root에서 새 private bundle 준비')
    mode.add_argument('--dry-run', action='store_true', help='기본값: 입력 검증·공개 계획만 표시')
    options = parser.parse_args(argv)
    if options.prepare and (not sys.platform.startswith('linux') or os.geteuid() != 0 or not sys.stdin.isatty()):
        raise ValueError('LINUX_ROOT_INTERACTIVE_TERMINAL_REQUIRED')
    value = read_config(options.config, options.prepare)
    result = prepare(value) if options.prepare else render(value)[2]
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, EOFError, KeyboardInterrupt):
        print('OIDC 준비를 완료하지 못했습니다. 설정·권한·전용 경로를 확인하세요. 비밀값은 출력하지 않습니다.', file=sys.stderr)
        sys.exit(1)
