import { loadSecrets } from '../src/adapters/config/secrets.mjs';
import { settingsContract, validatedPort } from '../src/adapters/config/settings.mjs';

export async function checkHealth({ env = process.env, file = env.BRIDGE_SECRET_ENV_FILE, expectedAuthMode, fetchImpl = fetch } = {}) {
  const settings = await loadSecrets(env, file);
  const port = validatedPort(settings.BRIDGE_MCP_PORT ?? settingsContract.defaults.BRIDGE_MCP_PORT);
  const response = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw Error('Health request failed');
  const value = await response.json();
  if (value.healthy !== true || (expectedAuthMode && value.adminAuthMode !== expectedAuthMode)) throw Error('Unhealthy bridge');
  return true;
}

if (import.meta.main) {
  try {
    await checkHealth({ file: process.argv[2] ?? process.env.BRIDGE_SECRET_ENV_FILE ?? '/etc/ssh-mcp-approval-bridge.env', expectedAuthMode: process.argv[3] });
  } catch {
    console.error('Bridge health check failed.');
    process.exitCode = 1;
  }
}
