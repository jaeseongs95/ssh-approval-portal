#!/usr/bin/env python3
"""TEST-only isolated byte-order mutation proof, preserving the candidate sources."""
import argparse
import datetime
import hashlib
import json
import pathlib
import shutil
import subprocess

FILES=['native/freerdp-input/agni.c','native/freerdp-input/agni.h','native/freerdp-input/test_agni.c']
ARGV=['sh','-c','./protocol-test; result=$?; exit "$result"']

def hashed(data):
    return 'sha256:'+hashlib.sha256(data).hexdigest()

def seal(value):
    value['digest']=hashed(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())
    return value

def snapshot(root):
    files=[]
    for name in sorted(FILES):
        raw=(root/name).read_bytes()
        files.append({'path':name,'digest':hashed(raw),'size':len(raw),'lineCount':raw.count(b'\n')})
    return seal({'schemaVersion':'1.0.0','kind':'engineering-snapshot','files':files})

def iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',required=True)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    repo=pathlib.Path(args.repo).resolve();out=pathlib.Path(args.output).resolve()
    out.mkdir(parents=True,exist_ok=False)
    compiler=['cc','-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-Wno-misleading-indentation',
              '-fsanitize=address,undefined','-fno-omit-frame-pointer','-Wl,--wrap=send',
              '-I','native/freerdp-input','native/freerdp-input/test_agni.c',
              'native/freerdp-input/agni.c','-o','protocol-test']
    receipts={}
    for label in ('red','green'):
        root=out/label;root.mkdir()
        for name in FILES:
            dest=root/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(repo/name,dest)
        if label=='red':
            target=root/FILES[0];text=target.read_text()
            old='p[0] = (uint8_t)(v >> 8);\n    p[1] = (uint8_t)v;'
            assert text.count(old)==1,'mutation anchor mismatch'
            target.write_text(text.replace(old,'p[1] = (uint8_t)(v >> 8);\n    p[0] = (uint8_t)v;',1))
        r=subprocess.run(compiler,cwd=root,capture_output=True,text=True,timeout=60)
        (out/(label+'-compile.log')).write_text(r.stdout+r.stderr)
        assert r.returncode==0,'compilation is not an assertion witness'
        before=snapshot(root);started=iso()
        r=subprocess.run(ARGV,cwd=root,capture_output=True,text=True,timeout=30)
        finished=iso();after=snapshot(root)
        assert before['digest']==after['digest']
        receipt=seal({'schemaVersion':'1.0.0','kind':'engineering-run-receipt','argv':ARGV,
            'snapshot':before,'afterDigest':after['digest'],'startedAt':started,'finishedAt':finished,
            'status':'PASS' if r.returncode==0 else 'FAIL','exitCode':r.returncode,'signal':None,
            'stdout':r.stdout,'stderr':r.stderr,'stdoutDigest':hashed(r.stdout.encode()),
            'stderrDigest':hashed(r.stderr.encode()),'timeoutMs':30000,'executable':'sh',
            'nodeVersion':'native-C11-GCC13','platform':'linux',
            'environmentNote':'TEST Ubuntu24.04 pinned Docker, ASan+UBSan, CPU1 RAM2GiB'})
        (out/(label+'.json')).write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
        receipts[label]=receipt
    assert receipts['red']['exitCode']!=0 and 'r32(hello + 8) == 88' in receipts['red']['stderr']
    assert receipts['green']['exitCode']==0
    plan=json.loads((repo/'native/freerdp-input/engineering-test-plan.json').read_text())
    proof={'schemaVersion':'1.0.0','kind':'engineering-test-proof',
        'planDigest':hashed(json.dumps(plan,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()),
        'candidate':receipts['green']['snapshot'],'proofs':[{'caseId':'AGNI-PROTOCOL-001',
            'status':'DEMONSTRATED','red':{'path':'native/freerdp-input/proof/red.json',
                 'digest':hashed((out/'red.json').read_bytes())},
            'green':{'path':'native/freerdp-input/proof/green.json',
                 'digest':hashed((out/'green.json').read_bytes())},
            'mutationPaths':[FILES[0]],'assertionWitness':'r32(hello + 8) == 88',
            'reason':'Native BE writer mutation fails the unchanged wire oracle; real Windows consumption remains a separate TEST.'}]}
    (out/'proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'redExit':receipts['red']['exitCode'],'greenExit':receipts['green']['exitCode'],
                     'testSha256':receipts['green']['snapshot']['files'][2]['digest']}))

if __name__=='__main__':main()
