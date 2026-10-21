"""Install a pinned official binary without changing global packages or services."""
import os
from pathlib import Path
import platform
import re
import sys
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

import cloudflare_connector as cc
from cloudflare_provision import ProvisionFailure

VERSION = '2026.10.1'
CACHE = Path('/opt/ssh-approval/cloudflared')
# Published GitHub release asset sizes/digests, not hashes of any credential.
ARTIFACTS = {
    'x86_64': ('amd64', 40227032, '3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586'),
    'aarch64': ('arm64', 37651992, '2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46'),
}


def allowed_url(url):
    if not isinstance(url, str) or len(url) > 16384 or any(ord(c) < 33 or ord(c) > 126 for c in url):
        return False
    try:
        parsed = urlsplit(url)
        parsed.port
    except ValueError:
        return False
    return (parsed.scheme == 'https' and parsed.port in [None, 443] and not parsed.username
            and not parsed.password and not parsed.fragment
            and (parsed.hostname == 'release-assets.githubusercontent.com'
                 or (parsed.hostname == 'github.com' and not parsed.query
                     and parsed.path in ['/cloudflare/cloudflared/releases/download/' + VERSION + '/cloudflared-linux-' + arch
                                         for arch in ['amd64', 'arm64']])))


class ReleaseRedirect(HTTPRedirectHandler):
    max_redirections = 3
    def redirect_request(self, request, response, code, message, headers, url):
        if not allowed_url(url):
            raise ValueError('Unexpected release redirect')
        return super().redirect_request(request, response, code, message, headers, url)


def download(url, output, size):
    try:
        if not allowed_url(url):
            raise ValueError()
        deadline = time.monotonic() + 60
        request = Request(url, headers={'User-Agent': 'ssh-approval-portal-installer'})
        # No API credentials, environment proxy, or credential-bearing request is reused.
        with build_opener(ProxyHandler({}), ReleaseRedirect()).open(request, timeout=15) as response:
            if response.status != 200 or (response.headers.get('Content-Length') is not None
                                          and int(response.headers['Content-Length']) != size):
                raise ValueError()
            total = 0
            while True:
                if time.monotonic() > deadline:
                    raise TimeoutError()
                block = response.read(min(65536, size-total+1))
                if not block:
                    break
                total += len(block)
                if total > size:
                    raise ValueError()
                output.write(block)
            if total != size:
                raise ValueError()
    except Exception:
        raise ProvisionFailure('CLOUDFLARED_DOWNLOAD_FAILED') from None


def public_directory(path):
    cc.trusted_path(path)
    try:
        path.mkdir(mode=0o755)
    except FileExistsError:
        pass
    else:
        path.chmod(0o755)
        cc.sync_parent(path)
    cc.trusted_path(path, directory=True)
    if any(not p.stat().st_mode & 0o001 for p in [path, *path.parents]):
        raise ProvisionFailure('PUBLIC_EXECUTABLE_PATH_REQUIRED')


def verified(path, size, sha):
    cc.binary_file(path)
    if path.stat().st_size != size or cc.digest(path.read_bytes()) != sha:
        raise ProvisionFailure('CLOUDFLARED_BINARY_CHANGED')
    return path


def ensure_installed():
    if not sys.platform.startswith('linux') or os.geteuid() != 0:
        raise ProvisionFailure('LINUX_ROOT_REQUIRED')
    try:
        arch, size, sha = ARTIFACTS[platform.machine()]
    except KeyError:
        raise ProvisionFailure('CLOUDFLARED_CPU_UNSUPPORTED') from None
    public_directory(CACHE.parent)
    public_directory(CACHE)
    target = CACHE/('cloudflared-' + VERSION + '-linux-' + arch)
    if os.path.lexists(target):
        return verified(target, size, sha)
    work = Path(tempfile.mkdtemp(prefix='.download-', dir=CACHE))
    candidate = work/'cloudflared'
    try:
        fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as output:
            download('https://github.com/cloudflare/cloudflared/releases/download/' + VERSION + '/cloudflared-linux-' + arch, output, size)
            output.flush()
            os.fsync(output.fileno())
        if candidate.stat().st_size != size or cc.digest(candidate.read_bytes()) != sha:
            raise ProvisionFailure('CLOUDFLARED_ARTIFACT_MISMATCH')
        candidate.chmod(0o755)
        result = cc.command([str(candidate), '--version'], capture=True)
        match = re.search(rb'cloudflared version (\d+\.\d+\.\d+)(?:\s|$)', result.stdout)
        if result.returncode or not match or match[1].decode('ascii') != VERSION:
            raise ProvisionFailure('CLOUDFLARED_VERSION_MISMATCH')
        with candidate.open('rb') as stream:
            os.fsync(stream.fileno())
        try:
            os.link(candidate, target)  # Exclusive publication; never replace an existing path.
        except FileExistsError:
            pass
        candidate.unlink()
        cc.sync_parent(target)
        return verified(target, size, sha)
    except OSError:
        raise ProvisionFailure('CLOUDFLARED_INSTALL_FAILED') from None
    finally:
        if candidate.exists() or candidate.is_symlink():
            candidate.unlink()
        work.rmdir()
        cc.sync_parent(work)
