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
let restoreRequested = false;
let restoring = false;
let needsRestore = false;
let restoreHadFocus = false;
let previewTrigger;
let draftAttachments = [];
const pasting = new Set();
const maxAttachments = 3;
const maxAttachmentBytes = 2 * 1024 * 1024;
const attachmentObserver = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting || !target.isConnected) continue;
    attachmentObserver.unobserve(target);
    const { messageId, position } = target.dataset;
    post('readAttachment', { roomId: activeRoom.id, messageId, position: Number(position) });
  }
}, { root: byId('transcript'), rootMargin: '100px 0px' });
let shownMessages = [];
let roles = [];
let mentionMembers = [];
let mentionOptions = [];
let mentionIndex = 0;
let mentionToken;
let dismissedMention;
let composingMessage = false;
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

function syncRestoreAction() {
  const busy = restoreRequested || restoring;
  const action = byId('restore');
  const recovery = byId('recovery-action');
  const prominent = needsRestore || (busy && action.parentElement === recovery);
  const destination = prominent ? recovery : byId('roster-actions');
  if (busy && !action.disabled) restoreHadFocus = document.activeElement === action;
  const focused = document.activeElement === action || (restoreHadFocus && document.activeElement === document.body);
  const moved = action.parentElement !== destination;
  const settled = action.disabled && !busy;
  action.disabled = busy;
  action.textContent = busy ? 'Restoring…' : 'Restore team';
  if (moved) {
    recovery.hidden = !prominent;
    destination.prepend(action);
    action.classList.toggle('quiet', !prominent);
  }
  if (!busy && focused && (moved || settled) && !byId('overview').hidden) {
    const roster = byId('roster');
    (prominent || roster.open ? action : roster.querySelector('summary')).focus({ preventScroll: true });
  }
  if (!busy) restoreHadFocus = false;
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
  byId('reply-preview').textContent = message?.body || (message?.attachmentCount ? 'Image attachment' : '');
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
  if (message.body) content.append(body);
  if (message.attachmentCount) {
    const attachments = node('div', undefined, 'attachments');
    for (let position = 0; position < message.attachmentCount; position++) {
      const thumbnail = node('button', undefined, 'attachment-thumbnail');
      thumbnail.type = 'button';
      thumbnail.disabled = true;
      thumbnail.setAttribute('aria-label', `Preview image attachment ${position + 1} from ${author}`);
      const image = node('img', undefined, 'message-attachment');
      image.id = `attachment-${message.id}-${position}`;
      image.alt = `Image attachment ${position + 1}`;
      image.dataset.messageId = message.id;
      image.dataset.position = position;
      thumbnail.append(image);
      thumbnail.onclick = () => {
        previewTrigger = thumbnail;
        const preview = byId('image-preview-content');
        preview.src = image.src;
        preview.alt = image.alt;
        byId('image-preview').showModal();
      };
      attachments.append(thumbnail);
      attachmentObserver.observe(image);
    }
    content.append(attachments);
  }
  const summary = recipientSummary(message);
  if (summary) content.append(node('p', summary, 'muted entry-recipients'));
  entry.append(avatar, content);
  return entry;
}

function closeImagePreview(restoreFocus = true) {
  const trigger = previewTrigger;
  previewTrigger = undefined;
  const dialog = byId('image-preview');
  if (!dialog.open) return false;
  dialog.close();
  byId('image-preview-content').removeAttribute('src');
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  return true;
}

function releaseTranscriptImages() {
  const closed = closeImagePreview(false);
  for (const image of byId('transcript').querySelectorAll('.message-attachment')) {
    attachmentObserver.unobserve(image);
    if (image.hasAttribute('src')) URL.revokeObjectURL(image.src);
    image.removeAttribute('src');
    image.parentElement.disabled = true;
  }
  return closed;
}

function renderTranscript(messages, changedRoom, refreshEntries) {
  const transcript = byId('transcript');
  const atBottom = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 24;
  const visibleIds = new Set(messages.map(message => message.id));
  const render = message => messageEntry(message, visibleIds);
  if (!changedRoom && !refreshEntries && shownMessages.length &&
      shownMessages.every((message, index) => message.id === messages[index]?.id && message.bodyHtml === messages[index]?.bodyHtml)) {
    for (let index = 0; index < shownMessages.length; index++) {
      const message = messages[index];
      const summary = recipientSummary(message);
      if (summary !== recipientSummary(shownMessages[index])) {
        byId(`post-${message.id}`).querySelector('.entry-recipients').textContent = summary;
      }
    }
    transcript.append(...messages.slice(shownMessages.length).map(render));
  } else {
    const closedPreview = releaseTranscriptImages();
    if (messages.length) transcript.replaceChildren(...messages.map(render));
    else transcript.replaceChildren(node('p', 'No messages yet. Start the conversation below.', 'empty muted'));
    if (closedPreview) byId('room-title').focus({ preventScroll: true });
  }
  shownMessages = messages;
  if (changedRoom || atBottom) transcript.scrollTop = transcript.scrollHeight;
}

