import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamStore } from './store';
import { loadTeamConfig, resolveRoleLaunch } from './team-config';

test('workspace definitions replace vacant defaults and preserve state for stable role IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-config-'));
  const config = join(dir, 'agent-teams.json');
  const db = join(dir, 'team.sqlite');
  let store: TeamStore | undefined;
  try {
    const defaults = await loadTeamConfig(config);
    store = new TeamStore(db, defaults.roles);
    assert.deepEqual(store.roles().map(role => role.id), ['lead', 'builder', 'reviewer']);
    assert.equal(defaults.defaultRecipientRoleId, 'lead');
    const worker = store.reserve('lead');
    store.assign('lead', worker);
    store.pause(worker, true);
    const room = store.createRoom('Release', 'quick', ['lead', 'builder']);
    const { id } = store.post(room, 'You', 'Check readiness', ['lead'], true);
    store.close();
    store = undefined;

    const qa = { id: 'release-qa', name: 'Release QA', description: 'Check releases.' };
    const lead = { id: 'lead', name: 'Release Lead', description: 'Coordinate releases.', prompt: 'List blockers.\nInclude owners.' };
    await writeFile(config, JSON.stringify({ roles: [qa] }));
    const { roles: withoutLead } = await loadTeamConfig(config);
    assert.throws(() => new TeamStore(db, withoutLead), /release them before removing them: lead/);
    await writeFile(config, JSON.stringify({ roles: [lead, qa] }));
    const custom = await loadTeamConfig(config);
    assert.equal(custom.defaultRecipientRoleId, undefined, 'an existing custom roster does not gain an implicit recipient');
    store = new TeamStore(db, custom.roles);
    assert.deepEqual(store.roles().map(role => role.id), ['lead', 'release-qa']);
    assert.equal(store.role('lead').name, lead.name);
    assert.equal(store.role('lead').description, lead.description);
    assert.equal(store.rolePrompt('lead'), lead.prompt);
    assert.equal(store.role('lead').sessionId, worker);
    assert.equal(store.role('lead').paused, 1);
    assert.equal(store.role(qa.id).sessionId, null);
    assert.deepEqual(store.roomMembers('team'), ['lead', qa.id]);
    assert.deepEqual(store.roomMembers(room), ['lead']);
    assert.deepEqual(store.readInbox(worker).messages.map(message => message.id), [id]);
    assert.deepEqual(store.transcript(room).map(message => message.id), [id]);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid configurations report syntax errors and duplicate role IDs instead of falling back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-config-'));
  const path = join(dir, 'agent-teams.json');
  try {
    await writeFile(path, '{');
    await assert.rejects(loadTeamConfig(path), /\.vscode\/agent-teams\.json:/);
    await writeFile(path, JSON.stringify({ roles: [
      { id: 'lead', name: 'Lead', description: 'Coordinate.' },
      { id: 'lead', name: 'Also Lead', description: 'Review.' },
    ] }));
    await assert.rejects(loadTeamConfig(path), /roles\.1\.id: Role IDs must be unique/);
    const roles = [{ id: 'release-qa', name: 'Release QA', description: 'Check releases.' }];
    await writeFile(path, JSON.stringify({ roles, defaultRecipientRoleId: 'missing-role' }));
    await assert.rejects(loadTeamConfig(path), /defaultRecipientRoleId: Choose a role ID from the configured roster/);
    await writeFile(path, JSON.stringify({ roles, defaultRecipientRoleId: 'release-qa' }));
    assert.equal((await loadTeamConfig(path)).defaultRecipientRoleId, 'release-qa');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('role permission overrides preserve defaults for omitted flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-permissions-'));
  const config = join(dir, 'agent-teams.json');
  try {
    await writeFile(config, JSON.stringify({ roles: [
      { id: 'builder', name: 'Author', description: 'Build.', permissions: { run: false } },
      { id: 'reviewer', name: 'Reviewer', description: 'Review.' },
      { id: 'planner', name: 'Planner', description: 'Plan.', permissions: { read: false } },
    ] }));
    const store = new TeamStore(':memory:', (await loadTeamConfig(config)).roles);
    try {
      assert.deepEqual(store.rolePermissions('builder'), { read: true, edit: true, run: false, browser: false, sandbox: true, promptForApproval: true });
      assert.deepEqual(store.rolePermissions('reviewer'), { read: true, edit: false, run: true, browser: false, sandbox: true, promptForApproval: true });
      assert.deepEqual(store.rolePermissions('planner'), { read: false, edit: false, run: false, browser: false, sandbox: true, promptForApproval: true });
    } finally { store.close(); }
    await writeFile(config, JSON.stringify({ browserPreviewPorts: [43251], roles: [
      { id: 'builder', name: 'Builder', description: 'Build.', permissions: { sandbox: false } },
      { id: 'reviewer', name: 'Reviewer', description: 'Review.', permissions: { sandbox: false, promptForApproval: false, browser: true } },
    ] }));
    const parsed = await loadTeamConfig(config);
    assert(!Object.hasOwn(parsed, 'browserPreviewPorts'), 'accept the obsolete port list without applying it');
    const unsandboxed = new TeamStore(':memory:', parsed.roles);
    try {
      assert.deepEqual(unsandboxed.rolePermissions('builder'), { read: true, edit: true, run: true, browser: false, sandbox: false, promptForApproval: true });
      assert.deepEqual(unsandboxed.rolePermissions('reviewer'), { read: true, edit: false, run: true, browser: true, sandbox: false, promptForApproval: false });
    }
    finally { unsandboxed.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native launch options override individual editor defaults and reject legacy approval flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-launch-'));
  const path = join(dir, 'agent-teams.json');
  const role = { id: 'builder', name: 'Builder', description: 'Build.', launch: { approvals: 'allowAll' } };
  try {
    await writeFile(path, JSON.stringify({ roles: [role] }));
    const [builder] = (await loadTeamConfig(path)).roles;
    assert(builder.launch);
    assert.deepEqual(resolveRoleLaunch(builder.launch, { mode: 'autopilot', approvals: 'manual' }),
      { mode: 'autopilot', approvals: 'allowAll' });
    await writeFile(path, JSON.stringify({ roles: [{ ...role, permissions: { promptForApproval: false } }] }));
    await assert.rejects(loadTeamConfig(path), /Use launch\.approvals instead of promptForApproval/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reservations are exclusive; a paused assignment and unread deliveries survive reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-store-'));
  const file = join(dir, 'team.sqlite');
  let first: TeamStore | undefined;
  let second: TeamStore | undefined;
  try {
    first = new TeamStore(file);
    second = new TeamStore(file);
    const worker = first.reserve('builder');
    assert.throws(() => second?.reserve('builder'), /already reserved/);
    second.close();
    second = undefined;
    first.assign('builder', worker);
    const { id } = first.post('team', 'You', 'Please review', ['builder'], true);
    first.pause(worker, true);
    first.close();
    first = undefined;

    second = new TeamStore(file);
    assert.equal(second.role('builder').sessionId, worker);
    assert.equal(second.role('builder').phase, 'assigned');
    assert.equal(second.role('builder').paused, 1);
    assert.equal(second.unread(worker), 1);
    assert.deepEqual(second.claimWake(worker), []);
    second.pause(worker, false);
    assert.deepEqual(second.claimWake(worker).map(message => message.id), [id]);
    assert.deepEqual(second.claimWake(worker), []);
    assert.equal(second.acknowledge(worker, id), false, 'An exact ID is insufficient without a read');
    assert.deepEqual(second.readInbox(worker, [id]).messages.map(message => message.id), [id]);
    assert.equal(second.acknowledge(worker, id), true);
  } finally {
    first?.close();
    second?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('quick rooms are invite-only and closed rooms or replaced sessions cannot receive wakes', () => {
  const store = new TeamStore(':memory:');
  try {
    const room = store.createRoom('Review', 'quick', ['builder', 'reviewer']);
    const worker = store.reserve('builder');
    store.assign('builder', worker);
    assert.throws(() => store.joinRoom(room, 'lead'), /invite-only/);
    assert.throws(() => store.post(room, 'You', 'Hello', ['lead'], true), /not a member/);
    store.post(room, 'You', 'Hello', ['builder'], true);
    store.release('builder', worker);
    const replacement = store.reserve('builder');
    store.assign('builder', replacement);
    assert.deepEqual(store.claimWake(worker), []);
    assert.deepEqual(store.readInbox(replacement), { messages: [], threads: [] });
    store.post(room, 'You', 'One message for the new worker', ['builder'], true);
    store.closeRoom(room);
    assert.deepEqual(store.claimWake(replacement), []);
    assert.equal(store.unread(replacement), 0);
    assert.equal(store.transcript(room).length, 2);
  } finally { store.close(); }
});

test('room previews pin Team, list recent rooms first, and retain archived history', () => {
  const store = new TeamStore(':memory:');
  try {
    const recent = store.createRoom('Recent', 'group', ['lead']);
    const archive = store.createRoom('Archived', 'quick', ['lead', 'builder']);
    const empty = store.createRoom('Empty', 'group', []);
    store.post(recent, 'You', 'First', [], false);
    store.post(archive, 'Lead', 'Previous conversation', [], false);
    store.closeRoom(archive);
    const latest = 'x'.repeat(200);
    store.post(recent, 'You', latest, [], false);

    const rooms = store.roomSummaries();
    assert.deepEqual(rooms.map(room => room.id), ['team', recent, archive, empty]);
    assert.deepEqual([rooms[1].lastAuthor, rooms[1].lastBody, rooms[1].memberCount], ['You', latest.slice(0, 180), 1]);
    assert.deepEqual([rooms[2].closed, rooms[2].lastBody], [1, 'Previous conversation']);
    assert.equal(rooms[3].lastBody, null);
  } finally { store.close(); }
});

test('room mentions respect membership, explicit recipients, and quoted examples', () => {
  const store = new TeamStore(':memory:');
  try {
    const workers = Object.fromEntries(['lead', 'builder', 'reviewer'].map(role => {
      const session = store.reserve(role);
      store.assign(role, session);
      return [role, session];
    }));
    const room = store.createRoom('Private review', 'quick', ['lead', 'builder']);
    const sender = { roleId: 'lead', sessionId: workers.lead };
    const example = 'Mail test@builder.example, `@all`, \\@builder or quote:\n> @builder\n```md\n@all\n```';
    assert.deepEqual(store.post(room, 'Lead', example, [], true, sender).sessions, []);
    assert.deepEqual(store.post(room, 'Lead', '@reviewer', [], true, sender).sessions, []);
    assert.deepEqual(store.post(room, 'Lead', '@all @Builder', [], true, sender).wakeSessions, [workers.builder]);
    assert.deepEqual(store.post('team', 'Lead', '@all', ['reviewer'], true, sender).wakeSessions, [workers.reviewer]);
  } finally { store.close(); }
});

test('replies notify the original worker participants only and preserve the parent preview', () => {
  const store = new TeamStore(':memory:');
  try {
    const workers = Object.fromEntries(['lead', 'builder', 'reviewer'].map(role => {
      const session = store.reserve(role);
      store.assign(role, session);
      return [role, session];
    }));
    const sender = { roleId: 'lead', sessionId: workers.lead };
    const original = store.post('team', 'Lead', 'Please test the build.', ['builder'], true, sender);
    const room = store.createRoom('Other room', 'quick', ['lead', 'reviewer']);
    assert.throws(() => store.post(room, 'You', 'Wrong room', [], true, undefined, original.id), /only reply to a post in this room/);
    assert.throws(() => store.post(room, 'You', 'Missing post', [], true, undefined, 'missing'), /only reply to a post in this room/);
    assert.equal(store.transcript(room).length, 0);

    const human = store.post('team', 'You', 'Use the test fixture.', ['builder'], true, undefined, original.id);
    assert.deepEqual(human.wakeSessions, [workers.builder, workers.lead], 'deduplicate explicitly addressed participants');
    assert.equal(store.unread(workers.reviewer), 0);
    assert.deepEqual(store.readInbox(workers.lead, [human.id]).messages[0].replyTo, {
      id: original.id, author: 'Lead', preview: 'Please test the build.',
    });

    store.release('builder', workers.builder);
    store.assign('builder', store.reserve('builder'));
    const peer = store.post('team', 'Reviewer', 'I can review the results.', ['reviewer'], original.id,
      { roleId: 'reviewer', sessionId: workers.reviewer }, original.id);
    assert.deepEqual(peer.wakeSessions, [workers.lead], 'do not wake the sender or a replacement for an earlier worker');

    store.release('lead', workers.lead);
    store.assign('lead', store.reserve('lead'));
    const extra = store.post('team', 'You', '@reviewer Please check the results.', [], true, undefined, original.id);
    assert.deepEqual(extra.wakeSessions, [workers.reviewer], 'mentions add recipients without inheriting replaced authors');
  } finally { store.close(); }
});

test('inbox reads return deduplicated full thread context without reading other deliveries', () => {
  const store = new TeamStore(':memory:');
  try {
    const builder = store.reserve('builder');
    store.assign('builder', builder);
    const worker = { roleId: 'builder', sessionId: builder };
    const rootBody = 'Context beyond the preview. '.repeat(20);
    const root = store.post('team', 'You', rootBody, [], false);
    store.post('team', 'You', 'Unrelated', [], false);
    const first = store.post('team', 'You', 'First branch', ['builder'], false, undefined, root.id);
    const quiet = store.post('team', 'Builder', 'No delivery to the sender', [], false, worker, first.id);
    const sibling = store.post('team', 'You', 'Sibling branch', ['builder'], false, undefined, root.id);
    const nested = store.post('team', 'You', 'Nested', ['builder'], false, undefined, quiet.id);
    const filtered = store.readInbox(builder, [nested.id, first.id]);
    assert.deepEqual(filtered.messages.map(post => post.id), [first.id, nested.id]);
    assert.equal(filtered.messages[0].replyTo?.preview, rootBody.slice(0, 180));
    assert.equal(filtered.threads.length, 1);
    const [thread] = filtered.threads;
    assert.equal(thread.rootId, root.id);
    assert.equal(thread.anchorId, first.id);
    assert.deepEqual(thread.inboxIds, [first.id, nested.id]);
    assert.deepEqual(thread.ancestors.map(post => post.id), [root.id, first.id, quiet.id]);
    assert.equal(thread.ancestors[0].body, rootBody);
    assert.equal(thread.ancestorsIncomplete, false);
    const full = store.readThread(builder, thread.anchorId, 0);
    assert.deepEqual(full.messages.map(post => post.id), [root.id, first.id, quiet.id, sibling.id, nested.id]);
    assert.equal(full.nextAfterSeq, null);
    assert.equal(store.acknowledge(builder, sibling.id), false, 'context must not mark an unread delivery as read');
    assert.equal(store.acknowledge(builder, quiet.id), false, 'context must not create deliveries');
    assert.equal(store.acknowledge(builder, first.id), true);
    const drain = store.readInbox(builder);
    assert.deepEqual(drain.messages.map(post => post.id), [sibling.id, nested.id]);
    assert.deepEqual(drain.threads[0].ancestors, thread.ancestors);
    assert.deepEqual(store.claimWake(builder), []);
  } finally { store.close(); }
});

test('thread continuation has a bounded initial batch and rechecks authorization on each page', () => {
  const store = new TeamStore(':memory:');
  try {
    const builder = store.reserve('builder');
    store.assign('builder', builder);
    const lead = store.reserve('lead');
    store.assign('lead', lead);
    const room = store.createRoom('Private review', 'quick', ['builder']);
    const root = store.post(room, 'You', 'Root', [], false);
    const posts = [root.id];
    posts.push(store.post(room, 'You', 'Early sibling', [], false, undefined, root.id).id);
    for (let i = 0; i < 36; i++) {
      posts.push(store.post(room, 'You', `Reply ${i}`, [], false, undefined, i ? posts.at(-1) : root.id).id);
    }
    const anchor = store.post(room, 'You', 'Delivered last', ['builder'], false, undefined, posts.at(-1));
    posts.push(anchor.id);
    const otherRoot = store.post('team', 'You', 'Different root', [], false);
    let parent = otherRoot.id;
    for (let i = 0; i < 15; i++) {
      parent = store.post('team', 'You', `Other reply ${i}`, [], false, undefined, parent).id;
    }
    const separate = store.post('team', 'You', 'Different thread', ['builder'], false, undefined, parent);
    const inbox = store.readInbox(builder);
    assert.equal(inbox.threads.length, 2);
    assert.equal(inbox.threads.reduce((count, thread) => count + thread.ancestors.length, 0), 20);
    assert(inbox.threads.every(thread => thread.ancestorsIncomplete));
    assert.equal(inbox.threads[1].anchorId, separate.id);
    assert.equal(store.acknowledge(builder, anchor.id), true, 'continuation survives ack');
    const thread = inbox.threads[0];
    assert.equal(thread.anchorId, anchor.id);
    assert(!thread.ancestors.some(post => post.id === posts[1]));
    let next = store.readThread(builder, thread.anchorId, 0);
    const read: string[] = [];
    const cursor = next.nextAfterSeq;
    assert(cursor !== null);
    while (true) {
      assert(next.messages.length <= 20);
      read.push(...next.messages.map(post => post.id));
      if (next.nextAfterSeq === null) break;
      next = store.readThread(builder, thread.anchorId, next.nextAfterSeq);
    }
    assert.deepEqual(read, posts);
    assert.throws(() => store.readThread(builder, root.id, cursor), /unavailable/);
    assert.throws(() => store.readThread(lead, anchor.id, cursor), /unavailable/);
    store.closeRoom(room);
    assert.throws(() => store.readThread(builder, anchor.id, cursor), /unavailable/);
    store.release('builder', builder);
    const replacement = store.reserve('builder');
    store.assign('builder', replacement);
    assert.throws(() => store.readThread(builder, separate.id, 0), /unavailable/);
    assert.throws(() => store.readThread(replacement, separate.id, 0), /unavailable/);
  } finally { store.close(); }
});

test('transcript distinguishes queued wakes, claimed unacknowledged wakes, and inbox-only delivery', () => {
  const store = new TeamStore(':memory:');
  try {
    const builder = store.reserve('builder');
    store.assign('builder', builder);
    const first = store.post('team', 'You', 'First', ['builder'], true);
    const second = store.post('team', 'You', 'Second', ['builder'], first.id);
    const inboxOnly = store.post('team', 'You', 'No automatic wake requested', ['builder'], false);
    const status = (id: string) => store.transcript('team').find(message => message.id === id)?.recipients[0]?.state;
    assert.equal(status(first.id), 'queued');
    assert.equal(status(second.id), 'queued');
    assert.equal(status(inboxOnly.id), 'inbox-only');
    assert.deepEqual(store.claimWake(builder).map(({ id }) => id), [first.id, second.id]);
    store.readInbox(builder, [first.id, second.id]);
    assert.equal(store.acknowledge(builder, first.id), true);
    assert.equal(status(first.id), 'acknowledged');
    assert.equal(status(second.id), 'attempted', 'a claimed wake can stay pending after the turn fails to ack');
    assert.deepEqual(store.claimWake(builder), [], 'ordinary pumping does not retry an attempted delivery');
    store.retryUnread(builder);
    assert.equal(status(second.id), 'queued');
    assert.deepEqual(store.claimWake(builder).map(({ id }) => id), [second.id]);
    assert.deepEqual(store.claimWake(builder).map(({ id }) => id), [inboxOnly.id]);
    assert.equal(status(first.id), 'acknowledged', 'retry must not replay acknowledged deliveries');
  } finally { store.close(); }
});

test('a shared wake chain exhausts its budget across branches and restarts without dropping delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-wake-chain-'));
  const file = join(dir, 'team.sqlite');
  let store = new TeamStore(file);
  try {
    const lead = store.reserve('lead');
    const builder = store.reserve('builder');
    const reviewer = store.reserve('reviewer');
    store.assign('lead', lead);
    store.assign('builder', builder);
    store.assign('reviewer', reviewer);
    const root = store.post('team', 'You', '@lead', [], true);
    assert.deepEqual(store.claimWake(lead).map(wake => [wake.id, wake.chain]), [[root.id, root.id]]);
    for (let i = 0; i < 7; i++) {
      const post = store.post('team', 'Lead', '@all Check in', [], root.id, { roleId: 'lead', sessionId: lead });
      assert.equal(post.wakeSessions.length, 2);
    }
    const branch = store.claimWake(builder);
    assert.equal(branch.length, 7);
    const independent = store.post('team', 'You', '@reviewer Different task', [], true);
    assert.deepEqual(store.claimWake(reviewer).map(wake => wake.chain), Array(7).fill(root.id));
    assert.deepEqual(store.claimWake(reviewer).map(wake => [wake.id, wake.chain]), [[independent.id, independent.id]]);
    const reply = store.post('team', 'Builder', 'Last wake', ['lead', 'reviewer'], branch[0].chain, { roleId: 'builder', sessionId: builder }, root.id);
    assert.deepEqual(reply.wakeSessions, [lead]);
    assert.equal(reply.wakeLimited, true);
    assert.deepEqual(store.transcript('team').find(message => message.id === reply.id)?.recipients.map(({ state }) => state),
      ['queued', 'wake-limited']);
    store.close();
    store = new TeamStore(file);
    const restored = store.transcript('team');
    const restoredReply = restored.find(message => message.id === reply.id);
    assert.equal(restoredReply?.replyTo?.id, root.id);
    assert.deepEqual(restoredReply?.recipients.map(({ state }) => state), ['queued', 'wake-limited']);
    assert.equal(restored.find(message => message.id === root.id)?.recipients[0]?.state, 'attempted');
    const limited = store.post('team', 'Reviewer', 'One more update', [], root.id, { roleId: 'reviewer', sessionId: reviewer }, root.id);
    assert.equal(limited.wakeLimited, true);
    assert.deepEqual(limited.wakeSessions, []);
    const limitedStatus = () => store.transcript('team').find(message => message.id === limited.id)?.recipients[0]?.state;
    assert.equal(limitedStatus(), 'wake-limited');
    assert.deepEqual(store.claimWake(lead).map(wake => [wake.id, wake.chain]), [[reply.id, root.id]]);
    assert(store.readInbox(lead, [limited.id]).messages.some(message => message.id === limited.id));
    store.retryUnread(lead);
    assert.equal(limitedStatus(), 'queued');
    assert(store.claimWake(lead).some(wake => wake.id === limited.id && wake.chain === root.id));
    assert.equal(limitedStatus(), 'attempted');
    assert.deepEqual(store.post('team', 'You', 'New request', [], true, undefined, root.id).wakeSessions, [lead]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
