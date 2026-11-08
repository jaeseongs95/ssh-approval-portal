import { readFile } from 'node:fs/promises';

// Consume only the explicitly supplied, newly created host stdout JSONL file.
// Revision 2 corrects an extraction boundary, not the completion requirement:
// Claude Read returns canonical file.content plus a numbered display of it.
// Prefer canonical content once, and allow numbered JSON only as a fallback.
// Original trial/oracle receipts remain owned and preserved by the runner.
// The runner must separately preserve one initial prompt and tool receipts.
const id = 'a'.repeat(48), chunks = [], notifications = [], resultReads = [];
let recordIndex = -1;
const text = value => {
  if (typeof value === 'string') chunks.push({ value, recordIndex });
  else if (Array.isArray(value)) for (const item of value) {
    if (item?.type === 'text') text(item.text);
    else if (item?.type === 'tool_result') text(item.content);
  }
};
function notification(record, kind) {
  const subtype = record.subtype ?? record.event ?? record.data?.type;
  if (kind === 'system' && ['task_notification', 'task-notification'].includes(subtype)) {
    const raw = record.status ?? record.task_status ?? record.data?.status;
    notifications.push({ recordIndex, source: 'system.task_notification',
      status: ['completed', 'failed', 'stopped'].includes(raw) ? raw : 'unknown' });
  }
  // Host-generated task notifications can arrive in a user message envelope.
  // Only the notification grammar is examined; user prompt text is not output.
  if (record.message?.role === 'user') for (const block of record.message.content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    if (!/^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/.test(block.text)) continue;
    const status = block.text.match(/<status>(completed|failed|stopped)<\/status>/)?.[1] ?? 'unknown';
    notifications.push({ recordIndex, source: 'message.task_notification', status });
  }
}
try {
  if (process.argv.length !== 3) throw Error();
  const source = await readFile(process.argv[2], 'utf8');
  if (source.length > 16 * 1024 * 1024) throw Error();
  for (const line of source.split(/\r?\n/).filter(Boolean)) {
    recordIndex++;
    const record = JSON.parse(line), kind = record.type ?? record.event;
    notification(record, kind);
    // Codex JSONL: use tool output/message text, never command arguments.
    if (kind === 'item.completed') {
      if (record.item?.type === 'command_execution') text(record.item.aggregated_output);
      if (record.item?.type === 'agent_message') text(record.item.text);
    }
    // Claude stream-json: assistant text and tool results in user envelopes.
    if (record.message?.role === 'assistant') {
      text(record.message.content);
      for (const block of record.message.content ?? []) if (block?.type === 'tool_use' && block.name === 'Read') resultReads.push(recordIndex);
    }
    const fileContent = record.tool_use_result?.file?.content;
    if (typeof fileContent === 'string') text(fileContent);
    else if (record.message?.role === 'user') for (const block of record.message.content ?? []) {
      if (block?.type === 'tool_result') text(block.content);
    }
    // agy/Gemini variants: output fields only; ignore tool-call input and prompts.
    if (kind === 'tool_result') text(record.output ?? record.result?.output ?? record.result);
    if (kind === 'message' && record.role === 'assistant') text(record.content);
    if (kind === 'result') text(typeof record.result === 'string' ? record.result : record.result?.response ?? record.response);
  }
  const observed = chunks.map(chunk => chunk.value).join('\n');
  let other = -1, finished = -1, followup = -1, terminalCount = 0;
  let index = 0, otherRecord = -1, finishedRecord = -1;
  for (const chunk of chunks) for (const line of chunk.value.split(/\r?\n/)) {
    if (line.trim() === 'OTHER_DONE' && other < 0) other = index;
    if (line.trim() === 'OTHER_DONE' && otherRecord < 0) otherRecord = chunk.recordIndex;
    try {
      // Strip only a display line-number prefix immediately before JSON. The
      // parsed object's exact event/id/state still decides whether it counts.
      const event = JSON.parse(line.replace(/^\s*[1-9][0-9]*\t(?=\s*\{)/, ''));
      if (event.event === 'operation.finished' && event.id === id && event.state === 'completed') {
        terminalCount++; if (finished < 0) { finished = index; finishedRecord = chunk.recordIndex; }
      }
    } catch { /* Ordinary host text is not an operation event. */ }
    if (line.trim() === 'FOLLOWUP_DONE ' + id + ' completed' && followup < 0) followup = index;
    index++;
  }
  const passed = other >= 0 && finished > other && followup > finished;
  const unsupported = !passed && observed.includes('BACKGROUND_UNSUPPORTED');
  const completedNotice = notifications.find(item => item.status === 'completed');
  process.stdout.write(JSON.stringify({ status: passed ? 'PASS' : unsupported ? 'NOT_SUPPORTED' : 'FAIL',
    otherObserved: other >= 0, completionObserved: finished >= 0, followupObserved: followup >= 0,
    ordered: passed, terminalRecords: terminalCount,
    oracleRevision: 2,
    automaticNotification: { status: completedNotice ? 'observed' : 'unknown', records: notifications.length,
      sources: [...new Set(notifications.map(item => item.source))],
      afterIndependentBeforeCompletion: completedNotice ? completedNotice.recordIndex > otherRecord && completedNotice.recordIndex <= finishedRecord : null },
    resultReads: { count: resultReads.length,
      beforeCompletionNotification: completedNotice ? resultReads.filter(position => position < completedNotice.recordIndex).length : null,
      afterCompletionNotification: completedNotice ? resultReads.filter(position => position > completedNotice.recordIndex).length : null },
    hostMechanismReviewRequired: true, extraUserInputReviewRequired: true }) + '\n');
  process.exitCode = passed ? 0 : unsupported ? 2 : 1;
} catch {
  process.stderr.write('{"error":"INVALID_HOST_STDOUT_TRACE"}\n'); process.exitCode = 1;
}
