import { parseSecretReference } from './secret-service.mjs';

/** The server operator provisions the reference via the existing secret store;
 * request arguments and editable administrator settings cannot grant this capability.
 * Resolve on every check: a startup snapshot must not outlive secret revocation.
 */
export function createTestServerMode({ reference, resolver }) {
  const available = async () => {
    if (!reference) return false;
    try {
      parseSecretReference(reference);
      const value = await resolver.resolve(reference);
      return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    } catch { return false; }
  };
  return Object.freeze({
    available,
    async require() { if (!await available()) throw Error('Test server capability unavailable'); },
  });
}
