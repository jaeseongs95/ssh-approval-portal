export function createWebApi({ fetch, accessMode, getToken, isSignedOut, unauthorized, t }) {
  let sessionReady;
  const sessionRequest=async action=>{
   let status;
   try{
    const response=await fetch('/api/session/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'});
    status=response.status;
    if(!response.ok)throw Error('Administrator session unavailable');
    const value=await response.json();if(value?.connected!==(action==='start'))throw Error('Administrator session unavailable');
   }catch{if(action==='start')unauthorized();throw Object.assign(Error(t('로그인이 만료되었거나 접근할 수 없습니다. 다시 로그인해 주세요.')),{status});}
  };
  const api=async function api(path, method = 'GET', body, { signal, timeoutMs = 15000, preferAsync = false } = {}) {
    if(sessionReady)await sessionReady;
    if (isSignedOut()) throw Error(t('로그아웃되었습니다.'));
    // Read cancellation never cancels, times out or replays a mutation.
    const read = method === 'GET' ? new AbortController() : null;
    const cancel = () => read.abort(signal.reason);
    let timer, onAbort;
    if (read) {
      if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => read.abort(Object.assign(Error(t('요청 실패') + ': read timed out'), { name: 'TimeoutError' })), timeoutMs);
    }
    const request = async () => {
    read?.signal.throwIfAborted();
    const response = await fetch(path, { method, credentials: 'same-origin', headers: { ...(preferAsync ? { Prefer: 'respond-async' } : {}), ...(accessMode ? {} : { Authorization: 'Bearer ' + getToken() }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(read ? { signal: read.signal } : {}) });
    read?.signal.throwIfAborted();
    if (isSignedOut()) throw Error(t('로그아웃되었습니다.'));
    if (accessMode && response.status === 401) {
      unauthorized(); throw Object.assign(Error(t('로그인이 만료되었거나 접근할 수 없습니다. 다시 로그인해 주세요.')), { status: response.status });
    }
    const value = await response.json().catch(error => { throw Object.assign(error, { status: response.status }); });
    read?.signal.throwIfAborted();
    if (isSignedOut()) throw Error(t('로그아웃되었습니다.'));
    if (!response.ok) throw Object.assign(Error(value.error ?? t('요청 실패')), { status: response.status });
    return value;
    };
    try {
      return await (read ? Promise.race([request(), new Promise((_, reject) => {
        onAbort = () => reject(read.signal.reason);
        if (read.signal.aborted) onAbort(); else read.signal.addEventListener('abort', onAbort, { once: true });
      })]) : request());
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (onAbort) read.signal.removeEventListener('abort', onAbort); }
  };
  api.beginAdminSession=()=>sessionReady=accessMode?sessionRequest('start'):undefined;
  api.endAdminSession=async()=>{try{await sessionReady;}catch{}await sessionRequest('logout');};
  return api;
}
