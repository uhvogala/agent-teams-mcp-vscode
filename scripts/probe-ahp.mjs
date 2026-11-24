import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startModelBridge } from '../dist/ahp-model-bridge.mjs';
import { fixtureModel, holdPrompt, reply, startProbe } from './ahp-probe-fixture.mjs';

const manual = process.argv.includes('--manual');
const joinable = process.argv.includes('--join');
const bridgeCatalog = process.argv.includes('--catalog-bridge');
const stopQueued = process.argv.includes('--stop-queued');
const restartHost = process.argv.includes('--restart-host');
assert(!(manual && joinable), 'Use Run Native Chat Join Probe for a manual join test.');
assert(!bridgeCatalog || joinable, 'Use --join with --catalog-bridge.');
assert(!stopQueued || joinable, 'Use --join with --stop-queued.');
assert(!restartHost || stopQueued, 'Use --join --stop-queued with --restart-host.');
const root = 'ahp-root://';
const actionOf = frame => frame.params?.action ?? frame.params?.envelope?.action;

async function open(url) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.addEventListener('message', event => frames.push(JSON.parse(event.data)));
  try {
    await until(() => socket.readyState === WebSocket.OPEN, 'WebSocket connection');
  } catch (error) {
    socket.close();
    throw error;
  }
  let seq = 0;
  const send = (method, params, id) => socket.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
  return {
    frames,
    close: () => socket.close(),
    isClosed: () => socket.readyState === WebSocket.CLOSED,
    send,
    async request(method, params) {
      const id = ++seq;
      send(method, params, id);
      const frame = await until(() => frames.find(item => item.id === id), method);
      assert(!frame.error, `${method}: ${frame.error?.message}`);
      return frame.result;
    },
  };
}

