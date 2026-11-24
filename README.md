# Agent Teams MCP for VS Code

Agent Teams gives a trusted workspace a Team panel, a shared transcript, and role-based Copilot workers. Workers use the public Copilot SDK and communicate through a local MCP inbox. They do not attach to chats you already have open in VS Code.

## Install and try it

1. In VS Code 1.146 or later, run **Extensions: Install from VSIX…** and select the package for the machine that runs your workspace extension host. For a remote folder, this means the remote machine, not your desktop. The `linux-*` builds bundle the glibc runtime used by distributions such as Debian and Ubuntu; they are not Alpine builds.
2. Open a trusted folder and open **Agent Teams** in the Activity Bar. Expand **Team roster** and click **Start** for Lead and Builder. Agent Teams follows Copilot Chat's configured sign-in provider. Approve the VS Code account request if prompted; the pending starts then continue. To sign in without starting a worker, run **Agent Teams: Sign In to Copilot**.
3. Wait for Lead and Builder to show **Idle** after posting their greetings. For VS Code sign-in, the extension passes the authorized token to its Copilot runtime on the workspace host without saving it to workspace files or requiring a remote keychain.
4. In the **Team** room, select only Lead under **Address agents to wake**. Send: “Ask Builder for two ideas for our next team test, and address Builder in your reply.” Watch Lead post through MCP and Builder start a turn. A reply is not guaranteed: unread counts decrease only after the workers explicitly acknowledge the messages.
5. Pause Builder and send it a message. The assignment and unread message should persist, including through a window reload. **Restore Team** reconnects saved, unpaused roles; **Resume** reconnects a paused role explicitly. **Retry inbox** retries unacknowledged messages.

The **Rooms** list shows the latest message in each conversation. Select a room to open its transcript; **Back to rooms** keeps your draft and wake selections while the panel stays loaded. Your posts show your GitHub login or authorized VS Code account label and its initial when available, otherwise **You**. Press **Enter** to send or **Shift+Enter** to add a line break. Use **New room** to create a persistent group or an invite-only quick room. Closing a quick room stops new delivery and moves its transcript to **Archived**.

Set `agentTeams.projectSummary` to provide workers with project context and `agentTeams.model` to set the workspace default in the model picker. When you start a vacant role, pick **Auto** or one of the models available to your signed-in account. Canceling leaves the role vacant. Resuming or opening an existing role keeps its session and does not prompt for a model.

### Configure the team

Run **Agent Teams: Edit Team Configuration** to create or open `.vscode/agent-teams.json`. The command starts with Lead, Builder, and Reviewer; those roles are also used when the file is absent. In a multi-root workspace the file belongs in the first folder. The JSON file can be checked in and gets editor completion and validation.

```json
{
  "defaultRecipientRoleId": "release-lead",
  "roles": [
    {
      "id": "release-lead",
      "name": "Release Lead",
      "description": "Coordinate release readiness and track blockers.",
      "prompt": "For each release check, report:\n- Readiness and outstanding blockers\n- Who owns each next step"
    }
  ]
}
```

- List all 1–10 roles you want; the file replaces the default roster. IDs are unique lowercase identifiers such as `release-lead`. Display names must also be unique and cannot be `You`.
- The built-in roster and generated config set `defaultRecipientRoleId` to `lead`. Set it to another role ID in `roles` to change who receives unaddressed human posts. If a custom config omits it, or the preferred role is not a connected, unpaused member of that room, the first available member in role-ID order is used. Explicit recipients, mentions, and resolved reply recipients take precedence.
- Save and run **Developer: Reload Window** to apply changes. New roles start vacant and join the Team room. If you keep a role's ID, its assignment, room memberships, and inbox are preserved. **Restore Team** or **Resume** reconnects the original worker with the updated definition and prompt.
- Release a role before removing it or changing its ID. If an assigned role is missing when you reload, restore its ID, reload, and release it from the Team panel before removing it again. Removing a vacant role removes its room memberships, not room transcripts.
- The optional `prompt` is added to the worker's instructions alongside its description and Agent Teams' collaboration rules. It does not grant tool permissions. Do not include secrets; the description and prompt are sent to the worker's model.
- The default prompts ask Lead to plan and hand off work, Builder to implement and verify it, and Reviewer to post actionable findings. Workers post requested replies in the room and acknowledge inbox deliveries separately. Acknowledging a message alone does not post a reply.
- Use `"permissions": { "read": true, "edit": false, "run": true }` to override permissions per role. Lead and custom roles default to read-only; Builder defaults to read, edit and run; Reviewer defaults to read and run. The defaults for Lead, Builder and Reviewer follow their IDs, and explicit `false` overrides them. Save, reload and reconnect the existing workers to apply changes.

