// @ts-check
/** @typedef {{ name: string, address: string, connectionToken: string }} RemoteAgentHost */
/** @typedef {{ localAddress: string | { host: string, port: number }, dispose(): void | Thenable<void> }} Tunnel */
/** @typedef {{ registerRemoteAgentHost?(host: RemoteAgentHost): import('vscode').Disposable }} ProposedChat */
/** @typedef {{ openTunnel?(options: { remoteAddress: { host: string, port: number }, label: string }): Thenable<Tunnel> }} ProposedWorkspace */
const name = 'Agent Teams Chat Probe';
/** @type {Awaited<ReturnType<typeof import('../../scripts/ahp-probe-fixture.mjs').startProbe>> | undefined} */
let probe;
/** @type {Awaited<ReturnType<typeof import('../../dist/ahp-model-bridge.mjs').startModelBridge>> | undefined} */
let modelBridge;
/** @type {Tunnel | undefined} */
let tunnel;
/** @type {import('vscode').Disposable | undefined} */
let registration;

/** @param {Tunnel['localAddress']} localAddress */
function desktopAddress(localAddress) {
  const value = typeof localAddress === 'string' ? localAddress
    : `${localAddress.host === '::1' ? '[::1]' : localAddress.host}:${localAddress.port}`;
  const url = new URL(value.includes('://') ? value : `ws://${value}`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !['http:', 'ws:'].includes(url.protocol)) {
    throw new Error('VS Code did not provide a desktop loopback forward. The probe was not registered.');
  }
  return `ws://${url.host}`;
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {typeof import('vscode')} vscode
 * @param {boolean} joinable
 * @param {boolean} live
 */
async function activate(context, vscode = require('vscode'), joinable = process.env.AGENT_TEAMS_PROBE_JOIN === '1',
  live = process.env.AGENT_TEAMS_PROBE_LIVE === '1') {
  const output = vscode.window.createOutputChannel(name);
  const approval = process.env.AGENT_TEAMS_PROBE_APPROVAL === '1';
  context.subscriptions.push(output);
  /** @param {unknown} error */
  const report = error => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    void vscode.window.showErrorMessage(`${name}: ${message}`);
  };
  try {
    /** @type {typeof vscode.chat & ProposedChat} */
    const chat = vscode.chat;
    /** @type {typeof vscode.workspace & ProposedWorkspace} */
    const workspace = vscode.workspace;
    if (!chat.registerRemoteAgentHost) throw new Error('Use current VS Code Insiders and the "Run Native Chat Probe" launch.');
    if (!workspace.isTrusted || vscode.env.uiKind !== vscode.UIKind.Desktop) {
      throw new Error('Run the probe in a trusted desktop VS Code workspace.');
    }
    if (!workspace.getConfiguration('chat').get('remoteAgentHostsEnabled', true)) {
      throw new Error('Remote agent connections are disabled in VS Code. No settings were changed.');
    }
    if (vscode.env.remoteName && workspace.getConfiguration('remote').get('localPortHost', 'localhost') !== 'localhost') {
      throw new Error('VS Code is configured to forward ports on all interfaces. The probe requires desktop loopback.');
    }
    const { fixtureModel, startProbe } = await import('../../scripts/ahp-probe-fixture.mjs');
    let authorization;
    if (live) {
      const consent = await vscode.window.showInformationMessage(
        'Use your configured Copilot account for this disposable chat probe? Test prompts will use Copilot credits.',
        { modal: true }, 'Start Live Probe',
      );
      if (consent !== 'Start Live Probe') return;
      const { editorGitHubAuthorization } = require('../../dist/editor-auth.js');
      authorization = { ...editorGitHubAuthorization(vscode), requireEditorSession: true };
    }
    probe = await startProbe({
      joinable,
      approval,
      log: message => output.appendLine(message),
      authorization,
      approveJoin: async role => role.id === 'lead' && await vscode.window.showInformationMessage(
        'Allow this disposable Copilot chat to join Agent Teams as Lead and receive automatic inbox turns?',
        { modal: true }, 'Join as Lead',
      ) === 'Join as Lead',
    });
    if (joinable || approval) {
      const { inspectAgentCatalog } = await import('../../scripts/ahp-probe-catalog.mjs');
      const catalog = await inspectAgentCatalog(probe.url, probe.token);
      const agents = catalog.map(({ provider, models }) => `${provider} (${models} ${models === 1 ? 'model' : 'models'})`);
      output.appendLine(`Local AHP catalog (${live ? 'live' : 'scripted'}): ${agents.join(', ') || 'no agents'}.`);
      const copilot = catalog.find(agent => agent.provider === 'copilot');
      if (!copilot) throw new Error('The local SDK host did not advertise a Copilot provider.');
      if (!copilot.models) {
        const models = live
          ? await probe.sdkModels().catch(() => { throw new Error('Could not list models from the signed-in SDK.'); })
          : [fixtureModel];
        if (live) output.appendLine(`Signed-in SDK listModels(): ${models.length} model(s).`);
        if (!models.length) throw new Error('The signed-in SDK did not return any model to advertise.');
        const { startModelBridge } = await import('../../dist/ahp-model-bridge.mjs');
        modelBridge = await startModelBridge(probe, models);
        const bridged = await inspectAgentCatalog(modelBridge.url, modelBridge.token);
        const count = bridged.find(agent => agent.provider === 'copilot')?.models ?? 0;
        if (!count) throw new Error('The bridge did not advertise any composer models.');
        output.appendLine(`Bridged AHP catalog: copilot (${count} model(s)).`);
      }
    }
    const connection = modelBridge ?? probe;
    let address = connection.url.origin;
    if (vscode.env.remoteName) {
      if (!workspace.openTunnel) throw new Error('The VS Code port forwarding proposal is unavailable.');
      try {
        tunnel = await workspace.openTunnel({
          remoteAddress: { host: '127.0.0.1', port: Number(connection.url.port) },
          label: name,
        });
      } catch {
        throw new Error('VS Code could not forward the disposable host to the desktop.');
      }
      address = desktopAddress(tunnel.localAddress);
    }
    try {
      registration = chat.registerRemoteAgentHost({ name, address, connectionToken: connection.token });
    } catch {
      throw new Error('VS Code could not register the disposable host. Use current Insiders and the "Run Native Chat Probe" launch.');
    }
    if (joinable) {
      output.appendLine(`Select ${name} as the host for a new Chat, then send "Join the team as Lead". No role is assigned until you approve it.`);
      output.appendLine(`If asked for a working directory, select the disposable workspace: ${probe.workspace}`);
    } else if (approval) {
      output.appendLine(`Open the existing session ${probe.published?.sessionId}, then send PROBE APPROVAL. Shell sandboxing is off for this scripted fixture; manual approval is still required.`);
      context.subscriptions.push(vscode.commands.registerCommand('agentTeamsChatProbe.approvalStatus', async () => {
        try {
          if (!probe) throw new Error('The approval probe is not running.');
          output.appendLine(await probe.approvalStatus());
          output.show(true);
        } catch (error) { report(error); }
      }));
      return;
    } else {
      output.appendLine(`Registered disposable Lead ${probe.published?.sessionId}. Open its existing session in the editor Chat view.`);
    }
    let waking = false;
    /** @type {string | undefined} */
    let stopDeliveryId;
    context.subscriptions.push(vscode.commands.registerCommand('agentTeamsChatProbe.wake', async () => {
      if (!probe || waking) return;
      if (stopDeliveryId) return report(new Error('Finish the queued Stop test before starting another wake.'));
      waking = true;
      try {
        const id = await probe.wake();
        output.appendLine(`Lead acknowledged Team inbox ID ${id}.`);
        return id;
      } catch (error) { report(error); }
      finally { waking = false; }
    }));
    context.subscriptions.push(
      vscode.commands.registerCommand('agentTeamsChatProbe.queueStopDelivery', () => {
        try {
          if (!joinable || !probe) throw new Error('Use the native Chat Join Probe launch.');
          if (waking || stopDeliveryId) throw new Error('Finish the current probe delivery before queueing another one.');
          stopDeliveryId = probe.queueWhileBusy();
          output.appendLine(`Queued ${stopDeliveryId} while Lead was busy. Click Stop in the native Chat now.`);
          return stopDeliveryId;
        } catch (error) { report(error); }
      }),
      vscode.commands.registerCommand('agentTeamsChatProbe.restartHost', async () => {
        try {
          if (!probe || !stopDeliveryId) throw new Error('Queue a delivery and click native Chat Stop before restarting.');
          if (waking) throw new Error('Wait for the running probe command to finish.');
          const id = stopDeliveryId;
          waking = true;
          try {
            await probe.restart(id);
            output.appendLine(`Host restarted. Lead is paused with ${id} unread. Reopen the original Chat from history before resuming.`);
            return id;
          } finally { waking = false; }
        } catch (error) { report(error); }
      }),
      vscode.commands.registerCommand('agentTeamsChatProbe.resumeStopDelivery', async () => {
        try {
          if (!probe || !stopDeliveryId) throw new Error('Queue a delivery and click native Chat Stop first.');
          if (waking) throw new Error('A wake is already in progress.');
          const id = stopDeliveryId;
          waking = true;
          try {
            await probe.resumeQueued(id);
            output.appendLine(`Lead stayed paused with ${id} unread after Stop and acknowledged it after Resume.`);
            stopDeliveryId = undefined;
            return id;
          } finally { waking = false; }
        } catch (error) { report(error); }
      }),
    );
  } catch (error) {
    report(error);
    try { await deactivate(); }
    catch { report(new Error('Could not fully clean up the disposable probe. Close the Extension Development Host.')); }
  }
}

async function deactivate() {
  const current = probe;
  const registered = registration;
  const forward = tunnel;
  const bridge = modelBridge;
  probe = undefined;
  registration = undefined;
  tunnel = undefined;
  modelBridge = undefined;
  try {
    registered?.dispose();
  } finally {
    try { await forward?.dispose(); }
    finally {
      try { await bridge?.dispose(); }
      finally { await current?.dispose(); }
    }
  }
}

module.exports = { activate, deactivate };
