import type * as vscode from 'vscode';
import { startModelBridge } from './ahp-model-bridge.mjs';
import type { Team } from './team';

type Registration = { name: string; address: string; connectionToken: string };
type Tunnel = { localAddress: string | { host: string; port: number }; dispose(): void | Thenable<void> };
const launchFlag = '--enable-proposed-api=uhvogala.agent-teams-mcp-vscode';

function isMissingProposal(error: unknown, proposal: 'tunnels' | 'remoteAgentHost') {
  return error instanceof Error && error.message.includes(`CANNOT use API proposal: ${proposal}.`);
}

function proposalError(proposal: 'tunnels' | 'remoteAgentHost') {
  return new Error(`VS Code did not enable the ${proposal} proposal for Agent Teams. Fully quit desktop Insiders and relaunch with code-insiders ${launchFlag}, or use Run Agent Teams with Native Chat from Run and Debug.`);
}

function desktopAddress(localAddress: Tunnel['localAddress']) {
  const value = typeof localAddress === 'string' ? localAddress
    : `${localAddress.host === '::1' ? '[::1]' : localAddress.host}:${localAddress.port}`;
  const url = new URL(value.includes('://') ? value : `ws://${value}`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !['http:', 'ws:'].includes(url.protocol)) {
    throw new Error('VS Code did not provide a desktop loopback forward.');
  }
  return `ws://${url.host}`;
}

export async function connectNativeChat(team: Team, editor: typeof vscode, savedAddress?: string) {
  const chat: typeof vscode.chat & { registerRemoteAgentHost?(host: Registration): vscode.Disposable } = editor.chat;
  const workspace: typeof vscode.workspace & {
    openTunnel?(options: { remoteAddress: { host: string; port: number }; localAddressPort?: number; label: string }): Thenable<Tunnel>;
  } = editor.workspace;
  if (editor.env.uiKind !== editor.UIKind.Desktop) throw new Error('Native Chat requires desktop VS Code Insiders.');
  if (!chat.registerRemoteAgentHost) throw proposalError('remoteAgentHost');
  if (!workspace.getConfiguration('chat').get('remoteAgentHostsEnabled', true)) {
    throw new Error('Remote agent connections are disabled in VS Code.');
  }
  if (editor.env.remoteName && (!workspace.openTunnel ||
      workspace.getConfiguration('remote').get('localPortHost', 'localhost') !== 'localhost')) {
    throw new Error('Native Chat requires desktop loopback port forwarding for this remote workspace.');
  }

  const host = await team.openNativeHost();
  if (!host.models.length) throw new Error('The signed-in SDK returned no models for native Chat.');
  const savedPort = savedAddress ? Number(new URL(savedAddress).port) : undefined;
  const bridge = await startModelBridge(host, host.models, editor.env.remoteName ? undefined : savedPort).catch(error => {
    if (savedPort && error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
      throw new Error(`The saved Agent Teams Chat port (${savedPort}) is in use. Free that port and try again to reopen the same chats.`);
    }
    throw error;
  });
  let tunnel: Tunnel | undefined;
  let registration: vscode.Disposable | undefined;
  const dispose = async () => {
    try { registration?.dispose(); }
    finally {
      try { await tunnel?.dispose(); }
      finally { await bridge.dispose(); }
    }
  };
  try {
    if (editor.env.remoteName) {
      try {
        tunnel = await workspace.openTunnel?.({
          remoteAddress: { host: '127.0.0.1', port: Number(bridge.url.port) }, localAddressPort: savedPort, label: 'Agent Teams',
        });
      } catch (error) {
        if (isMissingProposal(error, 'tunnels')) throw proposalError('tunnels');
        throw new Error('VS Code could not open a desktop loopback port forward for Agent Teams. Check the remote connection and Ports view.');
      }
      if (!tunnel) throw new Error('VS Code did not return a desktop loopback port forward for Agent Teams.');
    }
    const address = tunnel ? desktopAddress(tunnel.localAddress) : bridge.url.origin;
    if (savedAddress && address !== savedAddress) {
      throw new Error(`VS Code could not restore the saved Agent Teams Chat address (${savedAddress}). Check the Ports view and try again; a different address would open a separate Chat history.`);
    }
    try {
      registration = chat.registerRemoteAgentHost({ name: 'Agent Teams', address, connectionToken: bridge.token });
    } catch (error) {
      if (isMissingProposal(error, 'remoteAgentHost')) throw proposalError('remoteAgentHost');
      throw new Error('VS Code rejected the Agent Teams remote host registration after the loopback address was validated.');
    }
    return { address, dispose };
  } catch (error) {
    try { await dispose(); }
    catch { throw new AggregateError([error], `${error instanceof Error ? error.message : 'Native Chat connection failed.'} Cleanup also failed; reload the window.`); }
    throw error;
  }
}
