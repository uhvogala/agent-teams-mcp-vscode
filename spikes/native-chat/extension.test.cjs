const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { activate, deactivate } = require('./extension.cjs');
const { connectNativeChat } = require('../../dist/native-chat.js');

function editor(remoteAddress) {
  const context = { subscriptions: [] };
  const commands = new Map();
  const errors = [];
  const approvals = [];
  const output = [];
  const result = {};
  const vscode = {
    UIKind: { Desktop: 1 },
    env: { uiKind: 1, remoteName: remoteAddress ? 'ssh-remote' : undefined },
    window: {
      createOutputChannel: () => ({ appendLine: line => output.push(line) }),
      showErrorMessage: message => errors.push(message),
      async showInformationMessage(message, options, action) {
        approvals.push({ message, options, action });
        return action;
      },
    },
    chat: {
      registerRemoteAgentHost(host) {
        result.host = host;
        return { dispose() { result.removed = true; } };
      },
    },
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({ get: (_name, fallback) => fallback }),
      async openTunnel({ remoteAddress: target, localAddressPort }) {
        result.target = target;
        result.requestedPort = localAddressPort;
        return { localAddress: remoteAddress, dispose() { result.closed = true; } };
      },
    },
    commands: { registerCommand: (id, command) => commands.set(id, command) },
  };
  return { context, commands, errors, approvals, vscode, result, output };
}

function openSocket(address, token) {
  const url = new URL(address);
  if (token) url.searchParams.set('tkn', token);
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket handshake failed')), { once: true });
  });
}

test('installed Native Chat distinguishes missing proposal permissions from invalid forwards', async () => {
  const team = {
    openNativeHost: async () => ({
      url: new URL('ws://127.0.0.1:12345'), token: 'upstream-token',
      models: [{ id: 'fixture', name: 'Fixture' }],
    }),
  };
  const { vscode, result } = editor('http://127.0.0.1:19212');
  const openTunnel = vscode.workspace.openTunnel;
  const registerHost = vscode.chat.registerRemoteAgentHost;
  vscode.workspace.openTunnel = () => { throw new Error('Extension CANNOT use API proposal: tunnels.'); };
  await assert.rejects(connectNativeChat(team, vscode), /did not enable the tunnels proposal.*--enable-proposed-api/);

  vscode.workspace.openTunnel = openTunnel;
  vscode.chat.registerRemoteAgentHost = () => { throw new Error('Extension CANNOT use API proposal: remoteAgentHost.'); };
  await assert.rejects(connectNativeChat(team, vscode), /did not enable the remoteAgentHost proposal.*--enable-proposed-api/);
  assert(result.closed);
  assert.equal(result.host, undefined);
  await assert.rejects(openSocket(`ws://127.0.0.1:${result.target.port}`), /handshake failed/);

  const invalid = editor('https://public.example.test:19212');
  invalid.vscode.chat.registerRemoteAgentHost = registerHost;
  await assert.rejects(connectNativeChat(team, invalid.vscode), /did not provide a desktop loopback forward/);
  assert(invalid.result.closed);
  assert.equal(invalid.result.host, undefined);
});

test('installed Native Chat reuses its desktop address instead of silently publishing under a different host', async () => {
  const team = {
    openNativeHost: async () => ({
      url: new URL('ws://127.0.0.1:12345'), token: 'upstream-token',
      models: [{ id: 'fixture', name: 'Fixture' }],
    }),
  };
  const first = editor();
  const initial = await connectNativeChat(team, first.vscode);
  await initial.dispose();
  const second = editor();
  const recovered = await connectNativeChat(team, second.vscode, initial.address);
  try {
    assert.equal(second.result.host.address, first.result.host.address);
    assert.notEqual(second.result.host.connectionToken, first.result.host.connectionToken);
  } finally { await recovered.dispose(); }

  const preferred = 'ws://127.0.0.1:19212';
  const remote = editor('http://127.0.0.1:19212');
  const forwarded = await connectNativeChat(team, remote.vscode, preferred);
  try {
    assert.equal(remote.result.requestedPort, 19212);
    assert.equal(forwarded.address, preferred);
  } finally { await forwarded.dispose(); }
  const moved = editor('127.0.0.1:19213');
  await assert.rejects(connectNativeChat(team, moved.vscode, preferred), /could not restore the saved Agent Teams Chat address/);
  assert(moved.result.closed);
  assert.equal(moved.result.host, undefined);
});

