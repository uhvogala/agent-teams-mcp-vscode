import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { approveAll, CopilotClient, RuntimeConnection, type CopilotSession, type CreateSessionOptions } from '@microsoft/copilot-sdk';
import { type Role, receiverTools, senderTool, serverName, startMailbox } from './mailbox.js';

export async function runProbe(dir: string, runs: number, modelOptions?: Pick<CreateSessionOptions, 'model' | 'github' | 'inference'>) {
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('Specify 1 to 10 trials');
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  const tracePath = join(dir, 'trace.jsonl');
  const client = new CopilotClient({
    mode: 'empty',
    runtime: RuntimeConnection.forInProcess({ baseDirectory: join(dir, 'runtime') }),
  });

  try {
    await client.start();
    if (!modelOptions && !(await client.getAuthStatus()).isAuthenticated) {
      throw new Error('Public Copilot SDK is not signed in. Run with supported CLI sign-in or a supported COPILOT_GITHUB_TOKEN; do not copy credentials from the editor host.');
    }
    console.log(`Copilot runtime: ${(await client.getStatus()).version}. Trace: ${tracePath}`);
    const mailbox = await startMailbox(tracePath);
    try {
      const makeSession = (role: Role): Promise<CopilotSession> => {
        const tools = role === 'sender' ? [senderTool] : [...receiverTools];
        const config: CreateSessionOptions = {
          model: process.env.AGENT_TEAMS_PROBE_MODEL ?? 'auto',
          ...modelOptions,
          workingDirectory: workspace,
          enableConfigDiscovery: false,
          mcp: { servers: { [serverName]: { type: 'http', url: mailbox.url, headers: mailbox.headers(role), tools } } },
          tools: { availableTools: tools.map(tool => `mcp:${serverName}-${tool}`) },
          permissions: { onRequest: (request, invocation) =>
            request.kind === 'mcp' && request.serverName === serverName &&
              tools.some(tool => request.toolName === tool || request.toolName === `${serverName}-${tool}`)
              ? approveAll(request, invocation)
              : { kind: 'user-not-available' },
          },
        };
        return client.createSession(config);
      };
      const sender = await makeSession('sender');
      const receiver = await makeSession('receiver');
      assert.notEqual(sender.sessionId, receiver.sessionId);
      const ready = await receiver.sendAndWait('Reply READY, then finish without any tool calls.', 60_000);
      assert.equal(ready?.data.content.trim(), 'READY', 'Receiver must finish its setup turn');

      for (let trial = 1; trial <= runs; trial++) {
        const id = `idle-${trial}`;
        let acceptedWake = false;
        let startedAt: number | undefined;
        const unsubscribe = receiver.on(event => {
          if (event.type === 'user.message' && event.data.clientTurnId === id) {
            acceptedWake = event.data.delivery === 'idle';
            mailbox.trace(id, `delivery_${event.data.delivery ?? 'unknown'}`);
          }
          if (event.type === 'assistant.turn_start' && acceptedWake && startedAt === undefined) {
            startedAt = Date.now();
            mailbox.trace(id, 'turn_started', startedAt);
          }
        });
        let unsubscribePost: (() => void) | undefined;
        const post = new Promise<number>(resolve => {
          unsubscribePost = mailbox.onStored(message => {
            if (message.id === id) resolve(message.storedAt);
          });
        });
        const send = async () => {
          const body = `sample-${trial}`;
          await sender.sendAndWait(`Use post_message exactly once, with id "${id}" and body "${body}". Then finish.`, 60_000);
          assert.equal(mailbox.message(id)?.body, body, `Sender did not store the expected message (${id})`);
        };
        const wake = async () => {
          const storedAt = await post;
          mailbox.trace(id, 'dispatch');
          await receiver.sendAndWait({
            mode: 'enqueue',
            source: 'agent-sender',
            clientTurnId: id,
            prompt: `You have one team message, ID "${id}". Call read_message for that ID, then call ack_message for the same ID and finish.`,
          }, 60_000);
          const ack = mailbox.message(id)?.acknowledgedAt;
          assert(startedAt !== undefined && startedAt - storedAt <= 15_000, `${id}: no verified turn start within 15s`);
          assert(ack !== undefined && ack >= startedAt && ack - storedAt <= 60_000, `${id}: no verified acknowledgement within 60s`);
          console.log(`${id} started in ${startedAt - storedAt} ms, acknowledged in ${ack - storedAt} ms`);
        };
        try {
          await Promise.all([send(), wake()]);
        } finally {
          unsubscribePost?.();
          unsubscribe();
        }
      }
      console.log(`${runs}/${runs} SDK + MCP idle wake trials passed. Trace: ${tracePath}`);
    } finally {
      await mailbox.close();
    }
  } finally {
    await client.stop();
  }
}
