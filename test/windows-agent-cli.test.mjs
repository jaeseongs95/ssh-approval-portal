import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareAgentCliPlan,validateAgentCliPlan,prepareAgentCliStatus,projectAgentCliResult} from '../src/adapters/ssh/agent-cli.mjs';
import {validateAgentRelease} from '../src/domain/agent-cli.mjs';

const binding={targetId:'windows',targetRevision:'a'.repeat(64),profile:'windows-read',platform:'windows'};
const release=validateAgentRelease('codex',{name:'@openai/codex',version:'1.2.3',dist:{tarball:'https://registry.npmjs.org/@openai/codex/-/codex-1.2.3.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')}});
const install=()=>prepareAgentCliPlan({action:'install',provider:'codex',binding,release,expectedInstallationRevision:'b'.repeat(64),expiresAt:1900000000000,operationId:'c'.repeat(48)});

test('CLI 의도 해시는 expected를 expires 앞에 둔 고정 JSON과 LF에 결속된다',()=>{
 const canonical='{"action":"install","expected":"'+ 'b'.repeat(64)+'","expires":1900000000000,"integrity":"'+release.integrity+'","provider":"codex","version":"1.2.3"}\n';
 assert.equal(install().agentCli.intentDigest,createHash('sha256').update(canonical).digest('hex'));
});

test('Windows 고정 CLI 계획은 Python 없이 전체 인수와 소스에 결속된다',()=>{
 const plan=install();
 assert.equal(plan.manifest.contract,'agent-cli-powershell-v1');
 assert.equal(plan.manifest.cwd,'C:/');
 assert.match(plan.command,/^powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden /);
 assert.equal(validateAgentCliPlan(plan).planDigest,plan.planDigest);
 for(const change of [{stdin:plan.stdin+'\n'},{command:plan.command+' '},{manifest:{...plan.manifest,profile:'other'}},{agentCli:{...plan.agentCli,platform:'linux'}}])assert.throws(()=>validateAgentCliPlan({...plan,...change}));
});
test('Windows 로그인 진단도 고정 helper와 7개 인수만 허용한다',()=>{
 const plan=prepareAgentCliPlan({action:'login-status',provider:'claude',binding});
 assert.deepEqual(JSON.parse(plan.manifest.argvJson),['login-status','claude','','','','','']);
 assert.equal(validateAgentCliPlan(plan).planDigest,plan.planDigest);
});
test('Windows CLI의 모든 계획은 원문·수신기 해시와 시작 명령 상한에 결속된다',()=>{
 for(const provider of ['codex','claude'])for(const action of ['inspect','login-status','install','update','status']){
  const name=provider==='codex'?'@openai/codex':'@anthropic-ai/claude-code';
  const pinned=validateAgentRelease(provider,{name,version:'999999.999999.999999',dist:{tarball:'https://registry.npmjs.org/'+name+'/-/'+name.split('/')[1]+'-999999.999999.999999.tgz',integrity:release.integrity}});
  const options=['install','update'].includes(action)?{release:pinned,expectedInstallationRevision:'b'.repeat(64),expiresAt:Number.MAX_SAFE_INTEGER,operationId:'c'.repeat(48)}:action==='status'?{operationId:'c'.repeat(48),expectedIntentDigest:'d'.repeat(64)}:{};
  const plan=prepareAgentCliPlan({action,provider,binding,...options});
  assert.ok(plan.command.length<=8000);
  const receiver=Buffer.from(plan.args.at(-1),'base64').toString('utf16le');
  assert.equal(createHash('sha256').update(receiver).digest('hex'),plan.manifest.receiverSha256);
  assert.equal(createHash('sha256').update(plan.stdin).digest('hex'),plan.manifest.sourceSha256);
  assert.equal(Buffer.byteLength(plan.stdin),plan.manifest.sourceBytes);
  assert.equal(validateAgentCliPlan(plan).planDigest,plan.planDigest);
  assert.throws(()=>validateAgentCliPlan({...plan,manifest:{...plan.manifest,receiverSha256:'0'.repeat(64)}}));
 }
});
test('Windows 응답 유실 뒤에는 기존 intent의 읽기 전용 상태 계획을 만든다',()=>{
 const plan=install();
 const operation={agentCliContract:plan.agentCli.contract,agentCliTargetId:binding.targetId,agentCliTargetRevision:binding.targetRevision,agentCliProfile:binding.profile,agentCliAction:'install',agentCliProvider:'codex',agentCliOperationId:plan.agentCli.operationId,sourceContract:plan.manifest.contract,sourceElevate:false,sourceCwd:plan.manifest.cwd,sourceArgvJson:plan.manifest.argvJson};
 const status=prepareAgentCliStatus(operation,binding);
 assert.equal(status.agentCli.action,'status');
 assert.equal(status.agentCli.intentDigest,plan.agentCli.intentDigest);
 assert.equal(validateAgentCliPlan(status).planDigest,status.planDigest);
 assert.throws(()=>prepareAgentCliStatus({...operation,sourceContract:'python-source-v1'},binding));
});
test('Windows 외부 실행 파일 경로를 투영하고 UNC/상대경로/비밀 출력은 거부한다',()=>{
 const plan=prepareAgentCliPlan({action:'inspect',provider:'codex',binding});
 const value={provider:'codex',installed:true,managed:false,version:'1.2.3',active:'C:/Users/test/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js',login:'not_checked',installationRevision:'a'.repeat(64)};
 const result=active=>projectAgentCliResult({exitCode:0,stdout:JSON.stringify({...value,active}),stderr:''},plan);
 assert.equal(result(value.active).data.agentCli.active,value.active);
 for(const invalid of ['//server/share/codex.exe','codex.exe','C:/bad\n/codex.exe','C:/path/run.cmd'])assert.throws(()=>result(invalid));
 assert.throws(()=>projectAgentCliResult({exitCode:0,stdout:JSON.stringify(value),stderr:'token'},plan));
});
