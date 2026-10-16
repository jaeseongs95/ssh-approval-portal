import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { SecretError } from '../../application/secret-service.mjs';

/** Human-owned terminal only; typed bytes are discarded by the echo sink. */
export async function readHiddenSecret(prompt, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || !output.isTTY) throw new SecretError('terminal_required');
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input, output: muted, terminal: true, historySize: 0 });
  let outputFailed = false, onOutputError;
  try {
    return await new Promise((resolve, reject) => {
      onOutputError = () => { outputFailed = true; reject(new SecretError('input_cancelled')); };
      output.once('error', onOutputError);
      reader.once('SIGINT', () => reject(new SecretError('input_cancelled')));
      reader.once('close', () => reject(new SecretError('input_cancelled')));
      reader.once('error', () => reject(new SecretError('input_cancelled')));
      try { output.write(prompt); reader.question('', resolve); } catch { onOutputError(); }
    });
  } finally {
    reader.close(); muted.end(); if (onOutputError) output.removeListener('error', onOutputError);
    if (!outputFailed && !output.destroyed) output.write('\n');
  }
}
