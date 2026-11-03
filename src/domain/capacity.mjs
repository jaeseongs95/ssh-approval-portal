export function validateCapacity(value, name = 'capacity') {
  if (!Number.isSafeInteger(value) || value < 1) throw Error(`Invalid ${name}`);
  return value;
}

export function parseCapacity(value, name = 'capacity') {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw Error(`Invalid ${name}`);
  return validateCapacity(Number(value), name);
}
