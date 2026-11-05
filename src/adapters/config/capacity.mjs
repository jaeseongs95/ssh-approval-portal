import { availableParallelism } from 'node:os';
import { validateCapacity } from '../../domain/capacity.mjs';
export { validateCapacity, parseCapacity } from '../../domain/capacity.mjs';

export function capacityDefaults(cpus = availableParallelism()) {
  const availableCpus = validateCapacity(cpus, 'available CPU count');
  return { availableCpus, queueCapacity: validateCapacity(availableCpus * 10, 'queue capacity'), maxConcurrency: availableCpus };
}
