/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();
const byId = id => document.getElementById(id);
const post = (action, data = {}) => vscode.postMessage({ action, ...data });
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};
const button = (text, action, data, className = 'quiet') => {
  const el = node('button', text, className);
  el.type = 'button';
  el.onclick = () => post(action, data);
  return el;
};
const checked = where => Array.from(where.querySelectorAll('input:checked'), input => input.value);
const plural = (count, label) => `${count} ${label}${count === 1 ? '' : 's'}`;
const kindOf = room => room.kind === 'quick' ? 'Quick room' : 'Group room';
const initials = name => Array.from(name.trim())[0]?.toUpperCase() ?? '?';
const drafts = new Map();
const fingerprints = new Map();
let activeRoom;
let replyTo;
let sending;
let shownMessages = [];
let roles = [];
let login;
const displayAuthor = author => author === 'You' ? login ?? author : author;

function refresh(id, data, render) {
  const fingerprint = JSON.stringify(data);
  if (fingerprints.get(id) === fingerprint) return;
  fingerprints.set(id, fingerprint);
  const container = byId(id);
  const key = container.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
  container.replaceChildren(...render());
  if (key) Array.from(container.querySelectorAll('[data-focus]')).find(el => el.dataset.focus === key)?.focus();
}

function checkboxes(id, roles, selected) {
  refresh(id, roles.map(({ id, name }) => [id, name]), () => roles.map(role => {
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.value = role.id;
    checkbox.dataset.focus = role.id;
    const label = node('label');
    label.append(checkbox, node('span', role.name));
    return label;
  }));
  for (const checkbox of byId(id).querySelectorAll('input')) checkbox.checked = selected.includes(checkbox.value);
}

function roleCard(role) {
  const card = node('article', undefined, 'role');
  const heading = node('strong', role.name);
  const state = node('span', role.activity, `role-state ${role.activity.toLowerCase().replaceAll(' ', '-')}`);
  const name = node('div', undefined, 'role-name');
  name.append(heading, state);
  if (role.unread) name.append(node('span', plural(role.unread, 'unread message'), 'unread'));
  card.append(name, node('p', role.description, 'muted'));
  if (role.issue) card.append(node('p', role.issue, 'issue'));
  const controls = node('div', undefined, 'controls');
  const action = (label, verb, style) => {
    const control = button(label, verb, { roleId: role.id }, style);
    control.dataset.focus = `${role.id}:${label}`;
    controls.append(control);
  };
  if (!role.phase) action('Start', 'start', 'secondary');
  if (role.phase && ['Paused', 'Needs recovery'].includes(role.activity)) action('Resume', 'start', 'secondary');
  if (['Idle', 'Busy'].includes(role.activity)) action('Pause', 'pause');
  if (role.phase && role.activity !== 'Starting') {
    if (role.unread) action('Retry inbox', 'retry');
    action('Release', 'release');
  }
  card.append(controls);
  return card;
}

function showRestoreAction(needsRestore) {
  const action = byId('restore');
  const recovery = byId('recovery-action');
  const destination = needsRestore ? recovery : byId('roster-actions');
  if (action.parentElement === destination) return;
  const focused = document.activeElement === action;
  recovery.hidden = !needsRestore;
  destination.prepend(action);
  action.classList.toggle('quiet', !needsRestore);
  if (focused) {
    const roster = byId('roster');
    (needsRestore || roster.open ? action : roster.querySelector('summary')).focus({ preventScroll: true });
  }
}

function roomRow(room) {
  const li = node('li');
  const row = button(undefined, 'select', { roomId: room.id }, 'room-row');
  row.dataset.focus = room.id;
  const icon = node('span', room.id === 'team' ? '@' : room.kind === 'quick' ? '↗' : '#', 'room-icon');
  icon.setAttribute('aria-hidden', 'true');
  const details = node('span', undefined, 'room-copy');
  const preview = room.lastAuthor ? `${displayAuthor(room.lastAuthor)}: ${room.lastBody}` : 'No messages yet';
  details.append(node('strong', room.title), node('span', `${kindOf(room)} · ${plural(room.memberCount, 'role')}`, 'room-meta'),
    node('span', preview, 'room-preview'));
  const arrow = node('span', '›', 'room-arrow');
  arrow.setAttribute('aria-hidden', 'true');
  row.append(icon, details, arrow);
  li.append(row);
  return li;
}

