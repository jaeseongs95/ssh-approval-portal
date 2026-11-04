#!/usr/bin/env python3
"""TEST/Cloud Linux private build; never installs to the host. See native README."""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import platform
import shutil
import subprocess
import tarfile
import urllib.request

PIN = 'bf217a504e54cc719880c228e82353382cd7d4fa'
ARCHIVE_SHA = '4a25a61f2e81f8d8832634c6d457edc1b48fc76630cf58c06695a27afdbbecca'
IMAGE = 'ubuntu@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852'

def sha(path):
    return hashlib.file_digest(open(path,'rb'),'sha256').hexdigest()

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output',required=True)
    ap.add_argument('--archive',help='Optional exact pinned archive (still hash checked)')
    args=ap.parse_args()
    if platform.system()!='Linux':
        ap.error('Build and protocol tests require the approved Linux TEST/Cloud environment')
    out=pathlib.Path(args.output).resolve()
    out.mkdir(parents=True,exist_ok=False)
    repo=pathlib.Path(__file__).resolve().parent.parent
    overlay=repo/'native/freerdp-input'
    def run(argv,log,timeout=900,**kw):
        with (out/log).open('wb') as f:
            r=subprocess.run([str(x) for x in argv],stdout=f,stderr=subprocess.STDOUT,timeout=timeout,**kw)
        if r.returncode: raise RuntimeError(f'{log}: exit {r.returncode}')
    archive=out/'upstream.tar.gz'
    if args.archive: shutil.copyfile(args.archive,archive)
    else: urllib.request.urlretrieve('https://codeload.github.com/FreeRDP/FreeRDP/tar.gz/'+PIN,archive)
    if sha(archive)!=ARCHIVE_SHA: raise RuntimeError('upstream archive hash mismatch')
    with tarfile.open(archive) as tf: tf.extractall(out,filter='data')
    source=out/('FreeRDP-'+PIN)
    spec=importlib.util.spec_from_file_location('apply_agni',overlay/'apply_patch.py')
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    digest=mod.apply(source,out/'freerdp-input.patch')
    build=out/'build'
    options=['-DCMAKE_BUILD_TYPE=Release','-DCMAKE_INSTALL_PREFIX=/private',
       '-DCMAKE_INSTALL_LIBDIR=lib','-DCMAKE_INSTALL_RPATH=$ORIGIN/../lib;$ORIGIN',
       '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON','-DBUILD_SHARED_LIBS=ON',
       '-DWITH_X11=ON','-DWITH_CLIENT_SDL=OFF','-DWITH_WAYLAND=OFF',
       '-DWITH_SERVER=OFF','-DWITH_SAMPLE=OFF','-DBUILD_TESTING=OFF',
       '-DWITH_FFMPEG=OFF','-DWITH_SWSCALE=OFF','-DWITH_OPENH264=OFF',
       '-DWITH_ALSA=OFF','-DWITH_PULSE=OFF','-DWITH_CUPS=OFF','-DWITH_PCSC=OFF',
       '-DWITH_FUSE=OFF','-DWITH_JPEG=ON','-DWITH_KRB5=OFF','-DWITH_PKCS11=OFF',
       '-DWITH_GSSAPI=OFF','-DWITH_SMARTCARD_EMULATE=OFF','-DWITH_URBDRC=OFF',
       '-DWITH_MANPAGES=OFF','-DWITH_WINPR_TOOLS=OFF','-DWITH_AAD=OFF',
       '-DWITH_CHANNELS=ON','-DWITH_CLIENT_CHANNELS=ON','-DWITH_SERVER_CHANNELS=OFF',
       '-DCHANNEL_URBDRC=OFF','-DCHANNEL_TSMF=OFF','-DWITH_CLANG_FORMAT=OFF',
       '-DWITH_SSE2=ON','-DWITH_NATIVE_SSPI=OFF']
    run(['cmake','-S',source,'-B',build,'-G','Ninja']+options,'configure.log',180)
    run(['cmake','--build',build,'--parallel','1','--target','xfreerdp'],'compile.log',900)
    # Tests use the exact engine compiled into the client, no RDP/credentials required.
    test_binary=out/'agni-test'
    run(['cc','-std=c11','-O1','-g','-Wall','-Wextra','-Werror',
         '-Wno-misleading-indentation','-fsanitize=address,undefined',
         '-fno-omit-frame-pointer','-Wl,--wrap=send','-I',overlay,overlay/'test_agni.c',overlay/'agni.c','-o',test_binary],
        'protocol-compile.log',60)
    run([test_binary],'protocol-test.log',30)
    runtime=out/'runtime';(runtime/'bin').mkdir(parents=True);(runtime/'lib').mkdir()
    executable=runtime/'bin/xfreerdp3'
    shutil.copyfile(build/'client/X11/xfreerdp',executable);executable.chmod(0o755)
    # Carry only the three privately built library families, including SONAME aliases.
    for family in ('libfreerdp3.so*','libfreerdp-client3.so*','libwinpr3.so*'):
        found=list(build.rglob(family))
        if not found:raise RuntimeError('missing private runtime library '+family)
        for lib in found:
            target=runtime/'lib'/lib.name
            if target.exists() and sha(target)!=sha(lib):raise RuntimeError('library collision')
            shutil.copyfile(lib,target);target.chmod(0o644)
    run([executable,'/ags-input-capabilities'],'capabilities.json',10,env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent'})
    capabilities=json.loads((out/'capabilities.json').read_text())
    if capabilities!={'protocol':'ags-native-input/1','upstreamCommit':PIN,'patchDigest':digest}:raise RuntimeError('capability mismatch')
    run(['ldd',executable],'ldd.txt',10)
    linked=(out/'ldd.txt').read_text()
    if 'not found' in linked:raise RuntimeError('missing runtime library')
    for name in ('libfreerdp3.so.3','libfreerdp-client3.so.3','libwinpr3.so.3'):
        line=next((line for line in linked.splitlines() if line.strip().startswith(name+' => ')),'')
        linked_path=line.split(' => ',1)[-1].split(' (',1)[0]
        if pathlib.Path(linked_path).resolve()!=(runtime/'lib'/name).resolve():raise RuntimeError('private RPATH not used: '+name)
    run(['readelf','-d',executable],'readelf.txt',10)
    (runtime/'licenses').mkdir()
    shutil.copyfile(source/'LICENSE',runtime/'licenses/FreeRDP-LICENSE')
    if (source/'NOTICE').exists():shutil.copyfile(source/'NOTICE',runtime/'licenses/FreeRDP-NOTICE')
    files=[]
    for p in sorted(runtime.rglob('*')):
        if p.is_symlink():raise RuntimeError('symlink in bundle')
        if p.is_file():files.append({'path':p.relative_to(runtime).as_posix(),'size':p.stat().st_size,'sha256':sha(p),'mode':p.stat().st_mode&0o777})
    manifest={'format':'portal.freerdp-native.v1','upstreamVersion':'3.32.1','upstreamCommit':PIN,
       'patchSha256':digest,'executable':'bin/xfreerdp3','files':files}
    (runtime/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    notices=out/'source';notices.mkdir()
    shutil.copyfile(out/'freerdp-input.patch',notices/'freerdp-input.patch')
    shutil.copyfile(archive,notices/'upstream.tar.gz')
    shutil.copyfile(source/'LICENSE',notices/'LICENSE-FreeRDP')
    if (source/'NOTICE').exists():shutil.copyfile(source/'NOTICE',notices/'NOTICE-FreeRDP')
    shutil.copyfile(__file__,notices/'build-freerdp-input.py')
    shutil.copytree(overlay,notices/'overlay',ignore=shutil.ignore_patterns('__pycache__'))
    (notices/'build.json').write_text(json.dumps({'upstreamArchiveSha256':ARCHIVE_SHA,'baseImage':IMAGE,
        'options':options,'command':['cmake','--build','build','--parallel','1','--target','xfreerdp'],
        'host':platform.platform(),'architecture':platform.machine()},indent=2)+'\n')
    shutil.copyfile(build/'CMakeCache.txt',notices/'CMakeCache.txt')
    run(['cc','--version'],'compiler.txt',10)
    run(['dpkg-query','-W'],'build-packages.txt',10)
    for log in ('compiler.txt','build-packages.txt','ldd.txt','readelf.txt','capabilities.json','protocol-test.log'):
        shutil.copyfile(out/log,notices/log)
    with tarfile.open(out/'freerdp-input-v1-linux-x64.tgz','w:gz',dereference=True) as tf:
        tf.add(runtime,arcname='runtime');tf.add(notices,arcname='source')
    print(json.dumps({'patchSha256':digest,'executableSha256':sha(executable),
        'bundleSha256':sha(out/'freerdp-input-v1-linux-x64.tgz'),'protocolTests':'passed'}))

if __name__=='__main__':main()