async function attach(socket, { create = false } = {}) {
  let id = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const receive = ({ data }) => {
      const frame = JSON.parse(data);
      if (frame.id !== requestId) return;
      socket.removeEventListener('message', receive);
      if (frame.error) reject(new Error(`${method}: ${frame.error.message}`));
      else resolve(frame.result);
    };
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }));
  });
  const channel = 'ahp-root://';
  await request('initialize', { channel, protocolVersions: ['1.2.0'], clientId: randomUUID(), initialSubscriptions: [channel] });
  if (create) {
    assert.deepEqual((await request('listSessions', { channel })).items, []);
    await request('createSession', { channel: `copilot:/${randomUUID()}`, provider: 'copilot' });
  }
  const { items } = await request('listSessions', { channel });
  assert.equal(items.length, 1);
  const { snapshot } = await request('subscribe', { channel: items[0].resource });
  await request('subscribe', { channel: snapshot.state.defaultChat });
  return snapshot.state.defaultChat;
}

test('the unsandboxed approval probe writes exactly once on Allow and not on Deny or Stop',
  { skip: process.platform === 'win32', timeout: 15000 }, async t => {
    const { startProbe } = await import('../../scripts/ahp-probe-fixture.mjs');
    const probe = await startProbe({ approval: true, log: () => {} });
    t.after(() => probe.dispose());
    const socket = await openSocket(probe.url, probe.token);
    t.after(() => socket.close());
    const chat = await attach(socket);
    const waitForAction = (turnId, type) => new Promise(resolve => {
      const receive = ({ data }) => {
        const { params } = JSON.parse(data);
        const action = params?.envelope?.action ?? params?.action;
        if (params?.channel !== chat || action?.turnId !== turnId || action.type !== type) return;
        socket.removeEventListener('message', receive);
        resolve(action);
      };
      socket.addEventListener('message', receive);
    });
    let clientSeq = 0;
    const dispatch = action => socket.send(JSON.stringify({
      jsonrpc: '2.0', method: 'dispatchAction', params: { channel: chat, clientSeq: ++clientSeq, action },
    }));
    for (const [index, decision] of ['allow', 'deny', 'stop'].entries()) {
      const turnId = randomUUID();
      const ready = waitForAction(turnId, 'chat/toolCallReady');
      dispatch({ type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(),
        message: { text: `PROBE APPROVAL ${decision}`, origin: { kind: 'user' } } });
      const { toolCallId, confirmationTitle, confirmed } = await ready;
      assert(confirmationTitle && !confirmed, 'The fixture command must await native confirmation.');
      const filename = `approval-marker-${index + 1}.txt`;
      assert.equal(await probe.approvalStatus(), `${filename}: absent`);
      const done = waitForAction(turnId, decision === 'allow' ? 'chat/turnComplete' : 'chat/turnCancelled');
      if (decision === 'stop') dispatch({ type: 'chat/turnCancelled', turnId, duration: 0 });
      else dispatch({ type: 'chat/toolCallConfirmed', turnId, toolCallId, ...(decision === 'allow'
        ? { approved: true, confirmed: 'user-action' } : { approved: false, reason: 'denied' }) });
      await done;
      assert.equal(await probe.approvalStatus(), `${filename}: ${decision === 'allow' ? JSON.stringify('approved\n') : 'absent'}`);
    }
  });