function setReply(message) {
  replyTo = message;
  byId('reply-draft').hidden = !message;
  byId('reply-author').textContent = message ? `Replying to ${displayAuthor(message.author)}` : '';
  byId('reply-preview').textContent = message?.body ?? '';
  byId('mentions-hint').textContent = message
    ? 'Replies address the original workers still assigned here. Add others with selections or @mentions. If nobody is addressed, one available member is notified if possible.'
    : 'Select recipients or use @role-id or @all. Otherwise, one available room member is notified if possible.';
}

function recipientSummary(message) {
  if (!message.recipients.length) return message.author === 'You' ? 'No worker recipients' : '';
  const labels = {
    acknowledged: 'Acknowledged',
    attempted: 'Wake claimed; not acknowledged',
    queued: 'Wake queued',
    'wake-limited': 'Wake limit reached; inbox only',
    'inbox-only': 'Inbox only; no wake queued',
  };
  const summary = `To: ${message.recipients.map(({ name, state }) =>
    `${name ?? 'Unknown former worker'} (${labels[state]})`).join(', ')}`;
  return !activeRoom.closed && message.recipients.some(({ state }) => state === 'wake-limited')
    ? `${summary}. Use Retry inbox in the Team roster to queue another attempt for a still-assigned recipient.`
    : summary;
}