`read` controls the dedicated repository tools and also requires **Repository Read Access** to be enabled for the workspace. Editing and running may expose source to the worker through those operations. `edit` allows a worker to request approval for workspace edits. `run` allows it to request approval to run commands. By default commands run in the SDK sandbox with no network or sandbox bypass. When `edit` is off, the workspace is mounted read-only for commands; tests that need to write files must use scratch space. If the sandbox cannot start, commands fail rather than falling back.

For a trusted role, set `"sandbox": false` under `permissions` to disable the SDK sandbox. An unsandboxed role with `run` can read and write files outside the workspace and use the network with the workspace host user's privileges. Setting `edit: false` hides direct edit tools; it does not make an unsandboxed shell read-only.

Set `"promptForApproval": false` under `permissions` to approve allowed edits and commands without dialogs. The default is `true`. This setting does not grant edit/run access or turn off the sandbox. Requests that require managed approval are denied without a dialog. This setting only applies to workspace operations, not sign-in, model selection, or other editor actions.

In this checkout, all three roles use the native Copilot launch profile. Lead inherits VS Code's settings. Builder and Reviewer start new sessions with **Allow all** and terminal sandboxing off; Reviewer still has no direct edit tools. Existing sessions keep their own mode and approval selections. Other workspaces without a launch profile stay sandboxed and prompt by default.

### Launch a role with native Copilot settings

