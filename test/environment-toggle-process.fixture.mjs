// Loopback-only integration fixture; stdin closes the application cleanly.
import {createApplication} from '../app.mjs';
const [root, automation] = process.argv.slice(2);
const env = {BRIDGE_MCP_TOKEN:'test-mcp', BRIDGE_ADMIN_TOKEN:'test-admin', BRIDGE_ADMIN_ORIGIN:'https://example.test', BRIDGE_UI_TICKET_KEY:'b'.repeat(64), BRIDGE_UI_ENABLED:'true', BRIDGE_COMMAND_AUTOMATION:automation};
const registry = {getProfile:name=>({host:'127.0.0.1',port:22,user:'fixture',readOnly:name==='aws-readonly'}), closeAll:async()=>{}};
const app = await createApplication({transferRoot:root, env, registry, uiHtml:'', classify:()=>({class:'privileged'}), executeCommand:async()=>({texts:[]}), audit:()=>{}});
await new Promise(resolve=>app.adminHttp.listen(0,'127.0.0.1',resolve));
console.log(app.adminHttp.address().port);
await new Promise(resolve=>process.stdin.once('data',resolve));
await app.close();
