import { createWebI18n } from './src/i18n.js';
import { createWebState } from './src/state.js';
import { createWebView } from './src/view.js';
import { createWebApi } from './src/http.js';
import { createWebController } from './src/controller.js';
import { createCommandPolicyEditor } from './src/command-policy.js';
import { createAdminPages } from './src/pages.js';
import { createAutomationMetricsPanel } from './src/metrics.js';

const i18n = createWebI18n(navigator.language ?? 'en');
const state = createWebState(document.body?.dataset.authMode === 'access');
const view = createWebView({ document, i18n });
const api = createWebApi({ fetch: globalThis.fetch.bind(globalThis), accessMode: state.accessMode, getToken: view.token,
  isSignedOut: () => state.signedOut, unauthorized: view.unauthorized, t: i18n.t });
const controller = createWebController({ state, view, api, document, location });
controller.start();
const pages = createAdminPages({ document, location, history });
createCommandPolicyEditor({ document, api, onNavigate: pages.settings });
createAutomationMetricsPanel({ document, api });
pages.sync();
