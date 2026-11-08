import { openCompletionInbox } from '../../src/adapters/cli/completion-inbox.mjs';

// Synthetic TEST-only worker. It never resolves another session or invokes a host/SSH command.
let inbox, input;
const reportError = error => {
  process.send({ type: 'error', code: error.code ?? error.name }, () => process.exit(1));
};
process.on('message', message => {
  try {
    if (message.type === 'prepare') {
      input = message.input;
      inbox = openCompletionInbox({ filePath: input.filePath, now: () => input.now });
      process.send({ type: 'ready' });
    } else if (message.type === 'go') {
      const value = input.action === 'enqueue'
        ? inbox.enqueue({ bindingId: input.bindingId, origin: input.origin, event: input.event })
        : inbox.claim({ bindingId: input.bindingId, limit: input.limit ?? 8, leaseMs: input.leaseMs ?? 30000 });
      process.send({ type: 'result', value }, () => {
        if (input.crashAfterClaim) process.exit(23); // Deliberately bypass close/ACK after the committed claim.
        inbox.close();
        process.disconnect();
      });
    }
  } catch (error) { reportError(error); }
});
