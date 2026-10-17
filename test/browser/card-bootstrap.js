const calls = [], waiting = new Map();
const contexts = [];
let held = '';
const job = { id: 'old-A', kind: 'command', state: 'completed', command: 'fixture A', target: 'fixture', expiresAt: Date.now() + 60000 };
async function call(name, args, namespace) {
  calls.push({ name, args, namespace });
  if (name === held) await new Promise(resolve => waiting.set(name, resolve));
  if (name === 'show-file-transfer' && args.target) return { structuredContent: { transfer: args, uiEnabled: true, maxBytes:67108864 }, _meta: { sshApproval: { uiEnabled:true, namespace:'fixture_', maxBytes:67108864, chunkBytes:2, bootstrapTicket:'synthetic-bootstrap', targetId:args.target, targetRevision:args.target+'-v1', targetDisplayName:args.target+' 이름', targets:['alpha','beta'].map(id=>({id,displayName:id+' 이름',enabled:true})) } } };
  if (name === 'show-file-transfer') return { _meta: { sshApproval: { bootstrapTicket: 'synthetic-bootstrap' } } };
  if (name === 'ui-upload-begin') return { structuredContent: { transferId: 'synthetic-upload' }, _meta: { sshApproval: { uploadTicket: 'synthetic-ticket' } } };
  if (name === 'ui-upload-finish') return { structuredContent: job, _meta: { sshApproval: {} } };
  if (name === 'show-approval') return { _meta: { sshApproval: { viewTicket: 'synthetic-view' } } };
  if (name === 'ui-download-link') return { _meta: { sshApproval: { downloadUrl:'https://fixture.test/file?ticket=synthetic-download-ticket',fileName:'fixture.txt' } } };
  if (name === 'ui-read-command-output') return { structuredContent: { outputId: args.outputId, offsetBytes: args.offsetBytes, nextOffset: args.offsetBytes + 20, totalBytes: 20, eof: true }, _meta: { sshOutput: { text: 'EXPLICIT_OUTPUT_SENTINEL' } } };
  return {};
}
const host = { call, downloadFile: async () => ({}), openLink: async args => {calls.push({name:'host-open-link',args});return {};}, updateModelContext: async value => { contexts.push(value); return {}; } };
const source = await (await fetch('/fixture/card-source')).text();
let receive;
if (source.startsWith('import { App }')) {
  window.FixtureApp = class {
    constructor() { window.fixtureApp = this; }
    callServerTool({ name, arguments: args }) { return call(name.replace(/^fixture_/, ''), args, 'fixture_'); }
    connect() { return Promise.resolve(); }
    getHostContext() { return {}; }
    updateModelContext(value) { contexts.push(value); return Promise.resolve({}); }
    openLink() { return Promise.resolve({}); }
    downloadFile() { return Promise.resolve({}); }
  };
  await import('/fixture/legacy-card.js');
  receive = result => window.fixtureApp.ontoolresult(result);
} else {
  const [{ createCardController }, { createCardState }, { createCardView }, { createCardI18n }] = await Promise.all([
    import('/ui/src/controller.js'), import('/ui/src/state.js'), import('/ui/src/view.js'), import('/ui/src/i18n.js'),
  ]);
  const view = createCardView({ document, i18n: createCardI18n(navigator.language) });
  const controller = createCardController({ state: createCardState(), view, host, document,
    hashFile: async file => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join(''),
    encodeFileChunk: async (file, start, end) => btoa(String.fromCharCode(...new Uint8Array(await file.slice(start, end).arrayBuffer()))),
  });
  view.initialize(controller.openWeb); receive = controller.receive;
}
window.fixture = { calls, contexts, hold: name => { held = name; }, release: name => { held = ''; waiting.get(name)?.(); }, receive,
  transfer: (path, target) => receive({ structuredContent: { transfer: { ...(target ? {target} : {}), direction: 'upload', remotePath: path, elevate: false, overwrite: false } },
    _meta: { sshApproval: { ...(target ? {targetId:target,targetRevision:target+'-v1',targetDisplayName:target+' 이름',targets:['alpha','beta'].map(id=>({id,displayName:id+' 이름',enabled:true}))} : {}), uiEnabled: true, namespace: 'fixture_', maxBytes: 67108864, chunkBytes: 2, bootstrapTicket: 'synthetic-bootstrap' } } }),
};
