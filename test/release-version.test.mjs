import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

test('Docker defaults and delivery instructions match the current package version', () => {
  const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const version = JSON.parse(read('package.json')).version;
  const archive = 'dist/ssh-approval-portal-' + version + '.tar.gz';
  assert.ok(read('docker/Dockerfile').includes('ARG PACKAGE_ARCHIVE=' + archive + '\n'));
  assert.ok(read('.dockerignore').split('\n').includes('!' + archive));
  assert.ok(read('docker/compose.yaml').includes('$' + '{BRIDGE_IMAGE:-ssh-approval-portal:' + version + '}'));
  assert.ok(read('config/docker.example.env').includes('BRIDGE_IMAGE=ssh-approval-portal:' + version + '\n'));
  for (const file of ['README.md', 'README.ko.md']) {
    assert.ok(read(file).startsWith('# SSH Approval Portal ' + version + '\n'));
    assert.ok(read(file).includes('ssh-approval-portal-' + version + '.tar.gz'));
  }
});
