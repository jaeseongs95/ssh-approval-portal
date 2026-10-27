import {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {idValid} from '../../domain/validation.mjs';
import {AGENT_CLI_CONTRACT} from '../../domain/agent-cli.mjs';

/** Dedicated private journal; does not enable or write the command-automation policy. */
export function createAgentCliState(root){
 const path=join(root,'agent-cli.sqlite');
 try{closeSync(openSync(path,'wx',0o600));}catch(error){if(error.code!=='EEXIST')throw error;}
 const st=lstatSync(path);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(process.platform!=='win32'&&((st.mode&0o077)||st.uid!==process.getuid())))throw Error('Unsafe CLI journal');
 const db=new DatabaseSync(path);
 const encode=job=>{
  if(!idValid(job?.id)||job.operation?.agentCliContract!==AGENT_CLI_CONTRACT||job.kind!=='command')throw Error('Invalid CLI journal request');
  const body=JSON.stringify(job);if(Buffer.byteLength(body)>65536)throw Error('CLI journal request too large');return body;
 };
 try{
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, remote_status TEXT);');
  for(const row of db.prepare('SELECT id,body FROM requests').all()){
   const job=JSON.parse(row.body);
   if(['pending','evaluating','running'].includes(job.state)){
    job.state=job.state==='pending'?'expired':'unknown';job.finishedAt=Date.now();db.prepare('UPDATE requests SET body=? WHERE id=?').run(encode(job),row.id);
   }
  }
 }catch(error){db.close();throw error;}
 return {
  preservationRows(){const usage=db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(body AS BLOB))+coalesce(length(CAST(remote_status AS BLOB)),0)),0) AS bytes FROM requests').get();if(usage.count>10000||usage.bytes>64*1024*1024)throw Error('CLI preservation budget exceeded');return {schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all(),requests:db.prepare('SELECT * FROM requests ORDER BY id').all()};},
  find(key){const row=db.prepare('SELECT digest,body FROM requests WHERE request_key=?').get(key);return row&&{digest:row.digest,job:JSON.parse(row.body)};},
  list(){return db.prepare('SELECT body FROM requests').all().map(row=>JSON.parse(row.body));},
  history(binding,cursor=null){
   const {targetId,targetRevision,profile,provider}=binding??{};
   if(typeof targetId!=='string'||typeof targetRevision!=='string'||typeof profile!=='string'||!['codex','claude'].includes(provider))throw Error('Invalid CLI history binding');
   if(cursor!==null&&(!cursor||Object.keys(cursor).length!==2||!Number.isSafeInteger(cursor.before)||cursor.before<=0||!idValid(cursor.beforeId)))throw Error('Invalid CLI history cursor');
   const created="json_extract(body,'$.createdAt')",args=[AGENT_CLI_CONTRACT,targetId,targetRevision,profile,provider,profile];
   let older='';if(cursor){older=` AND (${created}<? OR (${created}=? AND id<?))`;args.push(cursor.before,cursor.before,cursor.beforeId);}
   const rows=db.prepare(`SELECT id,json_extract(body,'$.state') AS state,${created} AS createdAt FROM requests WHERE json_extract(body,'$.operation.agentCliContract')=? AND json_extract(body,'$.operation.agentCliTargetId')=? AND json_extract(body,'$.operation.agentCliTargetRevision')=? AND json_extract(body,'$.operation.agentCliProfile')=? AND json_extract(body,'$.operation.agentCliProvider')=? AND json_extract(body,'$.profile')=?${older} ORDER BY ${created} DESC,id DESC LIMIT 21`).all(...args);
   if(rows.some(row=>!idValid(row.id)||!['pending','running','completed','failed','unknown','expired','denied','evaluating'].includes(row.state)||!Number.isSafeInteger(row.createdAt)||row.createdAt<=0))throw Error('Invalid CLI history metadata');
   const requests=rows.slice(0,20).map(row=>({id:row.id,state:row.state,createdAt:row.createdAt})),last=requests.at(-1);
   return {requests,next:rows.length>20?{before:last.createdAt,beforeId:last.id}:null};
  },
  insert(job,key,digest){
   if(typeof key!=='string'||!/^agent-cli:[A-Za-z0-9_.:-]{16,128}$/.test(key)||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw Error('Invalid CLI journal identity');
   if(db.prepare('SELECT count(*) AS n FROM requests').get().n>=10000)throw Error('CLI journal full');
   db.prepare('INSERT INTO requests VALUES (?,?,?,?,NULL)').run(job.id,key,digest,encode(job));
  },
  save(job){if(db.prepare('UPDATE requests SET body=? WHERE id=?').run(encode(job),job.id).changes!==1)throw Error('Missing CLI journal request');},
  get(id){if(!idValid(id))throw Error('Invalid CLI request');const row=db.prepare('SELECT body,remote_status FROM requests WHERE id=?').get(id);return row&&{job:JSON.parse(row.body),remoteStatus:row.remote_status?JSON.parse(row.remote_status):null};},
  recordRemote(id,value){
   const row=this.get(id),op=row?.job.operation;
   if(!op||value?.provider!==op.agentCliProvider||value.operationId!==op.agentCliOperationId||value.login!=='not_checked'||!['not_found','unknown','preparing','installing','completed','reused','failed'].includes(value.state))throw Error('Invalid CLI remote status');
   if(value.state!=='not_found'&&(typeof value.version!=='string'||!/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(value.version)))throw Error('Invalid CLI status version');
   const status={provider:value.provider,operationId:value.operationId,state:value.state,login:'not_checked',...(value.state==='not_found'?{}:{version:value.version}),...(value.state==='failed'?{error:'INSTALL_FAILED'}:{})};
   db.prepare('UPDATE requests SET remote_status=? WHERE id=?').run(JSON.stringify(status),id);return status;
  },
  close(){db.close();},
 };
}
