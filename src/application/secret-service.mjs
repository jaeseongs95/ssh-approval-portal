/** References and ports only. No filesystem, provider SDK, or MCP value endpoint. */
export class SecretError extends Error {
  constructor(code) { super('Secret operation refused'); this.code = code; }
}

export function parseSecretReference(reference) {
  const match = typeof reference === 'string' && /^secret:\/\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/.exec(reference);
  if (!match) throw new SecretError('invalid_reference');
  return { provider: match[1], name: match[2] };
}

export function createSecretService(providers) {
  const registered = Object.freeze({ ...providers });
  const select = reference => {
    const { provider, name } = parseSecretReference(reference);
    if (!Object.hasOwn(registered, provider)) throw new SecretError('provider_unavailable');
    return { port: registered[provider], name };
  };
  return Object.freeze({
    async resolve(reference) { const { port, name } = select(reference); return port.read(name); },
    async describe(reference) { const { port, name } = select(reference); return port.describe(name); },
    async put(reference, value) { const { port, name } = select(reference); return port.put(name, value); },
    async remove(reference) { const { port, name } = select(reference); return port.remove(name); },
  });
}
