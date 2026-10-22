export function createWebState(accessMode = false, logoutPath = '/signed-out') {
  return { accessMode, logoutPath, signedOut: false, loading: null, deciding: false, polling: null };
}
