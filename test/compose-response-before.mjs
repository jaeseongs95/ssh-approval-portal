// Fixture only: the release request never reaches the server.
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  if (String(args[0]).endsWith('/maintenance/release')) throw Error('Synthetic loss before request');
  return realFetch(...args);
};
