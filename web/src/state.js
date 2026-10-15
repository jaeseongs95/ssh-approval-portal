export function createWebState(accessMode = false) {
  return { accessMode, signedOut: false, loading: null, deciding: false, polling: null };
}
