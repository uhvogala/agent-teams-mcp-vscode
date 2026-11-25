import { strict as assert } from 'node:assert';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { decodePngAttachment, decodeScreenshot, maxAttachmentBytes, readPickedPng } from './attachments';
import { TeamStore } from './store';

function pngFixture() {
  const png = new PNG({ width: 1, height: 1 });
  png.data.set([30, 60, 90, 255]);
  return PNG.sync.write(png);
}

test('attachment decoding accepts real PNG pixels and rejects spoofed, malformed and oversized data', () => {
  const png = pngFixture();
  assert.deepEqual([...PNG.sync.read(decodePngAttachment(png.toString('base64'))).data], [30, 60, 90, 255]);
  for (const invalid of ['!', Buffer.from('<svg></svg>').toString('base64'),
    png.subarray(0, 40).toString('base64'), `${png.toString('base64')}!`]) {
    assert.throws(() => decodePngAttachment(invalid), /not a valid PNG/);
  }
  assert.throws(() => decodePngAttachment(Buffer.alloc(maxAttachmentBytes + 1).toString('base64')), /2 MiB/);
  png.writeUInt32BE(2049, 16);
  assert.throws(() => decodePngAttachment(png.toString('base64')), /2048/);
});

test('approved PNG files are read with size and link checks, not trusted by extension', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-teams-picked-image-'));
  try {
    const root = await realpath(directory);
    const file = join(root, 'generated.png');
    const png = pngFixture();
    await writeFile(file, png);
    assert.deepEqual(await readPickedPng(file), png);
    if (process.platform !== 'win32') {
      const linked = join(root, 'linked.png');
      await symlink(file, linked);
      await assert.rejects(readPickedPng(linked), /linked file/);
    }
    await writeFile(file, Buffer.alloc(maxAttachmentBytes + 1));
    await assert.rejects(readPickedPng(file), /2 MiB/);
    await writeFile(file, '<svg/>');
    await assert.rejects(readPickedPng(file), /valid PNG/);
    assert.throws(() => decodeScreenshot(png.toString('base64'), 'image/jpeg'), /valid JPEG/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('image-only posts persist, with bytes separate from transcripts and worker deliveries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-teams-attachments-'));
  const database = join(directory, 'team.sqlite');
  let store = new TeamStore(database);
  try {
    const builder = store.reserve('builder');
    store.assign('builder', builder);
    const other = store.createRoom('Other room', 'group', ['builder']);
    const image = pngFixture();
    const post = store.post('team', 'You', '', ['builder'], true, undefined, undefined, [], [image]);
    const reply = store.post('team', 'You', 'Text reply', [], false, undefined, post.id);
    store.close();
    store = new TeamStore(database);
    assert.deepEqual(store.readAttachment('team', post.id, 0), image);
    assert.deepEqual(store.readWorkerAttachment(builder, 'team', post.id, 0), image);
    assert.equal(store.acknowledge(builder, post.id), false, 'image access must not mark the delivery read');
    assert.equal(store.claimWake(builder)[0]?.id, post.id, 'image access must not claim a queued wake');
    assert.throws(() => store.readAttachment(other, post.id, 0), /unavailable/);
    assert.throws(() => store.readAttachment('team', post.id, 1), /unavailable/);
    const [imagePost, textPost] = store.transcript('team');
    assert.deepEqual([imagePost.body, imagePost.attachmentCount], ['', 1]);
    assert.equal(textPost.id, reply.id);
    assert.equal(textPost.attachmentCount, undefined);
    assert.equal(textPost.replyTo?.preview, 'Image attachment');
    const delivery = store.readInbox(builder, [post.id]).messages[0];
    assert.deepEqual(Object.keys(delivery).sort(), ['attachmentCount', 'author', 'body', 'id', 'roomId', 'seq']);
    assert.equal(delivery.attachmentCount, 1);
    store.acknowledge(builder, post.id);
    assert.equal(store.isAcknowledged(builder, post.id), true);
    assert.deepEqual(store.readWorkerAttachment(builder, 'team', post.id, 0), image);
    assert.deepEqual(store.readThread(builder, post.id, 0).messages.map(message => message.attachmentCount), [1, undefined]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('active room members can discover and read images without an inbox delivery', () => {
  const store = new TeamStore(':memory:');
  try {
    const builder = store.reserve('builder');
    const lead = store.reserve('lead');
    store.assign('builder', builder);
    store.assign('lead', lead);
    const room = store.createRoom('Private room', 'quick', ['builder']);
    const otherRoom = store.createRoom('Other room', 'group', ['builder']);
    const image = pngFixture();
    const post = store.post(room, 'You', 'Image caption', [], true, undefined, undefined, [], [image]);
    store.post(room, 'You', 'Unrelated text', [], false);
    assert.deepEqual(post.sessions, []);
    assert.deepEqual(post.wakeSessions, []);
    const { posts, nextBeforeSeq } = store.listWorkerAttachments(builder, room);
    assert.deepEqual(posts.map(row => ({ ...row })), [
      { messageId: post.id, seq: store.transcript(room)[0].seq, author: 'You', attachmentCount: 1 },
    ]);
    assert.equal(nextBeforeSeq, null);
    assert.deepEqual(store.readWorkerAttachment(builder, room, post.id, 0), image);
    assert.deepEqual(store.readInbox(builder).messages, []);
    assert.deepEqual(store.claimWake(builder), []);
    assert.equal(store.acknowledge(builder, post.id), false);
    assert.throws(() => store.readThread(builder, post.id, 0), /unavailable/);
    assert.throws(() => store.readWorkerAttachment(builder, otherRoom, post.id, 0), /unavailable/);
    const inaccessible = (sessionId: string) => {
      assert.throws(() => store.listWorkerAttachments(sessionId, room), /unavailable/);
      assert.throws(() => store.readWorkerAttachment(sessionId, room, post.id, 0), /unavailable/);
    };
    inaccessible(lead);
    store.pause(builder, true);
    inaccessible(builder);
    store.pause(builder, false);
    store.release('builder', builder);
    inaccessible(builder);
    const replacement = store.reserve('builder');
    inaccessible(replacement);
    store.assign('builder', replacement);
    inaccessible(builder);
    store.closeRoom(room);
    inaccessible(replacement);
  } finally { store.close(); }
});

test('attachment discovery pages newest to oldest without gaps or repeated posts', () => {
  const store = new TeamStore(':memory:');
  try {
    const builder = store.reserve('builder');
    store.assign('builder', builder);
    const image = pngFixture();
    const ids = Array.from({ length: 22 }, () => store.post('team', 'You', '', [], false, undefined, undefined, [], [image]).id).reverse();
    const first = store.listWorkerAttachments(builder, 'team');
    assert.deepEqual(first.posts.map(post => post.messageId), ids.slice(0, 20));
    assert.ok(first.nextBeforeSeq !== null);
    const second = store.listWorkerAttachments(builder, 'team', first.nextBeforeSeq);
    assert.deepEqual(second.posts.map(post => post.messageId), ids.slice(20));
    assert.equal(second.nextBeforeSeq, null);
  } finally { store.close(); }
});
