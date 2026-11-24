// @ts-check
import { randomUUID } from 'node:crypto';

/** @param {URL} url @param {string} token @returns {Promise<{ provider: string, models: number }[]>} */
export async function inspectAgentCatalog(url, token) {
  const address = new URL(url);
  address.searchParams.set('tkn', token);
  const socket = new WebSocket(address);
  const channel = 'ahp-root://';
  const id = 1;
  const protocolVersions = ['1.2.0'];
  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      const fail = () => reject(new Error('The local AHP catalog handshake failed.'));
      timeout = setTimeout(fail, 5000);
      socket.addEventListener('error', fail, { once: true });
      socket.addEventListener('close', fail, { once: true });
      socket.addEventListener('open', () => socket.send(JSON.stringify({
        jsonrpc: '2.0', id, method: 'initialize',
        params: { channel, protocolVersions, clientId: randomUUID(), initialSubscriptions: [channel] },
      })), { once: true });
      socket.addEventListener('message', ({ data }) => {
        try {
          /** @type {{ id?: number, result?: { protocolVersion?: string, snapshots?: { resource: string, state?: { agents?: { provider: string, models?: unknown[] }[] } }[] } }} */
          const response = JSON.parse(data);
          if (response.id !== id) return;
          const agents = response.result?.snapshots?.find(snapshot => snapshot.resource === channel)?.state?.agents;
          if (!protocolVersions.includes(response.result?.protocolVersion ?? '') || !Array.isArray(agents)) {
            reject(new Error('The local AHP host did not return an AHP 1.2 agent catalog.'));
            return;
          }
          resolve(agents.map(agent => ({ provider: String(agent.provider), models: agent.models?.length ?? 0 })));
        } catch {
          fail();
        }
      });
    });
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}
