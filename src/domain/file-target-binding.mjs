/** Server-owned flat fields remain part of the existing immutable approval operation. */
export function fileTargetBinding(operation) {
  const { fileTargetId: targetId, fileTargetRevision: targetRevision } = operation;
  if (targetId === undefined && targetRevision === undefined) return undefined;
  if (typeof targetId !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(targetId) ||
      typeof targetRevision !== 'string' || !/^[a-f0-9]{64}$/.test(targetRevision)) throw Error('Invalid file target binding');
  return Object.freeze({ targetId, targetRevision });
}

export function fileTargetFields(binding) {
  if (binding === undefined) return {};
  const fields = { fileTargetId: binding.targetId, fileTargetRevision: binding.targetRevision };
  if (!fileTargetBinding(fields)) throw Error('Invalid file target binding');
  return fields;
}
