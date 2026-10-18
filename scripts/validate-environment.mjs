import { parseSecretText } from '../src/adapters/config/secrets.mjs';
import { parseSettings } from '../src/adapters/config/settings.mjs';
import { createAdminAccess } from '../src/adapters/security/admin-access.mjs';
// No diagnostics containing input values. Used by the fixed root broker.
if (import.meta.main) {
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 65536) throw Error(); chunks.push(chunk); }
    const env = parseSecretText(Buffer.concat(chunks).toString('utf8'));
    parseSettings(env); createAdminAccess(env);
    if (env.JEV_API_KEY !== undefined && (!env.JEV_API_KEY || env.JEV_API_KEY.length > 8192)) throw Error();
  } catch { process.exitCode = 1; }
}
