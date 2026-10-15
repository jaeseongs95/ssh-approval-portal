import { createRequire } from 'node:module';
import { loadConfig } from 'ssh-mcp/build/config/loader.js';
import { ConnectionRegistry } from 'ssh-mcp/build/ssh/connection-registry.js';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { SftpClient } from 'ssh-mcp/build/ssh/sftp.js';
import { redactText } from 'ssh-mcp/build/guard/redactor.js';

/** The only adapter coupled to ssh-mcp's versioned internal modules. */
export async function createSshRuntime(settings) {
  if (createRequire(import.meta.url)('ssh-mcp/package.json').version !== '2.18.0') throw Error('Requires ssh-mcp 2.18.0');
  for (const [key, value] of Object.entries(settings)) if (key.startsWith('SSH_MCP_')) process.env[key] = value;
  const config = await loadConfig(settings.BRIDGE_CONFIG_PATH);
  const registry = new ConnectionRegistry(config, settings.BRIDGE_HOST_KEY_MODE ?? 'tofu');
  const auditRedact = text => redactText(text, { entropyScan: true });
  return {
    registry, classify: classifyCommand, auditRedact,
    async executeCommand(profile, command) {
      const result = await (await registry.getOrCreate(profile)).exec(command);
      const failed = result.exitCode !== 0 || Boolean(result.signal);
      const stdout = auditRedact(result.stdout), stderr = auditRedact(result.stderr), parts = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      if (failed) parts.push(result.signal ? `[killed by SIG${result.signal}]` : `[exit ${result.exitCode}]`);
      return { failed, texts: [parts.join('\n\n')] };
    },
  };
}

/** Connections expose a narrow transport contract, never vendor profile objects. */
export function createSshTransport(registry) {
  return {
    async connect(profile) {
      const connection = await registry.getOrCreate(profile);
      const idleTimeoutMs = connection.profile.transferTimeoutMs;
      return {
        call(command, payload) { return connection.exec(command, { stdin: JSON.stringify(payload), timeoutMs: idleTimeoutMs }); },
        upload(source, remotePath, { maxBytes }) {
          return new SftpClient(connection).uploadFile(source, remotePath, { maxBytes, idleTimeoutMs, overwrite: false, mode: 0o600 });
        },
        download(remotePath, destination, { maxBytes }) {
          return new SftpClient(connection).downloadFile(remotePath, destination, { maxBytes, idleTimeoutMs });
        },
      };
    },
  };
}