function showNewRoom(show) {
  byId('new-room').hidden = !show;
  byId('new').setAttribute('aria-expanded', String(show));
  byId(show ? 'title' : 'new').focus();
}

function* mentionProse(text) {
  let fence;
  for (const { 0: line, index } of text.matchAll(/[^\n]+/g)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line)) fence = undefined;
      continue;
    }
    if (marker) { fence = marker; continue; }
    if (/^(?: {4}|\t|\s*>)/.test(line)) continue;
    yield { index, text: line.replace(/(`+).*?\1/g, code => '\0'.repeat(code.length)) };
  }
}

function draftMentionRanges(text, members) {
  const ids = new Set(members.map(({ id }) => id));
  const ranges = [];
  for (const line of mentionProse(text)) {
    for (const match of line.text.matchAll(/(?:^|[\s([{])(@([a-z][a-z0-9]*(?:-[a-z0-9]+)*))(?![\w@/-]|\.[\w])/gi)) {
      const id = match[2].toLowerCase();
      if (id !== 'all' && !ids.has(id)) continue;
      const end = line.index + match.index + match[0].length;
      ranges.push([end - match[1].length, end]);
    }
  }
  return ranges;
}

function mentionAtCaret(text, caret) {
  for (const line of mentionProse(text)) {
    const index = caret - line.index;
    if (index < 0 || index > line.text.length) continue;
    const before = /(?:^|[\s([{])(@([a-z0-9-]*))$/i.exec(line.text.slice(0, index));
    if (!before) return;
    const after = /^[a-z0-9-]*/i.exec(line.text.slice(index))[0];
    const end = caret + after.length;
    if (/^(?:[\w@/-]|\.[\w])/.test(text.slice(end))) return;
    return { start: caret - before[1].length, end, query: before[2].toLowerCase() };
  }
}

function syncDraftHighlight() {
  const input = byId('message');
  const overlay = byId('message-highlight');
  const pieces = [];
  let offset = 0;
  for (const [start, end] of draftMentionRanges(input.value, mentionMembers)) {
    pieces.push(input.value.slice(offset, start), node('span', input.value.slice(start, end), 'draft-mention'));
    offset = end;
  }
  overlay.replaceChildren(...pieces, `${input.value.slice(offset)}\u200b`);
  syncHighlightScroll();
}

function syncHighlightScroll() {
  const input = byId('message');
  const overlay = byId('message-highlight');
  overlay.style.width = `${input.clientWidth}px`;
  overlay.scrollTop = input.scrollTop;
}

function closeMentionOptions() {
  mentionOptions = [];
  mentionToken = undefined;
  byId('mention-options').hidden = true;
  byId('message').removeAttribute('aria-activedescendant');
}

function selectMentionIndex(index, scroll = false) {
  mentionIndex = index;
  const list = byId('mention-options');
  for (const [position, option] of Array.from(list.children).entries()) {
    option.setAttribute('aria-selected', String(position === index));
  }
  const active = list.children[index];
  byId('message').setAttribute('aria-activedescendant', active.id);
  if (scroll) active.scrollIntoView({ block: 'nearest' });
}

function syncMentionOptions() {
  const input = byId('message');
  const caret = input.selectionStart;
  const token = activeRoom && !activeRoom.closed && !composingMessage && document.activeElement === input && !input.readOnly &&
    caret === input.selectionEnd && mentionAtCaret(input.value, caret);
  if (!token || (dismissedMention?.text === input.value && dismissedMention.caret === caret)) {
    closeMentionOptions();
    return;
  }
  const options = [{ id: 'all', name: 'All room members' }, ...mentionMembers.filter(role => role.phase === 'assigned')]
    .filter(({ id, name }) => id.startsWith(token.query) || name.toLowerCase().includes(token.query));
  if (!options.length) {
    closeMentionOptions();
    return;
  }
  const previous = mentionToken?.start === token.start && mentionToken.query === token.query ? mentionOptions[mentionIndex]?.id : undefined;
  mentionOptions = options;
  mentionToken = token;
  const list = byId('mention-options');
  list.replaceChildren(...options.map(({ id, name }, index) => {
    const option = node('li', `${name} (@${id})`);
    option.id = `mention-option-${index}`;
    option.setAttribute('role', 'option');
    option.onmousedown = event => event.preventDefault();
    option.onclick = () => acceptMention(index);
    return option;
  }));
  list.hidden = false;
  selectMentionIndex(Math.max(0, options.findIndex(option => option.id === previous)));
}

function acceptMention(index) {
  const input = byId('message');
  const { start, end } = mentionToken;
  const suffix = input.value.slice(end);
  const text = `@${mentionOptions[index].id}${suffix ? '' : ' '}`;
  if (input.value.length - (end - start) + text.length > input.maxLength) return;
  input.setRangeText(text, start, end, 'end');
  dismissedMention = { text: input.value, caret: input.selectionStart };
  closeMentionOptions();
  syncDraftHighlight();
}

function syncSend() {
  const disabled = Boolean(sending) || !activeRoom || Boolean(activeRoom.closed) || pasting.has(activeRoom.id);
  byId('send').disabled = disabled;
  byId('message').readOnly = Boolean(sending && sending === activeRoom?.id);
  if (byId('message').readOnly) closeMentionOptions();
  byId('cancel-reply').disabled = byId('message').readOnly;
  for (const button of byId('draft-attachments').querySelectorAll('button')) button.disabled = byId('message').readOnly;
}

function showAttachmentStatus(text = '') {
  byId('attachment-status').textContent = text;
  byId('attachment-status').hidden = !text;
}

function showDraftAttachments() {
  const container = byId('draft-attachments');
  container.replaceChildren(...draftAttachments.map(({ url }, index) => {
    const preview = node('div', undefined, 'draft-attachment');
    const image = node('img');
    image.alt = `Pasted image ${index + 1}`;
    image.src = url;
    image.onerror = () => showAttachmentStatus('Could not preview this PNG. Remove it and paste another image.');
    const remove = node('button', 'Remove', 'quiet');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove image ${index + 1}`);
    remove.onclick = () => {
      URL.revokeObjectURL(url);
      draftAttachments = draftAttachments.filter(attachment => attachment.url !== url);
      showAttachmentStatus();
      showDraftAttachments();
      syncSend();
      byId('message').focus();
    };
    preview.append(image, remove);
    return preview;
  }));
  container.hidden = !draftAttachments.length;
}

