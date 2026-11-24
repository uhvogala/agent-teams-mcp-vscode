import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CopilotClient } from '@microsoft/copilot-sdk';
import { SignInCancelled } from './auth';
import { postTeamFromChat, prepareTeamChatMessage, readTeamForChat } from './chat';
import { TeamStore } from './store';
import { Team } from './team';
import { defaultRoles, defaultTeamConfig, type RoleDefinition } from './team-config';
import { teamRuntime } from './runtime';

test('the bundled Linux runtime starts when the extension host omits glibc metadata', { skip: process.platform !== 'linux' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-runtime-test-'));
  t.mock.method(process.report, 'getReport', () => ({ header: {} }));
  const client = new CopilotClient({
    mode: 'empty',
    github: { useLoggedInUser: false },
    runtime: teamRuntime(dir),
  });
  try {
    await client.start();
    assert.match((await client.getStatus()).version, /^\d+\.\d+\.\d+/);
  } finally {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the bundled SDK routes Enterprise token validation only to the configured instance', { skip: process.platform !== 'linux', timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-enterprise-routing-'));
  const proxy = createServer();
  const destinations = new Set<string>();
  proxy.on('connect', (request, socket) => {
    destinations.add(request.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  assert(address && typeof address !== 'string');
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const overrides = {
    COPILOT_GH_HOST: 'wrong-host.ghe.com', GH_HOST: 'wrong-host.ghe.com',
    HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl, NO_PROXY: '', no_proxy: '',
  };
  const original = Object.entries(overrides).map(([key]) => [key, process.env[key]] as const);
  Object.assign(process.env, overrides);
  let client: CopilotClient | undefined;
  try {
    client = new CopilotClient({
      mode: 'empty', github: { token: 'gho_synthetic', useLoggedInUser: false },
      runtime: teamRuntime(dir, 'work.ghe.com'),
    });
    assert.equal((await client.getAuthStatus()).isAuthenticated, false);
    assert.deepEqual([...destinations], ['api.work.ghe.com:443']);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await client?.stop();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent role starts share GitHub approval and leave both roles vacant if it is cancelled', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-auth-test-'));
  const store = new TeamStore(join(dir, 'team.sqlite'));
  t.mock.method(CopilotClient.prototype, 'start', async () => {});
  const authStatus = t.mock.method(CopilotClient.prototype, 'getAuthStatus', async () => ({ isAuthenticated: false }));
  let requestShown!: () => void;
  const requested = new Promise<void>(resolve => { requestShown = resolve; });
  let cancel!: (error: Error) => void;
  const pending = new Promise<never>((_, reject) => { cancel = reject; });
  let requests = 0;
  const team = new Team(store, dir, join(dir, 'runtime'), () => ({ projectSummary: '' }), () => {}, () => {}, {
    target: () => ({ provider: 'github', host: 'github.com' }),
    session: () => {
      requests++;
      requestShown();
      return pending;
    },
  });
  try {
    const starts = Promise.allSettled([team.start('lead'), team.start('builder')]);
    await requested;
    cancel(new SignInCancelled());
    for (const result of await starts) {
      assert.equal(result.status, 'rejected');
      assert(result.reason instanceof SignInCancelled);
    }
    assert.equal(requests, 1);
    assert.equal(authStatus.mock.callCount(), 1);
    assert.equal(store.role('lead').sessionId, null);
    assert.equal(store.role('builder').sessionId, null);
  } finally {
    await team.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Enterprise startup rejects another host before assigning a role', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-enterprise-test-'));
  const store = new TeamStore(join(dir, 'team.sqlite'));
  t.mock.method(CopilotClient.prototype, 'start', async () => {});
  const status = t.mock.method(CopilotClient.prototype, 'getAuthStatus', async () => ({
    isAuthenticated: true, host: 'https://github.com', login: 'other-account',
  }));
  const team = new Team(store, dir, join(dir, 'runtime'), () => ({ projectSummary: '' }), () => {}, () => {}, {
    target: () => ({ provider: 'github-enterprise', host: 'work.ghe.com' }),
    session: async (target) => {
      assert.equal(status.mock.callCount(), 0, 'Enterprise must not probe ambient SDK credentials');
      assert.equal(target.host, 'work.ghe.com');
      return { accessToken: 'synthetic-enterprise', accountLabel: 'unverified-account' };
    },
  });
  try {
    await assert.rejects(team.start('lead'), /could not verify the VS Code sign-in for work.ghe.com/);
    assert.equal(store.role('lead').sessionId, null);
    assert.equal(team.signedInLogin, undefined);
  } finally {
    await team.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('verified sign-in uses the editor account label when SDK login is missing without changing stored authorship', async t => {
  const store = new TeamStore(':memory:');
  t.mock.method(CopilotClient.prototype, 'start', async () => {});
  t.mock.method(CopilotClient.prototype, 'getAuthStatus', async () => ({
    isAuthenticated: true, host: 'https://work.ghe.com',
  }));
  let changes = 0;
  const team = new Team(store, '/fixture', '/fixture-runtime', () => ({ projectSummary: '' }), () => { changes++; }, () => {}, {
    target: () => ({ provider: 'github-enterprise', host: 'work.ghe.com' }),
    session: async () => ({ accessToken: 'synthetic-enterprise', accountLabel: 'octocat' }),
  });
  try {
    assert.equal(team.signedInLogin, undefined);
    await team.authenticate();
    assert.equal(team.signedInLogin, 'octocat');
    assert.equal(changes, 1);
    team.postHuman('team', 'Hello', []);
    assert.equal(store.transcript('team')[0].author, 'You');
  } finally {
    await team.close();
    store.close();
  }
});

test('unaddressed human posts select one available room member and preserve explicit delivery', async t => {
  const store = new TeamStore(':memory:', [
    { id: 'release-qa', name: 'Release QA', description: 'Check releases.' },
    ...defaultRoles,
  ]);
  t.mock.method(CopilotClient.prototype, 'start', async () => {});
  t.mock.method(CopilotClient.prototype, 'stop', async () => {});
  let finishTurn!: () => void;
  const turn = new Promise<void>(resolve => { finishTurn = resolve; });
  t.mock.method(CopilotClient.prototype, 'resumeSession', async () => ({
    sendAndWait: () => turn,
    abort: async () => {},
    disconnect: async () => {},
  }));
  let preferred: string | undefined = 'release-qa';
  const team = new Team(store, '/fixture', '/fixture-runtime', () => ({
    projectSummary: '', defaultRecipientRoleId: preferred, github: { capi: { enabled: false } },
  }), () => {}, () => {});
  const assign = (id: string) => {
    const session = store.reserve(id);
    store.assign(id, session);
    return session;
  };
  const builder = assign('builder');
  const qa = assign('release-qa');
  const lead = assign('lead');
  const room = store.createRoom('Quick', 'quick', ['lead', 'builder']);
  const recipients = (roomId: string, id: string) => store.transcript(roomId).find(message => message.id === id)
    ?.recipients.map(({ name, unread }) => ({ name, unread }));
  try {
    const offline = team.postHuman('team', 'Everything is disconnected', []);
    assert.equal(offline.wakeScheduled, 0);
    assert.deepEqual(recipients('team', offline.id), []);
    await team.start('release-qa');
    await team.start('builder');
    const first = team.postHuman('team', 'Unaddressed', []);
    assert.equal(first.wakeScheduled, 1);
    assert.deepEqual(recipients('team', first.id), [{ name: 'Release QA', unread: true }]);
    preferred = undefined;
    const reply = team.postHuman('team', 'Follow-up', [], first.id);
    assert.equal(reply.wakeScheduled, 1, 'a busy worker can queue a wake');
    assert.deepEqual(recipients('team', reply.id), [{ name: 'Release QA', unread: true }]);
    preferred = 'release-qa';
    const quick = team.postHuman(room, 'Preferred role is not a member', []);
    assert.deepEqual(recipients(room, quick.id), [{ name: 'Builder', unread: true }]);
    const explicit = team.postHuman(room, 'Explicit disconnected target', ['lead']);
    assert.deepEqual(recipients(room, explicit.id), [{ name: 'Lead', unread: true }]);
    assert.equal(store.unread(lead), 1);
    const mention = team.postHuman('team', '@reviewer vacant mention', []);
    assert.equal(mention.wakeScheduled, 0);
    assert.deepEqual(recipients('team', mention.id), []);
    preferred = undefined;
    const ordered = team.postHuman('team', 'Use role-ID order', []);
    assert.deepEqual(recipients('team', ordered.id), [{ name: 'Builder', unread: true }]);

    store.readInbox(qa, [first.id]);
    assert.deepEqual(recipients('team', first.id), [{ name: 'Release QA', unread: true }]);
    assert.equal(store.acknowledge(qa, first.id), true);
    assert.deepEqual(recipients('team', first.id), [{ name: 'Release QA', unread: false }]);
    await team.pause('builder');
    const paused = team.postHuman(room, 'No available room worker', []);
    assert.equal(paused.wakeScheduled, 0);
    assert.deepEqual(recipients(room, paused.id), []);
    await team.start('lead');
    preferred = defaultTeamConfig.defaultRecipientRoleId;
    const toLead = team.postHuman('team', 'Unaddressed request with Lead available', []);
    assert.equal(toLead.wakeScheduled, 1);
    assert.deepEqual(recipients('team', toLead.id), [{ name: 'Lead', unread: true }]);
    const addressed = team.postHuman('team', '@release-qa Please check this', []);
    assert.deepEqual(recipients('team', addressed.id), [{ name: 'Release QA', unread: true }]);
    finishTurn();
    await team.release('release-qa');
    assert.equal(store.unread(assign('release-qa')), 0);
    assert.deepEqual(recipients('team', first.id), [{ name: 'Release QA', unread: false }]);
  } finally {
    finishTurn();
    await team.close();
    store.close();
  }
});

test('the real SDK and MCP relay notifications and restore previously published sessions', { timeout: 25_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-integration-'));
  const workspace = join(dir, 'workspace');
  const database = join(dir, 'team.sqlite');
  await mkdir(workspace);
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  await writeFile(join(workspace, 'README.md'), 'DOGFOOD-README-FIXTURE');
  await writeFile(join(dir, 'builder-outside.txt'), 'BUILDER-UNSANDBOXED-FIXTURE');
  let repositoryReadAccess = false;
  let chatDefaults: unknown;
  let chatSandbox: boolean | undefined;
  let sawRepositoryContents = false;
  const repositoryTrace: unknown[] = [];
  const workspaceOperations: string[] = [];
  const operationOutput = new Map<string, string>();
  const browserTools = [
    'openBrowserPage', 'readPage', 'screenshotPage', 'navigatePage', 'clickElement', 'typeInPage',
    'hoverElement', 'dragElement', 'handleDialog', 'runPlaywrightCode',
  ];
  const browserInputs: unknown[] = [];
  const browserInput = { url: 'https://preview.example.test/demo?case=original', forceNew: false };
  let taskCompletionCalls = 0;
  const toolCatalog = new Map<string, string[] | undefined>();
  let continuedThread = false;
  let delegationDescription: string | undefined;
  let delegationRooms: string | undefined;
  let calls = 0;
  const systemPrompts = new Set<string>();
  const model = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const request: {
        messages: { role: string; content?: string }[];
        tools?: { function: { name: string; description?: string } }[];
        stream?: boolean;
      } = JSON.parse(raw);
      calls++;
      for (const message of request.messages) {
        if (message.role === 'system' && typeof message.content === 'string') systemPrompts.add(message.content);
      }
      const index = request.messages.map(message => message.role).lastIndexOf('user');
      const prompt = request.messages[index]?.content ?? '';
      const after = request.messages.slice(index + 1).filter(message => message.role === 'tool');
      const batch = /\["[a-f0-9-]+"(?:,"[a-f0-9-]+")*\]/.exec(prompt)?.[0];
      const ids: string[] = batch ? JSON.parse(batch) : [];
      const id = ids[0];
      const inboxResult: {
        messages?: { body: string }[];
        threads?: { anchorId: string; ancestorsIncomplete: boolean }[];
      } = id && after[0]?.content
        ? JSON.parse(after[0].content) : {};
      const deliveredBody = inboxResult.messages?.[0]?.body;
      let tool: string | undefined;
      let args: object = {};
      if (id && !after.length) {
        tool = 'read_inbox'; args = { ids };
      } else if (deliveredBody === 'Check thread continuation') {
        const page = inboxResult.threads?.[0];
        assert(page?.ancestorsIncomplete);
        if (after.length === 1) {
          tool = 'read_thread'; args = { anchorId: page.anchorId };
        } else if (after.length <= 3) {
          const continuation = JSON.parse(after.at(-1)?.content ?? '{}');
          if (continuation.nextAfterSeq !== null) {
            tool = 'read_thread'; args = {
              anchorId: page.anchorId, afterSeq: continuation.nextAfterSeq, throughSeq: continuation.throughSeq,
            };
          } else {
            continuedThread = continuation.messages.some((post: { body: string }) => post.body === 'Last quiet branch');
            tool = 'ack_message'; args = { id };
          }
        }
      } else if (ids.length > 1 && after.length <= ids.length) {
        tool = 'ack_message'; args = { id: ids[after.length - 1] };
      } else if (id && after.length === 1 && deliveredBody?.includes('relay this')) {
        tool = 'post_message'; args = { roomId: 'team', body: 'Agent relay', targets: ['builder'] };
      } else if (id && after.length === 1 && deliveredBody === 'Agent relay') {
        tool = 'post_message'; args = { roomId: 'team', body: 'Received the relay', replyTo: id };
      } else if (prompt.includes('NATIVE-DELEGATE') && !after.length) {
        delegationDescription = request.tools?.find(candidate => candidate.function.name.endsWith('post_message'))?.function.description;
        tool = 'list_rooms';
      } else if (prompt.includes('NATIVE-DELEGATE') && after.length < 3) {
        delegationRooms = after[0].content;
        tool = 'post_message';
        args = {
          roomId: 'team',
          body: after.length === 2 ? '@all Native follow-up' : '@Builder @reviewer Native assignment',
        };
      } else if (id && after.length && after.length <= (deliveredBody === 'Agent relay' || deliveredBody?.includes('relay this') ? 2 : 1)) {
        tool = 'ack_message'; args = { id };
      } else if (!id && !after.length && prompt.includes('greeting')) {
        tool = 'post_message'; args = { roomId: 'team', body: 'Ready.' };
      } else if (prompt.includes('NATIVE-AFTER-RESTART')) {
        repositoryTrace.push({ after, tools: request.tools?.map(candidate => candidate.function.name) });
        if (!after.length) {
          tool = 'list_repository_files'; args = { prefix: 'README' };
        } else if (after.length === 1 && after[0].content?.includes('README.md')) {
          tool = 'read_repository_file'; args = { path: 'README.md' };
        } else if (after.length === 2) {
          sawRepositoryContents = Boolean(after[1].content?.includes('DOGFOOD-README-FIXTURE'));
        }
      }
      const shellCommands = {
        'BUILDER-RUN': `node -e 'process.stdout.write(require("node:fs").readFileSync("../builder-outside.txt"))'`,
        'REVIEWER-RUN': 'printf AGENT-TEAMS-RUN-OK',
        'REVIEWER-WRITE': 'printf x > reviewer-write.txt',
        'LEAD-RUN': 'printf AGENT-TEAMS-RUN-OK',
        'COPILOT-LAUNCH-RUN': 'printf NATIVE-LAUNCH-RUN > native-launch-marker.txt',
      };
      const shellOperation = Object.entries(shellCommands).find(([marker]) => prompt.includes(marker));
      const edit = ['BUILDER-EDIT-OUTSIDE', 'BUILDER-EDIT'].find(marker => prompt.includes(marker));
      const browser = ['LEAD-BROWSER', 'BUILDER-BROWSER', 'REVIEWER-BROWSER'].find(marker =>
        prompt.includes(marker) || deliveredBody?.includes(marker));
      const basicTools = prompt.includes('BASIC-EDITOR-TOOLS');
      if (basicTools) taskCompletionCalls++;
      const operation = edit ?? shellOperation?.[0] ?? browser ??
        (basicTools ? 'BASIC-EDITOR-TOOLS' : prompt.includes('COPILOT-LAUNCH-TOOLS') ? 'COPILOT-LAUNCH-TOOLS' : undefined);
      if (operation) toolCatalog.set(operation, request.tools?.map(candidate => candidate.function.name));
      if (operation && after.length) operationOutput.set(operation, after.at(-1)?.content ?? '');
      if (!after.length && edit) {
        tool = 'create';
        args = {
          path: edit === 'BUILDER-EDIT' ? join(workspace, 'builder-edit.txt') : join(dir, 'builder-outside-edit.txt'),
          file_text: 'Builder edited this file.\n',
        };
      } else if (!after.length && shellOperation) {
        tool = 'bash';
        args = { command: shellOperation[1], description: 'Workspace permission fixture' };
      } else if (browser && after.length === (id ? 2 : 0)) {
        tool = 'openBrowserPage';
        args = browserInput;
      } else if (!after.length && basicTools) {
        tool = 'problems';
      } else if (after.length === 1 && basicTools) {
        tool = 'task_complete';
        args = { summary: 'BASIC TOOL VERIFICATION COMPLETE' };
      }
      const name = request.tools?.find(candidate => candidate.function.name.endsWith(`-${tool}`) || candidate.function.name === tool)?.function.name;
      const message = name
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `tool_${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
        : { role: 'assistant', content: 'Done' };
      const finish = name ? 'tool_calls' : 'stop';
      const common = { id: `chatcmpl-${calls}`, model: 'gpt-4o', created: Math.floor(Date.now() / 1000) };
      if (request.stream) {
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
  await new Promise<void>((resolve, reject) => {
    model.once('error', reject);
    model.listen(0, '127.0.0.1', resolve);
  });
  const address = model.address();
  assert(address && typeof address !== 'string');
  const makeTeam = (store: TeamStore) => new Team(store, workspace, join(dir, 'runtime'), () => ({
    projectSummary: 'Synthetic test',
    repositoryReadAccess,
    chatDefaults,
    chatSandbox,
    model: 'gpt-4o',
    github: { capi: { enabled: false } },
    inference: { defaultProvider: 'fixture', providers: [
      { name: 'fixture', type: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1/`, wireApi: 'completions', apiKey: 'local-dummy' },
    ] },
  }), () => {}, message => console.error(message), undefined, async (role, operation) => {
    workspaceOperations.push(`${role.id}:${operation.kind}`);
    return true;
  });
  const waitUntil = async (check: () => boolean, message: string) => {
    const end = Date.now() + 5000;
    while (!check() && Date.now() < end) await delay(20);
    assert(check(), message);
  };
  const definitions = (prompt: string, overrides: Record<string, RoleDefinition['permissions']> = {}) => defaultRoles.map(role => ({
    ...role, ...(role.id === 'builder' ? { prompt } : {}), permissions: { ...role.permissions, ...overrides[role.id] },
  }));
  const connect = async (host: Awaited<ReturnType<Team['openNativeHost']>>) => {
    const url = new URL(host.url);
    url.searchParams.set('tkn', host.token);
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not connect to the native host.')), { once: true });
    });
    let requestId = 0;
    const request = (method: string, params: object) => new Promise<unknown>((resolve, reject) => {
      const id = ++requestId;
      const receive = (event: MessageEvent) => {
        const frame = JSON.parse(event.data);
        if (frame.id !== id) return;
        socket.removeEventListener('message', receive);
        if (frame.error) reject(new Error(frame.error.message));
        else resolve(frame.result);
      };
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    const channel = 'ahp-root://';
    const clientId = crypto.randomUUID();
    await request('initialize', { channel, protocolVersions: ['1.2.0'], clientId, initialSubscriptions: [channel] });
    let clientSeq = 0;
    const dispatch = (channel: string, action: object) => socket.send(JSON.stringify({
      jsonrpc: '2.0', method: 'dispatchAction', params: { channel, clientSeq: ++clientSeq, action },
    }));
    return { socket, request, channel, clientId, dispatch };
  };
  type ChatSnapshot = { snapshot: { state: { interactivity?: string; turns: { message: { text: string } }[] } } };
  const sendNative = async ({ socket, dispatch }: Awaited<ReturnType<typeof connect>>, chat: string, text: string) => {
    const turnId = crypto.randomUUID();
    let complete = false;
    const receive = (event: MessageEvent) => {
      const { params } = JSON.parse(event.data);
      const action = params?.envelope?.action ?? params?.action;
      complete ||= action?.type === 'chat/turnComplete' && action.turnId === turnId;
    };
    socket.addEventListener('message', receive);
    try {
      dispatch(chat, { type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(), message: { text, origin: { kind: 'user' } } });
      await waitUntil(() => complete, `native turn should complete: ${text}`);
    } finally { socket.removeEventListener('message', receive); }
  };
  let store = new TeamStore(database, definitions('BUILDER-ORIGINAL-PROMPT'));
  let team = makeTeam(store);
  try {
    t.mock.method(CopilotClient.prototype, 'listModels', async () => []);
    const createSession = t.mock.method(CopilotClient.prototype, 'createSession');
    const nativeHost = await team.openNativeHost();
    const started = await team.startInNativeChat('lead', 'gpt-4o-mini');
    await team.start('builder');
    const lead = store.role('lead').sessionId!;
    const builder = store.role('builder').sessionId!;
    assert.equal(started.sessionId, lead);
    assert.deepEqual(createSession.mock.calls.map(call => call.arguments[0]?.model), ['gpt-4o-mini', 'gpt-4o']);
    const native = await connect(nativeHost);
    const { socket, request: nativeRequest, channel } = native;
    let resource: string;
    let chat: string;
    const activity = (id: string) => team.roster().find(role => role.id === id)?.activity;
    try {
      const { items } = await nativeRequest('listSessions', { channel }) as { items: { resource: string; provider: string }[] };
      assert.deepEqual(items.map(item => [new URL(item.resource).pathname, item.provider]), [[`/${lead}`, 'copilot']]);
      resource = items[0].resource;
      const { snapshot } = await nativeRequest('subscribe', { channel: resource }) as { snapshot: { state: { defaultChat?: string } } };
      assert(snapshot.state.defaultChat);
      chat = snapshot.state.defaultChat;
      await nativeRequest('subscribe', { channel: chat });
      await assert.rejects(nativeRequest('createSession', { channel: `copilot:/${crypto.randomUUID()}`, provider: 'copilot' }), /disabled|not allowed/i);
      assert.equal((await team.startInNativeChat('lead')).sessionId, lead);
      assert.equal(createSession.mock.callCount(), 2);
      await waitUntil(() => activity('lead') === 'Idle', 'Lead should finish its greeting before native input');
      await sendNative(native, chat, 'NATIVE-BEFORE-RESTART');
    } finally {
      socket.close();
    }
    await waitUntil(() => activity('lead') === 'Idle' && activity('builder') === 'Idle', 'both workers should go idle');
    assert([...systemPrompts].some(prompt => prompt.includes('BUILDER-ORIGINAL-PROMPT')), 'the custom prompt should reach the worker model');
    const request = { roomId: 'team', roleId: 'lead', body: 'Please relay this to Builder' };
    const overview = readTeamForChat(team, {});
    assert(overview.roles?.some(role => role.id === 'lead' && role.activity === 'Idle'));
    assert.equal(overview.recentMessages, undefined);
    const before = team.store.transcript('team');
    assert.equal(prepareTeamChatMessage(team, request).role.id, 'lead');
    assert.deepEqual(team.store.transcript('team'), before, 'preparing a confirmation must not post');
    assert.throws(() => postTeamFromChat(team, { ...request, roleId: 'reviewer' }), /start or resume/i);
    const first = postTeamFromChat(team, request);
    assert.equal(first.recipients, 1);
    await waitUntil(() => store.isAcknowledged(lead, first.id) && store.transcript('team').some(message => message.body === 'Received the relay'), 'Lead should wake Builder through MCP');
    await waitUntil(() => store.unread(builder) === 0 && activity('builder') === 'Idle', 'Builder should acknowledge the relayed ID');
    const reply = store.transcript('team').find(message => message.body === 'Received the relay');
    assert(reply);
    assert.equal(reply.replyTo?.preview, 'Agent relay');
    await waitUntil(() => store.isAcknowledged(lead, reply.id) && activity('lead') === 'Idle',
      'Builder should also be able to wake Lead from its inbox turn');
    assert(readTeamForChat(team, { roomId: 'team' }).recentMessages?.some(message => message.author === 'Builder' && message.body === 'Received the relay'));

    const root = store.post('team', 'You', 'Long thread root', [], false);
    let parent = root.id;
    for (let index = 0; index < 20; index++) {
      parent = store.post('team', 'You', `Quiet ancestor ${index}`, [], false, undefined, parent).id;
    }
    store.post('team', 'You', 'Last quiet branch', [], false, undefined, root.id);
    const continuation = team.postHuman('team', 'Check thread continuation', ['lead'], parent);
    await waitUntil(() => store.isAcknowledged(lead, continuation.id) && activity('lead') === 'Idle',
      'Lead should read the thread continuation through MCP and acknowledge the inbox delivery');
    assert(continuedThread);

    await team.start('reviewer');
    const reviewer = store.role('reviewer').sessionId!;
    await waitUntil(() => activity('reviewer') === 'Idle', 'Reviewer should finish the greeting before the delegation');
    const delegation = await connect(nativeHost);
    try {
      await delegation.request('subscribe', { channel: resource });
      await delegation.request('subscribe', { channel: chat });
      await sendNative(delegation, chat, 'NATIVE-DELEGATE');
    } finally { delegation.socket.close(); }
    const assignment = store.transcript('team').find(message => message.body === '@Builder @reviewer Native assignment');
    const followup = store.transcript('team').find(message => message.body === '@all Native follow-up');
    assert(assignment && followup, 'the native prompt should produce both addressed posts');
    assert.match(delegationDescription ?? '', /targets such as \["builder","reviewer"\].*@builder or @all.*replyTo/);
    assert.match(delegationRooms ?? '', /"id":"team".*"memberRoleIds":\["builder","lead","reviewer"\]/);
    await waitUntil(() => [builder, reviewer].every(id => store.isAcknowledged(id, assignment.id) && store.isAcknowledged(id, followup.id)),
      'both native posts should wake the intended peers, including the @all follow-up');
    assert.equal(store.unread(lead), 0, '@all must not include the sender');

    assert.equal((await team.startInNativeChat('builder')).sessionId, builder);
    await team.pause('builder');
    assert.throws(() => postTeamFromChat(team, { ...request, roleId: 'builder' }), /paused/i);
    const next = team.postHuman('team', 'Preserve this across restart', ['builder']);
    assert.equal(store.role('builder').paused, 1);
    await team.close();
    store.close();
    repositoryReadAccess = true;
    store = new TeamStore(database, definitions('BUILDER-UPDATED-PROMPT', {
      builder: { sandbox: false, promptForApproval: false, browser: true },
      reviewer: { sandbox: false, promptForApproval: false, browser: true },
    }));
    team = makeTeam(store);
    assert.equal(activity('lead'), 'Needs recovery');
    assert.equal(activity('builder'), 'Paused');
    await assert.rejects(team.restore(async () => { throw new Error('test port conflict'); }), /test port conflict/);
    assert.equal(activity('lead'), 'Idle', 'a desktop registration failure does not undo worker recovery');
    assert.equal(activity('reviewer'), 'Idle');
    const recoveredHost = await team.openNativeHost();
    await team.restore(() => Promise.resolve(recoveredHost));
    assert.equal(activity('builder'), 'Paused');
    assert.equal(store.isAcknowledged(builder, next.id), false);
    const recovered = await connect(recoveredHost);
    try {
      const list = async () => {
        const { items } = await recovered.request('listSessions', { channel }) as { items: { resource: string }[] };
        return new Map(items.map(item => [new URL(item.resource).pathname, item.resource]));
      };
      const listed = await list();
      assert.deepEqual([...listed.keys()].sort(), [`/${lead}`, `/${builder}`].sort(), 'the host lists only opted-in chats');
      await assert.rejects(recovered.request('subscribe', { channel: listed.get(`/${builder}`) }), /materialization failed/, 'a native subscription cannot restart a paused worker');
      assert.equal(activity('builder'), 'Paused');
      const { snapshot: session } = await recovered.request('subscribe', { channel: resource }) as { snapshot: { state: { defaultChat: string } } };
      assert.equal(session.state.defaultChat, chat);
      const { snapshot: restored } = await recovered.request('subscribe', { channel: chat }) as ChatSnapshot;
      assert(!['read-only', 'hidden'].includes(restored.state.interactivity ?? ''));
      assert(restored.state.turns.some(turn => turn.message.text === 'NATIVE-BEFORE-RESTART'));
      await sendNative(recovered, chat, 'NATIVE-AFTER-RESTART');
      assert(sawRepositoryContents, `the restored worker should be able to list and read workspace docs: ${JSON.stringify(repositoryTrace)}`);
      await team.start('builder');
      await team.restoreNativeChat(() => Promise.resolve(recoveredHost), 'builder');
      const { snapshot: builderSession } = await recovered.request('subscribe', { channel: listed.get(`/${builder}`) }) as { snapshot: { state: { defaultChat: string } } };
      assert(builderSession.state.defaultChat, 'explicit resume republishes the original opted-in worker');
      await waitUntil(() => store.isAcknowledged(builder, next.id), 'the restored worker should acknowledge its saved delivery with the new MCP connection');
      assert([...systemPrompts].some(prompt => prompt.includes('BUILDER-UPDATED-PROMPT') && !prompt.includes('BUILDER-ORIGINAL-PROMPT')),
        'the original worker should use the updated role prompt after reconnect');
      assert.equal(createSession.mock.callCount(), 3);
    } finally { recovered.socket.close(); }
    const runForRole = async (roleId: string, marker: string, browserTurn?: 'native' | 'inbox') => {
      const role = await team.startInNativeChat(roleId);
      await waitUntil(() => activity(roleId) === 'Idle', `${roleId} should be idle before native input`);
      const observer = await connect(recoveredHost);
      try {
        const { items } = await observer.request('listSessions', { channel }) as { items: { resource: string }[] };
        const matched = items.find(item => new URL(item.resource).pathname === `/${role.sessionId}`);
        assert(matched);
        const { snapshot } = await observer.request('subscribe', { channel: matched.resource }) as { snapshot: { state: { defaultChat: string } } };
        await observer.request('subscribe', { channel: snapshot.state.defaultChat });
        if (browserTurn) {
          let advertised = false;
          observer.socket.addEventListener('message', event => {
            const { params } = JSON.parse(event.data);
            const action = params?.envelope?.action ?? params?.action;
            advertised ||= action?.type === 'session/activeClientSet' && action.activeClient.clientId === observer.clientId;
            const request = action?.type === 'session/inputNeededSet' && action.request;
            const name = request?.toolCall?.toolName;
            if (request?.kind === 'toolClientExecution' && (name === 'openBrowserPage' || name === 'problems')) {
              if (name === 'openBrowserPage') browserInputs.push(request.toolCall.toolInput);
              const text = name === 'problems' ? 'EDITOR DIAGNOSTICS RESULT' : 'NATIVE BROWSER RESULT';
              observer.dispatch(request.chat, {
                type: 'chat/toolCallComplete', turnId: request.turnId, toolCallId: request.toolCall.toolCallId,
                result: { success: true, pastTenseMessage: 'Completed fixture', content: [{ type: 'text', text }] },
              });
            }
          });
          observer.dispatch(matched.resource, {
            type: 'session/activeClientSet',
            activeClient: { clientId: observer.clientId, tools: [...browserTools, 'problems', 'usages', 'runTask'].map(name => ({
              name, inputSchema: { type: 'object', properties: { url: { type: 'string' }, forceNew: { type: 'boolean' } } },
            })) },
          });
          await waitUntil(() => advertised, 'editor client tools should be advertised');
        }
        if (browserTurn === 'inbox') {
          await sendNative(observer, snapshot.state.defaultChat, 'Connect the editor before the inbox wake.');
          const delivery = team.postHuman('team', marker, [roleId]);
          await waitUntil(() => store.isAcknowledged(role.sessionId!, delivery.id) && activity(roleId) === 'Idle',
            'the original worker should acknowledge the exact inbox message and finish using the editor browser');
        } else {
          await sendNative(observer, snapshot.state.defaultChat, marker);
        }
        return (await observer.request('subscribe', { channel: snapshot.state.defaultChat }) as ChatSnapshot).snapshot.state;
      } finally { observer.socket.close(); }
    };
    await runForRole('lead', 'LEAD-RUN');
    assert(!operationOutput.has('LEAD-RUN'));
    const basicToolTranscript = await runForRole('lead', 'BASIC-EDITOR-TOOLS', 'native');
    const basics = toolCatalog.get('BASIC-EDITOR-TOOLS') ?? [];
    assert(basics.includes('problems') && basics.includes('usages'), JSON.stringify(basics));
    assert(basics.includes('task_complete'), JSON.stringify(basics));
    assert(!basics.includes('runTask'), 'editor tasks must not bypass the shell policy');
    assert.match(operationOutput.get('BASIC-EDITOR-TOOLS') ?? '', /EDITOR DIAGNOSTICS RESULT/);
    assert.match(JSON.stringify(basicToolTranscript.turns.at(-1)), /BASIC TOOL VERIFICATION COMPLETE/);
    assert.equal(taskCompletionCalls, 2, 'task_complete must end the turn without another model response');
    await runForRole('lead', 'LEAD-BROWSER', 'native');
    assert(!toolCatalog.get('LEAD-BROWSER')?.some(name => browserTools.includes(name)));
    await runForRole('builder', 'BUILDER-BROWSER');
    assert(!toolCatalog.get('BUILDER-BROWSER')?.some(name => browserTools.includes(name)), 'without an advertising editor there are no browser tools');
    await runForRole('builder', 'BUILDER-BROWSER', 'native');
    await runForRole('reviewer', 'REVIEWER-BROWSER', 'inbox');
    for (const role of ['BUILDER', 'REVIEWER']) {
      assert.match(operationOutput.get(`${role}-BROWSER`) ?? '', /NATIVE BROWSER RESULT/,
        `${role}: ${JSON.stringify({ tools: toolCatalog.get(`${role}-BROWSER`), result: operationOutput.get(`${role}-BROWSER`) })}`);
      const catalog = toolCatalog.get(`${role}-BROWSER`) ?? [];
      assert.deepEqual(catalog.filter(name => browserTools.includes(name)).sort(), [...browserTools].sort());
      assert(!catalog.includes('agentTeamsBrowserPreview'));
    }
    assert.equal(browserInputs.length, 2);
    for (const input of browserInputs) {
      assert(typeof input === 'string', JSON.stringify(input));
      assert.deepEqual(JSON.parse(input), browserInput);
    }
    await runForRole('builder', 'BUILDER-EDIT');
    assert.equal(await readFile(join(workspace, 'builder-edit.txt'), 'utf8').catch(error => error.message),
      'Builder edited this file.\n', operationOutput.get('BUILDER-EDIT'));
    await runForRole('builder', 'BUILDER-EDIT-OUTSIDE');
    await assert.rejects(readFile(join(dir, 'builder-outside-edit.txt')), { code: 'ENOENT' });
    if (process.platform === 'linux') {
      await runForRole('builder', 'BUILDER-RUN');
      assert.match(operationOutput.get('BUILDER-RUN') ?? '', /BUILDER-UNSANDBOXED-FIXTURE/);
      await runForRole('reviewer', 'REVIEWER-RUN');
      assert.match(operationOutput.get('REVIEWER-RUN') ?? '', /AGENT-TEAMS-RUN-OK/);
      await runForRole('reviewer', 'REVIEWER-WRITE');
      assert.equal(await readFile(join(workspace, 'reviewer-write.txt'), 'utf8'), 'x');
      assert(!workspaceOperations.includes('reviewer:shell'), 'Reviewer commands should not prompt for approval');
      assert(!toolCatalog.get('REVIEWER-RUN')?.some(tool => ['edit', 'create', 'apply_patch', 'str_replace_editor'].includes(tool)));
    }
    assert(!workspaceOperations.some(operation => operation.startsWith('builder:')), 'the Builder edit and run should not prompt for approval');
    await team.close();
    team = makeTeam(store);
    await team.release('builder');
    const afterRelease = await connect(await team.openNativeHost());
    try {
      const { items } = await afterRelease.request('listSessions', { channel }) as { items: { resource: string }[] };
      assert(!items.some(item => new URL(item.resource).pathname === `/${builder}`), 'release while the host is offline withdraws the saved publication');
    } finally { afterRelease.socket.close(); }

    await team.close();
    store.close();
    chatDefaults = { mode: 'plan', approvals: 'assisted' };
    chatSandbox = false;
    store = new TeamStore(database, defaultRoles.map(role => role.id === 'builder' ? {
      ...role, launch: { approvals: 'allowAll' },
    } : role));
    team = makeTeam(store);
    const launchHost = await team.openNativeHost();
    const launched = await team.startInNativeChat('builder');
    await waitUntil(() => activity('builder') === 'Idle', 'native launch greeting should finish');
    const original = await createSession.mock.calls.at(-1)?.result;
    assert(original && original.sessionId === launched.sessionId);
    const observer = await connect(launchHost);
    const sessionState = async (client: typeof observer, resource: string) =>
      (await client.request('subscribe', { channel: resource }) as { snapshot: { state: {
        defaultChat: string; config: { values: Record<string, unknown> };
      } } }).snapshot.state;
    let launchResource: string;
    let launchChat: string;
    try {
      const { items } = await observer.request('listSessions', { channel }) as { items: { resource: string }[] };
      launchResource = items.find(item => new URL(item.resource).pathname === `/${launched.sessionId}`)!.resource;
      const state = await sessionState(observer, launchResource);
      launchChat = state.defaultChat;
      assert.equal(state.config.values.mode, 'plan');
      assert.equal(state.config.values.effectiveApprovalMode, 'allow-all');
      assert.equal(await original.rpc.mode.get(), 'plan');
      await observer.request('subscribe', { channel: launchChat });
      observer.dispatch(launchResource, { type: 'session/configChanged', config: { mode: 'interactive', approvalMode: 'manual' } });
      let configChanged = false;
      for (let attempt = 0; attempt < 30 && !configChanged; attempt++) {
        const values = (await sessionState(observer, launchResource)).config.values;
        configChanged = values.mode === 'interactive' && values.effectiveApprovalMode === 'manual';
        if (!configChanged) await delay(20);
      }
      assert(configChanged, 'the native controls should change the running session');
      const editorTools = ['problems', 'usages', 'runTask', 'getTaskOutput', 'openBrowserPage', 'agentTeamsSend'];
      observer.dispatch(launchResource, { type: 'session/activeClientSet', activeClient: {
        clientId: observer.clientId, tools: editorTools.map(name => ({ name, inputSchema: { type: 'object' } })),
      } });
      await sendNative(observer, launchChat, 'COPILOT-LAUNCH-TOOLS');
      assert.equal(await original.rpc.mode.get(), 'interactive');
      assert.equal((await original.rpc.permissions.getMode()).mode, 'manual');
      const catalog = toolCatalog.get('COPILOT-LAUNCH-TOOLS') ?? [];
      for (const name of ['view', 'glob', 'problems', 'usages', 'runTask', 'getTaskOutput', 'openBrowserPage']) assert(catalog.includes(name), JSON.stringify(catalog));
      if (process.platform === 'linux') {
        for (const name of ['bash', 'read_bash', 'stop_bash', 'list_bash']) assert(catalog.includes(name), JSON.stringify(catalog));
      }
      assert(!catalog.includes('agentTeamsSend'), 'workers must not inherit the human send-as-you tool');
      if (process.platform === 'linux') {
        const marker = join(workspace, 'native-launch-marker.txt');
        let pending: { turnId: string; toolCallId: string } | undefined;
        const receive = (event: MessageEvent) => {
          const { params } = JSON.parse(event.data);
          const action = params?.envelope?.action ?? params?.action;
          if (params?.channel === launchChat && action?.type === 'chat/toolCallReady' && action.confirmationTitle && !action.confirmed) {
            pending = { turnId: action.turnId, toolCallId: action.toolCallId };
          }
        };
        observer.socket.addEventListener('message', receive);
        const turn = sendNative(observer, launchChat, 'COPILOT-LAUNCH-RUN');
        try {
          await waitUntil(() => Boolean(pending), 'manual permissions should send the command to the native approval UI');
          await assert.rejects(readFile(marker), { code: 'ENOENT' });
          assert(pending);
          observer.dispatch(launchChat, { type: 'chat/toolCallConfirmed', ...pending, approved: true, confirmed: 'user-action' });
        } finally {
          observer.socket.removeEventListener('message', receive);
          await turn;
        }
        assert.equal(await readFile(marker, 'utf8'), 'NATIVE-LAUNCH-RUN');
      }
      const delivery = team.postHuman('team', 'Native launch inbox test.', ['builder']);
      await waitUntil(() => store.isAcknowledged(launched.sessionId!, delivery.id) && activity('builder') === 'Idle',
        'manual permissions should not prompt for the authenticated team MCP calls');
    } finally { observer.socket.close(); }
    await team.close();
    chatSandbox = true;
    team = makeTeam(store);
    await team.restore(async () => { await team.openNativeHost(); });
    const reopened = await connect(await team.openNativeHost());
    try {
      const state = await sessionState(reopened, launchResource);
      assert.equal(state.defaultChat, launchChat);
      assert.equal(state.config.values.mode, 'interactive');
      assert.equal(state.config.values.effectiveApprovalMode, 'manual');
      await reopened.request('subscribe', { channel: launchChat });
      reopened.dispatch(launchResource, { type: 'session/activeClientSet', activeClient: {
        clientId: reopened.clientId, tools: ['problems', 'runTask', 'runTests', 'runNotebookCell']
          .map(name => ({ name, inputSchema: { type: 'object' } })),
      } });
      await sendNative(reopened, launchChat, 'COPILOT-LAUNCH-TOOLS AFTER RESTORE');
      const sandboxedCatalog = toolCatalog.get('COPILOT-LAUNCH-TOOLS') ?? [];
      assert(sandboxedCatalog.includes('problems'), 'editor read tools should still be available');
      assert(!sandboxedCatalog.some(name => ['runTask', 'runTests', 'runNotebookCell'].includes(name)),
        'the restored worker must not be able to run tasks outside its sandbox');
    } finally { reopened.socket.close(); }
  } finally {
    await team.close();
    store.close();
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  }
});
