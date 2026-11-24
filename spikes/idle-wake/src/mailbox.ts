import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const serverName = 'team';
const senderTool = 'post_message';
const receiverTools = ['read_message', 'ack_message'] as const;
export { serverName, senderTool, receiverTools };

export type Role = 'sender' | 'receiver';
const messageId = z.string().regex(/^[a-z0-9-]{1,48}$/);
type Message = {
  id: string;
  body: string;
  storedAt: number;
  read: boolean;
  acknowledgedAt?: number;
};

function reply(value: object, isError = false) {
  return { isError, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export async function startMailbox(tracePath: string) {
  const events = new EventEmitter();
  const messages = new Map<string, Message>();
  const tokens = {
    sender: `Bearer ${randomBytes(32).toString('hex')}`,
    receiver: `Bearer ${randomBytes(32).toString('hex')}`,
  };
  const trace = (id: string, event: string, now = Date.now()) => {
    appendFileSync(tracePath, `${JSON.stringify({ id, event, at: now })}\n`, { mode: 0o600 });
  };

  function makeMcp(role: Role) {
    const mcp = new McpServer({ name: serverName, version: '0.1.0' });
    const schema = { id: messageId };
    if (role === 'sender') {
      mcp.registerTool(senderTool, {
        description: 'Post the given synthetic test message to the receiver.',
        inputSchema: { ...schema, body: z.string().min(1).max(64) },
      }, ({ id, body }) => {
        const existing = messages.get(id);
        if (existing) {
          return existing.body === body
            ? reply({ id, status: 'duplicate' })
            : reply({ error: 'ID already bound to different content' }, true);
        }
        const storedAt = Date.now();
        appendFileSync(tracePath, `${JSON.stringify({ id, event: 'stored', body, at: storedAt })}\n`, { mode: 0o600 });
        const message = { id, body, storedAt, read: false };
        messages.set(id, message);
        events.emit('stored', message);
        return reply({ id, status: 'stored' });
      });
    } else {
      mcp.registerTool('read_message', {
        description: 'Read the synthetic message addressed to this receiver.',
        inputSchema: schema,
      }, ({ id }) => {
        const message = messages.get(id);
        if (!message) return reply({ error: 'Unknown message ID' }, true);
        trace(id, 'read');
        message.read = true;
        return reply({ id, body: message.body });
      });
      mcp.registerTool('ack_message', {
        description: 'Acknowledge this exact ID after reading its message.',
        inputSchema: schema,
      }, ({ id }) => {
        const message = messages.get(id);
        if (!message?.read) return reply({ error: 'Read the message before acknowledging' }, true);
        if (message.acknowledgedAt === undefined) {
          const now = Date.now();
          trace(id, 'acknowledged', now);
          message.acknowledgedAt = now;
        }
        return reply({ id, status: 'acknowledged' });
      });
    }
    return mcp;
  }

  const http = createServer((request, response) => {
    const auth = request.headers.authorization;
    const role = auth === tokens.sender ? 'sender' : auth === tokens.receiver ? 'receiver' : undefined;
    // This probe accepts only its own loopback clients, not browser origins or DNS aliases.
    if (request.headers.origin || request.headers.host !== new URL(url).host) {
      response.writeHead(403).end();
    } else if (request.url !== '/mcp') {
      response.writeHead(404).end();
    } else if (!role) {
      response.writeHead(401).end();
    } else if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
    } else {
      const mcp = makeMcp(role);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.once('close', () => {
        void mcp.close().catch(error => console.error('MCP cleanup failed:', error));
      });
      void mcp.connect(transport).then(() => transport.handleRequest(request, response)).catch(error => {
        console.error('MCP probe request failed:', error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Loopback MCP endpoint unavailable');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  return {
    url,
    headers: (role: Role) => ({ Authorization: tokens[role] }),
    message: (id: string) => messages.get(id),
    onStored: (listener: (message: Message) => void) => {
      events.on('stored', listener);
      return () => events.off('stored', listener);
    },
    trace,
    close: () => new Promise<void>((resolve, reject) => {
      http.close(error => error ? reject(error) : resolve());
      http.closeAllConnections();
    }),
  };
}
