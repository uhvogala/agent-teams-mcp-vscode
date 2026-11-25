import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('Restore stays outside a collapsed roster while busy and can retry after failure', () => {
  const script = readFileSync(join(__dirname, '../media/team.js'), 'utf8');
  const elements = new Map<string, Element>();
  const posts: unknown[] = [];
  let focused: Element | undefined;
  let receive: ((event: { data: unknown }) => void) | undefined;

  class Element {
    hidden = false;
    open = false;
    textContent = '';
    private isDisabled = false;
    get disabled() { return this.isDisabled; }
    set disabled(value: boolean) {
      this.isDisabled = value;
      if (value && focused === this) focused = get('body');
    }
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
    document: { body: get('body'), getElementById: get, get activeElement() { return focused; }, addEventListener() {} },
    window: { addEventListener: (type: string, handler: typeof receive) => { if (type === 'message') receive = handler; } },
  });
  const onMessage = receive;
  assert(onMessage);
  const state = (needsRestore: boolean, restoring = false) =>
    onMessage({ data: { type: 'state', roles: [], rooms: [], needsRestore, restoring } });
  const finished = () => onMessage({ data: { type: 'restoreFinished' } });
  state(false);
  assert.equal(restore.parentElement, actions);
  assert.equal(recovery.hidden, true);
  state(true);
  assert.equal(roster.open, false);
  assert.equal(restore.parentElement, recovery);
  assert.equal(recovery.hidden, false);
  restore.focus();
  restore.onclick?.();
  assert.equal(restore.disabled, true);
  assert.equal(restore.textContent, 'Restoring…');
  assert.deepEqual(JSON.parse(JSON.stringify(posts.at(-1))), { action: 'restore' });
  const afterClick = posts.length;
  state(true);
  restore.onclick?.();
  assert.equal(posts.length, afterClick, 'a stale idle update must not allow a second request');
  state(true, true);
  state(true);
  assert.equal(restore.disabled, true, 'wait for completion of the panel request');
  finished();
  assert.equal(restore.disabled, false);
  assert.equal(restore.textContent, 'Restore team');
  assert.equal(restore.parentElement, recovery);
  assert.equal(focused, restore);

  state(true, true);
  assert.equal(restore.disabled, true, 'a command-initiated restore also disables the panel button');
  restore.onclick?.();
  assert.equal(posts.length, afterClick);
  state(true);
  assert.equal(restore.disabled, false);

  restore.onclick?.();
  assert.equal(posts.length, afterClick + 1);
  state(false, true);
  assert.equal(restore.parentElement, recovery, 'keep progress visible even after recovery state clears');
  state(false);
  finished();
  assert.equal(restore.disabled, false);
  assert.equal(restore.parentElement, actions);
  assert.equal(recovery.hidden, true);
  assert.equal(focused, get('summary'));
});
