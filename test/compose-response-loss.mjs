// Fixture only: let the server commit, then make its client's fetch lose the response.
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await realFetch(...args);
  const url = String(args[0]);
  if (url.endsWith('/preservation/capture') || url.endsWith('/maintenance/release')) {
    throw Error('Synthetic response loss after server reply');
  }
  return response;
};
