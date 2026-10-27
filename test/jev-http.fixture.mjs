import { createServer } from 'node:http';

// Independent TypeSafe wire fixture. Never imports production encoders/validators.
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const fixtureChoice = () => ({ model: 'jev-1.14.0', answers: { risk: {
  type: 'choice', choice: 'low_risk', confidence: 1, probabilities: { low_risk: 1, high_risk: 0 },
} }, usage: { input_tokens: 20, output_tokens: 4 } });

/** Test-owned loopback server, scenario replies only; it never executes commands. */
export async function createJevFixture(replies = []) {
  const records = [], sockets = new Set();
  const heldClose = Promise.withResolvers();
  let closedHeldResponses = 0;
  const server = createServer(async (req, res) => {
    const record = { method: req.method, path: req.url, valid: false, bytes: 0 };
    records.push(record);
    const refuse = status => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":"fixture_contract_mismatch"}'); };
    try {
      if (req.url !== '/v1/systemone') return refuse(404);
      if (req.method !== 'POST') return refuse(405);
      if (req.headers.authorization !== 'Bearer fixture-only-token') return refuse(401);
      if (req.headers['content-type'] !== 'application/json') return refuse(415);
      const chunks = [];
      for await (const chunk of req) {
        record.bytes += chunk.length;
        if (record.bytes > 24 * 1024) return refuse(413);
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { return refuse(400); }
      if (!exact(body, ['model', 'state', 'questions']) || body.model !== 'jev-1.14.0'
        || !exact(body.state, ['command', 'target', 'environment', 'context'])
        || !Object.values(body.state).every(value => typeof value === 'string' && value.trim() && value.length <= 4096)
        || !exact(body.questions, ['risk']) || !exact(body.questions.risk, ['type', 'instructions', 'criteria'])
        || body.questions.risk.type !== 'choice' || typeof body.questions.risk.instructions !== 'string' || !body.questions.risk.instructions.trim()
        || !exact(body.questions.risk.criteria, ['low_risk', 'high_risk'])
        || !Object.values(body.questions.risk.criteria).every(value => typeof value === 'string' && value.trim())) return refuse(422);
      record.valid = true;
      record.stateKeys = Object.keys(body.state);
      const reply = replies.shift() || {};
      if (reply.hold) res.once('close', () => { closedHeldResponses++; heldClose.resolve(); });
      if (reply.hold === 'headers') return;
      res.writeHead(reply.status || 200, { 'content-type': 'application/json', ...reply.headers });
      if (reply.hold === 'body') { res.write('{"model":'); return; }
      if (reply.fragments) { for (const chunk of reply.fragments) res.write(chunk); res.end(); }
      else res.end(reply.raw ?? JSON.stringify(reply.body ?? fixtureChoice()));
    } catch { if (!res.destroyed) res.destroy(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, records,
    get closedHeldResponses() { return closedHeldResponses; },
    async waitForHeldClose() {
      let timer;
      try { await Promise.race([heldClose.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Held response was not cancelled')), 2000); })]); }
      finally { clearTimeout(timer); }
    },
    // Redirect only the fixed production endpoint through test-owned wiring.
    // All HTTP behavior (including redirect and AbortSignal) is real Node fetch.
    async fetchImpl(url, options) {
      if (url !== 'https://api.typesafe.ai/v1/systemone') throw Error('Unexpected external route');
      return fetch(origin + '/v1/systemone', options);
    },
    async close() {
      const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await done;
    },
  };
}
