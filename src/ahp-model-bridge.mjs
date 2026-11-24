// @ts-check
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const root = 'ahp-root://';
const maxPayload = 16 * 1024 * 1024;
/** @typedef {import('@microsoft/copilot-sdk').Model} Model */
/** @typedef {Pick<Model, 'id' | 'name'> & Partial<Pick<Model, 'policy' | 'capabilities' | 'vendor'>>} CatalogModel */
/** @typedef {{ provider: string, models?: unknown[] }} Agent */
/** @typedef {{ resource?: string, state?: { agents?: Agent[] } }} Snapshot */
/** @typedef {{ channel?: string, action?: { type?: string, agents?: Agent[] }, envelope?: Envelope }} Envelope */
/** @typedef {{ result?: { snapshots?: Snapshot[], snapshot?: Snapshot, actions?: Envelope[] }, params?: Envelope & { snapshot?: Snapshot } }} Frame */

/** @param {{ url: URL, token: string }} upstream @param {CatalogModel[]} sdkModels @param {number} [port] */
export async function startModelBridge(upstream, sdkModels, port = 0) {
  const models = sdkModels.map(model => ({
    id: model.id, name: model.name, provider: 'copilot', policyState: model.policy?.state, vendor: model.vendor,
    maxContextWindow: model.capabilities?.limits?.max_context_window_tokens,
    maxPromptTokens: model.capabilities?.limits?.max_prompt_tokens,
    maxOutputTokens: model.capabilities?.limits?.max_output_tokens,
    supportsVision: model.capabilities?.supports?.vision,
  }));
  const target = new URL(upstream.url);
  if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1' || !target.port) throw new Error('The model bridge requires a loopback SDK host.');
  target.searchParams.set('tkn', upstream.token);
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(token);
  const server = new WebSocketServer({
    host: '127.0.0.1', port, maxPayload, perMessageDeflate: false,
    verifyClient: (/** @type {{ req: import('node:http').IncomingMessage }} */ { req }) => {
      try {
        const url = new URL(req.url ?? '/', 'ws://127.0.0.1');
        const actual = Buffer.from(url.searchParams.get('tkn') ?? '');
        return url.pathname === '/' && actual.length === expected.length && timingSafeEqual(actual, expected);
      } catch {
        return false;
      }
    },
  });
  /** @param {Agent[] | undefined} agents */
  const patchAgents = agents => {
    let changed = false;
    for (const agent of agents ?? []) {
      if (agent.provider !== 'copilot' || agent.models?.length) continue;
      agent.models = models;
      changed = true;
    }
    return changed;
  };
  /** @param {Snapshot | undefined} snapshot */
  const patchSnapshot = snapshot => snapshot?.resource === root && patchAgents(snapshot.state?.agents);
  /** @param {Envelope | undefined} envelope */
  const patchAction = envelope => {
    const action = envelope?.envelope ?? envelope;
    return action?.channel === root && action.action?.type === 'root/agentsChanged' && patchAgents(action.action.agents);
  };
  /** @param {Frame} frame */
  const patchFrame = ({ result, params }) => {
    const updates = [...(result?.snapshots ?? []), result?.snapshot, params?.snapshot].map(patchSnapshot);
    updates.push(...[...(result?.actions ?? []), params].map(patchAction));
    return updates.some(Boolean);
  };
  server.on('connection', downstream => {
    const host = new WebSocket(target, { maxPayload, handshakeTimeout: 5000, perMessageDeflate: false });
    const stop = () => { downstream.terminate(); host.terminate(); };
    downstream.pause();
    host.once('open', () => downstream.resume());
    for (const peer of [downstream, host]) {
      peer.on('error', stop);
      peer.once('close', stop);
    }
    /** @param {WebSocket} peer @param {string | import('ws').RawData} data @param {boolean} binary */
    const send = (peer, data, binary) => {
      if (peer.readyState !== WebSocket.OPEN || peer.bufferedAmount > maxPayload) stop();
      else peer.send(Array.isArray(data) ? Buffer.concat(data) : data, { binary }, error => { if (error) stop(); });
    };
    downstream.on('message', (data, binary) => send(host, data, binary));
    host.on('message', (data, binary) => {
      try {
        /** @type {Frame | Frame[]} */
        const frame = JSON.parse(data.toString());
        const changed = (Array.isArray(frame) ? frame : [frame]).map(patchFrame).some(Boolean);
        send(downstream, changed ? JSON.stringify(frame) : data, binary);
      } catch {
        stop();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The model bridge did not bind to loopback.');
  return {
    url: new URL(`ws://127.0.0.1:${address.port}`), token,
    dispose: () => new Promise((resolve, reject) => {
      for (const socket of server.clients) socket.terminate();
      server.close(error => error ? reject(error) : resolve(undefined));
    }),
  };
}
