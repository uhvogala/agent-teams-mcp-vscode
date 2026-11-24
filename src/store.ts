import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mentionedRoles } from './mentions';
import { defaultRoles, rolePermissions, teamConfigPath, type RoleDefinition } from './team-config';

export type Role = { id: string; name: string; description: string; sessionId: string | null; phase: 'reserved' | 'assigned' | null; paused: number };
export type Room = { id: string; title: string; kind: 'group' | 'quick'; closed: number };
type RoomSummary = Room & { memberCount: number; lastAuthor: string | null; lastBody: string | null };
export type Message = {
  seq: number; id: string; roomId: string; author: string; body: string;
  replyTo?: { id: string; author: string; preview: string };
};
type MessageRow = Omit<Message, 'replyTo'> & { parentId: string | null; parentAuthor: string | null; parentPreview: string | null };
const replyColumns = 'm.*, p.id AS parentId, p.author AS parentAuthor, substr(p.body, 1, 180) AS parentPreview';
const replyJoins = 'LEFT JOIN message_links link ON link.messageId=m.id LEFT JOIN messages p ON p.id=link.replyTo';
function toMessage({ parentId, parentAuthor, parentPreview, ...message }: MessageRow): Message {
  return parentId !== null && parentAuthor !== null && parentPreview !== null
    ? { ...message, replyTo: { id: parentId, author: parentAuthor, preview: parentPreview } } : message;
}
const maxChainWakes = 32;
const inboxLimit = 20;
const threadContextLimit = 20;
export class TeamStore {
  private readonly db: DatabaseSync;
  private readonly definitions: ReadonlyMap<string, RoleDefinition>;

