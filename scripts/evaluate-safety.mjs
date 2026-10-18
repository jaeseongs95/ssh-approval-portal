#!/usr/bin/env node
import { readFile, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { SAFETY_PROTOCOL, SAFETY_QUESTION, SAFETY_LABELS } from '../src/domain/safety.mjs';
import { evaluateSafety } from '../src/application/safety-evaluation.mjs';
import { createJevAssessor } from '../src/adapters/safety/jev.mjs';

const sha256 = data => 'sha256:' + createHash('sha256').update(data).digest('hex');
const sources = ['scripts/evaluate-safety.mjs','src/domain/safety.mjs','src/application/safety-evaluation.mjs','src/adapters/safety/jev.mjs'];

/** Only the repository's synthetic corpus is accepted. No live SSH jobs/configs are read. */
export async function runSafetyEvaluation({ mode = 'replay', apiKey, fetchImpl } = {}) {
  if (!['replay', 'live'].includes(mode)) throw Error('Invalid evaluation mode');
  const startedAt = new Date().toISOString();
  const corpusBytes = await readFile(new URL('../test/fixtures/safety-corpus.json', import.meta.url));
  const corpus = JSON.parse(corpusBytes);
  if (corpus.syntheticOnly !== true || corpus.qualification !== 'development-smoke-only') throw Error('Invalid synthetic corpus');
  const sourceFiles = Object.fromEntries(await Promise.all(sources.map(async path => [path, sha256(await readFile(new URL('../' + path, import.meta.url)))])));
  let replayBytes, assessor;
  if (mode === 'live') {
    if (!apiKey) throw Error('TYPESAFE_API_KEY is required');
    assessor = createJevAssessor({ apiKey, fetchImpl });
  } else {
    replayBytes = await readFile(new URL('../test/fixtures/safety-replay.json', import.meta.url));
    const replay = JSON.parse(replayBytes);
    if (replay.source !== 'simulated' || replay.predictions.length !== corpus.cases.length
      || replay.predictions.some(label => label !== null && !SAFETY_LABELS.includes(label))) throw Error('Invalid replay fixture');
    let index = 0;
    assessor = { async assess() {
      const label = replay.predictions[index++];
      return label === null ? { status: 'unavailable', reason: 'http_error' } : {
        status: 'assessed', model: SAFETY_PROTOCOL.model, label, confidence: 1,
        probabilities: Object.fromEntries(SAFETY_LABELS.map(option => [option, Number(option === label)])), inputTokens: 100, outputTokens: 20,
      };
    } };
  }
  // Injected transports include local contract servers, never real-model evidence.
  const transport = mode === 'replay' ? 'replay' : fetchImpl === undefined ? 'typesafe-https' : 'injected';
  const report = await evaluateSafety({ cases: corpus.cases, assessor, source: transport === 'typesafe-https' ? 'live' : 'simulated' });
  return { ...report, runId: randomUUID(), startedAt, finishedAt: new Date().toISOString(),
    datasetVersion: corpus.version, datasetDigest: sha256(corpusBytes),
    protocolDigest: sha256(JSON.stringify({ protocol: SAFETY_PROTOCOL, question: SAFETY_QUESTION })),
    sourceFiles, transport, replayDigest: replayBytes ? sha256(replayBytes) : null,
    requestedModel: SAFETY_PROTOCOL.model, actualCostUsd: null,
    usageComplete: report.unavailable === 0,
    qualification: 'development-smoke-only',
    limitations: ['No production-risk qualification or approved automation threshold.', 'Timeout/error can still incur provider charges.',
      ...(transport !== 'typesafe-https' ? ['Simulated outputs: no model accuracy measured; usage values are synthetic.'] : [])] };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4 || argv[0] !== '--mode' || !['replay', 'live'].includes(argv[1]) || argv[2] !== '--out' || !argv[3]) {
    console.error('Usage: node scripts/evaluate-safety.mjs --mode replay|live --out NEW_REPORT.json'); return 2;
  }
  // Reserve exclusive output before any paid call. Never overwrite previous evidence.
  let file;
  try {
    if (argv[1] === 'live' && !process.env.TYPESAFE_API_KEY) throw Error('Missing key');
    file = await open(resolve(argv[3]), 'wx', 0o600);
    const report = await runSafetyEvaluation({ mode: argv[1], apiKey: process.env.TYPESAFE_API_KEY });
    await file.writeFile(JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ source: report.source, total: report.total, assessed: report.assessed,
      unavailable: report.unavailable, falseCandidates: report.falseCandidates, stage5Ready: false }));
    return report.unavailable ? 1 : 0;
  } catch {
    // Never log provider errors, key values, command bodies, or operator paths.
    if (file) await file.writeFile(JSON.stringify({ schemaVersion: '1.0.0', status: 'failed', stage5Ready: false }) + '\n').catch(() => {});
    console.error('Evaluation could not complete. Check arguments, key presence, and a new writable output path.');
    return 2;
  } finally { await file?.close(); }
}

if (import.meta.main) process.exitCode = await main();
