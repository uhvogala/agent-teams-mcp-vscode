import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as vscode from 'vscode';
import { z } from 'zod';
import { decodePngAttachment, maxAttachmentBase64, maxAttachments } from './attachments';
import { SignInCancelled } from './auth';
import { postTeamFromChat, prepareTeamChatMessage, readTeamForChat } from './chat';
import { editorGitHubAuthorization } from './editor-auth';
import { renderMessageMarkdown } from './markdown';
import { id, roomKind, title } from './mcp';
import { connectNativeChat } from './native-chat';
import { TeamStore } from './store';
import { Team } from './team';
import { defaultTeamConfig, loadTeamConfig, teamConfigPath } from './team-config';
import { checkWorkspaceReferenceRange, resolveWorkspaceReference } from './workspace-reference';

const previewAttachmentRoom = z.object({ action: z.literal('previewAttachments'), roomId: id });
const request = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['ready', 'restore', 'configure', 'back']) }),
  z.object({ action: z.enum(['start', 'pause', 'release', 'retry']), roleId: id }),
  z.object({ action: z.literal('select'), roomId: id }),
  z.object({ action: z.literal('close'), roomId: id }),
  z.object({ action: z.literal('create'), title, kind: roomKind, members: z.array(id).max(10) }),
  z.object({ action: z.literal('post'), roomId: id, body: z.string().trim().max(4000), targets: z.array(id).max(10),
    replyTo: id.optional(), attachments: z.array(z.string().max(maxAttachmentBase64)).max(maxAttachments).optional() }),
  z.object({ action: z.literal('openReference'), reference: z.string().max(512) }),
  previewAttachmentRoom.extend({
    attachments: z.array(z.string().max(maxAttachmentBase64)).min(1).max(maxAttachments) }),
  z.object({ action: z.literal('readAttachment'), roomId: id, messageId: id, position: z.number().int().min(0).lt(maxAttachments) }),
]);
let shutdown: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Agent Teams');
  context.subscriptions.push(output);
  const report = (error: unknown) => {
    if (error instanceof SignInCancelled) return;
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    void vscode.window.showErrorMessage(`Agent Teams: ${message}`);
  };
  let team: Team | undefined;
  let store: TeamStore | undefined;
  let owner: DatabaseSync | undefined;
  let unavailable: string | undefined;
  let panel: vscode.WebviewView | undefined;
  let selectedRoom: string | undefined;
  let editorAccountLabel: string | undefined;
  let restoring: Promise<void> | undefined;
  const authorization = editorGitHubAuthorization(vscode);
  const render = () => {
    if (!panel) return;
    const roles = team?.roster() ?? [];
    const rooms = store?.roomSummaries() ?? [];
    const active = rooms.find(room => room.id === selectedRoom);
    const members = active ? store?.roomMembers(active.id) ?? [] : [];
    const mentionMembers = new Set(members);
    void panel.webview.postMessage({
      type: 'state', roles, rooms, active, unavailable, needsRestore: team?.needsRestore ?? false,
      restoring: Boolean(restoring),
      login: team?.signedInLogin ?? editorAccountLabel,
      members,
      transcript: active ? store?.transcript(active.id).map(message => ({
        ...message, bodyHtml: renderMessageMarkdown(message.body, mentionMembers),
      })) : [],
    });
  };
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !context.storageUri || !vscode.workspace.isTrusted) {
    unavailable = 'Open a trusted workspace folder to start a team.';
  } else {
    try {
      const directory = join(context.storageUri.fsPath, 'team-v1');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      owner = new DatabaseSync(join(directory, 'owner.sqlite'));
      try {
        owner.exec('BEGIN IMMEDIATE');
      } catch (error) {
        if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 255) === 5) {
          throw new Error('This workspace already has an Agent Teams controller in another window. Close the other window and reload.');
        }
        throw error;
      }
      const { roles, defaultRecipientRoleId } = await loadTeamConfig(join(folder.uri.fsPath, teamConfigPath));
      const teamStore = store = new TeamStore(join(directory, 'team.sqlite'), roles);
      team = new Team(teamStore, folder.uri.fsPath, join(directory, 'runtime'), () => {
        const config = vscode.workspace.getConfiguration('agentTeams', folder.uri);
        const chat = vscode.workspace.getConfiguration('chat', folder.uri);
        const sandbox = chat.get<boolean | string>('agent.sandbox.enabled');
        return {
          model: config.get('model', 'auto'), projectSummary: config.get('projectSummary', ''),
          repositoryReadAccess: config.get('repositoryReadAccess', false), defaultRecipientRoleId,
          chatDefaults: chat.get('defaultConfiguration'),
          chatSandbox: sandbox === true || sandbox === 'on' ? true : sandbox === false || sandbox === 'off' ? false : undefined,
        };
      }, render, line => output.appendLine(line), authorization, async (role, operation) => {
        const command = operation.kind === 'shell';
        const unsandboxed = command && !teamStore.rolePermissions(role.id).sandbox;
        const action = unsandboxed ? 'Run without sandbox' : command ? 'Run once' : 'Apply once';
        const detail = operation.kind === 'shell'
          ? `${unsandboxed ? 'This command can access files outside the workspace and use the network as the workspace host user.\n\n' : ''}${operation.fullCommandText}`
          : `${operation.fileName}\n\n${operation.diff || operation.newFileContents || ''}`;
        if (detail.length > 12000) {
          report(new Error(`${role.name} requested a ${command ? 'command' : 'file edit'} too large to review. Ask it to split the operation into smaller steps.`));
          return false;
        }
        return await vscode.window.showWarningMessage(`${role.name} wants to ${unsandboxed ? 'run a command without sandboxing' : command ? 'run a workspace command' : 'edit workspace files'}.`,
          { modal: true, detail }, action) === action;
      }, async role => {
        const [file] = await vscode.window.showOpenDialog({
          title: `Select a PNG for ${role.name} to share in Agent Teams`,
          openLabel: 'Allow worker to use this image',
          defaultUri: folder.uri, canSelectMany: false, filters: { 'PNG images': ['png'] },
        }) ?? [];
        if (file && file.scheme !== 'file') throw new Error('Choose a local file on this workspace extension host.');
        return file?.fsPath;
      });
    } catch (error) {
      store?.close();
      owner?.close();
      store = undefined;
      owner = undefined;
      unavailable = error instanceof Error ? error.message : String(error);
      report(error);
    }
  }
  const requireTeam = () => {
    if (!team) throw new Error(unavailable ?? 'The team is unavailable.');
    return team;
  };
  const chooseModel = async (service: Team, roleId: string) => {
    const role = service.store.role(roleId);
    if (role.sessionId) return {};
    const launch = service.launchSettings(roleId);
    const launchDetail = launch ? [
      { interactive: 'Interactive', plan: 'Plan', autopilot: 'Autopilot' }[launch.mode],
      { manual: 'Manual permissions', assisted: 'Assisted permissions', allowAll: 'Allow all' }[launch.approvals],
      `Terminal sandbox ${launch.sandbox ? 'on' : 'off'}`,
    ].join(' / ') : undefined;
    const configured = vscode.workspace.getConfiguration('agentTeams', folder?.uri).get('model', 'auto');
    const models = await service.listModels();
    const choices = [
      { label: 'Auto', id: 'auto', detail: 'Let Copilot choose the model.' },
      ...models.filter(model => model.id !== 'auto' && model.policy?.state !== 'disabled')
        .map(model => ({ label: model.name, id: model.id, detail: model.id })),
    ];
    const preferred = choices.findIndex(model => model.id === configured);
    if (preferred > 0) choices.unshift(...choices.splice(preferred, 1));
    const selected = await vscode.window.showQuickPick(choices.map(model => ({
      ...model, ...(model.id === configured ? { description: 'Workspace default' } : {}),
    })), { title: launchDetail, placeHolder: `Choose a model for ${role.name}`, matchOnDetail: true });
    return selected ? { model: selected.id } : undefined;
  };
  const addressKey = 'nativeChat.address';
  let nativeChat: ReturnType<typeof connectNativeChat> | undefined;
  const ensureNativeChat = () => {
    nativeChat ??= connectNativeChat(requireTeam(), vscode, context.workspaceState.get<string>(addressKey)).then(async connection => {
      try {
        await context.workspaceState.update(addressKey, connection.address);
        return connection;
      } catch (error) {
        await connection.dispose();
        throw error;
      }
    }).catch(error => {
      nativeChat = undefined;
      throw error;
    });
    return nativeChat;
  };
  const start = async (roleId: string, openInChat = false) => {
    const service = requireTeam();
    const selection = await chooseModel(service, roleId);
    if (!selection) return;
    if (openInChat || service.store.roleLaunch(roleId)) {
      await ensureNativeChat();
      const role = await service.startInNativeChat(roleId, selection.model);
      void vscode.window.showInformationMessage(`Agent Teams: ${role.name} is ready. Open its existing session under the Agent Teams host in Chat.`);
      return;
    }
    await service.start(roleId, selection.model);
    if (context.workspaceState.get<string>(addressKey)) await service.restoreNativeChat(ensureNativeChat, roleId);
  };
  const restore = () => {
    if (restoring) return restoring;
    restoring = Promise.resolve().then(() =>
      requireTeam().restore(context.workspaceState.get<string>(addressKey) ? ensureNativeChat : undefined),
    ).catch(report).finally(() => {
      restoring = undefined;
      render();
    });
    render();
    return restoring;
  };
  const chatResult = (result: object) => new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(result)),
  ]);
  const checkChatCancellation = (token: vscode.CancellationToken) => {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
  };
  context.subscriptions.push(
    vscode.lm.registerTool<unknown>('agent_teams_read', {
      invoke({ input }, token) {
        checkChatCancellation(token);
        return chatResult(readTeamForChat(requireTeam(), input));
      },
    }),
    vscode.lm.registerTool<unknown>('agent_teams_send', {
      prepareInvocation({ input }, token) {
        checkChatCancellation(token);
        const { message, room, role } = prepareTeamChatMessage(requireTeam(), input);
        return {
          invocationMessage: `Sending an Agent Teams message to ${role.name}`,
          confirmationMessages: {
            title: `Send to ${role.name} in ${room.title}?`,
            message: `This posts as you and can wake the worker and consume Copilot usage.\n\n${message.body}`,
          },
        };
      },
      invoke({ input }, token) {
        checkChatCancellation(token);
        return chatResult(postTeamFromChat(requireTeam(), input));
      },
    }),
    vscode.commands.registerCommand('agentTeams.open', () => vscode.commands.executeCommand('agentTeams.team.focus')),
    vscode.commands.registerCommand('agentTeams.editConfiguration', async () => {
      try {
        if (!folder || !vscode.workspace.isTrusted) throw new Error('Open a trusted workspace folder to configure a team.');
        const path = join(folder.uri.fsPath, teamConfigPath);
        await mkdir(dirname(path), { recursive: true });
        try {
          await writeFile(path, `${JSON.stringify(defaultTeamConfig, null, 2)}\n`, { flag: 'wx' });
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
        await vscode.window.showTextDocument(vscode.Uri.file(path));
      } catch (error) { report(error); }
    }),
    vscode.commands.registerCommand('agentTeams.signIn', async () => {
      try {
        await requireTeam().authenticate();
        void vscode.window.showInformationMessage('The Copilot runtime is signed in for Agent Teams.');
      } catch (error) { report(error); }
    }),
    vscode.commands.registerCommand('agentTeams.start', async () => {
      try {
        const role = await vscode.window.showQuickPick(requireTeam().roster().map(role => ({
          label: role.name, description: role.activity, id: role.id,
        })), { placeHolder: 'Choose a role to start or resume' });
        if (role) await start(role.id);
      } catch (error) { report(error); }
    }),
    vscode.commands.registerCommand('agentTeams.restore', restore),
    vscode.commands.registerCommand('agentTeams.startInNativeChat', async () => {
      try {
        const service = requireTeam();
        const choice = await vscode.window.showQuickPick(service.roster().map(role => ({
          label: role.name, description: role.activity, id: role.id,
        })), { placeHolder: 'Choose a role to start or show in native Chat' });
        if (!choice) return;
        await start(choice.id, true);
      } catch (error) { report(error); }
    }),
    vscode.window.registerWebviewViewProvider('agentTeams.team', {
      resolveWebviewView(view) {
        panel = view;
        const media = vscode.Uri.joinPath(context.extensionUri, 'media');
        view.webview.options = { enableScripts: true, localResourceRoots: [media] };
        const nonce = randomBytes(18).toString('base64');
        const script = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'team.js'));
        const style = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'team.css'));
        view.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${view.webview.cspSource}; img-src blob:;">
<link rel="stylesheet" href="${style}"><title>Agent Teams</title></head><body>
<p id="status" role="status">Loading team...</p>
<main id="team" hidden>
  <section id="overview" aria-label="Team overview">
    <div id="recovery-action" hidden></div>
    <details id="roster">
      <summary><span>Team roster</span><span class="muted" id="roster-count"></span></summary>
      <div id="roles"></div>
      <div id="roster-actions" class="controls roster-actions"><button id="restore" class="quiet" type="button">Restore team</button><button id="configure" class="quiet" type="button">Configure</button></div>
    </details>
    <button id="new" class="new-room" type="button" aria-controls="new-room" aria-expanded="false"><span aria-hidden="true">+</span> New room</button>
    <form id="new-room" hidden>
      <label for="title">Room name</label><input id="title" placeholder="e.g. Release readiness" maxlength="80" required>
      <label for="kind">Room type</label><select id="kind"><option value="group">Group</option><option value="quick">Quick · invite-only</option></select>
      <fieldset><legend>Invite roles</legend><div class="chips" id="invites"></div></fieldset>
      <div class="controls"><button id="create" type="submit">Create room</button><button id="cancel" class="quiet" type="button">Cancel</button></div>
    </form>
    <nav aria-label="Rooms">
      <h2>Rooms <span id="room-count" class="muted"></span></h2>
      <ul class="room-list" id="rooms"></ul>
      <details id="archive" hidden><summary><span>Archived</span><span id="archive-count" class="muted"></span></summary><ul class="room-list" id="archive-rooms"></ul></details>
    </nav>
  </section>
  <section id="conversation" aria-labelledby="room-title" hidden>
    <header class="conversation-header">
      <button id="back" class="quiet" type="button" aria-label="Back to rooms" title="Back to rooms">‹</button>
      <div class="room-heading"><h2 id="room-title" tabindex="-1"></h2><p id="room-meta" class="muted"></p></div>
      <button id="close" class="quiet" type="button" title="Close this quick room and keep its history">Close room</button>
    </header>
    <div id="transcript" role="log" aria-label="Recent messages" tabindex="0"></div>
    <p id="closed-note" class="muted" hidden>This room is archived. Its history is read-only.</p>
    <form id="composer">
      <div id="reply-draft" class="reply-context" hidden>
        <div><strong id="reply-author"></strong><p id="reply-preview"></p></div>
        <button id="cancel-reply" type="button" class="quiet" aria-label="Cancel reply" title="Cancel reply">×</button>
      </div>
      <label for="message" class="sr-only">Message</label>
      <div class="message-input">
        <div id="message-highlight" aria-hidden="true"></div>
        <textarea id="message" rows="3" maxlength="4000" aria-describedby="reply-author mentions-hint hint"
          aria-autocomplete="list" aria-controls="mention-options"></textarea>
      </div>
      <ul id="mention-options" role="listbox" aria-label="Mention a room member" hidden></ul>
      <div id="draft-attachments" class="attachments" hidden></div>
      <p id="attachment-status" class="issue" role="status" hidden></p>
      <p class="muted" id="mentions-hint">Select recipients or use @role-id or @all. Otherwise, one available room member is notified if possible.</p>
      <fieldset><legend>Wake agents</legend><div class="chips" id="targets"></div></fieldset>
      <div class="composer-footer"><span id="hint" class="muted">Shift+Enter for a new line</span><button id="send" type="submit">Send</button></div>
    </form>
  </section>
</main>
<dialog id="image-preview" aria-labelledby="image-preview-title">
  <div class="image-preview-header"><h2 id="image-preview-title">Image preview</h2>
    <button id="close-image-preview" type="button" class="quiet" autofocus>Close</button></div>
  <img id="image-preview-content" alt="">
</dialog>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
        const sub = view.webview.onDidReceiveMessage(async (input: unknown) => {
          let attachmentRequest: Extract<z.infer<typeof request>, { action: 'readAttachment' }> | undefined;
          try {
            const data = request.parse(input);
            if (data.action === 'ready') {
              render();
              if (team && !team.signedInLogin) {
                void authorization.readAccountLabel().then(label => {
                  editorAccountLabel = label;
                  render();
                }, () => output.appendLine('Could not read the authorized VS Code account label for the Team panel.'));
              }
              return;
            }
            if (data.action === 'restore') {
              try { await restore(); }
              finally { void view.webview.postMessage({ type: 'restoreFinished' }); }
              return;
            }
            const service = requireTeam();
            switch (data.action) {
              case 'start': await start(data.roleId); break;
              case 'pause': await service.pause(data.roleId); break;
              case 'release': {
                const choice = await vscode.window.showWarningMessage('Release this role? Its worker inbox will not transfer to a replacement.', { modal: true }, 'Release role');
                if (choice === 'Release role') await service.release(data.roleId);
                break;
              }
              case 'retry': service.retry(data.roleId); break;
              case 'configure': await vscode.commands.executeCommand('agentTeams.editConfiguration'); break;
              case 'back': selectedRoom = undefined; break;
              case 'select':
                if (!service.store.rooms().some(room => room.id === data.roomId)) throw new Error('Unknown room.');
                selectedRoom = data.roomId;
                break;
              case 'create':
                selectedRoom = service.store.createRoom(data.title, data.kind, data.members);
                void view.webview.postMessage({ type: 'created' });
                break;
              case 'close': service.store.closeRoom(data.roomId); break;
              case 'post': {
                if (data.roomId !== selectedRoom) throw new Error('Select the room before sending a message.');
                const attachments = data.attachments?.map(decodePngAttachment);
                if (!data.body && !attachments?.length) throw new Error('Enter a message or paste a PNG image.');
                service.postHuman(data.roomId, data.body, data.targets, data.replyTo, attachments);
                void view.webview.postMessage({ type: 'sent', roomId: data.roomId });
                break;
              }
              case 'openReference': {
                if (!folder || !vscode.workspace.isTrusted) throw new Error('Open a trusted workspace to follow file references.');
                const { file, line, column } = await resolveWorkspaceReference(folder.uri.fsPath, data.reference);
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                checkWorkspaceReferenceRange(document, line, column);
                if ((await resolveWorkspaceReference(folder.uri.fsPath, data.reference)).file !== file) {
                  throw new Error('The referenced file changed while it was being opened.');
                }
                const position = new vscode.Position(line, column);
                await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
                return;
              }
              case 'previewAttachments': {
                const pngs = data.attachments.map(png => decodePngAttachment(png).toString('base64'));
                void view.webview.postMessage({ type: 'attachmentPreviews', roomId: data.roomId, pngs });
                return;
              }
              case 'readAttachment': {
                attachmentRequest = data;
                if (data.roomId !== selectedRoom) throw new Error('Select the room before viewing its attachments.');
                const png = service.store.readAttachment(data.roomId, data.messageId, data.position);
                void view.webview.postMessage({ ...data, type: 'image', png: png.toString('base64') });
                return;
              }
            }
            render();
          } catch (error) {
            if (attachmentRequest) void view.webview.postMessage({ ...attachmentRequest, type: 'imageFailed' });
            const preview = previewAttachmentRoom.safeParse(input);
            if (preview.success) {
              const message = error instanceof Error ? error.message : String(error);
              output.appendLine(message);
              void view.webview.postMessage({ type: 'attachmentPreviews', roomId: preview.data.roomId, error: message });
              return;
            }
            if (typeof input === 'object' && input !== null && 'action' in input && input.action === 'post') {
              void view.webview.postMessage({ type: 'sendFailed' });
            }
            if (typeof input === 'object' && input !== null && 'action' in input && input.action === 'create') {
              void view.webview.postMessage({ type: 'createFailed' });
            }
            report(error);
          }
        });
        view.onDidDispose(() => { sub.dispose(); if (panel === view) panel = undefined; });
      },
    }),
  );
  shutdown = async () => {
    try { await team?.close(); }
    finally {
      try { await (await nativeChat?.catch(() => undefined))?.dispose(); }
      finally { store?.close(); owner?.close(); }
    }
  };
  return { roster: () => requireTeam().roster() };
}

export async function deactivate() {
  await shutdown?.();
}
