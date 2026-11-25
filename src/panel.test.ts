import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('the panel moves one Restore button outside a collapsed roster until recovery succeeds', () => {
  const script = readFileSync(join(__dirname, '../media/team.js'), 'utf8');
  const elements = new Map<string, Element>();
  const posts: unknown[] = [];
  let focused: Element | undefined;
  let receive: ((event: { data: unknown }) => void) | undefined;

  class Element {
    hidden = false;
    open = false;
    parentElement?: Element;
    onclick?: () => void;
    classList = { toggle() {} };
    addEventListener() {}
    replaceChildren() {}
    contains(other: Element) { return other?.parentElement === this; }
    querySelector(selector: string) { return get(selector); }
    focus() { focused = this; }
    prepend(child: Element) {
      child.parentElement = this;
      if (focused === child) focused = undefined;
    }
  }
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const roster = get('roster');
  const actions = get('roster-actions');
  const recovery = get('recovery-action');
  const restore = get('restore');
  actions.parentElement = roster;
  actions.prepend(restore);
  recovery.hidden = get('new-room').hidden = true;
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posts.push(message) }),
    IntersectionObserver: class {},
    document: { getElementById: get, get activeElement() { return focused; }, addEventListener() {} },
    window: { addEventListener: (type: string, handler: typeof receive) => { if (type === 'message') receive = handler; } },
  });
  const onMessage = receive;
  assert(onMessage);
  const state = (needsRestore: boolean) => onMessage({ data: { type: 'state', roles: [], rooms: [], needsRestore } });
  state(false);
  assert.equal(restore.parentElement, actions);
  assert.equal(recovery.hidden, true);
  state(true);
  assert.equal(roster.open, false);
  assert.equal(restore.parentElement, recovery);
  assert.equal(recovery.hidden, false);
  restore.focus();
  restore.onclick?.();
  assert.deepEqual(JSON.parse(JSON.stringify(posts.at(-1))), { action: 'restore' });
  state(true);
  assert.equal(focused, restore);
  state(false);
  assert.equal(restore.parentElement, actions);
  assert.equal(recovery.hidden, true);
  assert.equal(focused, get('summary'));
});
