export function createWebApi({ fetch, accessMode, getToken, isSignedOut, unauthorized, t }) {
  return async function api(path, method = 'GET') {
    if (isSignedOut()) throw Error(t('로그아웃되었습니다.'));
    const response = await fetch(path, { method, credentials: 'same-origin', headers: accessMode ? {} : { Authorization: 'Bearer ' + getToken() } });
    if (isSignedOut()) throw Error(t('로그아웃되었습니다.'));
    if (accessMode && response.status === 401) {
      unauthorized(); throw Error(t('로그인이 만료되었거나 접근할 수 없습니다. 다시 로그인해 주세요.'));
    }
    const value = await response.json();
    if (isSignedOut()) throw Error(t('로그아웃되었습니다.'));
    if (!response.ok) throw Error(value.error ?? t('요청 실패'));
    return value;
  };
}