function messageEntry(message, visibleIds) {
  const own = message.author === 'You';
  const author = displayAuthor(message.author);
  const entry = node('article', undefined, own ? 'entry own' : 'entry');
  entry.id = `post-${message.id}`;
  entry.tabIndex = -1;
  const avatar = node('span', initials(author), 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  const content = node('div', undefined, 'entry-copy');
  const header = node('div', undefined, 'entry-header');
  header.append(node('strong', author));
  if (!activeRoom.closed) {
    const reply = node('button', 'Reply', 'quiet reply-button');
    reply.type = 'button';
    reply.setAttribute('aria-label', `Reply to ${author}'s message`);
    reply.onclick = () => {
      if (sending === activeRoom.id) return;
      setReply(message);
      byId('message').focus();
    };
    header.append(reply);
  }
  content.append(header);
  if (message.replyTo) {
    const parent = message.replyTo;
    const canJump = visibleIds.has(parent.id);
    const context = node(canJump ? 'button' : 'div', undefined, 'reply-context');
    context.append(node('strong', `Reply to ${displayAuthor(parent.author)}`), node('span', parent.preview));
    if (canJump) {
      context.type = 'button';
      context.onclick = () => {
        const original = byId(`post-${parent.id}`);
        original?.focus({ preventScroll: true });
        original?.scrollIntoView({ block: 'center' });
      };
    }
    content.append(context);
  }
  const body = node('div', undefined, 'message-body');
  // Only the extension's restricted Markdown renderer produces bodyHtml.
  body.innerHTML = message.bodyHtml;
  content.append(body);
  const summary = recipientSummary(message);
  if (summary) content.append(node('p', summary, 'muted entry-recipients'));
  entry.append(avatar, content);
  return entry;
}

function renderTranscript(messages, changedRoom, refreshEntries) {
  const transcript = byId('transcript');
  const atBottom = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 24;
  const visibleIds = new Set(messages.map(message => message.id));
  const render = message => messageEntry(message, visibleIds);
  if (!changedRoom && !refreshEntries && shownMessages.length &&
      shownMessages.every((message, index) => message.id === messages[index]?.id)) {
    for (let index = 0; index < shownMessages.length; index++) {
      const message = messages[index];
      const summary = recipientSummary(message);
      if (summary !== recipientSummary(shownMessages[index])) {
        byId(`post-${message.id}`).querySelector('.entry-recipients').textContent = summary;
      }
    }
    transcript.append(...messages.slice(shownMessages.length).map(render));
  } else {
    if (messages.length) transcript.replaceChildren(...messages.map(render));
    else transcript.replaceChildren(node('p', 'No messages yet. Start the conversation below.', 'empty muted'));
  }
  shownMessages = messages;
  if (changedRoom || atBottom) transcript.scrollTop = transcript.scrollHeight;
}

function showNewRoom(show) {
  byId('new-room').hidden = !show;
  byId('new').setAttribute('aria-expanded', String(show));
  byId(show ? 'title' : 'new').focus();
}

function syncSend() {
  const disabled = Boolean(sending) || !activeRoom || Boolean(activeRoom.closed);
  byId('send').disabled = disabled;
  byId('message').readOnly = Boolean(sending && sending === activeRoom?.id);
  byId('cancel-reply').disabled = byId('message').readOnly;
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'sent' || data.type === 'sendFailed') {
    if (data.type === 'sent') {
      if (activeRoom?.id === data.roomId) {
        byId('message').value = '';
        setReply(undefined);
      }
      const draft = drafts.get(data.roomId);
      if (draft) { draft.text = ''; draft.replyTo = undefined; }
    }
    sending = undefined;
    syncSend();
    return;
  }
  if (data.type === 'created' || data.type === 'createFailed') {
    byId('create').disabled = byId('cancel').disabled = false;
    if (data.type === 'created') {
      byId('new-room').reset();
      showNewRoom(false);
    }
    return;
  }
  if (data.type !== 'state') return;
  byId('status').textContent = data.unavailable ?? '';
  byId('status').hidden = !data.unavailable;
  byId('team').hidden = Boolean(data.unavailable);
  if (data.unavailable) return;

  roles = data.roles;
  showRestoreAction(data.needsRestore);
  const changedLogin = login !== data.login;
  login = data.login;
  byId('roster-count').textContent = `${roles.filter(role => ['Idle', 'Busy'].includes(role.activity)).length}/${roles.length} active`;
  refresh('roles', roles, () => roles.map(roleCard));
  const open = data.rooms.filter(room => !room.closed);
  const archived = data.rooms.filter(room => room.closed);
  byId('room-count').textContent = open.length;
  byId('archive-count').textContent = archived.length;
  byId('archive').hidden = !archived.length;
  refresh('rooms', [open, login], () => open.map(roomRow));
  refresh('archive-rooms', [archived, login], () => archived.map(roomRow));
  if (!byId('new-room').hidden) checkboxes('invites', roles, checked(byId('invites')));

  const previous = activeRoom;
  const changedRoom = previous?.id !== data.active?.id;
  if (changedRoom && previous) drafts.set(previous.id, { text: byId('message').value, targets: checked(byId('targets')), replyTo });
  activeRoom = data.active;
  byId('overview').hidden = Boolean(activeRoom);
  byId('conversation').hidden = !activeRoom;
  if (!activeRoom) {
    if (changedRoom) {
      if (previous.closed) byId('archive').open = true;
      Array.from(byId('overview').querySelectorAll('.room-row')).find(row => row.dataset.focus === previous.id)?.focus();
    }
    return;
  }
  byId('room-title').textContent = activeRoom.title;
  byId('room-meta').textContent = `${kindOf(activeRoom)} · ${plural(activeRoom.memberCount, 'role')}`;
  byId('close').hidden = activeRoom.kind !== 'quick' || Boolean(activeRoom.closed);
  byId('closed-note').hidden = !activeRoom.closed;
  byId('composer').hidden = Boolean(activeRoom.closed);
  const draft = drafts.get(activeRoom.id);
  if (changedRoom) byId('message').value = draft?.text ?? '';
  if (changedRoom || changedLogin) setReply(changedRoom ? draft?.replyTo : replyTo);
  const recipients = roles.filter(role => role.phase === 'assigned' && data.members.includes(role.id));
  checkboxes('targets', recipients, changedRoom ? draft?.targets ?? [] : checked(byId('targets')));
  byId('targets').parentElement.hidden = !recipients.length;
  byId('message').placeholder = `Message ${activeRoom.title}`;
  syncSend();
  renderTranscript(data.transcript, changedRoom, changedLogin || activeRoom.closed !== previous?.closed);
  if (changedRoom || (activeRoom.closed && !previous?.closed)) byId('room-title').focus({ preventScroll: true });
});

byId('restore').onclick = () => post('restore');
byId('configure').onclick = () => post('configure');
byId('back').onclick = () => post('back');
byId('cancel-reply').onclick = () => {
  setReply(undefined);
  byId('message').focus();
};
byId('close').onclick = () => post('close', { roomId: activeRoom.id });
byId('new').onclick = () => {
  if (!byId('new-room').hidden && byId('create').disabled) return;
  checkboxes('invites', roles, checked(byId('invites')));
  showNewRoom(byId('new-room').hidden);
};
byId('cancel').onclick = () => showNewRoom(false);
byId('new-room').onsubmit = event => {
  event.preventDefault();
  byId('create').disabled = byId('cancel').disabled = true;
  post('create', { title: byId('title').value, kind: byId('kind').value, members: checked(byId('invites')) });
};
byId('message').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!event.repeat && !byId('send').disabled && event.currentTarget.value.trim()) byId('composer').requestSubmit();
  }
};
byId('composer').onsubmit = event => {
  event.preventDefault();
  if (byId('send').disabled || !byId('message').value.trim()) return;
  sending = activeRoom.id;
  syncSend();
  post('post', { roomId: sending, body: byId('message').value, targets: checked(byId('targets')), replyTo: replyTo?.id });
};
post('ready');