test('the restart command keeps the original host address, chat and queued delivery after native Stop', { timeout: 15000 }, async t => {
  const { context, vscode, result, errors, commands, approvals, output } = editor();
  t.after(deactivate);
  await activate(context, vscode, true);
  assert.deepEqual(errors, []);
  assert(output.includes('Local AHP catalog (scripted): copilot (0 models).'));
  assert(output.includes('Bridged AHP catalog: copilot (1 model(s)).'));
  assert(output.every(line => !line.includes(result.host.connectionToken)));
  await assert.rejects(openSocket(result.host.address, 'wrong-token'), /handshake failed/);
  const socket = await openSocket(result.host.address, result.host.connectionToken);
  t.after(() => socket.close());
  const chat = await attach(socket, { create: true });
  assert.deepEqual(approvals, []);
  const waitForAction = check => new Promise(resolve => {
    const receive = ({ data }) => {
      const { params } = JSON.parse(data);
      const action = params?.action ?? params?.envelope?.action;
      if (params?.channel !== chat || !action || !check(action)) return;
      socket.removeEventListener('message', receive);
      resolve();
    };
    socket.addEventListener('message', receive);
  });
  let clientSeq = 0;
  const dispatch = action => socket.send(JSON.stringify({
    jsonrpc: '2.0', method: 'dispatchAction', params: { channel: chat, clientSeq: ++clientSeq, action },
  }));
  const start = (turnId, text) => dispatch({
    type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(), message: { text, origin: { kind: 'user' } },
  });
  const turn = randomUUID();
  const completed = waitForAction(action => action.type === 'chat/turnComplete' && action.turnId === turn);
  start(turn, 'Join the team as Lead');
  await completed;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].action, 'Join as Lead');
  assert.equal(approvals[0].options.modal, true);
  assert.match(await commands.get('agentTeamsChatProbe.wake')(), /^[0-9a-f-]{36}$/);

  const { holdPrompt, holdReply } = await import('../../scripts/ahp-probe-fixture.mjs');
  const manual = randomUUID();
  const holding = waitForAction(action => action.turnId === manual && JSON.stringify(action).includes(holdReply));
  start(manual, holdPrompt);
  await holding;
  const id = commands.get('agentTeamsChatProbe.queueStopDelivery')();
  assert.match(id, /^[0-9a-f-]{36}$/);
  const cancelled = waitForAction(action => action.type === 'chat/turnCancelled' && action.turnId === manual);
  dispatch({ type: 'chat/turnCancelled', turnId: manual, duration: 0 });
  await cancelled;
  const { address, connectionToken } = result.host;
  const disconnected = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
  // The host broadcasts cancellation before the SDK reports aborted idle to the controller.
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.equal(await commands.get('agentTeamsChatProbe.restartHost')(), id);
  await disconnected;
  assert(!result.removed, 'Restart should keep the desktop registration.');
  const reopened = await openSocket(address, connectionToken);
  t.after(() => reopened.close());
  assert.equal(await attach(reopened), chat);
  assert.equal(await commands.get('agentTeamsChatProbe.resumeStopDelivery')(), id);
  assert.deepEqual(errors, []);
});

test('declining the live probe does not request credentials or register a host', async () => {
  const { context, vscode, result, errors } = editor();
  vscode.window.showInformationMessage = async () => undefined;
  await activate(context, vscode, true, true);
  assert.equal(result.host, undefined);
  assert.deepEqual(errors, []);
});

test('registers a live token-protected host and removes it on shutdown', { timeout: 15000 }, async t => {
  const { context, vscode, result, errors, commands } = editor();
  t.after(deactivate);
  await activate(context, vscode);
  assert.deepEqual(errors, []);
  const { address, connectionToken } = result.host;
  assert.equal(new URL(address).hostname, '127.0.0.1');
  await assert.rejects(openSocket(address), /handshake failed/);
  const socket = await openSocket(address, connectionToken);
  t.after(() => socket.close());
  await attach(socket);
  const frames = [];
  socket.addEventListener('message', ({ data }) => frames.push(data));
  const id = await commands.get('agentTeamsChatProbe.wake')();
  assert.deepEqual(errors, []);
  assert.match(id, /^[0-9a-f-]{36}$/);
  const { reply } = await import('../../scripts/ahp-probe-fixture.mjs');
  for (const text of [id, `${reply}: acknowledged ${id}`]) {
    // The SDK idle event and the AHP stream arrive on different connections.
    for (const deadline = Date.now() + 2000; !frames.some(frame => frame.includes(text)) && Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(frames.some(frame => frame.includes(text)), `AHP did not stream "${text}"`);
  }
  await deactivate();
  assert(result.removed);
  await assert.rejects(openSocket(address, connectionToken), /handshake failed/);
});

test('uses the desktop port returned by VS Code and closes the remote forward', { timeout: 15000 }, async t => {
  const { context, vscode, result, errors } = editor('http://127.0.0.1:19212');
  t.after(deactivate);
  await activate(context, vscode);
  assert.deepEqual(errors, []);
  assert.equal(result.target.host, '127.0.0.1');
  assert(result.target.port > 0);
  assert.equal(result.host.address, 'ws://127.0.0.1:19212');
  await deactivate();
  assert(result.removed && result.closed);
});

test('rejects a non-loopback forward without registering or leaving the listener up', { timeout: 15000 }, async () => {
  const { context, vscode, result, errors } = editor('https://public.example.test:19212');
  await activate(context, vscode);
  assert.equal(result.host, undefined);
  assert.match(errors[0], /did not provide a desktop loopback forward/);
  assert(result.closed);
  await assert.rejects(openSocket(`ws://127.0.0.1:${result.target.port}`), /handshake failed/);
});
