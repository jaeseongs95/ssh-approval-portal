import { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalQueue as ProductionApprovalQueue } from '../../src/domain/approval-queue.mjs';
import { createOperationStore } from '../../src/adapters/storage/operation-store.mjs';
import { createOperationScheduler } from '../../src/domain/operation-scheduler.mjs';

// Unit fixtures use the same durable admission and dispatch path as production.
export class ApprovalQueue extends ProductionApprovalQueue {
  constructor(ports) {
    const root = mkdtempSync(join(tmpdir(), 'approval-runtime-'));
    const now = ports.now ?? Date.now;
    let operationStore, scheduler, queue;
    try {
      operationStore = createOperationStore({ filePath: join(root, 'operations.sqlite'), now });
      scheduler = createOperationScheduler({ store: operationStore, now,
        globalConcurrency: 1, targetConcurrency: 1,
        queueCapacity: 100, targetQueueCapacity: 100,
        execute: (record, options) => queue.executeScheduled(record.id, options),
        onChange: record => queue?.syncOperation(record) });
      super({ ...ports, operationStore, scheduler });
    } catch (error) { scheduler?.close(); operationStore?.close(); rmSync(root, { recursive: true, force: true }); throw error; }
    queue = this;
    scheduler.configure({ queueCapacity: this.requestCapacity, targetQueueCapacity: this.requestCapacity });
    after(async () => {
      try { queue.maintenance = true; await queue.drain(); }
      finally { scheduler.close(); operationStore.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
}