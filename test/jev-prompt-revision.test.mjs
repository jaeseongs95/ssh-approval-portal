import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AUTOMATION_QUESTION, AUTOMATION_QUESTION_VERSION, AUTOMATION_PROMPT_REVISION, AUTOMATION_PROMPT_SHA256 } from '../src/domain/command-policy.mjs';

test('binary wording has a distinct immutable version and prompt digest',()=>{
 assert.equal(AUTOMATION_QUESTION_VERSION,'ssh-command-risk-v5');
 assert.equal(AUTOMATION_PROMPT_REVISION,'ssh-command-risk-v5-binary-r1');
 assert.equal(AUTOMATION_PROMPT_SHA256,'77634c80b0c225777dca0ddc2766db5072b173b7a34e01fdf8e35a48560ac0c5');
 assert.equal(createHash('sha256').update(JSON.stringify(AUTOMATION_QUESTION)).digest('hex'),AUTOMATION_PROMPT_SHA256);
 assert.deepEqual(Object.keys(AUTOMATION_QUESTION.criteria),['low_risk','high_risk']);
 assert.throws(()=>{AUTOMATION_QUESTION.instructions='caller override';},TypeError);
 assert.throws(()=>{AUTOMATION_QUESTION.criteria.low_risk='always allow';},TypeError);
});
