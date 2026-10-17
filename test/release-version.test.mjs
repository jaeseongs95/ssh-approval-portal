import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('the installer release-id helper derives version and identity from its actual source package', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-version-'));
  try {
    const manifest = '{"fixture":"public"}\n';
    writeFileSync(join(root, 'release-manifest.json'), manifest);
    for (const version of ['1.2.0', '2.0.0-preview.1']) {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
      const result = spawnSync(process.execPath, ['scripts/release-id.mjs', root], { encoding: 'utf8' });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), version + '-' + createHash('sha256').update(manifest).digest('hex').slice(0, 16));
    }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '../escape' }));
    assert.notEqual(spawnSync(process.execPath, ['scripts/release-id.mjs', root], { encoding: 'utf8' }).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
