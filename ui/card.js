import { createCardI18n } from './src/i18n.js';
import { createCardState } from './src/state.js';
import { createCardView } from './src/view.js';
import { createCardHost, hashFile, encodeFileChunk } from './src/host.js';
import { createCardController } from './src/controller.js';

const i18n = createCardI18n(navigator.language ?? 'en');
const view = createCardView({ document, i18n });
const host = createCardHost(i18n.t);
const controller = createCardController({ state: createCardState(), view, host, document, hashFile, encodeFileChunk });
view.initialize(controller.openWeb);
await host.connect({ receive: controller.receive, theme: view.theme, dispose: controller.dispose });
