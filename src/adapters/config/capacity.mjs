import { availableParallelism } from 'node:os';

export function validateCapacity(value, name = 'capacity') {
  if (!Number.isSafeInteger(value) || value < 1) throw Error(`Invalid ${name}`);
  return value;
}

export function parseCapacity(value, name = 'capacity') {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw Error(`Invalid ${name}`);
  return validateCapacity(Number(value), name);
}

export function capacityDefaults(cpus = availableParallelism()) {
  const availableCpus = validateCapacity(cpus, 'available CPU count');
  return { availableCpus, queueCapacity: validateCapacity(availableCpus * 10, 'queue capacity'), maxConcurrency: availableCpus };
}
