import { validateCommand } from '../domain/validation.mjs';

/** @typedef {import('../contracts/ports.mjs').OperationOutcome} OperationOutcome */
/**
 * Read commands use the read profile without approval. All other classes become jobs.
 * executeCommand(profile, command) must return a neutral OperationOutcome.
 * @param {{queue:import('../domain/approval-queue.mjs').ApprovalQueue, classify:(command:string)=>{class:string}, executeCommand:(profile:string,command:string)=>Promise<OperationOutcome>, audit:(event:Object)=>void, target:string, readProfile:string}} ports
 * @returns {{read:(command:string)=>Promise<OperationOutcome>,run:(command:string)=>Promise<{type:'immediate',outcome:OperationOutcome}|{type:'job',job:import('../contracts/ports.mjs').Job}>,busy:()=>boolean}}
 */
export function createCommandService({ queue, classify, executeCommand, audit, target, readProfile, claimExecution = () => () => {} }) {
  let activeReads = 0;
  const idleWaiters = [];
  const read = async command => {
    if (queue.maintenance || queue.busy()) throw Error('Maintenance or another operation is in progress');
    if (validateCommand(command, classify).class !== 'read-only') throw Error('Approval required');
    const release = claimExecution();
    try { audit({ action: 'read-started', command, profile: readProfile, target }); } catch (error) { release(); throw error; }
    // Claim before the first await; queue.externalBusy consults busy().
    activeReads++;
    let outcome;
    try {
      outcome = await executeCommand(readProfile, command);
    } catch {
      outcome = { failed: true, texts: ['Operation failed; check the protected server diagnostics.'] };
      // Preserve the protocol's generic refusal for transport exceptions.
      throw Error('Operation failed; check the protected server diagnostics.');
    } finally {
      activeReads--;
      // AP-02: an executor rejection still records a terminal failure, without raw errors.
      try { audit({ action: outcome?.failed ? 'read-failed' : 'read-completed', profile: readProfile, target }); }
      finally { release(); if (!activeReads) for (const resolve of idleWaiters.splice(0)) resolve(); }
    }
    return outcome;
  };
  return {
    read,
    async run(command) {
      return validateCommand(command, classify).class === 'read-only'
        ? { type: 'immediate', outcome: await read(command) }
        : { type: 'job', job: queue.submit(command) };
    },
    busy: () => activeReads > 0,
    drain: () => activeReads ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve(),
  };
}
