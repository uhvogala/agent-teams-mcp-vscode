import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { runProbe } from './probe.js';

test('real Copilot runtime wakes an idle receiver and records an exact MCP ACK', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-runtime-test-'));
  const requestSchema = z.object({
    messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() })),
    tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
    stream: z.boolean().optional(),
  });
  const model = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { messages, tools, stream } = requestSchema.parse(JSON.parse(raw));
      const lastUser = messages.map(message => message.role).lastIndexOf('user');
      const id = JSON.stringify(messages[lastUser]?.content ?? '').match(/idle-[0-9]+/)?.[0];
      const results = messages.slice(lastUser + 1).filter(message => message.role === 'tool').length;
      const findTool = (suffix: string) => tools?.find(tool => tool.function.name.endsWith(suffix))?.function.name;
      const name = results === 0
        ? findTool('post_message') ?? findTool('read_message')
        : results === 1 ? findTool('ack_message') : undefined;
      const args = name?.endsWith('post_message') ? { id, body: `sample-${id?.split('-')[1]}` } : { id };
      const message = {
        role: 'assistant',
        ...(name && id
          ? { tool_calls: [{ index: 0, id: `test_call_${id}_${results}`, type: 'function',
              function: { name, arguments: JSON.stringify(args) } }] }
          : { content: id ? 'DONE' : 'READY' }),
      };
      const finish = 'tool_calls' in message ? 'tool_calls' : 'stop';
      const common = { id: 'chatcmpl-test', model: 'gpt-4o', created: Math.floor(Date.now() / 1000) };
      if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const [delta, finish_reason] of [[message, null], [{}, finish]]) {
          res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }],
        }));
      }
    } catch (error) {
      res.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
  });
  t.after(async () => {
    await new Promise<void>(resolve => {
      model.close(() => resolve());
      model.closeAllConnections();
    });
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    model.once('error', reject);
    model.listen(0, '127.0.0.1', resolve);
  });
  const address = model.address();
  assert(address && typeof address !== 'string');
  const trials = 10;
  await runProbe(dir, trials, {
    model: 'gpt-4o',
    github: { capi: { enabled: false } },
    inference: { defaultProvider: 'fixture', providers: [
      { name: 'fixture', type: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1/`,
        wireApi: 'completions', apiKey: 'local-dummy' },
    ] },
  });
  const lines = (await readFile(join(dir, 'trace.jsonl'), 'utf8')).trim().split('\n');
  const trace = lines.map(line => z.object({ id: z.string(), event: z.string() }).parse(JSON.parse(line)));
  for (let trial = 1; trial <= trials; trial++) {
    const id = `idle-${trial}`;
    assert.deepEqual(trace.filter(entry => entry.id === id).map(entry => entry.event), [
      'stored', 'dispatch', 'delivery_idle', 'turn_started', 'read', 'acknowledged',
    ]);
  }
});
