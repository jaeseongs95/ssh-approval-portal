import { App } from '@modelcontextprotocol/ext-apps';

export function createCardHost(t) {
  const app = new App({ name: 'SSH Approval Portal', version: '0.3.0' }, { availableDisplayModes: ['inline', 'fullscreen'] });
  return {
    async call(name, args, namespace = 'ssh-approval-bridge_') {
      const result = await app.callServerTool({ name: namespace + name, arguments: args });
      if (result.isError) throw Error(t('요청이 거부되었습니다. 인증·만료·전송 상태를 확인하세요.'));
      return result;
    },
    downloadFile: args => app.downloadFile(args),
    openLink: args => app.openLink(args),
    updateModelContext: args => app.updateModelContext(args),
    async connect({ receive, theme, dispose }) {
      app.ontoolresult = receive; app.onhostcontextchanged = theme;
      app.onteardown = async () => { dispose(); return {}; };
      await app.connect(); theme(app.getHostContext());
    },
  };
}

export async function hashFile(file) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  return [...digest].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function encodeFileChunk(file, start, end) {
  const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
