import { parseUploadHosts, UPLOAD_HOSTS_MAX_BYTES } from '../src/adapters/config/upload-hosts.mjs';

if (import.meta.main) {
  try {
    if (process.versions.node.split('.')[0] !== '24') throw Error('Node24 required');
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > UPLOAD_HOSTS_MAX_BYTES) throw Error('Input too large');
      chunks.push(chunk);
    }
    const value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    process.stdout.write(parseUploadHosts(value).join(','));
  } catch {
    console.error('Upload source validation failed.');
    process.exitCode = 1;
  }
}