function clearAttachments(attachments) {
  for (const { url } of attachments) URL.revokeObjectURL(url);
}

function pngUrl(png) {
  return URL.createObjectURL(new Blob([Uint8Array.fromBase64(png)], { type: 'image/png' }));
}

window.addEventListener('message', ({ data }) => {
  if (data.type === 'restoreFinished') {
    restoreRequested = false;
    syncRestoreAction();
    return;
  }
  if (data.type === 'attachmentPreviews') {
    if (!pasting.delete(data.roomId)) return;
    if (data.error) {
      if (activeRoom?.id === data.roomId) showAttachmentStatus(data.error);
    } else {
      const previews = data.pngs.map(png => ({ png, url: pngUrl(png) }));
      if (activeRoom?.id === data.roomId) {
        draftAttachments = [...draftAttachments, ...previews];
        showDraftAttachments();
        showAttachmentStatus();
      } else {
        const draft = drafts.get(data.roomId);
        draft.attachments = [...draft.attachments, ...previews];
      }
    }
    syncSend();
    return;
  }
  if (data.type === 'image' || data.type === 'imageFailed') {
    if (activeRoom?.id !== data.roomId) return;
    const image = byId(`attachment-${data.messageId}-${data.position}`);
    if (!image || image.hasAttribute('src')) return;
    if (data.type === 'imageFailed') {
      image.alt = 'Image attachment unavailable';
      return;
    }
    const url = pngUrl(data.png);
    image.onload = () => { if (image.getAttribute('src') === url) image.parentElement.disabled = false; };
    image.onerror = () => {
      if (image.getAttribute('src') !== url) return;
      URL.revokeObjectURL(url);
      image.removeAttribute('src');
      image.alt = 'Image attachment unavailable';
    };
    image.src = url;
    return;
  }
  if (data.type === 'sent' || data.type === 'sendFailed') {
    if (data.type === 'sent') {
      if (activeRoom?.id === data.roomId) {
        byId('message').value = '';
        syncDraftHighlight();
        setReply(undefined);
        clearAttachments(draftAttachments);
        draftAttachments = [];
        showDraftAttachments();
        showAttachmentStatus();
      }
      const draft = drafts.get(data.roomId);
      if (draft) {
        clearAttachments(draft.attachments);
        draft.text = ''; draft.replyTo = undefined; draft.attachments = [];
      }
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
  if (data.unavailable) {
    closeMentionOptions();
    releaseTranscriptImages();
    shownMessages = [];
    return;
  }

  roles = data.roles;
  needsRestore = data.needsRestore;
  restoring = data.restoring;
  syncRestoreAction();
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
  if (changedRoom && previous) drafts.set(previous.id, {
    text: byId('message').value, targets: checked(byId('targets')), replyTo, attachments: draftAttachments,
  });
  activeRoom = data.active;
  byId('overview').hidden = Boolean(activeRoom);
  byId('conversation').hidden = !activeRoom;
  if (!activeRoom) {
    mentionMembers = [];
    if (changedRoom) closeMentionOptions();
    if (changedRoom) {
      dismissedMention = undefined;
      closeMentionOptions();
      releaseTranscriptImages();
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
  if (changedRoom) {
    byId('message').value = draft?.text ?? '';
    draftAttachments = draft?.attachments ?? [];
    showDraftAttachments();
    showAttachmentStatus();
  }
  if (changedRoom || changedLogin) setReply(changedRoom ? draft?.replyTo : replyTo);
  mentionMembers = roles.filter(role => data.members.includes(role.id));
  const recipients = mentionMembers.filter(role => role.phase === 'assigned');
  checkboxes('targets', recipients, changedRoom ? draft?.targets ?? [] : checked(byId('targets')));
  byId('targets').parentElement.hidden = !recipients.length;
  byId('message').placeholder = `Message ${activeRoom.title}`;
  syncSend();
  syncDraftHighlight();
  renderTranscript(data.transcript, changedRoom, changedLogin || activeRoom.closed !== previous?.closed);
  if (changedRoom || (activeRoom.closed && !previous?.closed)) byId('room-title').focus({ preventScroll: true });
  else syncMentionOptions();
});

byId('restore').onclick = () => {
  if (restoreRequested || restoring) return;
  restoreRequested = true;
  syncRestoreAction();
  post('restore');
};
byId('close-image-preview').onclick = () => closeImagePreview();
byId('image-preview').addEventListener('cancel', event => {
  event.preventDefault();
  closeImagePreview();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) closeImagePreview();
});
window.addEventListener('pagehide', () => closeImagePreview(false));
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
byId('transcript').addEventListener('click', event => {
  const reference = event.target.closest('button.workspace-reference');
  if (reference) post('openReference', { reference: reference.textContent });
});
byId('message').addEventListener('paste', async event => {
  const clipboard = event.clipboardData;
  const files = Array.from(clipboard?.files ?? []);
  if (!files.length || !activeRoom || sending === activeRoom.id) return;
  if (!clipboard.types.includes('text/plain')) event.preventDefault();
  const { id: roomId } = activeRoom;
  const status = text => { if (activeRoom?.id === roomId) showAttachmentStatus(text); };
  if (pasting.has(roomId)) return status('Wait for the current image paste to finish.');
  const pngs = files.filter(file => file.type === 'image/png' && file.size <= maxAttachmentBytes);
  if (pngs.length !== files.length) return status('Paste PNG images of up to 2 MiB each.');
  if (draftAttachments.length + pngs.length > maxAttachments) return status('Attach up to three images per message.');
  pasting.add(roomId);
  syncSend();
  try {
    const attachments = await Promise.all(pngs.map(async file => new Uint8Array(await file.arrayBuffer()).toBase64()));
    post('previewAttachments', { roomId, attachments });
  } catch (error) {
    status(error instanceof Error ? error.message : 'Could not paste this image.');
    pasting.delete(roomId);
    syncSend();
  }
});
byId('message').addEventListener('input', () => {
  dismissedMention = undefined;
  syncDraftHighlight();
  syncMentionOptions();
});
byId('message').addEventListener('selectionchange', syncMentionOptions);
byId('message').addEventListener('blur', closeMentionOptions);
byId('message').addEventListener('compositionstart', () => {
  composingMessage = true;
  closeMentionOptions();
});
byId('message').addEventListener('compositionend', () => {
  composingMessage = false;
  syncMentionOptions();
});
byId('message').addEventListener('scroll', syncHighlightScroll);
new ResizeObserver(syncHighlightScroll).observe(byId('message'));
byId('message').onkeydown = event => {
  if (event.isComposing) return;
  if (mentionOptions.length && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      selectMentionIndex((mentionIndex + step + mentionOptions.length) % mentionOptions.length, true);
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      if (!event.repeat) acceptMention(mentionIndex);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      const input = byId('message');
      dismissedMention = { text: input.value, caret: input.selectionStart };
      closeMentionOptions();
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (!event.repeat && !byId('send').disabled) byId('composer').requestSubmit();
  }
};
byId('composer').onsubmit = event => {
  event.preventDefault();
  if (byId('send').disabled || (!byId('message').value.trim() && !draftAttachments.length)) return;
  sending = activeRoom.id;
  syncSend();
  post('post', { roomId: sending, body: byId('message').value, targets: checked(byId('targets')), replyTo: replyTo?.id,
    attachments: draftAttachments.map(({ png }) => png) });
};
post('ready');
