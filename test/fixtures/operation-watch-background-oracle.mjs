import { readFile } from 'node:fs/promises';

// Consume only the explicitly supplied, newly created host stdout JSONL file.
// This oracle checks observed ordering. The runner must separately preserve one
// initial prompt, native background tool receipts and absence of polling.
const id = 'a'.repeat(48), chunks = [];
const text = value => {
  if (typeof value === 'string') chunks.push(value);
  else if (Array.isArray(value)) for (const item of value) {
    if (item?.type === 'text') text(item.text);
    else if (item?.type === 'tool_result') text(item.content);
  }
};
try {
  if (process.argv.length !== 3) throw Error();
  const source = await readFile(process.argv[2], 'utf8');
  if (source.length > 16 * 1024 * 1024) throw Error();
  for (const line of source.split(/\r?\n/).filter(Boolean)) {
    const record = JSON.parse(line), kind = record.type ?? record.event;
    // Codex JSONL: use tool output/message text, never command arguments.
    if (kind === 'item.completed') {
      if (record.item?.type === 'command_execution') text(record.item.aggregated_output);
      if (record.item?.type === 'agent_message') text(record.item.text);
    }
    // Claude stream-json: assistant text and tool results in user envelopes.
    if (record.message?.role === 'assistant') text(record.message.content);
    if (record.message?.role === 'user') for (const block of record.message.content ?? []) {
      if (block?.type === 'tool_result') text(block.content);
    }
    // agy/Gemini variants: output fields only; ignore tool-call input and prompts.
    if (kind === 'tool_result') text(record.output ?? record.result?.output ?? record.result);
    if (kind === 'message' && record.role === 'assistant') text(record.content);
    if (kind === 'result') text(typeof record.result === 'string' ? record.result : record.result?.response ?? record.response);
  }
  const observed = chunks.join('\n'), lines = observed.split(/\r?\n/);
  let other = -1, finished = -1, followup = -1, terminalCount = 0;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === 'OTHER_DONE' && other < 0) other = index;
    try {
      const event = JSON.parse(line);
      if (event.event === 'operation.finished' && event.id === id && event.state === 'completed') {
        terminalCount++; if (finished < 0) finished = index;
      }
    } catch { /* Ordinary host text is not an operation event. */ }
    if (line.trim() === 'FOLLOWUP_DONE ' + id + ' completed' && followup < 0) followup = index;
  }
  const passed = other >= 0 && finished > other && followup > finished;
  const unsupported = !passed && observed.includes('BACKGROUND_UNSUPPORTED');
  process.stdout.write(JSON.stringify({ status: passed ? 'PASS' : unsupported ? 'NOT_SUPPORTED' : 'FAIL',
    otherObserved: other >= 0, completionObserved: finished >= 0, followupObserved: followup >= 0,
    ordered: passed, terminalRecords: terminalCount,
    hostMechanismReviewRequired: true, extraUserInputReviewRequired: true }) + '\n');
  process.exitCode = passed ? 0 : unsupported ? 2 : 1;
} catch {
  process.stderr.write('{"error":"INVALID_HOST_STDOUT_TRACE"}\n'); process.exitCode = 1;
}
