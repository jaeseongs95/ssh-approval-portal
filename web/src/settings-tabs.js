import { uiText as tr } from './ui-text.js';
/** Presentation only: panels retain their DOM and never own a policy or save. */
export function createSettingsTabs({ document, container, panels }) {
  const list = document.createElement('div'); list.className = 'settings-tabs';
  list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', tr('자동승인 설정'));
  const entries = panels.map(([panel, label], index) => {
    panel.id = 'settings-panel-' + index; panel.setAttribute('role', 'tabpanel'); panel.tabIndex = 0;
    const button = document.createElement('button'); button.type = 'button'; button.id = 'settings-tab-' + index;
    button.textContent = label; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
    panel.setAttribute('aria-labelledby', button.id); list.append(button); return { panel, button };
  });
  function select(index, focus = false) {
    entries.forEach(({ panel, button }, i) => { panel.hidden = i !== index; button.setAttribute('aria-selected', String(i === index)); button.tabIndex = i === index ? 0 : -1; });
    if (focus) entries[index].button.focus();
  }
  entries.forEach(({ button }, index) => {
    button.addEventListener('focus', () => select(index)); button.onclick = () => select(index);
    button.onkeydown = event => {
      const delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (delta === undefined && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault(); select(event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (index + delta + entries.length) % entries.length, true);
    };
  });
  container.append(list); select(0);
  return { select, reveal: node => { const index = entries.findIndex(({ panel }) => panel.contains(node)); if (index >= 0) select(index); } };
}