  constructor(path: string, definitions: readonly RoleDefinition[] = defaultRoles) {
    this.definitions = new Map(definitions.map(role => [role.id, role]));
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        sessionId TEXT UNIQUE, phase TEXT CHECK(phase IN ('reserved','assigned')),
        paused INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT CHECK(kind IN ('group','quick')), closed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS members (
        roomId TEXT NOT NULL REFERENCES rooms(id), roleId TEXT NOT NULL REFERENCES roles(id), PRIMARY KEY(roomId,roleId)
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        roomId TEXT NOT NULL REFERENCES rooms(id), author TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery (
        messageId TEXT NOT NULL REFERENCES messages(id), sessionId TEXT NOT NULL, wake INTEGER NOT NULL,
        attempted INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0, ack INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(messageId,sessionId)
      );
      CREATE INDEX IF NOT EXISTS delivery_inbox ON delivery(sessionId,ack);
      CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(roomId,seq);
      CREATE TABLE IF NOT EXISTS message_links (
        messageId TEXT PRIMARY KEY REFERENCES messages(id),
        authorSessionId TEXT, replyTo TEXT REFERENCES messages(id)
      );
      CREATE INDEX IF NOT EXISTS message_links_replies ON message_links(replyTo);
      CREATE TABLE IF NOT EXISTS wake_chains (
        id TEXT PRIMARY KEY, scheduled INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_wake_chains (
        messageId TEXT PRIMARY KEY REFERENCES messages(id), chainId TEXT NOT NULL REFERENCES wake_chains(id)
      );
      INSERT OR IGNORE INTO rooms(id,title,kind) VALUES ('team','Team','group');
    `);
      this.transaction(() => {
        if (!this.db.prepare("SELECT 1 FROM pragma_table_info('delivery') WHERE name='recipientName'").get()) {
          this.db.exec(`ALTER TABLE delivery ADD COLUMN recipientName TEXT;
            UPDATE delivery SET recipientName=(SELECT name FROM roles WHERE roles.sessionId=delivery.sessionId);`);
        }
        const removed = this.roles().filter(role => !this.definitions.has(role.id));
        const occupied = removed.filter(role => role.sessionId).map(role => role.id);
        if (occupied.length) {
          throw new Error(`${teamConfigPath}: Restore these role IDs and reload, then release them before removing them: ${occupied.join(', ')}.`);
        }
        for (const { id } of removed) {
          this.db.prepare('DELETE FROM members WHERE roleId=?').run(id);
          this.db.prepare('DELETE FROM roles WHERE id=?').run(id);
        }
        for (const { id, name, description } of definitions) {
          this.db.prepare(`INSERT INTO roles(id,name,description) VALUES (?,?,?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description`).run(id, name, description);
          this.db.prepare("INSERT OR IGNORE INTO members(roomId,roleId) VALUES ('team',?)").run(id);
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() { this.db.close(); }
  roles() { return this.db.prepare('SELECT * FROM roles ORDER BY rowid').all() as Role[]; }
  rolePrompt(id: string) { return this.definitions.get(id)?.prompt; }
  roleLaunch(id: string) { return this.definitions.get(id)?.launch; }
  rolePermissions(id: string, defaultSandbox?: boolean) { return rolePermissions(this.definitions.get(id), defaultSandbox); }
  role(id: string) {
    const role = this.db.prepare('SELECT * FROM roles WHERE id=?').get(id) as Role | undefined;
    if (!role) throw new Error('Unknown team role.');
    return role;
  }

  reserve(roleId: string, sessionId: string = randomUUID()) {
    const result = this.db.prepare("UPDATE roles SET sessionId=?, phase='reserved', paused=0 WHERE id=? AND sessionId IS NULL").run(sessionId, roleId);
    if (!result.changes) throw new Error('This role is already reserved or assigned.');
    return sessionId;
  }

  assign(roleId: string, sessionId: string) {
    const result = this.db.prepare("UPDATE roles SET phase='assigned' WHERE id=? AND sessionId=? AND phase='reserved'").run(roleId, sessionId);
    if (!result.changes) throw new Error('The saved reservation no longer belongs to this worker.');
  }

  pause(sessionId: string, paused: boolean) {
    this.db.prepare('UPDATE roles SET paused=? WHERE sessionId=?').run(Number(paused), sessionId);
  }

  release(roleId: string, sessionId: string) {
    this.db.prepare('UPDATE roles SET sessionId=NULL,phase=NULL,paused=0 WHERE id=? AND sessionId=?').run(roleId, sessionId);
  }

  rooms(roleId?: string) {
    return (roleId
      ? this.db.prepare('SELECT r.* FROM rooms r JOIN members m ON r.id=m.roomId WHERE m.roleId=? ORDER BY r.rowid').all(roleId)
      : this.db.prepare('SELECT * FROM rooms ORDER BY rowid').all()) as Room[];
  }

  roomMembers(roomId: string) {
    return (this.db.prepare('SELECT roleId FROM members WHERE roomId=?').all(roomId) as { roleId: string }[]).map(row => row.roleId);
  }

  roomSummaries() {
    return this.db.prepare(`SELECT r.*, m.author AS lastAuthor, substr(m.body, 1, 180) AS lastBody,
      (SELECT count(*) FROM members WHERE roomId=r.id) AS memberCount
      FROM rooms r LEFT JOIN messages m ON m.seq=(SELECT seq FROM messages WHERE roomId=r.id ORDER BY seq DESC LIMIT 1)
      ORDER BY (r.id='team') DESC, m.seq DESC, r.rowid DESC`).all() as RoomSummary[];
  }

  createRoom(title: string, kind: Room['kind'], members: string[]) {
    return this.transaction(() => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO rooms(id,title,kind) VALUES (?,?,?)').run(id, title, kind);
      for (const roleId of new Set(members)) {
        this.db.prepare('INSERT INTO members(roomId,roleId) VALUES (?,?)').run(id, roleId);
      }
      return id;
    });
  }

  joinRoom(id: string, roleId: string) {
    const room = this.db.prepare('SELECT * FROM rooms WHERE id=? AND closed=0').get(id) as Room | undefined;
    if (room?.kind !== 'group') throw new Error('Only open group rooms are joinable. Quick rooms are invite-only.');
    this.db.prepare('INSERT OR IGNORE INTO members(roomId,roleId) VALUES (?,?)').run(id, roleId);
  }

  closeRoom(id: string) {
    if (!this.db.prepare("UPDATE rooms SET closed=1 WHERE id=? AND kind='quick' AND closed=0").run(id).changes) {
      throw new Error('Only open quick rooms can be closed.');
    }
  }

  transcript(id: string) {
    type Recipient = {
      name: string | null; unread: boolean;
      state: 'acknowledged' | 'attempted' | 'queued' | 'wake-limited' | 'inbox-only';
    };
    const rows = this.db.prepare(`SELECT ${replyColumns},
      (SELECT json_group_array(json_object('name', d.recipientName,
        'unread', json(CASE d.ack WHEN 0 THEN 'true' ELSE 'false' END),
        'state', CASE WHEN d.ack=1 THEN 'acknowledged'
          WHEN d.attempted=1 THEN 'attempted' WHEN d.wake=1 THEN 'queued'
          WHEN chain.chainId IS NOT NULL THEN 'wake-limited' ELSE 'inbox-only' END)
        ORDER BY d.recipientName, d.rowid) FROM delivery d WHERE d.messageId=m.id) AS recipientsJson
      FROM messages m ${replyJoins} LEFT JOIN message_wake_chains chain ON chain.messageId=m.id
      WHERE m.roomId=? ORDER BY m.seq DESC LIMIT 100`).all(id) as
      (MessageRow & { recipientsJson: string })[];
    return rows.reverse().map(({ recipientsJson, ...row }) => ({
      ...toMessage(row), recipients: JSON.parse(recipientsJson) as Recipient[],
    }));
  }

  post(roomId: string, author: string, body: string, targets: string[], wake: boolean | string,
    source?: { roleId: string; sessionId: string }, replyTo?: string, humanFallback: readonly string[] = []) {
    return this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM rooms WHERE id=? AND closed=0').get(roomId)) throw new Error('Room is closed or unavailable.');
      const members = this.roomMembers(roomId);
      if (source && (!members.includes(source.roleId) || this.role(source.roleId).sessionId !== source.sessionId)) {
        throw new Error('This worker is not a member of the room.');
      }
      const recipients = new Map<string, string>();
      const addressed = targets.length ? targets : mentionedRoles(body, members);
      for (const target of addressed) {
        if (!members.includes(target)) throw new Error(`Role ${target} is not a member of the room.`);
        const role = this.role(target);
        if (role.phase === 'assigned' && role.sessionId && role.sessionId !== source?.sessionId) recipients.set(role.sessionId, role.name);
      }
      if (replyTo) {
        const parent = this.db.prepare('SELECT 1 FROM messages WHERE id=? AND roomId=?').get(replyTo, roomId);
        if (!parent) throw new Error('You can only reply to a post in this room.');
        const participants = this.db.prepare(`SELECT r.sessionId,r.name FROM roles r
          JOIN members m ON m.roleId=r.id WHERE m.roomId=? AND r.phase='assigned' AND r.sessionId IN (
            SELECT authorSessionId FROM message_links WHERE messageId=?
            UNION SELECT sessionId FROM delivery WHERE messageId=?
          ) ORDER BY r.id`).all(roomId, replyTo, replyTo) as { sessionId: string; name: string }[];
        for (const { sessionId, name } of participants) {
          if (sessionId !== source?.sessionId) recipients.set(sessionId, name);
        }
      }
      if (!source && author === 'You' && !addressed.length && !recipients.size) {
        for (const roleId of humanFallback) {
          if (!members.includes(roleId)) continue;
          const role = this.role(roleId);
          if (role.phase !== 'assigned' || !role.sessionId || role.paused) continue;
          recipients.set(role.sessionId, role.name);
          break;
        }
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO messages(id,roomId,author,body) VALUES (?,?,?,?)').run(id, roomId, author, body);
      if (source || replyTo) {
        this.db.prepare('INSERT INTO message_links(messageId,authorSessionId,replyTo) VALUES (?,?,?)')
          .run(id, source?.sessionId ?? null, replyTo ?? null);
      }
      let wakeCount = 0;
      if (wake && recipients.size) {
        const chain = wake === true ? id : wake;
        this.db.prepare('INSERT OR IGNORE INTO wake_chains(id,scheduled) VALUES (?,0)').run(chain);
        const { scheduled } = this.db.prepare('SELECT scheduled FROM wake_chains WHERE id=?').get(chain) as { scheduled: number };
        wakeCount = Math.min(recipients.size, maxChainWakes - scheduled);
        this.db.prepare('UPDATE wake_chains SET scheduled=scheduled+? WHERE id=?').run(wakeCount, chain);
        this.db.prepare('INSERT INTO message_wake_chains(messageId,chainId) VALUES (?,?)').run(id, chain);
      }
      const delivered = [...recipients.keys()];
      let index = 0;
      for (const [session, name] of recipients) {
        this.db.prepare('INSERT INTO delivery(messageId,sessionId,wake,recipientName) VALUES (?,?,?,?)')
          .run(id, session, Number(index++ < wakeCount), name);
      }
      return { id, sessions: delivered, wakeSessions: delivered.slice(0, wakeCount), wakeLimited: Boolean(wake && wakeCount < delivered.length) };
    });
  }

  unread(sessionId: string) {
    const row = this.db.prepare(`SELECT count(*) AS total FROM delivery d JOIN messages m ON m.id=d.messageId
      JOIN rooms r ON r.id=m.roomId WHERE d.sessionId=? AND d.ack=0 AND r.closed=0`).get(sessionId) as { total: number };
    return row.total;
  }

  readInbox(sessionId: string, ids?: string[]) {
    return this.transaction(() => {
      const messages = this.db.prepare(`SELECT ${replyColumns} FROM messages m JOIN delivery d ON d.messageId=m.id
        JOIN rooms r ON r.id=m.roomId
        JOIN roles worker ON worker.sessionId=d.sessionId AND worker.phase='assigned'
        JOIN members member ON member.roomId=m.roomId AND member.roleId=worker.id
        ${replyJoins}
        WHERE d.sessionId=? AND d.ack=0 AND r.closed=0 AND (? IS NULL OR m.id IN (SELECT value FROM json_each(?)))
        ORDER BY m.seq LIMIT ?`).all(sessionId, ids ? JSON.stringify(ids) : null, JSON.stringify(ids ?? []), inboxLimit) as MessageRow[];
      const byThread = new Map<string, { anchorId: string; roomId: string; inboxIds: string[]; parentIds: string[] }>();
      for (const { id, roomId, parentId } of messages) {
        const rootId = this.threadRoot(id, roomId);
        const existing = byThread.get(rootId);
        const thread = existing ?? { anchorId: id, roomId, inboxIds: [], parentIds: [] };
        thread.inboxIds.push(id);
        if (parentId !== null) thread.parentIds.push(parentId);
        if (!existing) byThread.set(rootId, thread);
      }
      let remaining = threadContextLimit;
      let pending = [...byThread.values()].filter(thread => thread.parentIds.length).length;
      const threads = Array.from(byThread, ([rootId, { anchorId, roomId, inboxIds, parentIds }]) => {
        const limit = parentIds.length ? Math.floor(remaining / pending--) : 0;
        const rows = parentIds.length ? this.threadAncestors(roomId, parentIds, limit) : [];
        const ancestors = rows.slice(0, limit).map(toMessage);
        remaining -= ancestors.length;
        return { rootId, roomId, anchorId, inboxIds, ancestors, ancestorsIncomplete: rows.length > limit };
      });
      for (const { id } of messages) this.db.prepare('UPDATE delivery SET read=1 WHERE messageId=? AND sessionId=?').run(id, sessionId);
      return { messages: messages.map(toMessage), threads };
    });
  }

  readThread(sessionId: string, anchorId: string, afterSeq: number, throughSeq?: number) {
    const anchor = this.db.prepare(`SELECT m.roomId, m.seq,
      (SELECT max(seq) FROM messages WHERE roomId=m.roomId) AS upperSeq
      FROM delivery d JOIN messages m ON m.id=d.messageId
      JOIN rooms r ON r.id=m.roomId AND r.closed=0
      JOIN roles worker ON worker.sessionId=d.sessionId AND worker.phase='assigned' AND worker.paused=0
      JOIN members member ON member.roomId=m.roomId AND member.roleId=worker.id
      WHERE d.sessionId=? AND d.messageId=?`).get(sessionId, anchorId);
    if (typeof anchor?.roomId !== 'string' || typeof anchor.upperSeq !== 'number' || typeof anchor.seq !== 'number') {
      throw new Error('Thread context is unavailable for this delivery.');
    }
    if (afterSeq > 0 ? throughSeq === undefined || throughSeq <= afterSeq ||
        throughSeq < anchor.seq || throughSeq > anchor.upperSeq : throughSeq !== undefined) {
      throw new Error('Continue with both nextAfterSeq and throughSeq from the previous page, or omit both to start a fresh read.');
    }
    return this.threadPage(this.threadRoot(anchorId, anchor.roomId), anchor.roomId, anchorId,
      afterSeq, throughSeq ?? anchor.upperSeq);
  }

  private threadRoot(anchorId: string, roomId: string) {
    const root = this.db.prepare(`WITH RECURSIVE ancestors(id,seq) AS (
      SELECT id,seq FROM messages WHERE id=? AND roomId=?
      UNION ALL
      SELECT p.id,p.seq FROM ancestors a JOIN message_links link ON link.messageId=a.id
      JOIN messages p ON p.id=link.replyTo AND p.roomId=? AND p.seq<a.seq
    ) SELECT id FROM ancestors ORDER BY seq LIMIT 1`).get(anchorId, roomId, roomId);
    if (typeof root?.id !== 'string') throw new Error('Thread root is unavailable.');
    return root.id;
  }

  private threadAncestors(roomId: string, parentIds: string[], limit: number) {
    return this.db.prepare(`WITH RECURSIVE ancestors(id,seq) AS (
      SELECT id,seq FROM messages WHERE roomId=? AND id IN (SELECT value FROM json_each(?))
      UNION
      SELECT p.id,p.seq FROM ancestors a JOIN message_links edge ON edge.messageId=a.id
      JOIN messages p ON p.id=edge.replyTo AND p.roomId=? AND p.seq<a.seq
    ), page AS (SELECT id FROM ancestors ORDER BY seq LIMIT ?)
    SELECT ${replyColumns} FROM page JOIN messages m ON m.id=page.id ${replyJoins}
    ORDER BY m.seq`).all(roomId, JSON.stringify(parentIds), roomId, limit + 1) as MessageRow[];
  }

  private threadPage(rootId: string, roomId: string, anchorId: string, afterSeq: number, throughSeq: number) {
    const rows = this.db.prepare(`WITH RECURSIVE thread(id,seq) AS (
      SELECT id,seq FROM messages WHERE id=? AND roomId=?
      UNION ALL
      SELECT child.id,child.seq FROM thread t JOIN message_links edge ON edge.replyTo=t.id
      JOIN messages child ON child.id=edge.messageId AND child.roomId=? AND child.seq>t.seq AND child.seq<=?
    ), page AS (SELECT id FROM thread WHERE seq>? ORDER BY seq LIMIT ?)
    SELECT ${replyColumns} FROM page JOIN messages m ON m.id=page.id ${replyJoins}
    ORDER BY m.seq`).all(rootId, roomId, roomId, throughSeq, afterSeq, threadContextLimit + 1) as MessageRow[];
    const messages = rows.slice(0, threadContextLimit).map(toMessage);
    return {
      rootId, roomId, anchorId, messages, throughSeq,
      nextAfterSeq: rows.length > threadContextLimit ? messages[messages.length - 1].seq : null,
    };
  }

  acknowledge(sessionId: string, id: string) {
    return Boolean(this.db.prepare('UPDATE delivery SET ack=1 WHERE messageId=? AND sessionId=? AND read=1').run(id, sessionId).changes);
  }

  isAcknowledged(sessionId: string, id: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM delivery WHERE messageId=? AND sessionId=? AND ack=1').get(id, sessionId));
  }

  claimWake(sessionId: string) {
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM roles WHERE sessionId=? AND phase='assigned' AND paused=0").get(sessionId)) return [];
      const messages = this.db.prepare(`WITH eligible AS (
        SELECT m.id,m.seq,coalesce(c.chainId,m.id) AS chain FROM messages m
        JOIN delivery d ON m.id=d.messageId JOIN rooms r ON r.id=m.roomId
        LEFT JOIN message_wake_chains c ON c.messageId=m.id
        WHERE d.sessionId=? AND d.ack=0 AND d.wake=1 AND d.attempted=0 AND r.closed=0
      ) SELECT id,chain FROM eligible WHERE chain=(SELECT chain FROM eligible ORDER BY seq LIMIT 1)
        ORDER BY seq LIMIT 8`).all(sessionId) as { id: string; chain: string }[];
      for (const { id } of messages) this.db.prepare('UPDATE delivery SET attempted=1 WHERE messageId=? AND sessionId=?').run(id, sessionId);
      return messages;
    });
  }

  retryUnread(sessionId: string) {
    this.db.prepare('UPDATE delivery SET attempted=0,wake=1 WHERE sessionId=? AND ack=0').run(sessionId);
  }
}
