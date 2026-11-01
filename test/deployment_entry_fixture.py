"""격리 Linux 파일 시험용 도구. 실제 호스트의 제품 경로는 만들지 않는다."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile

SOURCE = Path(__file__).resolve().parents[1]
ROOT_LINUX = sys.platform == 'linux' and hasattr(os, 'geteuid') and os.geteuid() == 0
ROOT_REASON = '실제 root 소유권 시험은 격리 Linux root 작업에서 실행'


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, SOURCE / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def root_directory(test):
    # /tmp는 누구나 쓸 수 있으므로 제품의 조상 디렉터리 검사를 통과해서는 안 된다.
    temporary = tempfile.TemporaryDirectory(prefix='ssh-portal-entry-', dir='/root')
    test.addCleanup(temporary.cleanup)
    return Path(temporary.name)


def put(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    path.write_bytes(data)
    path.chmod(mode)
    return path