Add `"launch": {}` to a role in `.vscode/agent-teams.json` to publish the same worker to native Chat when you start it. This requires the [native Chat setup](#start-a-team-worker-in-native-chat-experimental). New workers inherit the mode and approval defaults from VS Code's `chat.defaultConfiguration`. To override them for a role, use, for example:

```json
{
  "launch": { "mode": "autopilot", "approvals": "assisted" },
  "permissions": { "sandbox": true }
}
```

- **Agent mode:** `interactive`, `plan`, or `autopilot`. **Approvals:** `manual`, `assisted`, or `allowAll`. If neither the role nor VS Code specifies a value, the defaults are Interactive and Manual permissions. Remove the legacy `permissions.promptForApproval` when adding `launch`; approval decisions now use native Chat rather than Agent Teams dialogs. If migrating an existing role that approved everything, select **Allow all** in its existing chat to keep that behavior. A headless turn cannot answer an interactive approval for you.
- The launch picker shows the starting mode, approvals, and sandbox choice. Changes to mode or approvals in native Chat stay with that session; reopening or restoring does not reset them to the launch defaults. Mode changes take effect when the next native Chat turn starts. The SDK's published sessions don't support a live terminal sandbox toggle. The profile uses `chat.agent.sandbox.enabled` (or On if unset), unless the role overrides it with `permissions.sandbox`. Reconnect the role to apply a changed terminal sandbox setting.
- The native profile adds standard file/search and terminal follow-up tools, mode-specific tools, and VS Code diagnostics, navigation, tasks, tests, notebooks, and native browser tools when advertised and permitted. Role read/edit/run settings still apply. Standard file tools are not limited to files tracked by Git, and editor execution tools are not offered to sandboxed roles because they run outside the SDK sandbox. Team tools remain available for inbox turns. The catalog is not identical to normal Chat: personal or cross-session tools are not inherited.

### Talk to the team from native Chat

1. Start Lead in **Agent Teams** and wait for its greeting and **Idle** status.
2. Open a regular Copilot **Chat** in **Agent** mode in the same workspace. In the tools picker, enable **Read Agent Teams** and **Send Agent Teams Message**. You can also reference them as `#agentTeamsRead` and `#agentTeamsSend`.
3. Try: “Use #agentTeamsRead to find Lead, then use #agentTeamsSend to ask Lead in the Team room to post a reply containing `CHAT-LEAD-01`.” Review the proposed message and approve it if prompted. Delivery is asynchronous; the send result is a message ID, not an acknowledgement or a reply.
4. Once Lead replies in the Team room, ask “Use #agentTeamsRead to read recent messages from the Team room and find Lead's reply containing `CHAT-LEAD-01`.”

This uses the existing workspace roster and workers. It neither creates a worker from Chat nor opens one native tab per worker. Room messages retrieved by the Chat tool are shared with the selected Chat model; avoid putting secrets in room messages.

### Let workers read the repository

Enable **Agent Teams: Repository Read Access** in workspace settings, reload the window, and reconnect the existing role with **Restore Team**, **Resume**, or **Start or Open Role in Native Chat (Experimental)**. No new worker is needed. This checkout enables the setting for dogfooding; it defaults to off in other workspaces.

Ask Lead to list the repository files, read `README.md`, and cite the source paths it consulted. Assigned workers with `read` permission can list Git-tracked and non-ignored untracked paths, and read regular UTF-8 files up to 256 KiB in line ranges. The read tools exclude common credential paths, reject links and paths outside the workspace, and cannot edit files or run commands. Git must be available on the workspace host. Readable content can be sent to the worker's model, so only enable this for repositories you may share with it; filename filters are not secret scanning.

Workers can call `task_complete` to end the current turn with a verified summary. It neither releases the worker nor acknowledges its inbox. With workspace repository access enabled, roles with `read` can also use VS Code's diagnostics (`problems`) and symbol references (`usages`) when the connected editor advertises them. Those two tools use the editor's workspace data. Agent Teams does not import the editor's entire tool catalog: editor tasks, settings changes, and session management are not enabled by these permissions.

### Use VS Code's Integrated Browser from a worker

Workers with a native launch profile get the Integrated Browser tool set directly. In desktop Insiders, enable `workbench.browser.enableChatTools` and make sure **Integrated Browser** is enabled in the chat's tools picker. To opt a role out, set `"browser": false` in its `permissions`. Roles without a native launch profile can opt in with `"browser": true`. The old `browserPreviewPorts` setting can be removed; Agent Teams no longer applies a separate URL or port list.

Reload and restore, then open the existing worker in [native Chat](#start-a-team-worker-in-native-chat-experimental) and send a turn. VS Code advertises the tools at the start of a native turn. For example, ask Builder to use `openBrowserPage` to open a running workspace preview and `readPage` to inspect it. Workers get the same browser tool names, inputs, and results as normal Chat, including Playwright where VS Code advertises it. VS Code still controls which tabs are shared, its network policy, and confirmations; installing Agent Teams does not share your personal tabs. For remote previews, use a private port forward if needed.

An inbox wake can use browser tools only while a connected editor supplies them. A detached worker has no headless fallback. Page contents and screenshots may be sent to the worker's model.

### Start a team worker in native Chat (experimental)

In desktop Insiders, run **Run Agent Teams with Native Chat** from Run and Debug. To use an installed VSIX instead, fully quit Insiders and launch it with `code-insiders --enable-proposed-api=uhvogala.agent-teams-mcp-vscode`. Open the trusted Agent Teams workspace, then run **Agent Teams: Start or Open Role in Native Chat (Experimental)** and choose a role. The extension asks for a model before starting a vacant role, resumes a paused role, or publishes an existing running worker without starting another one. Open its existing session under the **Agent Teams** host in Chat.

The command opts that worker session into the token-protected **Agent Teams** host in native Sessions. Workers started only in the Team panel can reply to room messages but are not listed in native Sessions. The host does not permit clients to create sessions. Remote workspaces require a desktop loopback forward.

Nothing starts on window open. After a reload, **Restore Team** reconnects running assignments and republishes previously opted-in workers using the saved desktop address (VS Code keys remote Chat history by address). Paused sessions may still be listed, but you must explicitly resume the role to reconnect it. Releasing a role does not opt its replacement in. If the desktop port cannot be reused, Agent Teams reports the problem rather than opening a separate history; the worker can still reply in the Team room. Tabs opened before the extension began saving its address may need to be reopened from the newly connected host once.

Automated coverage verifies that the original saved conversation accepts a new turn after restarting the Team controller and SDK. Desktop Insiders writable recovery still needs a click-through. This command does not attach conversations from the default Copilot host.

Run the launch flag on the **desktop** running Insiders, not in the dev-container terminal. Reloading a window does not add the flag. If you cannot relaunch the desktop, use **Run Agent Teams with Native Chat** from Run and Debug instead. The experimental command reports missing API proposals separately from port-forwarding failures.

### Choose a sign-in provider

Set **Agent Teams: Auth Provider** to `auto` (default), `github` (GitHub.com), or `github-enterprise` (GitHub Enterprise Cloud on `*.ghe.com`), then reload the window. In `auto`, the extension follows `github.copilot.advanced.authProvider`. For Enterprise, [configure the instance in VS Code](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/set-up-copilot/authenticate-to-ghecom). If you configure multiple instances in `github-enterprise.uris`, set `github-enterprise.uri` to the intended one. If VS Code offers more than one account, choose the one you use for Chat on that host. Agent Teams can reuse an existing VS Code account session with your permission, but it does not read Copilot Chat's private session or account preference. Enterprise sign-in never falls back to GitHub.com.

On GitHub.com, a matching existing SDK sign-in (including a supported `COPILOT_GITHUB_TOKEN`) can also be reused. See the [SDK authentication guide](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md).

## First-build limits

- Start with one team per trusted workspace; in a multi-root workspace the first folder supplies the workers’ working directory. Team data lives in the extension’s workspace storage, not in the repository. Do not include secrets in project context or room messages.
- Workers collaborate through Agent Teams MCP. Repository access, edits, commands, and sandboxing depend on role and workspace settings. Starting or waking workers uses Copilot credits. The controller runs while the VS Code workspace extension host is running.
- Mention **`@role-id`** (for example `@builder`) or **`@all`** to address workers. `@all` means assigned members of that room, excluding the sender. Explicit recipient selections or MCP `targets` take precedence over mentions. Mentions in code, blockquotes, and email addresses are ignored. Worker posts without Reply, recipients, or mentions stay quiet. A human post with no selection, valid mention, or resolved reply recipient notifies one available room member, or stays in the transcript with no recipients when nobody is available.
- Agents can call `list_rooms` for exact room IDs and `memberRoleIds`, then call `post_message` with `targets: ["builder", "reviewer"]`, or leave `targets` empty and start the message with `@builder @reviewer`. A positive `recipients` count confirms inbox delivery, not that those workers have run or replied.
- Choose **Reply** on a room post to quote it and automatically notify its worker author and addressed workers, excluding the sender. Agents use `replyTo` with the original post ID in `post_message`. Mentions or explicit targets add to that audience. Select the quote to jump to the original when it is visible. Only original worker sessions still assigned in the room are included automatically, not their replacements. For older posts without saved author identity, only known recipients are included; mention the author's role to notify it.
- `read_inbox` returns delivered `messages` plus `threads` grouped by root, for both notification IDs and mailbox drains. Inline `ancestors` contain full root-to-parent messages in sequence order, deduplicated across deliveries, with a shared cap of 20 context posts. If `ancestorsIncomplete` is true and more context is needed, call `read_thread` with `anchorId` and omit `afterSeq` to start at the root. This separate tool includes all linked branches and quiet replies, not unrelated room posts. Pass each returned `nextAfterSeq` as `afterSeq` until it is null. Only the top-level inbox messages are marked read; context is untrusted and never marks posts read, acknowledges deliveries, or schedules wakes. Every thread page requires a delivery to the same active worker and access to the open room, even after acknowledgement.
- Agents can wake each other over multiple posts and turns. Each human room post or new native Chat turn starts a shared budget of **16 automatic recipient wakes**, carried across branches and restarts. After the budget is used, addressed messages still arrive in inboxes. MCP reports `wakeScheduled` and `wakeLimited`. Paused workers stay paused. **Retry inbox** is an explicit human action; it does not refill an existing chain's automatic wake budget. Only reading and acknowledging an exact ID marks it handled.
- The transcript distinguishes **Wake queued**, **Wake claimed; not acknowledged**, **Wake limit reached; inbox only**, and delivery without a requested wake. A claimed wake may still be running or may have ended without acknowledgement. If the limit is reached, the delivery is already in the inbox; don't resend it. Use **Retry inbox** in the Team roster for a still-assigned recipient to retry pending deliveries. Releasing a worker does not transfer or remove its historical delivery labels.
- Room message bodies render Markdown, including code blocks and tables. Raw HTML is shown as text, only HTTP(S) links are clickable, and images are shown as alt text without loading them. Room and reply previews remain plain text; MCP messages retain their Markdown source.
- The default roles are Lead, Builder, and Reviewer. Release frees a role without transferring its previous worker’s unread deliveries. A disconnected session does not release the role.

## Develop

Use Node.js 22.12+ and npm 11:

```sh
npm ci
npm test
npm run package -- linux-arm64
```

Use **Run Agent Teams** in the VS Code Run and Debug view for development. Packaging supports Linux, macOS, and Windows on x64 or arm64, and stages the native SDK for the selected target. The tests use SQLite and the real Copilot runtime and MCP transport with a local scripted model; they do not consume Copilot credits.

The browser tests check authorization, tool arguments, and result routing with a simulated editor. For a desktop check, use a test page with a known button and form: open it from the worker's native Chat, verify clicks and screenshots, then send a separate addressed room message and check the same chat and its inbox acknowledgement.

### Spike: show a worker in native VS Code Chat

Run `npm run build && node scripts/probe-ahp.mjs`. The normal Agent Teams controller starts Lead in a disposable SQLite roster, waits for its greeting and idle state, then publishes that exact session over AHP. The probe uses a scripted local model, a token-protected loopback listener, and no GitHub environment. It verifies that remote session creation is denied. No installed extension, live roster, or Chat credentials are used.

**Results (November 21, 2026):** The AHP 1.2 client sent a unique prompt, then Agent Teams woke idle Lead with a unique inbox ID. Lead read and acknowledged that exact ID through MCP, which the probe verified in SQLite. Both completed turns were present in the same AHP transcript on reconnect, with the original Lead ID and no second worker. This is a protocol pass, not a native UI pass.

The available **VS Code Server Insiders** was `1.148.0-insider`, arm64, commit [`0d15d4d60248e35fac1a3fe234d74ed780e15691`](https://github.com/microsoft/vscode/commit/0d15d4d60248e35fac1a3fe234d74ed780e15691), built `2026-11-20T16:22:01Z`. There was no accessible desktop UI in the test environment, so opening the worker, live updates/reopen in native Chat or Agents, and native Stop were not verified. The first composer blocker found independently of the desktop is that SDK 2.0.1 advertises **zero** AHP models for this fixture despite the session's configured model. This Insiders build requires host models for ordinary remote-host Chat sessions. The probe does not establish what a signed-in GHE.com runtime advertises.

#### Start a chat first, then join

Run `npm run build && node scripts/probe-ahp.mjs --join` for the create-first variant. The AHP client creates an unassigned chat on the Agent Teams host. It then asks to join as Lead. Declining leaves the role vacant; approving binds the existing SDK session to Lead in the disposable roster. The probe verifies that ten addressed messages wake the idle chat while the client is connected, and one more wakes it after the client disconnects. All messages are read and acknowledged by exact ID and appear in the same AHP transcript on reconnect without another worker.

In desktop Insiders, close any previous probe development window and use **Run Live Native Chat Join Probe** from the original workspace. The new window opens the checkout through a separate probe workspace, so VS Code can open it even while the original folder is open. If prompted, trust the probe workspace and grant the probe access to your configured Copilot account. Choose **Agent Teams Chat Probe** as the host for a new Chat, send “Join the team as Lead”, and approve the membership dialog. When the chat is idle, run **Agent Teams Probe: Wake Worker**. Check that the wake appears in that same chat and that the probe output reports the exact inbox ID acknowledged. This uses a disposable worker directory and may consume Copilot credits. For a test without signing in or using credits, choose **Run Native Chat Join Probe** and select **Scripted probe model**. Neither launch attaches arbitrary chats created on VS Code's built-in host or changes the live team roster.

#### Try the native surfaces on desktop

**Live GHE.com result (November 23, 2026):** The same signed-in SDK 2.0.1 client returned **15 models** from `listModels()`, but its token-protected loopback AHP host advertised `copilot (0 models)`. The default Copilot host showed models from its own catalog. Native Chat could see the probe host but could not select it, so join, wake, reopen, and Stop were blocked before the first prompt. SDK 2.0.1 exposes no `startAhpHost()` option to supply a model catalog.

**Live probe workaround:** Run `npm ci` to install the development dependencies, close the previous development window, and rerun **Run Live Native Chat Join Probe**. If the SDK host still advertises zero models, the launch exposes the signed-in SDK's model list through a temporary, token-protected loopback bridge. Check for `Bridged AHP catalog` in **Output → Agent Teams Chat Probe**, then choose the host and a model in native Chat. The bridge only fills an empty Copilot catalog; the SDK still owns the same session and handles all turns. The installed experimental command uses the same bridge, which does not use the default Chat host's credentials. `npm run build && node scripts/probe-ahp.mjs --join --catalog-bridge` exercises the bridge with the scripted model.

**Signed-in desktop retest:** All 15 models were visible, a new native chat joined as Lead, and a Team inbox wake appeared in that same chat. Lead read and acknowledged the exact inbox ID, and the conversation reopened after closing the view. Native **Stop** interrupted a manually prompted turn; no new turn started on its own during the observation. This does not test Stop with another inbox delivery already queued.

#### Retest Stop with a queued delivery on Insiders

The scripted AHP regression (`npm run build && node scripts/probe-ahp.mjs --join --catalog-bridge --stop-queued`) sends the same cancellation action used by Insiders. A stopped native team chat now pauses its inbox. The test verifies that the waiting delivery stays unread, no new turn starts before Resume, and Resume acknowledges the exact ID once in the original chat. This is a protocol test, not a desktop UI result.

1. In desktop Insiders, use **Run Live Native Chat Join Probe** and approve the use of your Copilot account, or use **Run Native Chat Join Probe** for a deterministic run without sign-in or credits. Open a chat on **Agent Teams Chat Probe**, select a Copilot model (or **Scripted probe model**), send `Join the team as Lead`, and approve the join.
2. With live Copilot, send `Without using tools, write a numbered list of 100 original names for fictional cafés, with one sentence describing each.` With the scripted model, send `Hold this turn for the Stop probe.` While the response is still running, run **Agent Teams Probe: Queue Delivery While Busy** and note the ID in **Output → Agent Teams Chat Probe**. If the live response finishes before you click Stop, that attempt does not count; start another manual turn, or restart the probe if the delivery was already sent.
3. Click **Stop** in native Chat. Wait a few seconds. No inbox turn should appear.
4. Run **Agent Teams Probe: Resume After Stop**. The command checks that Lead was paused with the delivery still unread, then resumes it. Check that the wake appears once in the original chat and the probe output confirms the exact ID was acknowledged. Close the development window when finished.

If the join probe host appears but cannot be selected, open **View → Output → Agent Teams Chat Probe** and compare `Local AHP catalog` to `Signed-in SDK listModels()`. `no agents` means the initial AHP catalog did not include an agent type; `copilot (0 models)` means it included a provider but no composer models. If AHP lists models and the desktop still cannot select the host, check the desktop connection and, for a dev container, the desktop loopback forward. These checks do not send prompts or print credentials.

- **Editor Chat (Insiders 1.148):** After `npm ci`, select **Run Native Chat Probe** in Run and Debug and press F5. The development extension uses the proposed [`chat.registerRemoteAgentHost`](https://github.com/microsoft/vscode/blob/0d15d4d60248e35fac1a3fe234d74ed780e15691/src/vscode-dts/vscode.proposed.remoteAgentHost.d.ts) with a WebSocket address and a separate connection token. For a remote workspace it requests a desktop loopback forward. Open the existing session under **Agent Teams Chat Probe**, then run **Agent Teams Probe: Wake Worker**. Compare the ID in the probe output to the acknowledgement in Chat. Close and reopen the session and check the same turn; close the development window to stop the probe and remove the registration.
- **Agents window:** Run `node scripts/probe-ahp.mjs --manual` in a VS Code terminal after building. In the matching build's source, **Add Remote Agent Host…** accepts a WebSocket URL with `?tkn=`. Enable `chat.remoteAgentHostsEnabled` if needed. If the workspace is remote, privately forward the printed port via **Ports** and use the desktop-side port. Open the existing session, press Enter in the terminal, and check for the exact acknowledgement ID in Agents. Stop the probe and remove the host entry afterward. Do not share or commit the token.

If the composer is available, send a uniquely marked prompt *before* triggering the inbox wake, and verify both completed turns on reopen. Do not count the AHP CLI's injected prompt as native input.

The exact build's proposed [`chatSessionsProvider`](https://github.com/microsoft/vscode/blob/0d15d4d60248e35fac1a3fe234d74ed780e15691/src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts) is a second experimental route. A stable resource URI could identify the original Lead, `provideChatSessionContent` could return SDK history on open, and `requestHandler` could submit to Lead. It exposes a stream for an already active response, but no documented way to append a new unsolicited inbox turn to a view that is already open and idle. This was a source check, not a working alternative. Use the [native Chat tools](#talk-to-the-team-from-native-chat) to talk to the team without a native tab per worker.

#### Check native SDK shell approvals

1. In desktop Insiders, run **Run Native Chat Approval Probe** on a POSIX workspace host. Open the existing session under **Agent Teams Chat Probe**. The probe uses a scripted model and a fixed marker command in a disposable workspace. SDK sandboxing is off so Bubblewrap cannot confound the result, but approval stays manual with no extension approval handler.
2. In native Chat's normal confirmation mode, send `PROBE APPROVAL`. In **Output → Agent Teams Chat Probe**, note the new marker name and `permission.requested`. Choose **Allow** or **Allow Once**, not a persistent approval. After the turn completes, run **Agent Teams Probe: Check Approval Marker** from the Command Palette. The marker must contain exactly `"approved\n"` before testing a denial or Stop.
3. Send `PROBE APPROVAL` again for a new marker and choose **Deny**. The turn should finish and the new marker should be absent. Repeat with a fresh marker and dismiss or stop instead; check the marker again after reopening the chat. A pending request with no desktop prompt does not count as a denial.
4. Close the Extension Development Host to clean up. This probe tests manual shell turns only; it does not establish approval inheritance after Restore or during Team inbox wakes, or test Integrated Browser approvals.

#### Restart the native Chat host on Insiders

The [scripted AHP probe](./scripts/probe-ahp.mjs) verifies this without Copilot credits:

```sh
npm run build && node scripts/probe-ahp.mjs --join --catalog-bridge --stop-queued --restart-host
```

For the desktop test, keep the Extension Development Host window running:

1. Launch **Run Live Native Chat Join Probe** (or **Run Native Chat Join Probe** for the scripted model). Open a chat on **Agent Teams Chat Probe**, join as Lead, and send `NATIVE-RESTART-01` as a transcript marker. Wait for the turn to finish.
2. Follow the [Stop test](#retest-stop-with-a-queued-delivery-on-insiders) to start a long turn, queue one delivery, and click native **Stop**. Note the delivery ID in **Output → Agent Teams Chat Probe**. Do **not** run Resume yet.
3. Run **Agent Teams Probe: Restart Host**. Wait for Output to report `Host restarted` and the same ID still unread. The command replaces the Team controller, SDK runtime, and AHP host while keeping the files and desktop registration. Do **not** reload or close the development window: that ends the disposable probe and removes its data.
4. Close the Chat view if it is still open, then reopen the **original** chat from Chat history. Check that `NATIVE-RESTART-01` and the earlier conversation are still visible. Do not create a chat or join again. No inbox turn should have started.
5. Run **Agent Teams Probe: Resume After Stop**. Pass: the original chat shows exactly one wake for the recorded ID, Output reports that exact ID acknowledged, and there is no duplicate chat.

The protocol test confirms the same SDK session and AHP chat resource, restored transcript, exact delivery after explicit Resume, and that the recovered chat accepts a fresh manual prompt. The live GHE.com desktop run also logged that delivery `f39a37ad-afe9-46ff-add7-19a57508ae1c` stayed unread after Stop and host restart, then was acknowledged after explicit Resume. However, the reopened native chat showed as read-only. That leaves native composer recovery unverified even though the SDK accepted input in the scripted run. This is not yet a VSIX feature.

#### Manual editor fallback on VS Code 1.147

Stable VS Code 1.147 does not expose programmatic registration. If you choose to test manually on that build, add the following to a temporary trusted editor workspace while the manual probe is running:

```json
{
  "chat.remoteAgentHostsEnabled": true,
  "chat.workspaceRemoteAgentHosts": [
    {
      "name": "Agent Teams Probe",
      "address": "ws://127.0.0.1:12345",
      "connectionToken": "TEMPORARY_PROBE_TOKEN"
    }
  ]
}
```

Replace `12345` with the desktop-side port and `TEMPORARY_PROBE_TOKEN` with the value of `tkn` in the printed URL. In the editor's **Chat** session list, open the existing probe session rather than starting a new one, then press Enter in the probe terminal and check for the exact acknowledged ID. Remove the entry and stop the probe afterward. Never commit the token.
