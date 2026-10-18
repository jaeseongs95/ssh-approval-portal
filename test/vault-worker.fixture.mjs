// Fixed public MCP probe. The parent selects only production source via /tmp/vault-source.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

let application, client, stage = 'bootstrap', calls = 0;
const audit = [];
const bootStarted = performance.now();
const progress = () => process.send?.({kind:'progress',stage,elapsedMs:Math.round(performance.now()-bootStarted)});
try {
  stage='config';progress();
  const config = JSON.parse(await readFile(process.env.VAULT_FIXTURE_CONFIG, 'utf8'));
  stage='client_imports';progress();
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  stage='application_import';progress();
  const { createApplication } = await import(pathToFileURL('/tmp/vault-source/app.mjs'));
  const { JEV_ENDPOINT } = await import(pathToFileURL('/tmp/vault-source/src/adapters/safety/jev.mjs'));
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) !== JEV_ENDPOINT) return nativeFetch(url, options);
    calls++;
    assert.ok(options.headers.Authorization === 'Bearer ' + config.expectedKey, 'MODEL_CREDENTIAL_VERSION');
    return new Response(JSON.stringify({ model:'jev-1.14.0', answers:{ risk:{ type:'choice', choice:'low_risk', confidence:1,
      probabilities:{ low_risk:1, high_risk:0, uncertain:0 } } }, usage:{ input_tokens:10, output_tokens:1 } }), { headers:{ 'content-type':'application/json' } });
  };
  stage = 'application';progress();
  application = await createApplication({
    registry:{ getProfile:name => ({ host:'127.0.0.1', port:22, user:'synthetic', readOnly:name === 'aws-readonly' }), closeAll:async () => {} },
    classify:() => ({ class:'privileged' }), executeCommand:() => assert.fail('UNEXPECTED_SSH_EXECUTION'),
    audit:event => audit.push(event), transferRoot:config.transferRoot, uiHtml:'<html>fixture</html>', env:config.env,
  });
  stage='mcp_connect';progress();
  await new Promise(resolve => application.mcpHttp.listen(0,'127.0.0.1',resolve));
  client = new Client({ name:'vault-local-probe', version:'1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${application.mcpHttp.address().port}/mcp`), { requestInit:{ headers:{ Authorization:'Bearer fixture-mcp' } } }));
  assert.ok((await client.listTools()).tools.every(item => !/secret/.test(item.name)), 'NO_SECRET_TOOLS');
  stage = 'ready';progress();process.send({ kind:'ready', pid:process.pid });
  process.on('message', async message => {
    try {
      if (message.kind === 'stop') {
        await client.close(); await application.close(); process.send({ kind:'stopped' }); process.disconnect(); return;
      }
      assert.ok(message.kind === 'assess', 'FIXTURE_ACTION');
      stage = 'assessment';
      const before = calls;
      const job = (await client.callTool({ name:'run-command', arguments:{ command:'sudo id' } })).structuredContent;
      const result = (await client.callTool({ name:'assess-request-risk', arguments:{ id:job.id, externalDisclosureApproved:true } })).structuredContent;
      assert.ok(application.queue.get(job.id).state === 'pending', 'NO_MODEL_EXECUTION_AUTHORITY');
      const visible = JSON.stringify({ result, audit });
      assert.ok(!visible.includes(config.expectedKey) && !visible.includes(config.readerToken), 'CREDENTIAL_NOT_VISIBLE');
      process.send({ kind:'assessment', status:result.assessment.status, calls:calls-before });
    } catch { process.send({ kind:'error', stage }); }
  });
} catch { process.send?.({ kind:'error', stage }); process.exitCode = 2; process.disconnect?.(); }
