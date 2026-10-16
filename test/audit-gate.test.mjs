import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAuditPass } from '../scripts/audit-gate.mjs';

test('deployment gate reads exactly one final verdict and ignores PASS elsewhere', () => {
  for (const report of ['tests PASS\n## Gate\nFAIL', 'DEPLOYED_PASS\n## Gate\nBLOCKED',
    'all tests PASS', '## Gate\nPASS\n## Gate\nPASS', '## Gate\nPASS\nFAIL',
    '## Gate\nBLOCKED\nPASS', '## Gate\nPASS PASS', '## Gate\n', '## Gate\nPASSAGE']) {
    assert.throws(() => requireAuditPass(report), /unambiguous PASS/);
  }
  for (const report of ['## Gate\nPASS', 'tests PASS\n## Gate\n**PASS — local gate**\n\n## Limitations\nNo live validation.',
    '## Gate\r\n**PASS**\r\n## Other\r\nFAIL was a previous result.']) assert.equal(requireAuditPass(report), 'PASS');
});
