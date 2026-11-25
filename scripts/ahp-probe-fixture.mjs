// @ts-check
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TeamStore } from '../dist/store.js';
import { Team, taskCompletionTool } from '../dist/team.js';

export const reply = 'Agent Teams AHP probe reply';
export const fixtureModel = { id: 'gpt-4o', name: 'Scripted probe model' };
export const holdPrompt = 'Hold this turn for the Stop probe.';
export const holdReply = 'Waiting for native Chat Stop.';

/** @param {{ joinable?: boolean, approval?: boolean, log?: (message: string) => void, approveJoin?: (role: import('../src/store.js').Role) => Promise<boolean>, authorization?: import('../src/team.js').GitHubAuthorization }} options */
export async function startProbe({ joinable = false, approval = false, log = console.log, approveJoin = async () => false, authorization } = {}) {
  assert(!authorization || joinable, 'Live sign-in is only available for the join probe.');
  assert(!approval || (!joinable && process.platform !== 'win32'), 'The approval probe requires the scripted POSIX host.');
  const directory = await mkdtemp(join(tmpdir(), 'agent-teams-ahp-'));
  const workspace = join(directory, 'workspace');
  const computeId = randomUUID();
  const inboxMarkers = new Map();
  let holdingTurn = false;
  const greeting = 'Lead is ready for the AHP probe.';
  let markerId = 0;
  const markerName = () => `approval-marker-${markerId}.txt`;
  const model = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      /** @type {{ messages: { role: string, content?: string }[], tools?: { function: { name: string } }[], stream?: boolean }} */
      const request = JSON.parse(raw);
      const user = request.messages.findLastIndex(message => message.role === 'user');
      const prompt = request.messages[user]?.content ?? '';
      const common = { id: `chatcmpl-${randomUUID()}`, model: fixtureModel.id, created: Math.floor(Date.now() / 1000) };
      if (prompt.includes(holdPrompt)) {
        holdingTurn = true;
        res.once('close', () => { holdingTurn = false; });
        const chunk = { ...common, object: 'chat.completion.chunk', choices: [
          { index: 0, delta: { role: 'assistant', content: holdReply }, finish_reason: null },
        ] };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write(`data: ${JSON.stringify(chunk)}\n\n`);
        return;
      }
      const results = request.messages.slice(user + 1).filter(message => message.role === 'tool');
      const id = /addressed team messages with these IDs: \["([a-f0-9-]+)"\]/.exec(prompt)?.[1];
      const approvalTurn = approval && prompt.includes('PROBE APPROVAL');
      const tool = approvalTurn ? (!results.length ? 'bash' : undefined) : id
        ? !results.length ? 'read_inbox' : results.length === 1 ? 'ack_message' : undefined
        : !results.length && prompt.includes('Join the team as Lead') ? 'join_agent_team'
          : !results.length && prompt.includes('post a short greeting') ? 'post_message' : undefined;
      if (approvalTurn && tool) {
        markerId++;
        log(`Model requested one shell action for ${markerName()}.`);
      }
      const args = approvalTurn ? { command: `printf '%s\\n' approved >> ${markerName()}`, description: 'Append one probe marker line' }
        : tool === 'read_inbox' ? { ids: [id] } : tool === 'ack_message' ? { id }
        : tool === 'join_agent_team' ? { roleId: 'Lead' } : { roomId: 'team', body: greeting };
      if (tool === 'ack_message') {
        const marker = inboxMarkers.get(id);
        assert(marker && results[0].content?.includes(marker), 'Lead did not read the probe inbox message.');
      }
      const name = request.tools?.find(candidate => candidate.function.name === tool || candidate.function.name.endsWith(`-${tool}`))?.function.name;
      if (tool) assert(name, `No ${tool} tool available to Lead.`);
      const message = name
        ? { role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
        : { role: 'assistant', content: approvalTurn ? 'Approval probe tool returned; check the marker via the probe command.' : id ? `${reply}: acknowledged ${id}` : reply };
      const finish = name ? 'tool_calls' : 'stop';
      if (!request.stream) {
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }],
        }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[message, null], [{}, finish]]) {
        res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      res.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
  });
  /** @type {Awaited<ReturnType<typeof boot>> | undefined} */
  let running;
  let fixtureEndpoint;
  let remoteSessionId;
  let reattachedSessionId;
  let disposed = false;
  let restarted = false;
  /** @type {Promise<void> | undefined} */
  let pendingRestart;
  const current = () => {
    assert(running, 'The Agent Teams probe host is not running.');
    return running;
  };
  const dispose = async () => {
    disposed = true;
    try {
      if (pendingRestart) await Promise.allSettled([pendingRestart]);
      await running?.close();
    } finally {
      running = undefined;
      model.closeAllConnections();
      model.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
  /** @param {{ port?: number, token?: string }} endpoint */
  async function boot(endpoint = {}) {
    const roster = new TeamStore(join(directory, 'team.sqlite'));
    const controller = new Team(roster, workspace, join(directory, 'runtime'), () => authorization ? {
      projectSummary: 'Disposable native Chat probe', model: 'auto',
    } : {
      projectSummary: 'Disposable native Chat probe', model: fixtureModel.id, github: { capi: { enabled: false } },
      inference: { defaultProvider: 'fixture', providers: [
        { name: 'fixture', type: 'openai', baseUrl: fixtureEndpoint, wireApi: 'completions', apiKey: 'local-dummy' },
      ] },
    }, () => {}, message => console.error(`Team probe: ${message}`), authorization);
    /** @type {import('@microsoft/copilot-sdk').AhpHost | undefined} */
    let host;
    const close = async () => {
      try { await host?.dispose(); }
      finally {
        try { await controller.close(); }
        finally { roster.close(); }
      }
    };
    const leadStatus = () => controller.roster().find(role => role.id === 'lead');
    const waitForIdle = async () => {
      for (const end = Date.now() + (authorization ? 120_000 : 10_000); Date.now() < end; await delay(25)) {
        const lead = leadStatus();
        if (lead?.activity === 'Needs recovery') throw new Error(lead.issue ?? 'Lead needs recovery.');
        if (lead?.activity === 'Idle') return;
      }
      throw new Error('Lead did not go idle.');
    };
    try {
      if (!joinable && !approval) {
        await controller.start('lead');
        await waitForIdle();
        assert(roster.transcript('team').some(message => message.author === 'Lead' && message.body === greeting));
      } else await controller.authenticate();
      // Use the owning client from this disposable controller.
      /** @type {import('@microsoft/copilot-sdk').CopilotClient | undefined} */
      const client = Reflect.get(controller, 'client');
      assert(typeof client?.startAhpHost === 'function', 'The spike requires the controller’s original SDK client.');
      const approvalSession = approval ? await client.createSession({
        sessionId: approvalSessionId,
        workingDirectory: workspace,
        model: fixtureModel.id,
        github: { capi: { enabled: false } },
        inference: { defaultProvider: 'fixture', providers: [
          { name: 'fixture', type: 'openai', baseUrl: fixtureEndpoint, wireApi: 'completions', apiKey: 'local-dummy' },
        ] },
        enableConfigDiscovery: false,
        tools: { definitions: [taskCompletionTool], availableTools: ['builtin:bash', `custom:${taskCompletionTool.name}`] },
        permissions: { mode: 'manual', sandbox: {
          enabled: false, allowBypass: false,
        } },
        events: { onEvent: event => {
          if (event.type === 'permission.requested' || event.type === 'permission.completed') log(`SDK: ${event.type}`);
        } },
      }) : undefined;
      const lead = roster.role('lead');
      let creating = false;
      host = await client.startAhpHost({
        authentication: { mode: 'none' },
        computeId,
        localServer: { hostname: '127.0.0.1', requireConnectionToken: true, ...endpoint },
        workspace,
        allowCreatingNewSessions: joinable && !lead.sessionId,
        createSession: joinable ? async request => {
          if (creating || remoteSessionId) throw new Error('The disposable join probe supports one chat.');
          creating = true;
          try {
            const session = await controller.createJoinableChat(request, approveJoin);
            remoteSessionId = session.sessionId;
            return session;
          } finally {
            creating = false;
          }
        } : undefined,
        resumeSession: joinable ? async request => {
          const session = await controller.resumeJoinableChat(request);
          reattachedSessionId = session.sessionId;
          return session;
        } : undefined,
      });
      const publishedId = approvalSession?.sessionId ?? (!joinable ? lead.sessionId : undefined);
      const published = publishedId ? await host.publishSession(publishedId) : undefined;
      if (published) assert.equal(published.sessionId, publishedId);
      assert(host.url && host.token);
      return { roster, controller, client, host, url: new URL(host.url), token: host.token, close, published, leadStatus, waitForIdle };
    } catch (error) {
      try { await close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Could not boot or close the Agent Teams runtime.'); }
      throw error;
    }
  }
  const approvalSessionId = randomUUID();
  try {
    await mkdir(workspace);
    if (!authorization) {
      await new Promise((resolve, reject) => {
        model.once('error', reject);
        model.listen(0, '127.0.0.1', () => resolve(undefined));
      });
      const listening = model.address();
      assert(listening && typeof listening !== 'string');
      fixtureEndpoint = `http://127.0.0.1:${listening.port}/v1/`;
    }
    running = await boot();
    /** @param {string} id */
    const isAcknowledged = id => {
      const { roster } = current();
      const { sessionId } = roster.role('lead');
      return Boolean(sessionId && roster.isAcknowledged(sessionId, id));
    };
    const queueInbox = () => {
      const { roster, controller } = current();
      assert(roster.role('lead').sessionId, 'Start a chat and join the team as Lead first.');
      const marker = `Team inbox probe ${randomUUID()}`;
      const { id, recipients } = controller.postHuman('team', marker, ['lead']);
      assert.equal(recipients, 1);
      inboxMarkers.set(id, marker);
      return id;
    };
    /** @param {string} id */
    const expectPaused = id => {
      const status = current().leadStatus();
      assert(inboxMarkers.has(id) && status?.activity === 'Paused' && status.unread === 1 && !isAcknowledged(id),
        `Expected Paused with one unread delivery after Stop; got ${status?.activity} with ${status?.unread} unread.`);
    };
    return {
      published: running.published, workspace, url: running.url, token: running.token, dispose,
      approvalStatus: async () => {
        assert(approval && markerId, 'Send PROBE APPROVAL to the disposable native chat first.');
        const name = markerName();
        try {
          const contents = await readFile(join(workspace, name), 'utf8');
          return `${name}: ${JSON.stringify(contents)}`;
        } catch (error) {
          if (error?.code === 'ENOENT') return `${name}: absent`;
          throw error;
        }
      },
      get createdSessionId() { return remoteSessionId; },
      assignedSessions: () => current().roster.roles().flatMap(role => role.sessionId ? [role.sessionId] : []),
      assignmentAnnouncements: () => current().roster.transcript('team').filter(message => message.author === 'Agent Teams'),
      sdkModels: () => current().client.listModels(),
      leadStatus: () => current().leadStatus(),
      isAcknowledged,
      isHoldingTurn: () => holdingTurn,
      queueWhileBusy: () => {
        const status = current().leadStatus();
        assert(status?.activity === 'Busy' && status.unread === 0, 'Start a manual turn with an empty Lead inbox before queueing this probe delivery.');
        return queueInbox();
      },
      /** @param {string} id */
      resumeQueued: async id => {
        expectPaused(id);
        assert(!pendingRestart && (!restarted || reattachedSessionId === remoteSessionId), 'Reopen the original native chat before resuming the delivery.');
        const { controller, waitForIdle } = current();
        await controller.start('lead');
        await waitForIdle();
        assert(isAcknowledged(id), `Lead did not acknowledge ${id} after Resume.`);
      },
      /** @param {string} id */
      restart: async id => {
        assert(joinable && !pendingRestart && !disposed, 'The join probe is not ready to restart.');
        expectPaused(id);
        const previous = current();
        const restart = async () => {
          running = undefined;
          reattachedSessionId = undefined;
          await previous.close();
          if (disposed) throw new Error('The probe closed during restart.');
          const next = await boot({ port: Number(previous.url.port), token: previous.token });
          running = next;
          if (disposed) throw new Error('The probe closed during restart.');
          assert.equal(next.url.href, previous.url.href, 'The restarted host must retain its address.');
          assert(next.token === previous.token, 'The restarted host must retain its connection token.');
          assert.notEqual(next.host.hostId, previous.host.hostId, 'The SDK must start a new host.');
          assert.equal(next.roster.role('lead').sessionId, remoteSessionId, 'The original role assignment must survive.');
          expectPaused(id);
          restarted = true;
        };
        pendingRestart = restart();
        try { await pendingRestart; }
        finally { pendingRestart = undefined; }
      },
      wake: async () => {
        const { waitForIdle } = current();
        await waitForIdle();
        const id = queueInbox();
        await waitForIdle();
        assert(isAcknowledged(id), `Lead did not acknowledge ${id}.`);
        return id;
      },
    };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Could not start or clean up the AHP probe.'); }
    throw error;
  }
}
