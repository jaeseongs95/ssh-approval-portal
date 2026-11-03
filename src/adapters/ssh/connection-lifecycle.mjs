import { executionFailure } from '../../domain/execution-failure.mjs';

// ssh-mcp 2.18.0 retries channel opening three times. A single refusal is not a
// broken connection, and a later successful open must keep the connection live.
const OPEN_ATTEMPTS = 3;
const states = new WeakMap(), clients = new WeakMap(), rawClients = new WeakMap();
const channelFailure = error => executionFailure(error, { stage: 'ssh_channel', code: 'SSH_CHANNEL_OPEN_FAILED' });
const connectFailure = error => executionFailure(error, { stage: 'ssh_connect', code: 'SSH_CONNECT_FAILED' });
const stateFor = connection => {
  let state = states.get(connection);
  if (!state) { state = { active: 0, retired: null, closing: null }; states.set(connection, state); }
  return state;
};
export const rawSshClient = client => rawClients.get(client) ?? client;

function clientState(client) {
  let state = clients.get(client);
  if (!state) {
    state = { opening: new Set(), channels: new Set() }; clients.set(client, state);
    // Transport closure also settles channels whose individual close was lost.
    client.once?.('close', () => { state.opening.clear(); state.channels.clear(); });
  }
  return state;
}

function observeClient(client, operation) {
  const usage = clientState(client);
  const view = new Proxy(client, { get(target, key) {
    const method = Reflect.get(target, key, target);
    if (key !== 'exec' && key !== 'sftp' && key !== 'forwardOut') return typeof method === 'function' ? method.bind(target) : method;
    return (...args) => {
      const callback = args.pop(), opening = {};
      usage.opening.add(opening);
      let called = false;
      try {
        return method.call(target, ...args, (error, channel, ...rest) => {
          if (called) return;
          called = true; usage.opening.delete(opening);
          if (error) {
            if (!operation.finished) {
              operation.failedOpens = operation.failedClient === client ? operation.failedOpens + 1 : 1;
              operation.failedClient = client;
            }
          } else {
            operation.failedOpens = 0; operation.failedClient = null;
            if (channel?.once) {
              usage.channels.add(channel);
              channel.once('close', () => usage.channels.delete(channel));
            }
          }
          callback(error, channel, ...rest);
        });
      } catch (error) {
        usage.opening.delete(opening);
        throw error; // A synchronous exception is not a confirmed channel refusal.
      }
    };
  } });
  rawClients.set(view, client);
  return view;
}

async function closeRetired(connection, client) {
  // End this exact idle client, not connection.close(): the vendor method awaits
  // session cleanup before reading connection.client, which may then be newer.
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); client.removeListener?.('close', onClose);
      if (error) reject(error);
      else if (connection.isConnected() && connection.getClient() === client) reject(channelFailure(Error('SSH client closure unconfirmed')));
      else resolve();
    };
    const onClose = () => finish();
    const timer = setTimeout(() => {
      try { client.destroy?.(); finish(); } catch (error) { finish(channelFailure(error)); }
    }, 1000);
    client.once?.('close', onClose);
    try { client.end(); } catch (error) { finish(channelFailure(error)); }
  });
}

/** Acquire a fresh connection only for a later, separately authorized operation. */
export async function acquireSshConnection(registry, profile) {
  let connection;
  try { connection = await registry.getOrCreate(profile); }
  catch (error) { throw connectFailure(error); }
  const state = stateFor(connection), retired = state.retired;
  if (!retired) return connection;
  if (!connection.isConnected() || connection.getClient() !== retired) { state.retired = null; return connection; }
  if (!state.closing) {
    const usage = clientState(retired);
    // No internal wait queue: other admitted work keeps its original channel.
    if (state.active || usage.opening.size || usage.channels.size || connection.activeChannels > 0 || connection.sessions?.size > 0) {
      throw channelFailure(Error('SSH connection recovery waits for active channels'));
    }
    // Set the gate before end() can emit synchronously or another lease starts.
    state.closing = Promise.resolve().then(() => closeRetired(connection, retired));
  }
  const closing = state.closing;
  try { await closing; }
  finally { if (state.closing === closing) state.closing = null; }
  // The registry owns reconnection, credentials, host-key checks and ProxyJump
  // forwarding. Never reconnect a closed ProxyJump object's dead bastion socket.
  let replacement;
  try { replacement = await registry.getOrCreate(profile); }
  catch (error) { throw connectFailure(error); }
  if (replacement === connection && replacement.isConnected() && replacement.getClient() === retired) {
    throw channelFailure(Error('SSH registry retained the retired client'));
  }
  if (state.retired === retired) state.retired = null;
  return replacement;
}

/** Observe the shared transport without changing vendor connection methods. */
export async function withConnectionLifecycle(connection, action) {
  const state = stateFor(connection);
  if (state.retired || state.closing) throw channelFailure(Error('SSH connection requires a fresh acquisition'));
  state.active++;
  const operation = { failedOpens: 0, failedClient: null, connectError: null, finished: false };
  const view = new Proxy(connection, { get(target, key) {
    if (key === 'ensureConnected') return async () => {
      operation.connectError = null;
      try { await target.ensureConnected(); }
      catch (error) { operation.connectError = connectFailure(error); throw operation.connectError; }
    };
    if (key === 'getClient') return () => observeClient(target.getClient(), operation);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' && key !== 'exec' ? value.bind(target) : value;
  } });
  try { return await action(view); }
  catch (error) {
    // Retire only exhausted callback failures. Timeout, command exit status,
    // guard refusal and SFTP file errors are not evidence of a stale client.
    if (operation.failedOpens >= OPEN_ATTEMPTS && operation.failedClient) {
      if (connection.isConnected() && connection.getClient() === operation.failedClient) state.retired = operation.failedClient;
      throw channelFailure(error);
    }
    throw operation.connectError ?? error;
  } finally { operation.finished = true; state.active--; }
}
