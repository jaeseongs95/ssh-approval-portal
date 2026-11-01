import { validateCommand } from '../domain/validation.mjs';
import { callerContext } from '../domain/execution-context.mjs';
import { executionFailure, executionFailureDetails } from '../domain/execution-failure.mjs';

const readFailure = (code, message) => Object.assign(Error(message), { code });

/** @typedef {import('../contracts/ports.mjs').OperationOutcome} OperationOutcome */
/**
 * Read commands use the read profile without approval. All other classes become jobs.
 * executeCommand(profile, command) must return a neutral OperationOutcome.
 * @param {{queue:import('../domain/approval-queue.mjs').ApprovalQueue, classify:(command:string)=>{class:string}, executeCommand:(profile:string,command:string)=>Promise<OperationOutcome>, audit:(event:Object)=>void, target:string, readProfile:string}} ports
 * @returns {{read:(command:string)=>Promise<OperationOutcome>,run:(command:string)=>Promise<{type:'immediate',outcome:OperationOutcome}|{type:'job',job:import('../contracts/ports.mjs').Job}>,busy:()=>boolean}}
 */
export function createCommandService({ queue, classify, executeCommand, audit, target, readProfile, claimExecution = () => () => {}, automation }) {
  let activeReads = 0;
  const idleWaiters = [];
  const read = async command => {
    if (queue.maintenance || queue.busy()) throw readFailure('READ_COMMAND_BUSY', 'Maintenance or another operation is in progress');
    if (validateCommand(command, classify).class !== 'read-only') throw readFailure('READ_COMMAND_REQUIRES_APPROVAL', 'Approval required');
    let release;
    try {
      release = claimExecution();
      audit({ action: 'read-started', command, profile: readProfile, target });
    } catch {
      release?.();
      throw readFailure('READ_COMMAND_NOT_STARTED', 'Read command was not started; check the protected server diagnostics.');
    }
    // Claim before the first await; queue.externalBusy consults busy().
    activeReads++;
    let outcome;
    try {
      outcome = await executeCommand(readProfile, command);
    } catch (error) {
      outcome = { failed: true, texts: [], failure: executionFailureDetails(error) };
      // Entering the executor is not proof of remote dispatch or non-execution.
      const refused = readFailure('READ_COMMAND_EXECUTION_UNKNOWN', 'Operation failed; check the protected server diagnostics.');
      const known = executionFailureDetails(error, false);
      if (known) {
        const diagnostic = executionFailure(refused, known);
        diagnostic.code = refused.code;
        throw diagnostic;
      }
      throw refused;
    } finally {
      activeReads--;
      // AP-02: an executor rejection still records a terminal failure, without raw errors.
      try { audit({ action: outcome?.failed ? 'read-failed' : 'read-completed', profile: readProfile, target, failure: outcome?.failure }); }
      catch { throw readFailure('READ_COMMAND_EXECUTION_UNKNOWN', 'Read command completion could not be confirmed; check the protected server diagnostics.'); }
      finally { release(); if (!activeReads) for (const resolve of idleWaiters.splice(0)) resolve(); }
    }
    return outcome;
  };
  return {
    read,
    runSource(args) { if (!automation) throw Error('Source requests require command automation'); return automation.runSource(args); },
    source(id) { if (!automation) throw Error('Source unavailable'); return automation.source(id); },
    close: () => automation?.close(),
    async run(command, requestKey, context = '', displayContext = '') {
      validateCommand(command, classify);
      context = callerContext(context); displayContext = callerContext(displayContext);
      if (automation) return automation.run(command, requestKey, context, displayContext);
      if (requestKey !== undefined) throw Error('Request keys require command automation');
      return validateCommand(command, classify).class === 'read-only'
        ? { type: 'immediate', outcome: await read(command) }
        : { type: 'job', job: queue.submit(command, false, context, displayContext) };
    },
    busy: () => activeReads > 0 || (automation?.busy() ?? false),
    reading: () => activeReads > 0,
    drain: async () => { await automation?.drain(); if (activeReads) await new Promise(resolve => idleWaiters.push(resolve)); },
  };
}
