import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandImport } from '../web/src/command-line-import.js';
import { commandLineNames } from '../src/domain/command-line.mjs';
test('import names reuse actual policy grammar for pipes sudo quoting and literal nested commands', () => {
  for (const line of ['pwd && ls -la | grep home','sudo -u root id','ls "$(id)"',"printf 'rm -rf /'",'bash -lc "ls && pwd"','ls >$(pwd)','env CMD=rm sh -c "$CMD"','python3 -c "print(1)"','pwd;pwd && ls']) {
    const a = parseCommandImport(line), b = commandLineNames(line); assert.equal(a.complete, true, line); assert.deepEqual(a.names, b.names); assert.equal(a.usesSudo, b.usesSudo);
  }
  assert.deepEqual(parseCommandImport('pwd;pwd && ls').names, ['pwd','ls']);
  for (const [source,names] of [['pwd && ls -la | grep home',['pwd','ls','grep']],["printf 'rm -rf /'",['printf']],['python3 -c "print(1)"',['python3']],['env CMD=rm sh -c "$CMD"',['env']]]) assert.deepEqual(parseCommandImport(source).names,names);
});
test('unsupported input never returns partial preapproval candidates', () => {
  for (const source of ['pwd &&','pwd; $CMD','pwd\nrm /tmp/example','cat <<EOF','if true; then id; fi','/usr/bin/ls','pwd $(id','pwd <(id)','pwd\0ls','pwd "unterminated']) {
    const result = parseCommandImport(source); assert.equal(result.complete, false, source); assert.deepEqual(result.names, []);
  }
});
test('32KiB UTF-8 and80 name limits agree with existing policies without truncation', () => {
  assert.equal(parseCommandImport('ls'+' '.repeat(32766)).complete, true); assert.equal(parseCommandImport('ls'+' '.repeat(32767)).reason, 'length');
  assert.equal(parseCommandImport('a'.repeat(80)).complete, true); const long = parseCommandImport('pwd && '+'a'.repeat(81)); assert.equal(long.reason, 'name_length'); assert.deepEqual(long.names, []);
});
test('empty and non-string input do not coerce or execute supplied values', () => {
  for (const source of ['', '   ', null, 1, { toString() { assert.fail('Must not coerce command input'); } }]) assert.equal(parseCommandImport(source).complete, false);
});
