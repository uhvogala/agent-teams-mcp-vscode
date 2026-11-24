import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Role, startMailbox } from './mailbox.js';

test('MCP post records the message before one wake; only the receiver can read and ACK it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-mailbox-test-'));
  const traceFile = join(dir, 'events.jsonl');
  const mailbox = await startMailbox(traceFile);
  const clients: Client[] = [];
  t.after(async () => {
    try {
      await Promise.all(clients.map(client => client.close()));
    } finally {
      await mailbox.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  async function connect(role: Role) {
    const client = new Client({ name: `test-${role}`, version: '0.1.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(mailbox.url), {
      requestInit: { headers: mailbox.headers(role) },
    }));
    return client;
  }
  const sender = await connect('sender');
  const receiver = await connect('receiver');
  assert.equal((await fetch(mailbox.url, { method: 'POST' })).status, 401);
  assert.deepEqual((await sender.listTools()).tools.map(tool => tool.name), ['post_message']);
  const id = 'test-1';
  const wakeIds: string[] = [];
  const off = mailbox.onStored(message => {
    wakeIds.push(message.id);
    mailbox.trace(message.id, 'dispatch');
  });
  t.after(off);

  const post = () => sender.callTool({ name: 'post_message', arguments: { id, body: 'sample-1' } });
  assert.notEqual((await post()).isError, true);
  assert.notEqual((await post()).isError, true);
  assert.equal((await sender.callTool({ name: 'post_message', arguments: { id, body: 'different' } })).isError, true);
  assert.deepEqual(wakeIds, [id]);

  const ack = () => receiver.callTool({ name: 'ack_message', arguments: { id } });
  assert.equal((await sender.callTool({ name: 'ack_message', arguments: { id } })).isError, true);
  assert.equal((await ack()).isError, true, 'An exact ID is not sufficient without a read');
  const read = await receiver.callTool({ name: 'read_message', arguments: { id } });
  assert.deepEqual(read.content, [{ type: 'text', text: JSON.stringify({ id, body: 'sample-1' }) }]);
  assert.notEqual((await ack()).isError, true);
  assert.notEqual((await ack()).isError, true);

  const trace = (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(trace.map(entry => [entry.id, entry.event]), [
    [id, 'stored'], [id, 'dispatch'], [id, 'read'], [id, 'acknowledged'],
  ]);
});
