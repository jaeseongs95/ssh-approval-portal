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

let storage;
try { storage = globalThis.localStorage; } catch { /* disabled browser storage */ }
const preference = displayLanguage(storage, navigator.language ?? 'en');
const i18n = createWebI18n(preference.language);
const state = createWebState(['access', 'oidc'].includes(document.body?.dataset.authMode), document.body?.dataset.authMode === 'oidc' ? '/oauth2/sign_out' : '/cdn-cgi/access/logout');
const view = createWebView({ document, i18n });
const api = createWebApi({ fetch: globalThis.fetch.bind(globalThis), accessMode: state.accessMode, getToken: view.token,
  isSignedOut: () => state.signedOut, unauthorized: view.unauthorized, t: i18n.t });
const controller = createWebController({ state, view, api, document, location });
controller.start();
const pages = createAdminPages({ document, location, history });
const policyEditor = createCommandPolicyEditor({ document, api, onNavigate: pages.settings, isSignedOut: () => state.signedOut });
view.openPolicy = id => policyEditor?.openTarget(id);
view.importCommandNames = input => policyEditor?.importCommandNames(input);
document.querySelector('#logout')?.addEventListener('click', () => policyEditor?.clearCommandImport());
createAutomationMetricsPanel({ document, api });
const environment = createEnvironmentPanel({ document, api });
let sessionStorage;
try { sessionStorage=globalThis.sessionStorage; } catch { /* storage can be disabled */ }
const agentCli=createAgentCliPanel({document,api,isSignedOut:()=>state.signedOut,canLoad:()=>state.accessMode||Boolean(view.token()),storage:sessionStorage});
createAppearancePanel({ document, storage, location, choice: preference.choice, korean: i18n.korean, reloadState: () => {
  const states = [policyEditor?.reloadState(), environment.reloadState(), agentCli.reloadState()];
  return { blocked: controller.reloadState().blocked || states.some(value => value?.blocked), dirty: states.flatMap(value => value?.dirty ?? []) };
} });
pages.sync();
