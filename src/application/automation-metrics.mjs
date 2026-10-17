/** Aggregate recorded execution decisions only; user approval is not a ground-truth safety label. */
export function createAutomationMetrics({state, now=()=>Date.now()}) {
  return function snapshot(targetId) {
    const to=now(),from=to-86_400_000;
    const result={available:Boolean(state),from,to,scope:'recorded-command-execution-decisions',total:0,commandSetApprovals:0,modelApprovals:0,ownerApprovals:0,modelReviews:0,ownerApprovalsAfterAssessment:0,providers:{},
      billedAmount:null,billingNote:'Provider billing amounts are not recorded. Token counts are observations, not a cost estimate.',qualityNote:'Owner approval after model review is not evidence of model error or command safety.'};
    for(const row of state?.metricsRows(from,to)??[]) {
      if(targetId&&(row.targetId??'default')!==targetId)continue;
      result.total++;
      if(row.reasonCode==='command_set'&&row.approvalMode==='automatic')result.commandSetApprovals++;
      if(row.reasonCode==='model_passed'&&row.approvalMode==='automatic')result.modelApprovals++;
      if(row.approvalMode==='owner')result.ownerApprovals++;
      if(row.assessed&&row.approvalMode!=='automatic'){result.modelReviews++;if(row.approvalMode==='owner')result.ownerApprovalsAfterAssessment++;}
      const add=(provider,inputTokens,outputTokens,latency,failed=false)=>{
        if(!['jev','luna','sonnet'].includes(provider))return;
        const item=result.providers[provider]??={calls:0,failures:0,inputTokens:0,outputTokens:0,usageUnknownCalls:0,latencySamples:0,latencyMs:0};
        item.calls++;if(failed)item.failures++;
        if(Number.isSafeInteger(inputTokens)&&Number.isSafeInteger(outputTokens)&&inputTokens>=0&&outputTokens>=0){item.inputTokens+=inputTokens;item.outputTokens+=outputTokens;}else item.usageUnknownCalls++;
        if(Number.isFinite(latency)&&latency>=0){item.latencySamples++;item.latencyMs+=latency;}
      };
      if(row.assessed)add(row.provider,row.inputTokens,row.outputTokens,row.latencyMs);
      for(const attempt of JSON.parse(row.attempts??'[]'))if(attempt.reason==='evaluation_failed')add(attempt.provider,undefined,undefined,undefined,true);
    }
    return result;
  };
}
