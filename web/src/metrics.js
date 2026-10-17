export function createAutomationMetricsPanel({document,api}) {
  const korean=document.documentElement.lang.startsWith('ko'),node=(tag,value='',className='')=>{const n=document.createElement(tag);n.textContent=value;n.className=className;return n;};
  const panel=node('details','','request automation-metrics');panel.id='automation-metrics';panel.append(node('summary',korean?'자동승인 효과 · 최근 24시간':'Automation observations · last 24 hours'));
  const help=node('p',korean?'저장된 명령 심사 이력을 집계합니다. 업로드·다운로드와 별도 읽기 호출은 포함하지 않습니다. 열거나 새로고침할 때만 조회합니다.':'Recorded command decisions only. Uploads, downloads and separate read calls are excluded. Loaded only when opened or refreshed.','policy-help');
  const content=node('div'),error=node('p','','error'),refresh=node('button',korean?'측정값 새로고침':'Refresh observations','secondary');refresh.type='button';error.hidden=true;panel.append(help,content,error,refresh);
  document.querySelector('.grid').before(panel);let busy=false;
  async function load() {
    if(busy)return;busy=true;refresh.disabled=true;error.hidden=true;
    const selected=document.querySelector(document.body.dataset.page==='settings'?'#important-settings select':'#target-filter'),target=selected?.value;
    const name=selected?.selectedOptions[0]?.textContent||(korean?'전체 대상':'All targets');
    try {
      const data=await api('/api/automation-metrics'+(target?'?target='+encodeURIComponent(target):''));content.replaceChildren();
      content.append(node('p',name+' · '+new Date(data.from).toLocaleString()+' — '+new Date(data.to).toLocaleString(),'policy-help'));
      if(!data.available){content.append(node('p',korean?'명령 자동승인 기록이 꺼져 있어 측정 자료가 없습니다.':'Recorded automation measurements are unavailable.'));return;}
      const grid=node('div','','metric-grid');content.append(grid);
      const entries=korean?[['기록된 명령 요청',data.total],['사전명령으로 자동승인',data.commandSetApprovals],['모델 판단으로 자동승인',data.modelApprovals],['사용자가 승인',data.ownerApprovals],['모델 평가 후 사용자 승인',data.ownerApprovalsAfterAssessment]]:
        [['Recorded command requests',data.total],['Command-set auto approvals',data.commandSetApprovals],['Model auto approvals',data.modelApprovals],['Owner approvals',data.ownerApprovals],['Owner approval after assessment',data.ownerApprovalsAfterAssessment]];
      for(const [label,value]of entries){const card=node('div','','metric-card');card.append(node('span',label),node('strong',value.toLocaleString()));grid.append(card);}
      for(const [provider,usage]of Object.entries(data.providers))content.append(node('p',`${provider} · ${korean?'기록된 호출 시도':'recorded call attempts'} ${usage.calls} · ${korean?'실패':'failed'} ${usage.failures} · ${korean?'입력/출력 토큰':'input/output tokens'} ${usage.inputTokens.toLocaleString()}/${usage.outputTokens.toLocaleString()} · ${korean?'사용량 미확인 호출':'usage unknown'} ${usage.usageUnknownCalls} · ${korean?'기록된 평균 응답':'recorded mean latency'} ${usage.latencySamples?Math.round(usage.latencyMs/usage.latencySamples)+'ms':'—'}`,'policy-help'));
      content.append(node('p',korean?'모델 보류 후 사용자가 승인했다고 해서 모델이 오판했거나 명령이 안전했다고 볼 수는 없습니다. 현재 청구금액은 수집하지 않으며, 토큰 수를 비용으로 환산하지 않습니다.':'Owner approval after model review is not a ground-truth safety label. Billing amounts are not collected; token counts are not converted into cost.','policy-help'));
    } catch(failure){error.textContent=(korean?'측정값을 읽지 못했습니다. ':'Could not load observations. ')+failure.message;error.hidden=false;}
    finally{busy=false;refresh.disabled=false;}
  }
  panel.ontoggle=()=>{if(panel.open)load();};refresh.onclick=load;
}
