import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium,firefox,webkit} from 'playwright';

const requested=process.argv[2]??'all',names=requested==='all'?['chromium','firefox','webkit']:[requested];
if(names.some(n=>!['chromium','firefox','webkit'].includes(n)))throw Error('Usage: node test/browser/run.mjs [all|chromium|firefox|webkit]');
const root=fileURLToPath(new URL('../../',import.meta.url)),results=[];
const count=(text,key)=>Number(text.match(new RegExp('(?:^|\\n)(?:#|ℹ) '+key+' (\\d+)'))?.[1]??0);
for(const name of names){
 const startedAt=new Date().toISOString();let version=null,executable=null;
 try{const engine={chromium,firefox,webkit}[name];executable=name==='chromium'&&process.env.SOLID_CHROMIUM_PATH?process.env.SOLID_CHROMIUM_PATH:engine.executablePath();const probe=await engine.launch({headless:true,executablePath:executable});try{version=probe.version();}finally{await probe.close();}}
 catch(error){const result={engine:name,status:'SPAWN_ERROR',startedAt,error:error.message};results.push(result);console.error(JSON.stringify(result));continue;}
 const screenshotDir=process.env.UI_TEST_RESULTS?process.env.UI_TEST_RESULTS+'/'+name+'/screenshots':null;
 if(screenshotDir)await mkdir(screenshotDir,{recursive:true});
 console.log('Browser engine: '+name+' '+version);
 const result=spawnSync(process.execPath,['--test','test/browser/*.test.mjs'],{cwd:root,encoding:'utf8',env:{...process.env,UI_TEST_BROWSER:name,...(screenshotDir?{UI_SCREENSHOTS:screenshotDir,POLICY_UX_SCREENSHOTS:screenshotDir,FOLLOWUP_SCREENSHOTS:screenshotDir}:{})},timeout:300000,maxBuffer:16*1024*1024});
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 const receipt={engine:name,version,executable,startedAt,endedAt:new Date().toISOString(),code:result.status,signal:result.signal,error:result.error?.code??null,status:result.error?(result.error.code==='ETIMEDOUT'?'TIMED_OUT':'SPAWN_ERROR'):result.status===0?'PASS':'FAIL',tests:count(result.stdout??'','tests'),passed:count(result.stdout??'','pass'),failed:count(result.stdout??'','fail'),skipped:count(result.stdout??'','skipped'),cancelled:count(result.stdout??'','cancelled')};
 results.push(receipt);
 if(process.env.UI_TEST_RESULTS){await mkdir(process.env.UI_TEST_RESULTS+'/'+name,{recursive:true});await writeFile(process.env.UI_TEST_RESULTS+'/'+name+'/stdout.log',result.stdout??'','utf8');await writeFile(process.env.UI_TEST_RESULTS+'/'+name+'/stderr.log',result.stderr??'','utf8');await writeFile(process.env.UI_TEST_RESULTS+'/'+name+'/receipt.json',JSON.stringify(receipt,null,2)+'\n','utf8');}
}
if(process.env.UI_TEST_RESULTS){await mkdir(process.env.UI_TEST_RESULTS,{recursive:true});await writeFile(process.env.UI_TEST_RESULTS+'/summary.json',JSON.stringify(results,null,2)+'\n','utf8');}
console.log(JSON.stringify(results));process.exitCode=results.every(r=>r.status==='PASS'&&r.tests>0&&r.passed>0&&r.failed===0&&r.cancelled===0)?0:1;
