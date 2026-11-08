import { createWebI18n } from './src/i18n.js';
import { createWebState } from './src/state.js';
import { createWebView } from './src/view.js';
import { createWebApi } from './src/http.js';
import { createWebController } from './src/controller.js';
import { createCommandPolicyEditor } from './src/command-policy.js';
import { createAdminPages } from './src/pages.js';
import { createAutomationMetricsPanel } from './src/metrics.js';
import { createEnvironmentPanel } from './src/environment.js';
import { displayLanguage, createAppearancePanel } from './src/appearance.js';
import { createAgentCliPanel } from './src/agent-cli.js';
import { createCapacityPanel } from './src/capacity.js';
import { createDesktopPanel } from './src/desktop.js';

let storage;
try { storage = globalThis.localStorage; } catch { /* disabled browser storage */ }
const preference = displayLanguage(storage, navigator.languages?.length ? navigator.languages : (navigator.language ?? 'en'));
const i18n = createWebI18n(preference.language);
const state = createWebState(['access', 'oidc'].includes(document.body?.dataset.authMode));
const view = createWebView({ document, i18n });
const api = createWebApi({ fetch: globalThis.fetch.bind(globalThis), accessMode: state.accessMode, getToken: view.token,
  isSignedOut: () => state.signedOut, unauthorized: view.unauthorized, t: i18n.t });
api.beginAdminSession();
const controller = createWebController({ state, view, api, document, location, beforeLogout: () => desktop.close() });
controller.start();
const pages = createAdminPages({ document, location, history });
let agentCli, workspaceReady = false, changingServer = false, syncingServer = false, serverTab = 'policy';
const policyEditor = createCommandPolicyEditor({ document, api, i18n, onNavigate: pages.settings, onRequestTarget: id => selectServer(id, 'policy'), onStateChange: refreshServerContext, isSignedOut: () => state.signedOut });
view.openPolicy = id => policyEditor?.openTarget(id);
view.importCommandNames = input => policyEditor?.importCommandNames(input);
document.querySelector('#logout')?.addEventListener('click', () => policyEditor?.clearCommandImport());
createAutomationMetricsPanel({ document, api, i18n });
const environment = createEnvironmentPanel({ document, api });
const capacity = createCapacityPanel({ document, api, i18n, getTarget: currentServer, isSignedOut: () => state.signedOut });
const desktop = createDesktopPanel({ document, api, i18n, getTarget: currentServer, isSignedOut: () => state.signedOut, onStateChange: refreshServerContext });
let sessionStorage;
try { sessionStorage=globalThis.sessionStorage; } catch { /* storage can be disabled */ }
agentCli=createAgentCliPanel({document,api,i18n,isSignedOut:()=>state.signedOut,canLoad:()=>state.accessMode||Boolean(view.token()),storage:sessionStorage,
  getTarget: policyEditor ? () => policyEditor.scopeState().targetId : undefined, onRequestTarget: id => selectServer(id, 'cli'), onStateChange: refreshServerContext});
const say = (ko, en) => i18n.korean ? ko : en;
const context = document.getElementById('server-context'), serverTarget = policyEditor?.targetControl ?? agentCli.targetControl;
const contextText = document.createElement('p'), switchMessage = document.createElement('p');
contextText.id = 'server-edit-context'; contextText.className = 'target'; contextText.setAttribute('role', 'status');
switchMessage.id = 'server-switch-message'; switchMessage.className = 'error'; switchMessage.setAttribute('role', 'alert');
if (context) {
  serverTarget.id = 'server-target';
  serverTarget.parentElement.querySelector('span')?.replaceChildren(document.createTextNode(say('편집 대상 서버', 'Server editing target')));
  context.append(serverTarget.parentElement, contextText, switchMessage);
  if (policyEditor) agentCli.targetControl.parentElement.hidden = true;
}
const serverTabs = [...document.querySelectorAll('#server-settings-tabs [data-server-tab]')];
const serverPanels = { policy: policyEditor?.root, cli: agentCli.root };
for (const button of serverTabs) {
  const key = button.dataset.serverTab, panel = serverPanels[key];
  button.id = 'server-tab-' + key; button.setAttribute('role', 'tab'); button.disabled = !panel;
  if (panel) { button.setAttribute('aria-controls', panel.id); panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id); }
  button.onclick = () => showServerTab(key);
  button.onkeydown = event => {
    const enabled = serverTabs.filter(tab => !tab.disabled), index = enabled.indexOf(button), delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (delta === undefined && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = enabled[event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + delta + enabled.length) % enabled.length];
    showServerTab(next.dataset.serverTab); next.focus();
  };
}
serverTarget.onchange = () => { const requested = serverTarget.value; serverTarget.value = currentServer(); selectServer(requested, serverTab); };
workspaceReady = true; showServerTab(policyEditor ? 'policy' : 'cli'); refreshServerContext();

