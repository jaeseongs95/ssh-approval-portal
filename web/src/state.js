export function createWebState(accessMode = false, logoutPath = '/cdn-cgi/access/logout') {
  return { accessMode, logoutPath, signedOut: false, loading: null, deciding: false, polling: null };
}
