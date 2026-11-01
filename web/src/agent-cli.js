/** Fixed-provider owner workflow. Browser storage contains only bounded public lookup hints. */
export function createAgentCliPanel({document,api,isSignedOut,canLoad,storage,getTarget,onRequestTarget,onStateChange=()=>{},random=globalThis.crypto,schedule=setTimeout,cancel=clearTimeout}) {
 const ko=document.documentElement.lang.startsWith('ko'),t=(a,b)=>ko?a:b;
 const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
 const root=el('section','','request agent-cli-settings');root.id='agent-cli-settings';
 root.append(el('h2',t('서버 CLI 설치','Server CLI installation')),el('p',t('등록된 서버에 Codex·Claude CLI를 설치합니다. 설치한 CLI는 해당 SSH 계정 권한으로 실행됩니다. 로그인과 자동심사 활성화는 별도로 진행합니다.','Install Codex or Claude CLI on a registered server. Installed code runs with that SSH account’s permissions. Login and review activation are separate.'),'policy-help'));
 const controls=el('div','','cli-selectors');root.append(controls);
 const select=(id,koLabel,enLabel)=>{const label=el('label',t(koLabel,enLabel),'policy-field'),node=el('select');node.id=id;label.append(node);controls.append(label);return node;};
 const target=select('cli-target','설치 대상 서버','Installation target'),provider=select('cli-provider','CLI','CLI');
 for(const [id,name] of [['codex','Codex'],['claude','Claude']]){const o=el('option',name);o.value=id;provider.append(o);}
 const identity=el('p','','target'),message=el('p','','policy-message'),failure=el('p','','error');identity.id='cli-target-context';message.setAttribute('role','status');failure.setAttribute('role','alert');root.append(identity,message,failure);
 const buttons=el('div','','cli-actions');root.append(buttons);
 const button=(id,a,b,cls='secondary')=>{const n=el('button',t(a,b),cls);n.id=id;n.type='button';buttons.append(n);return n;};
 const inspect=button('cli-inspect','버전 확인·설치 준비','Check versions and prepare');
 const checkLogin=button('cli-login-check','로그인 상태 확인','Check login status');
 const loginState=el('p','','cli-login-status');loginState.id='cli-login-state';loginState.setAttribute('role','status');root.append(loginState);
 const recover=button('cli-recover','기존 요청 상태 조회','Read existing request');
 const history=el('div'),historyLabel=el('label',t('기존 서버 요청 선택','Choose an existing server request'),'policy-field'),historySelect=el('select');historySelect.id='cli-history-select';historyLabel.append(historySelect);history.append(historyLabel);history.hidden=true;root.append(history);
 const historyNext=el('button',t('더 오래된 요청 보기','Read older requests'),'secondary');historyNext.id='cli-history-next';historyNext.type='button';historyNext.hidden=true;history.append(historyNext);
 const summary=el('pre','','command');summary.id='cli-summary';summary.hidden=true;root.append(summary);
 const confirmation=el('label','','policy-check'),ack=el('input');ack.type='checkbox';ack.id='cli-ack';confirmation.append(ack,el('span',t('위 서버·CLI·버전과 계정 권한을 확인했습니다.','I reviewed this server, CLI, version and account permissions.')));root.append(confirmation);
 const actions=el('div','','cli-actions');root.append(actions);
 const actionButton=(id,a,b)=>{const n=el('button',t(a,b),'primary');n.type='button';n.id=id;actions.append(n);return n;};
 const submit=actionButton('cli-submit','설치 요청 등록','Create installation request'),start=actionButton('cli-start','승인하고 설치 시작','Approve and start installation');
 for(const button of [submit,start])button.setAttribute('aria-describedby',identity.id);
 const reconcile=button('cli-reconcile','서버의 설치 기록 확인','Check server installation receipt');
 const readOutput=button('cli-output-read','저장 출력 읽기','Read stored output'),output=el('pre','','output');output.id='cli-output';output.tabIndex=0;output.hidden=true;root.append(output);
 const login=el('details');login.id='cli-login';login.append(el('summary',t('로그인 안내','Login guidance')));
 login.append(el('p',t('로그인 상태 확인 버튼으로 선택한 CLI의 저장된 로그인 상태를 조회할 수 있습니다. 설치 대상의 SSH 계정으로 터미널을 열어 로그인하세요. 인증코드·키는 이 화면에 입력하지 마세요. 설치만으로 Jev나 대체 심사가 활성화되지는 않습니다.','Use Check login status to read the selected CLI’s saved login state. Open a terminal as the target SSH account to log in. Do not enter login codes or keys here. Installation does not activate Jev or fallback review.'),'policy-help'));
 const loginAccount=el('p','','policy-help');loginAccount.id='cli-login-account';login.append(loginAccount);
 const loginCommand=el('pre');login.append(loginCommand);root.append(login);const panels=document.getElementById('server-panels');if(panels)panels.append(root);else document.querySelector('.grid')?.before(root);
 const storageKey='ssh-approval-cli-requests-v1',validId=v=>typeof v==='string'&&/^[a-f0-9]{48}$/.test(v),validTarget=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,31}$/.test(v);
 const validHint=h=>h&&Object.keys(h).every(k=>['requestKey','requestId','targetId','provider'].includes(k))&&typeof h.requestKey==='string'&&/^[A-Za-z0-9_.:-]{16,128}$/.test(h.requestKey)&&validTarget(h.targetId)&&['codex','claude'].includes(h.provider)&&(!Object.hasOwn(h,'requestId')||validId(h.requestId));
 let hints=[];try{const raw=storage?.getItem(storageKey);if(raw&&raw.length<=24576){const v=JSON.parse(raw);if(Array.isArray(v)&&v.length<=64&&v.every(validHint))hints=v;}}catch{/* disabled or invalid storage never grants execution */}
 let capabilities,capabilityRead,preview,job,remoteStatus,historyCursor,busy=false,uncertain=false,generation=0,timer,closed=false,currentScope='',currentBinding;
 const drafts=new Map(),blocked=()=>busy||uncertain||['running','evaluating','unknown'].includes(job?.state);
 const selectedTarget=()=>currentScope.split('\n')[0];
 const active=()=>!closed&&!isSignedOut()&&document.body.dataset.page==='settings';
 const binding=()=>capabilities?.bindings?.find(b=>b.targetId===target.value&&b.enabled===true);
 const supported=()=>Boolean(binding())&&binding().supported!==false;
 const hint=()=>hints.find(h=>h.targetId===target.value&&h.provider===provider.value);
 const persist=h=>{hints=hints.filter(v=>v.targetId!==h.targetId||v.provider!==h.provider);hints.push(h);hints=hints.slice(-64);try{storage?.setItem(storageKey,JSON.stringify(hints));}catch{/* local restoration may be unavailable */}};
 const clearTimer=()=>{cancel(timer);timer=undefined;};
 const stateName=state=>({pending:t('승인 대기','Awaiting approval'),running:t('설치 실행 중','Installing'),completed:t('완료','Completed'),failed:t('실패','Failed'),unknown:t('결과 불명','Outcome unknown'),expired:t('만료','Expired'),denied:t('거부','Denied'),evaluating:t('평가 중','Assessing'),not_found:t('기록 없음','Not found'),preparing:t('준비 중','Preparing'),installing:t('설치 중','Installing'),reused:t('기존 버전 사용','Reused')})[state]??t('확인 필요','Check required');
 function lock(){
  const ready=supported()&&capabilities?.available&&active()&&(!getTarget||getTarget()===target.value);
  checkLogin.disabled=busy||!ready;
  inspect.disabled=busy||!ready||uncertain||Boolean(job&&['pending','running','evaluating','unknown'].includes(job.state));
  recover.disabled=busy||!ready;historySelect.disabled=busy||!ready;historyNext.disabled=busy||!ready;submit.hidden=!preview||Boolean(job);submit.disabled=busy||!ready||uncertain||!ack.checked||!preview||Date.now()>=preview.expiresAt;
  start.hidden=job?.state!=='pending';start.disabled=busy||!ready||uncertain||!ack.checked;
  reconcile.hidden=!job||!['unknown','failed'].includes(job.state);reconcile.disabled=busy||!ready;
  readOutput.hidden=!validId(job?.result?.structuredContent?.output?.id);readOutput.disabled=busy||!ready;
  ack.disabled=busy||!ready||(!preview&&job?.state!=='pending');login.hidden=Boolean(binding())&&!supported();target.disabled=blocked();provider.disabled=blocked()||Boolean(binding())&&!supported();root.setAttribute('aria-busy',String(busy));onStateChange();
 }
 function clearHistory(){history.hidden=true;historySelect.replaceChildren();historyCursor=undefined;historyNext.hidden=true;}
 function scope(){
  if(currentScope)drafts.set(currentScope,{binding:currentBinding,preview,job,remoteStatus,uncertain,summary:summary.textContent,message:message.textContent,loginState:loginState.textContent});
  generation++;clearTimer();clearHistory();preview=job=remoteStatus=undefined;ack.checked=false;uncertain=Boolean(hint());summary.hidden=true;summary.textContent='';output.hidden=true;output.textContent='';failure.textContent='';message.textContent='';
  loginState.textContent=t('로그인 상태: 미조회','Login status: Not checked');
  const b=binding();currentScope=target.value+'\n'+provider.value;currentBinding=b&&{targetId:b.targetId,targetRevision:b.targetRevision,profile:b.profile};identity.textContent=b?[document.body.dataset.bridgeDisplayName,b.displayName,b.targetId,b.platform==='windows'?'Windows':b.platform==='linux'?'Linux':'',b.sshTarget,b.profile].filter(Boolean).join(' · '):target.value?t('선택 서버: ','Selected server: ')+target.value+t(' · CLI 연결 정보를 확인하지 못했습니다.',' · CLI binding is unavailable.'):'';
  if(!target.value)message.textContent=t('편집할 서버를 선택해 주세요. 서버 선택 전에는 명령줄 도구 작업을 시작할 수 없습니다.','Choose a server to edit. Command-line tool operations remain unavailable until a server is selected.');
  if(b&&!supported()){uncertain=false;message.textContent=t('이 대상에서는 서버 CLI 설치·로그인 상태 진단을 지원하지 않습니다. 일반 명령과 파일 전송은 사용할 수 있습니다.','Server CLI installation and login diagnostics are unavailable on this target. General commands and file transfers remain available.');loginState.textContent=t('로그인 상태: 지원하지 않는 대상','Login status: Unsupported target');}
  const user=/^([A-Za-z_][A-Za-z0-9_.-]{0,63})@/.exec(b?.sshTarget??'')?.[1];
  loginAccount.textContent=b&&supported()?t('로그인할 SSH 계정: ','SSH account for login: ')+b.sshTarget+(b.platform==='windows'?t(' · 설치·업데이트에는 Node.js 22 이상과 npm이 필요합니다. 로그인은 같은 Windows 계정에서 진행하세요.',' · Installation and updates require Node.js 22+ and npm. Log in as the same Windows account.') : user?t(' · 다른 계정이면 먼저 실행: ',' · From another account run first: ')+'sudo -iu '+user:''):'';
  const p=provider.value, packagePath=p==='codex'?'@openai\\codex':'@anthropic-ai\\claude-code';
  loginCommand.textContent=!supported()?'':b.platform==='windows'?`$root = Join-Path $env:USERPROFILE '.ssh-approval-cli\\${p}'
$active = (Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw | ConvertFrom-Json).active
$packageRoot = Join-Path (Join-Path $root $active) 'node_modules\\${packagePath}'
$package = Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json
$bin = if ($package.bin -is [string]) { $package.bin } else { $package.bin.${p} }
$executable = Join-Path $packageRoot $bin
if ($executable.EndsWith('.exe')) { & $executable ${p==='codex'?'login':'auth login'} } else { & node.exe $executable ${p==='codex'?'login':'auth login'} }
`+t('관리 설치용 안내입니다. 기존 외부 설치는 확인한 실행 파일 경로를 사용하세요.','For a managed installation. Use the verified executable path for an existing external installation.') : `PATH="/opt/ssh-approval/node/bin:$PATH" "$HOME/.local/share/ssh-approval-cli/${p}/current/bin/${p}"`+(p==='codex'?' login --device-auth':'')+'\n'+t('기존 외부 설치를 사용하는 경우에는 그 설치의 실행 경로를 사용하세요.','For an existing external installation, use that installation’s executable path.');
  const draft=drafts.get(currentScope);
  if(b&&draft&&draft.binding?.targetId===b.targetId&&draft.binding.targetRevision===b.targetRevision&&draft.binding.profile===b.profile){({preview,job,remoteStatus,uncertain}=draft);summary.textContent=draft.summary;summary.hidden=!preview&&!job;message.textContent=draft.message;loginState.textContent=draft.loginState;}
  lock();poll();
 }
 function validateJob(value){const b=binding(),op=value?.operation;if(!validId(value?.id)||!b||op?.agentCliContract!=='agent-cli-install-v1'||op.agentCliProvider!==provider.value||op.agentCliTargetId!==b.targetId||op.agentCliTargetRevision!==b.targetRevision||op.agentCliProfile!==b.profile||!['pending','running','completed','failed','unknown','expired','denied','evaluating'].includes(value.state))throw Error(t('요청의 대상 정보가 현재 선택과 다릅니다.','The request does not match the current target binding.'));return value;}
 function displayJob(value,status){job=validateJob(value);remoteStatus=status;preview=undefined;ack.checked=false;uncertain=false;
  summary.hidden=false;summary.textContent=[identity.textContent,provider.value,'ID: '+job.id,stateName(job.state),...(remoteStatus?[t('서버 기록: ','Server receipt: ')+stateName(remoteStatus.state)]:[])].join('\n');
  message.textContent=job.state==='unknown'?t('결과를 확정하지 못했습니다. 설치를 반복하지 말고 서버 기록을 확인하세요.','Outcome is unknown. Check the server receipt before attempting another installation.'):stateName(job.state);lock();poll();
 }
 async function run(fn){if(busy||!active())return;const token=generation;busy=true;failure.textContent='';lock();try{await fn(()=>token===generation&&active());}catch(error){if(token===generation&&active())failure.textContent=String(error.message);}finally{busy=false;lock();}}
 function poll(){clearTimer();if(!active()||document.hidden||!['pending','running','evaluating'].includes(job?.state))return;timer=schedule(()=>{if(busy){poll();return;}run(async current=>{try{const value=await api('/api/agent-cli/requests/'+job.id);if(current())displayJob(value.job,value.remoteStatus);}finally{if(current())poll();}});},2000);}
 async function loadHistory(current,cursor=null){
  const b=binding(),p=provider.value;clearTimer();clearHistory();preview=job=remoteStatus=undefined;ack.checked=false;summary.hidden=true;summary.textContent='';output.hidden=true;output.textContent='';lock();
  const value=await api('/api/agent-cli/history?'+new URLSearchParams({targetId:b.targetId,provider:p,...(cursor??{})}));if(!current())return;
  const states=['pending','running','completed','failed','unknown','expired','denied','evaluating'],rows=value?.requests;
  if(value?.binding?.targetId!==b.targetId||value.binding.targetRevision!==b.targetRevision||value.binding.profile!==b.profile||value.provider!==p||!Array.isArray(rows)||rows.length>20||rows.some(row=>!validId(row?.id)||!states.includes(row.state)||!Number.isSafeInteger(row.createdAt)||row.createdAt<=0)||new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('Invalid CLI history response');
  if(rows.some((row,i)=>i>0&&(row.createdAt>rows[i-1].createdAt||(row.createdAt===rows[i-1].createdAt&&row.id>=rows[i-1].id)))||cursor&&rows.some(row=>row.createdAt>cursor.before||(row.createdAt===cursor.before&&row.id>=cursor.beforeId)))throw Error('Invalid CLI history order');
  const last=rows.at(-1),next=value.next;
  if(next!==null&&(!next||Object.keys(next).length!==2||rows.length!==20||next.before!==last.createdAt||next.beforeId!==last.id))throw Error('Invalid CLI history page');
  const empty=el('option',t('요청 선택','Choose a request'));empty.value='';historySelect.append(empty);
  for(const row of rows){const option=el('option',new Date(row.createdAt).toLocaleString()+' · '+stateName(row.state)+' · '+row.id);option.value=row.id;historySelect.append(option);}
  historyCursor=next;historyNext.hidden=next===null;history.hidden=false;message.textContent=rows.length?t('기존 요청을 선택해 상태를 확인하세요. 설치는 다시 실행되지 않습니다.','Choose an existing request to read its status. Installation is not repeated.'):t('현재 서버·CLI의 요청 기록이 없습니다.','No request records for this server and CLI.');
 }
 async function restore(){return run(async current=>{const h=hint();if(!h)return loadHistory(current);uncertain=true;const value=await api('/api/agent-cli/lookup?'+new URLSearchParams({key:h.requestKey,targetId:h.targetId,provider:h.provider}));if(!current())return;
  if(value.found===true){const restored=validateJob(value.job);persist({...h,requestId:restored.id});displayJob(restored,value.remoteStatus);}else if(value.found===false){uncertain=true;message.textContent=t('요청 기록을 찾지 못했습니다. 자동으로 다시 설치하지 않습니다. 서버 기록을 확인한 뒤 새 작업을 준비하세요.','No request record found. Installation is not retried automatically. Check server records before preparing a new operation.');}else throw Error('Invalid CLI lookup response');
 });}
 historyNext.onclick=()=>{const cursor=historyCursor;if(cursor)return run(current=>loadHistory(current,cursor));};
 historySelect.onchange=()=>{const requestId=historySelect.value;if(!validId(requestId))return;return run(async current=>{
  clearTimer();preview=job=remoteStatus=undefined;ack.checked=false;summary.hidden=true;summary.textContent='';output.hidden=true;output.textContent='';lock();
  const value=await api('/api/agent-cli/requests/'+requestId);if(!current())return;if(value?.job?.id!==requestId)throw Error('CLI request identity changed');displayJob(value.job,value.remoteStatus);
 });};
 checkLogin.onclick=()=>run(async current=>{const b=binding(),p=provider.value;loginState.textContent=t('로그인 상태: 조회 중…','Login status: Checking…');
  let value;try{value=await api('/api/agent-cli/login-status','POST',{targetId:b.targetId,provider:p});}catch{if(current())loginState.textContent=t('로그인 상태: 확인 불가. 다시 확인해 주세요.','Login status: Unavailable. Check again.');return;}
  if(!current())return;
  const states={signed_in:t('로그인됨','Signed in'),signed_out:t('로그인 안 됨','Signed out'),not_installed:t('미설치','Not installed'),unavailable:t('확인 불가','Unavailable')};
  const reasons={
   unsafe_path:t('실행 경로 또는 상위 디렉터리의 소유권·쓰기 권한·실행 가능 여부가 안전 기준을 충족하지 않아 CLI를 실행하지 않았습니다. 서버 관리자가 해당 SSH 계정의 설치 경로와 권한을 확인한 뒤 다시 조회하세요.','The executable path or a parent directory failed ownership, write permissions or execution safety checks. The CLI was not executed. Ask the server administrator to review this SSH account’s installation path and permissions, then check again.'),
   invalid_installation:t('관리 설치의 메타데이터 또는 실행 파일 무결성을 확인하지 못했습니다. 서버 관리자가 설치 기록과 파일을 확인한 뒤 다시 조회하세요.','Managed installation metadata or executable integrity could not be verified. Ask the server administrator to review the installation records and files, then check again.'),
   timeout:t('CLI 로그인 검사 시간이 초과되었습니다. 해당 SSH 계정의 터미널에서 CLI 응답을 확인한 뒤 다시 조회하세요.','The CLI login check timed out. Check CLI responsiveness in this SSH account’s terminal, then check again.'),
   output_limit:t('CLI 로그인 검사 출력이 안전 한도를 초과했습니다. 해당 SSH 계정의 터미널에서 CLI 상태를 확인한 뒤 다시 조회하세요.','CLI login check output exceeded the safety limit. Check the CLI in this SSH account’s terminal, then check again.'),
   unexpected_response:t('CLI 응답을 로그인 상태로 판독하지 못했습니다. 해당 SSH 계정의 터미널에서 CLI 상태와 버전을 확인하세요.','The CLI response was not recognized as a login state. Check the CLI status and version in this SSH account’s terminal.'),
   check_failed:t('SSH 연결 또는 로그인 검사를 완료하지 못했습니다. 서버 연결과 해당 SSH 계정의 CLI 실행 가능 여부를 확인한 뒤 다시 조회하세요.','The SSH connection or login check could not be completed. Check server connectivity and CLI execution for this SSH account, then check again.')
  };
  if(value?.provider!==p||value.binding?.targetId!==b.targetId||value.binding.targetRevision!==b.targetRevision||value.binding.profile!==b.profile||!Object.hasOwn(states,value.state)||Object.hasOwn(value,'reason')&&(value.state!=='unavailable'||typeof value.reason!=='string'||!Object.hasOwn(reasons,value.reason))||!Number.isSafeInteger(value.checkedAt)||value.checkedAt<=0){loginState.textContent=t('로그인 상태: 확인 불가','Login status: Unavailable');return;}
  loginState.textContent=(p==='codex'?'Codex':'Claude')+' · '+states[value.state]+' · '+t('확인 시각: ','Checked: ')+new Date(value.checkedAt).toLocaleString()+(value.reason?' · '+reasons[value.reason]:'');
 });
 inspect.onclick=()=>run(async current=>{const b=binding(),p=provider.value;const value=await api('/api/agent-cli/preview','POST',{targetId:b.targetId,provider:p});if(!current())return;
  if(value?.binding?.targetId!==b.targetId||value.binding.targetRevision!==b.targetRevision||value.binding.profile!==b.profile||value.release?.provider!==p||!validId(value.planId)||!Number.isSafeInteger(value.expiresAt)||Date.now()>=value.expiresAt||!['@openai/codex','@anthropic-ai/claude-code'].includes(value.release.packageName))throw Error('Invalid CLI preview');
  preview=value;job=remoteStatus=undefined;ack.checked=false;summary.hidden=false;summary.textContent=[identity.textContent,value.release.packageName,t('현재: ','Current: ')+(value.installation.installed?value.installation.version??t('버전 확인 불가','Version unavailable'):t('미설치','Not installed')),t('후보: ','Candidate: ')+value.release.version,t('관리 설치: ','Managed installation: ')+String(value.installation.managed),t('계획 만료: ','Plan expires: ')+new Date(value.expiresAt).toLocaleString()].join('\n');
  submit.textContent=value.installation.managed?t('업데이트 요청 등록','Create update request'):t('설치 요청 등록','Create installation request');message.textContent=value.installation.installed&&!value.installation.managed?(value.installation.version===value.release.version?t('기존 외부 설치와 같은 버전입니다. 기존 설치를 재사용합니다.','The external installation has this version and will be reused.'):t('기존 외부 설치는 유지하고 별도 관리 경로에 설치합니다. 원래 실행 경로와 로그인 파일은 덮어쓰지 않습니다.','Keep the external installation and install in a separate managed path. The original executable path and login files are preserved.')):t('설치 계획을 확인한 뒤 요청을 등록하세요.','Review the installation plan, then create a request.');lock();
 });
 submit.onclick=()=>{if(submit.disabled)return;return run(async current=>{const p=preview,requestKey=Array.from(random.getRandomValues(new Uint8Array(24)),v=>v.toString(16).padStart(2,'0')).join(''),h={requestKey,targetId:p.binding.targetId,provider:p.release.provider};persist(h);uncertain=true;preview=undefined;ack.checked=false;
  try{const value=await api('/api/agent-cli/submit','POST',{planId:p.planId,request:{targetId:p.binding.targetId,targetRevision:p.binding.targetRevision,profile:p.binding.profile,provider:p.release.provider,action:p.installation.managed?'update':'install',releaseDigest:p.release.releaseDigest,expectedInstallationRevision:p.installation.installationRevision,requestKey}});if(!current())return;const checked=validateJob(value);persist({...h,requestId:checked.id});displayJob(checked);}
  catch(error){if(current())message.textContent=t('접수됐을 수 있습니다. 기존 요청 상태 조회만 실행하고 다시 등록하지 마세요.','The request may have been accepted. Read its existing status; do not submit it again.');throw error;}
 });};
 start.onclick=()=>{if(start.disabled)return;return run(async current=>{const requestId=job.id;uncertain=true;ack.checked=false;try{const value=await api('/api/agent-cli/start','POST',{requestId});if(current()){if(value?.id!==requestId)throw Error('CLI request identity changed');displayJob(value);}}catch(error){if(current())message.textContent=t('실행됐을 수 있습니다. 기존 요청 상태를 확인하세요.','Execution may have started. Read the existing request status.');throw error;}});};
 reconcile.onclick=()=>run(async current=>{const value=await api('/api/agent-cli/reconcile','POST',{requestId:job.id});if(current()){if(value.requestId!==job.id||value.remoteStatus?.provider!==provider.value)throw Error('Invalid CLI receipt');displayJob(job,value.remoteStatus);}});
 readOutput.onclick=()=>run(async current=>{const outputId=job?.result?.structuredContent?.output?.id;if(!validId(outputId))return;const value=await api('/api/outputs/'+outputId+'?format=json&limit=4096');if(current()){if(typeof value.text!=='string')throw Error('Invalid CLI output');output.textContent=value.text;output.hidden=false;output.focus();}});
 recover.onclick=restore;ack.onchange=lock;
 target.onchange=()=>{const requested=target.value;target.value=selectedTarget();if(onRequestTarget)return onRequestTarget(requested);return selectTarget(requested);};
 provider.onchange=()=>{const previous=currentScope.split('\n')[1];if(blocked()){provider.value=previous;failure.textContent=t('처리 결과를 확인하기 전에는 CLI를 바꿀 수 없습니다.','The CLI cannot change until the current result is reconciled.');return;}scope();if(supported()&&hint()&&!preview&&!job&&!busy)restore();};
 function selectTarget(id){
  if(id===selectedTarget()){target.value=id;return true;}
  if(blocked()){target.value=selectedTarget();failure.textContent=t('처리 중이거나 결과 미확인으로 서버를 전환하지 못했습니다. 현재 서버를 유지합니다.','Server switch refused while processing or awaiting reconciliation. The current server is preserved.');return false;}
  if(![...target.options].some(option=>option.value===id)){const option=el('option',id+t(' · CLI 연결 정보 없음',' · CLI binding unavailable'));option.value=id;target.append(option);}
  target.value=id;scope();if(supported()&&hint()&&!preview&&!job&&!busy)restore();return true;
 }
 async function load(){if(capabilityRead)return capabilityRead;if(capabilities||busy||!active()||!canLoad())return Boolean(capabilities);capabilityRead=run(async current=>{const value=await api('/api/agent-cli');if(!current())return;
  if(typeof value?.available!=='boolean'||!Array.isArray(value.bindings)||value.bindings.some(b=>!validTarget(b.targetId)||typeof b.targetRevision!=='string'||typeof b.profile!=='string'))throw Error('Invalid CLI capabilities');
  capabilities=value;target.replaceChildren();const items=value.bindings.filter(b=>b.enabled===true);const option=el('option',t('서버 선택','Choose a server'));option.value='';target.append(option);for(const b of items){const option=el('option',b.displayName+' · '+b.targetId+(b.platform?' · '+(b.platform==='windows'?'Windows':'Linux'):'')+(b.supported===false?t(' · 지원하지 않음',' · Unsupported'):''));option.value=b.targetId;target.append(option);}const requested=getTarget?.();if(requested&&![...target.options].some(option=>option.value===requested)){const option=el('option',requested+t(' · CLI 연결 정보 없음',' · CLI binding unavailable'));option.value=requested;target.append(option);}target.value=requested??'';scope();if(!value.available)message.textContent=t('이 서버는 CLI 설치 연결을 제공하지 않습니다.','CLI installation is unavailable on this bridge.');
 }).then(()=>Boolean(capabilities)).finally(()=>{capabilityRead=undefined;lock();});const ready=await capabilityRead;if(supported()&&hint()&&!preview&&!job&&!busy)await restore();return ready;}
 let page=document.body.dataset.page;
 document.addEventListener('admin-scope-change',()=>{const next=document.body.dataset.page;if(next===page)return;page=next;generation++;clearTimer();lock();if(active()){if(!capabilities)load();else if(supported()&&hint()&&uncertain&&!busy)restore();else poll();}});
 document.addEventListener('visibilitychange',()=>{clearTimer();if(!document.hidden)poll();});
 document.querySelector('#load')?.addEventListener('click',load);
 document.querySelector('#logout')?.addEventListener('click',()=>{closed=true;hints=[];drafts.clear();currentScope='';try{storage?.removeItem(storageKey);}catch{}scope();});
 scope();queueMicrotask(load);return {root,targetControl:target,ensureLoaded:load,selectTarget,scopeState:()=>({targetId:selectedTarget(),name:capabilities?.bindings?.find(b=>b.targetId===selectedTarget())?.displayName,ready:!!capabilities,blocked:blocked(),readingCapabilities:!!capabilityRead&&busy&&!uncertain&&!['running','evaluating','unknown'].includes(job?.state),uncertain}),reloadState:()=>({blocked:busy||uncertain,dirty:preview?[t('CLI 설치 계획','CLI installation plan')]:[]})};
}
