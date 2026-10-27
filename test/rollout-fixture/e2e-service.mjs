// Synthetic application instance, executed only in the isolated CI runner.
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const [source, root, adminPort, mcpPort] = process.argv.slice(2);
const {createApplication} = await import(pathToFileURL(resolve(source, 'app.mjs')));
const env = {BRIDGE_MCP_TOKEN:'fixture-mcp', BRIDGE_ADMIN_TOKEN:'fixture-admin',
  BRIDGE_ADMIN_ORIGIN:'https://example.test', BRIDGE_UI_TICKET_KEY:'b'.repeat(64),
  BRIDGE_UI_ENABLED:'true', BRIDGE_COMMAND_AUTOMATION:'false'};
const app = await createApplication({transferRoot:root, env, uiHtml:'',
  registry:{getProfile:name=>({host:'127.0.0.1',port:22,user:'fixture',readOnly:name==='aws-readonly'}),closeAll:async()=>{}},
  classify:()=>({class:'privileged'}), executeCommand:async()=>({texts:[]}), audit:()=>{}});
await Promise.all([new Promise(resolve=>app.adminHttp.listen(Number(adminPort),'127.0.0.1',resolve)),
                   new Promise(resolve=>app.mcpHttp.listen(Number(mcpPort),'127.0.0.1',resolve))]);
process.on('SIGTERM',()=>app.close().then(()=>process.exit(0),()=>process.exit(1)));
