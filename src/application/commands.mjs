import { validateCommand } from '../domain/validation.mjs';
import { callerContext } from '../domain/execution-context.mjs';

const readFailure = (code, message) => Object.assign(Error(message), { code });

/** Commands share approval policy and the durable scheduler, including reads. */
export function createCommandService({ queue, classify, automation }) {
  const read = async command => {
    if (queue.maintenance) throw readFailure('READ_COMMAND_BUSY', 'Maintenance is in progress');
    if (validateCommand(command, classify).class !== 'read-only') throw readFailure('READ_COMMAND_REQUIRES_APPROVAL', 'Approval required');
    let job;
    try { job = queue.submitRead(command); }
    catch (error) {
      if (error.code === 'OPERATION_QUEUE_FULL' || error.code === 'OPERATION_CAPACITY') throw error;
      throw readFailure('READ_COMMAND_NOT_STARTED', 'Read command was not started; check the protected server diagnostics.');
    }
    const completed = await queue.wait(job.id);
    if (!completed?.result || completed.state === 'unknown') throw readFailure('READ_COMMAND_EXECUTION_UNKNOWN', 'Read command completion could not be confirmed; check the protected server diagnostics.');
    return completed.result;
  };
  return {
    read,
    runSource(args) { if (!automation) throw Error('Source requests require command automation'); return automation.runSource(args); },
    source(id) { if (!automation) throw Error('Source unavailable'); return automation.source(id); },
    close: () => automation?.close(),
    async run(command, requestKey, context = '', displayContext = '') {
      const classification = validateCommand(command, classify);
      context = callerContext(context); displayContext = callerContext(displayContext);
      if (automation) return automation.run(command, requestKey, context, displayContext);
      // Native operation admission owns idempotency even when optional AI assessment is disabled.
      return { type: 'job', job: classification.class === 'read-only'
        ? queue.submitRead(command, context, displayContext) : queue.submit(command, false, context, displayContext) };
    },
    busy: () => queue.busy() || (automation?.busy() ?? false),
    reading: () => [...queue.jobs.values()].some(job => job.operation.readOnly && job.state === 'running'),
    drain: async () => { await automation?.drain(); await queue.drain(); },
  };
}
