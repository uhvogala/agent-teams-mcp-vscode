import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

function loadPanel() {
  const script = readFileSync(join(__dirname, '../media/team.js'), 'utf8');
  const elements = new Map<string, Element>();
  const posts: unknown[] = [];
  let focused: Element | undefined;
  let receive: ((event: { data: unknown }) => void) | undefined;

  class Element {
    children: (Element | string)[] = [];
    attributes = new Map<string, string>();
    listeners = new Map<string, () => void>();
    style = {};
    hidden = false;
    open = false;
    textContent = '';
    value = '';
    selectionStart = 0;
    selectionEnd = 0;
    maxLength = 4000;
    id = '';
    className = '';
    private isDisabled = false;
    get disabled() { return this.isDisabled; }
    set disabled(value: boolean) {
      this.isDisabled = value;
      if (value && focused === this) focused = get('body');
    }
    parentElement?: Element;
    onclick?: () => void;
    onkeydown?: (event: { key: string; preventDefault(): void }) => void;
    classList = { toggle() {} };
    addEventListener(type: string, handler: () => void) { this.listeners.set(type, handler); }
    replaceChildren(...children: (Element | string)[]) { this.children = children; }
    contains(other: Element) { return other?.parentElement === this; }
    querySelector(selector: string) { return get(selector); }
    focus() { focused = this; }
    scrollIntoView() {}
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    setRangeText(value: string, start: number, end: number) {
      this.value = this.value.slice(0, start) + value + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + value.length;
    }
    prepend(child: Element) {
      child.parentElement = this;
      if (focused === child) focused = undefined;
    }
  }
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const context = {
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posts.push(message) }),
    IntersectionObserver: class {},
    ResizeObserver: class { observe() {} },
    document: { body: get('body'), getElementById: get, createElement: () => new Element(),
      get activeElement() { return focused; }, addEventListener() {} },
    window: { addEventListener: (type: string, handler: typeof receive) => { if (type === 'message') receive = handler; } },
  };
  runInNewContext(script, context);
  const onMessage = receive;
  assert(onMessage);
  return { get, posts, onMessage, focused: () => focused, context };
}

test('Restore stays outside a collapsed roster while busy and can retry after failure', () => {
  const { get, posts, onMessage, focused } = loadPanel();
  const roster = get('roster');
  const actions = get('roster-actions');
  const recovery = get('recovery-action');
  const restore = get('restore');
  actions.parentElement = roster;
  actions.prepend(restore);
  recovery.hidden = get('new-room').hidden = true;
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
  assert.equal(focused(), restore);

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
  assert.equal(focused(), get('summary'));
});

test('composer suggests assigned room members and inserts their IDs without sending the draft', () => {
  const { get, posts, context } = loadPanel();
  runInNewContext(`activeRoom = { id: 'team' }; mentionMembers = [
    { id: 'release-qa', name: 'Release Coordinator', phase: 'assigned' },
    { id: 'writer', name: 'Writer', phase: 'assigned' },
    { id: 'vacant', name: 'Vacant', phase: null },
  ];`, context);
  const input = get('message');
  const list = get('mention-options');
  const update = (value: string, caret = value.length) => {
    input.value = value;
    input.selectionStart = input.selectionEnd = caret;
    input.listeners.get('input')?.();
  };
  const key = (key: string) => {
    let intercepted = false;
    input.onkeydown?.({ key, preventDefault: () => { intercepted = true; } });
    return intercepted;
  };
  const labels = () => list.children.map(child => typeof child === 'string' ? child : child.textContent);
  input.focus();
  update('@');
  assert.deepEqual(labels(), ['All room members (@all)', 'Release Coordinator (@release-qa)', 'Writer (@writer)']);
  assert.equal(key('ArrowDown'), true);
  assert.equal(input.attributes.get('aria-activedescendant'), 'mention-option-1');
  assert.equal(key('Enter'), true);
  assert.equal(input.value, '@release-qa ');
  assert.equal(list.hidden, true);
  assert.equal(posts.length, 1, 'completion did not send the draft');

  update('Ask @coordnow, please', 'Ask @coord'.length);
  assert.deepEqual(labels(), ['Release Coordinator (@release-qa)']);
  assert.equal(key('Tab'), true);
  assert.equal(input.value, 'Ask @release-qa, please');

  update('@');
  assert.equal(key('Escape'), true);
  input.listeners.get('selectionchange')?.();
  assert.equal(list.hidden, true, 'selection events do not reopen dismissed suggestions');
  update('hello@example');
  assert.equal(list.hidden, true);
  update('```\n@');
  assert.equal(list.hidden, true);
  update('@');
  const all = list.children[0];
  assert(all && typeof all !== 'string');
  all.onclick?.();
  assert.equal(input.value, '@all ');
  assert.equal(list.hidden, true);

  update('@all @release-qa @unknown `@writer`\n> @all\nhello@writer.example');
  const marked = get('message-highlight').children.flatMap(child =>
    typeof child !== 'string' && child.className === 'draft-mention' ? [child.textContent] : []);
  assert.deepEqual(marked, ['@all', '@release-qa']);
});