function currentServer() { return policyEditor?.scopeState().targetId ?? agentCli?.scopeState().targetId ?? ''; }
function showServerTab(key) {
  if (!serverPanels[key]) return;
  serverTab = key; document.getElementById('server-workspace')?.setAttribute('data-server-tab', key);
  for (const button of serverTabs) { const selected = button.dataset.serverTab === key; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
  for (const [name, panel] of Object.entries(serverPanels)) if (panel) panel.hidden = name !== key;
}
function refreshServerContext() {
  if (!workspaceReady || syncingServer) return;
  syncingServer = true;
  try {
    const policy = policyEditor?.scopeState(), cli = agentCli.scopeState(), id = currentServer();
    if (!changingServer && policy?.ready && cli.ready && !cli.blocked && cli.targetId !== id) agentCli.selectTarget(id);
    serverTarget.value = id;
    serverTarget.disabled = changingServer || !!policy?.blocked || agentCli.scopeState().blocked || desktop.reloadState().blocked;
    const label = [...serverTarget.options].find(option => option.value === id)?.textContent ?? id;
    contextText.textContent = [document.body.dataset.bridgeDisplayName || location.host, id ? label : policy?.ready || cli.ready ? say('편집할 서버를 선택해 주세요.', 'Choose a server to edit.') : say('서버 정보를 아직 확인하지 못했습니다.', 'Server context has not been loaded.'),
      policy?.uncertain || cli.uncertain ? say('결과 미확인 · 현재 서버 유지', 'Outcome unconfirmed · current server preserved') : policy?.conflict ? say('초안 충돌 · 현재 서버 유지', 'Draft conflict · current server preserved') : ''].filter(Boolean).join(' / ');
    capacity.syncTarget();
    desktop.syncTarget();
  } finally { syncingServer = false; }
}
async function selectServer(id, tab) {
  if (!workspaceReady || state.signedOut) return false;
  showServerTab(tab);
  const refused = () => {
    serverTarget.value = currentServer();
    switchMessage.textContent = say('요청한 서버 ', 'Requested server ') + id + say('로 전환하지 못했습니다. 처리·결과 미확인·초안 충돌 또는 연결 정보를 확인하세요. 현재 편집 서버: ', ' could not be selected. Check processing, reconciliation, draft conflicts or target bindings. Current editing server: ') + currentServer();
    refreshServerContext(); return false;
  };
  if (id === currentServer()) { switchMessage.textContent = ''; refreshServerContext(); return true; }
  const cliScope = agentCli.scopeState();
  if (changingServer || desktop.reloadState().blocked || policyEditor?.scopeState().blocked || cliScope.blocked && !cliScope.readingCapabilities) return refused();
  changingServer = true; refreshServerContext();
  try {
    if (policyEditor && !await policyEditor.ensureLoaded()) return refused();
    await agentCli.ensureLoaded();
    if (state.signedOut || document.body.dataset.page !== 'settings' || policyEditor?.scopeState().blocked || agentCli.scopeState().blocked) return refused();
    if (policyEditor && ![...policyEditor.targetControl.options].some(option => option.value === id)) return refused();
    // No await between both preflight checks and the two local scope changes.
    if (policyEditor && !policyEditor.selectTarget(id) || !agentCli.selectTarget(id)) return refused();
    switchMessage.textContent = ''; return true;
  } finally { changingServer = false; refreshServerContext(); }
}
createAppearancePanel({ document, storage, location, choice: preference.choice, korean: i18n.korean, reloadState: () => {
  const states = [policyEditor?.reloadState(), environment.reloadState(), agentCli.reloadState(), capacity.reloadState(), desktop.reloadState()];
  return { blocked: controller.reloadState().blocked || states.some(value => value?.blocked), dirty: states.flatMap(value => value?.dirty ?? []) };
} });
pages.sync();