async function until(check, label) {
  for (const end = Date.now() + 5000; Date.now() < end;) {
    const result = await check();
    if (result) return result;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

let approvals = 0;
const probe = await startProbe({ joinable, approveJoin: async () => ++approvals > 1 });
let observer;
let bridge;
try {
  const model = bridgeCatalog ? fixtureModel : undefined;
  if (model) bridge = await startModelBridge(probe, [model]);
  const { url, token } = bridge ?? probe;
  assert.deepEqual(probe.assignedSessions(), probe.published ? [probe.published.sessionId] : []);
  const anonymous = new WebSocket(url);
  try {
    await until(() => anonymous.readyState !== WebSocket.CONNECTING, 'unauthenticated WebSocket rejection');
    assert.notEqual(anonymous.readyState, WebSocket.OPEN, 'Host admitted a connection without the token');
  } finally {
    anonymous.close();
  }
  const address = new URL(url);
  address.searchParams.set('tkn', token);
  let advertisedModels;
  const connect = async () => {
    const connection = await open(address);
    try {
      const hello = await connection.request('initialize', {
        channel: root, protocolVersions: ['1.2.0'], clientId: randomUUID(), initialSubscriptions: [root],
      });
      assert.equal(hello.protocolVersion, '1.2.0');
      const agents = hello.snapshots.find(item => item.resource === root)?.state.agents;
      assert(agents?.every(agent => !agent.protectedResources?.length), 'The disposable host must not request editor credentials.');
      const copilot = agents.find(agent => agent.provider === 'copilot');
      assert(copilot, 'AHP host did not advertise Copilot');
      if (model) assert.deepEqual(copilot.models, [{ ...model, provider: 'copilot' }]);
      advertisedModels = copilot.models?.length ?? 0;
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  };
  observer = await connect();
  const requestedSessionId = randomUUID();
  const sessionUri = probe.published?.sessionUri ?? `copilot:/${requestedSessionId}`;
  if (joinable) {
    await observer.request('createSession', { channel: sessionUri, provider: 'copilot' });
    await assert.rejects(observer.request('createSession', { channel: `copilot:/${randomUUID()}`, provider: 'copilot' }),
      /application session materialization failed/);
    assert.deepEqual(probe.assignedSessions(), [], 'Creating a chat should not occupy a role.');
  } else {
    await assert.rejects(observer.request('createSession', {
      channel: `copilot:/${requestedSessionId}`, provider: 'copilot',
    }), /session creation.*(disabled|not allowed)|not allowed to create|creating new sessions.*disabled/i);
  }
  const sessionId = probe.published?.sessionId ?? probe.createdSessionId;
  assert(sessionId, 'The SDK did not return a worker session ID.');
  const catalog = await observer.request('listSessions', { channel: root });
  assert.deepEqual(catalog.items.map(item => item.resource), [sessionUri]);
  const { snapshot } = await observer.request('subscribe', { channel: sessionUri });
  const chat = snapshot.state.defaultChat;
  assert(chat);
  const { snapshot: initialChat } = await observer.request('subscribe', { channel: chat });
  const initialTurns = initialChat.state.turns.map(turn => turn.message.text);
  console.log(joinable ? `AHP created unassigned chat ${sessionId}.` : `AHP listed existing idle Lead ${sessionId} and denied remote session creation.`);
  console.log(`AHP host advertised ${advertisedModels} model(s) to the client.`);

  const verifyWake = async () => {
    const beforeWake = observer.frames.length;
    const id = await probe.wake();
    await until(() => observer.frames.slice(beforeWake).some(frame =>
      frame.params?.channel === chat && JSON.stringify(frame).includes(`${reply}: acknowledged ${id}`)),
    'Team wake response streamed to the open AHP chat');
    console.log(`Lead acknowledged Team inbox ID ${id} in SQLite.`);
    return id;
  };
  if (manual) {
    console.log(`For a remote workspace, privately forward port ${address.port} to your desktop.`);
    console.log('In the desktop Agents window, run Add Remote Agent Host.');
    console.log(`Paste this into VS Code only (replace the port if remapped): ${address}`);
    console.log('Open the only session. The local fixture does not provide a model to the VS Code composer.');
    console.log('Leave the chat open and trigger the SDK wake from this terminal. Ctrl+C to stop.');
    const { createInterface } = await import('node:readline/promises');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    try {
      await input.question('Press Enter once the published session is open in VS Code. ', { signal: controller.signal });
      const id = await verifyWake();
      await input.question(`Check the open chat for "${reply}: acknowledged ${id}". Press Enter to stop. `, { signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      process.removeListener('SIGINT', stop);
      input.close();
    }
  } else {
    const prompts = joinable ? ['Join the team as Lead (declined)', 'Join the team as Lead (approved)'] : [`AHP input probe ${randomUUID()}`];
    if (restartHost) prompts.push('NATIVE-RESTART-01');
    for (const [index, prompt] of prompts.entries()) {
      const turnId = randomUUID();
      observer.send('dispatchAction', {
        channel: chat, clientSeq: index + 1,
        action: {
          type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(),
          message: { text: prompt, origin: { kind: 'user' }, ...(model ? { model: { id: model.id } } : {}) },
        },
      });
      await until(() => observer.frames.some(frame => {
        const action = actionOf(frame);
        return action?.type === 'chat/turnComplete' && action.turnId === turnId;
      }), 'AHP input turn completion');
      if (joinable) assert.deepEqual(probe.assignedSessions(), index === 0 ? [] : [sessionId]);
    }
    if (joinable) console.log('Declining left Lead vacant; approval assigned the existing chat without creating another.');
    const wakeIds = [];
    for (let trial = 0; trial < (joinable ? 10 : 1); trial++) wakeIds.push(await verifyWake());
    observer.close();
    if (joinable) {
      await until(() => observer.isClosed(), 'AHP client disconnect');
      wakeIds.push(await probe.wake());
      console.log('The joined chat acknowledged another inbox message with no AHP client connected.');
    }
    observer = await connect();
    const reopened = await observer.request('subscribe', { channel: chat });
    const turns = reopened.snapshot.state.turns;
    assert.deepEqual(turns.slice(0, -wakeIds.length).map(turn => turn.message.text), [...initialTurns, ...prompts]);
    assert(JSON.stringify(turns.at(-wakeIds.length - 1)?.responseParts).includes(reply));
    for (const [index, id] of wakeIds.entries()) {
      const turn = turns.at(index - wakeIds.length);
      assert(turn?.message.text.includes(`["${id}"]`));
      assert(JSON.stringify(turn.responseParts).includes(`${reply}: acknowledged ${id}`));
    }
    assert.deepEqual((await observer.request('listSessions', { channel: root })).items.map(item => item.resource), [sessionUri]);
    assert.deepEqual(probe.assignedSessions(), [sessionId]);
    console.log('Reopening the AHP transcript showed the original prompts and the Team wake, with the original session ID.');
    if (stopQueued) {
      const turnId = randomUUID();
      const dispatch = (clientSeq, action) => observer.send('dispatchAction', { channel: chat, clientSeq, action });
      const beforeManual = observer.frames.length;
      dispatch(1, {
        type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(),
        message: { text: holdPrompt, origin: { kind: 'user' }, ...(model ? { model: { id: model.id } } : {}) },
      });
      await until(() => {
        const frames = observer.frames.slice(beforeManual);
        const error = frames.find(frame => frame.error || actionOf(frame)?.type === 'chat/error');
        assert(!error, `Manual turn failed: ${JSON.stringify(error)}`);
        assert(!frames.some(frame => actionOf(frame)?.type === 'chat/turnComplete'), 'The manual turn completed instead of staying open.');
        return probe.isHoldingTurn() && probe.leadStatus()?.activity === 'Busy';
      }, 'scripted manual turn in progress');
      const id = probe.queueWhileBusy();
      assert.equal(probe.leadStatus()?.unread, 1);
      assert(!probe.isAcknowledged(id));
      const beforeStop = observer.frames.length;
      dispatch(2, { type: 'chat/turnCancelled', turnId, duration: 0 });
      await until(() => observer.frames.slice(beforeStop).map(actionOf).some(action =>
        action?.type === 'chat/turnCancelled' && action.turnId === turnId), 'AHP Stop cancellation').catch(error => {
        const frames = observer.frames.slice(beforeStop).map(frame => frame.error ?? actionOf(frame) ?? frame.method);
        throw new Error(`${error.message}; ${JSON.stringify({ frames, lead: probe.leadStatus(), holding: probe.isHoldingTurn() })}`);
      });
      await until(() => !probe.isHoldingTurn(), 'Stop cancelled the model request');
      await delay(750);
      assert.equal(probe.leadStatus()?.activity, 'Paused', 'Native Stop must pause the joined role instead of waking it again.');
      assert.equal(probe.leadStatus()?.unread, 1, 'The queued message must stay unread after Stop.');
      assert(!probe.isAcknowledged(id));
      assert(!observer.frames.slice(beforeStop).map(actionOf).some(action => action?.type === 'chat/turnStarted'),
        'No new turn should start between Stop and Resume.');
      console.log(`Stop cancelled the manual turn; Lead stayed paused with ${id} unread.`);

      if (restartHost) {
        const { snapshot: stopped } = await observer.request('subscribe', { channel: chat });
        const promptsBefore = stopped.state.turns.map(turn => turn.message.text);
        assert(promptsBefore.includes(holdPrompt));
        await probe.restart(id);
        await until(() => observer.isClosed(), 'pre-restart AHP connection closed');
        observer = await connect();
        const { items } = await observer.request('listSessions', { channel: root });
        assert.deepEqual(items.map(item => item.resource), [sessionUri], 'Recovery must list only the original session resource.');
        await assert.rejects(observer.request('createSession', { channel: `copilot:/${randomUUID()}`, provider: 'copilot' }),
          /session creation.*(disabled|not allowed)|not allowed to create|creating new sessions.*disabled/i);
        await assert.rejects(probe.resumeQueued(id), /Reopen the original native chat/);
        const { snapshot: existing } = await observer.request('subscribe', { channel: sessionUri });
        assert.equal(existing.state.defaultChat, chat, 'Recovery must retain the original chat resource.');
        const { snapshot: restored } = await observer.request('subscribe', { channel: chat });
        assert.deepEqual(restored.state.turns.map(turn => turn.message.text), promptsBefore);
        assert(JSON.stringify(restored.state.turns).includes(reply), 'Recovery must retain the assistant transcript too.');
        assert(!restored.state.activeTurn, 'Reopening must not start a new turn.');
        assert.equal(probe.leadStatus()?.activity, 'Paused');
        assert.equal(probe.leadStatus()?.unread, 1);
        assert(!probe.isAcknowledged(id));
        console.log('A new host reopened the original session and chat resources with the paused inbox intact.');
      }

      const beforeResume = observer.frames.length;
      await probe.resumeQueued(id);
      await until(() => observer.frames.slice(beforeResume).some(frame =>
        frame.params?.channel === chat && JSON.stringify(frame).includes(`${reply}: acknowledged ${id}`)),
      'resumed wake streamed to the original AHP chat');
      const { snapshot: resumed } = await observer.request('subscribe', { channel: chat });
      const wakeTurns = resumed.state.turns.filter(turn => turn.message.text.includes(`["${id}"]`));
      assert.equal(wakeTurns.length, 1, 'Resume must deliver the queued message exactly once.');
      assert(JSON.stringify(wakeTurns[0].responseParts).includes(`${reply}: acknowledged ${id}`));
      assert.deepEqual(probe.assignedSessions(), [sessionId]);
      console.log(`Explicit Resume acknowledged ${id} exactly once in the original chat.`);
      if (restartHost) {
        assert(!['read-only', 'hidden'].includes(resumed.state.interactivity), 'The recovered SDK chat must allow input.');
        const prompt = 'POST-RESTART-INPUT';
        const turnId = randomUUID();
        observer.send('dispatchAction', {
          channel: chat, clientSeq: 1,
          action: { type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(), message: { text: prompt, origin: { kind: 'user' } } },
        });
        await until(() => observer.frames.map(actionOf).some(action => action?.type === 'chat/turnComplete' && action.turnId === turnId),
          'manual input completed in the recovered chat');
        const { snapshot } = await observer.request('subscribe', { channel: chat });
        assert.equal(snapshot.state.turns.at(-1)?.message.text, prompt);
        assert(JSON.stringify(snapshot.state.turns.at(-1)?.responseParts).includes(reply));
        console.log('The recovered AHP chat accepted and answered a fresh manual prompt.');
      }
    }
  }
} finally {
  observer?.close();
  try { await bridge?.dispose(); }
  finally { await probe.dispose(); }
}
