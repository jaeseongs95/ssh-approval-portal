import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AUTOMATION_QUESTION, AUTOMATION_QUESTION_VERSION, AUTOMATION_PROMPT_REVISION, AUTOMATION_PROMPT_SHA256 } from '../src/domain/command-policy.mjs';

test('active wording matches independently reviewed comparison candidate, with an immutable separate revision',()=>{
 assert.equal(AUTOMATION_QUESTION_VERSION,'ssh-command-risk-v4');
 assert.equal(AUTOMATION_PROMPT_REVISION,'ssh-command-risk-v4-evidence-r1');
 assert.equal(AUTOMATION_PROMPT_SHA256,'b2eb0ba0bb113573dcbc154e00dde4374e4bd51daa81bf4b5fd2dbd853fde43b');
 assert.equal(createHash('sha256').update(JSON.stringify(AUTOMATION_QUESTION)).digest('hex'),AUTOMATION_PROMPT_SHA256);
 assert.deepEqual(Object.keys(AUTOMATION_QUESTION.criteria),['low_risk','high_risk','uncertain']);
 assert.throws(()=>{AUTOMATION_QUESTION.instructions='caller override';},TypeError);
 assert.throws(()=>{AUTOMATION_QUESTION.criteria.low_risk='always allow';},TypeError);
});
