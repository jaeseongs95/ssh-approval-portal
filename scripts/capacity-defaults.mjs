import { capacityDefaults } from '../src/adapters/config/capacity.mjs';

const { queueCapacity, maxConcurrency } = capacityDefaults();
process.stdout.write(JSON.stringify({ BRIDGE_QUEUE_CAPACITY: String(queueCapacity), BRIDGE_MAX_CONCURRENCY: String(maxConcurrency) }));
