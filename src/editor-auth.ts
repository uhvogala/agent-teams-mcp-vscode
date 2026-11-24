import type * as vscode from 'vscode';
import { authorizeGitHub, matchesGitHubSession, resolveGitHubTarget, type GitHubTarget } from './auth';
import type { GitHubAuthorization } from './team';

export function editorGitHubAuthorization(editor: typeof vscode): GitHubAuthorization & { readAccountLabel(): Promise<string | undefined> } {
  const target = () => {
    const settings = editor.workspace.getConfiguration();
    const uris = settings.inspect<string[]>('github-enterprise.uris');
    const usesPluralSetting = uris?.globalValue !== undefined || uris?.workspaceValue !== undefined;
    return resolveGitHubTarget(
      settings.get('agentTeams.authProvider', 'auto'),
      settings.get('github.copilot.advanced.authProvider', 'github'),
      settings.get('github-enterprise.uri', ''),
      usesPluralSetting ? settings.get<string[]>('github-enterprise.uris') : undefined,
    );
  };
  const getSession = async (target: GitHubTarget, interactive: boolean) => {
    const session = await editor.authentication.getSession(target.provider, ['user:email'], interactive
      ? {
        createIfNone: { detail: `Agent Teams uses the ${target.host} account with the Copilot runtime on this workspace host.` },
        clearSessionPreference: target.provider === 'github-enterprise',
      }
      : { silent: true });
    if (!session) return;
    const issuer = 'authorizationServer' in session && session.authorizationServer instanceof editor.Uri
      ? session.authorizationServer.toString() : undefined;
    return { accessToken: session.accessToken, issuer, accountLabel: session.account.label };
  };
  return {
    target,
    session: (target, signal) => authorizeGitHub(interactive => getSession(target, interactive), signal, target),
    async readAccountLabel() {
      const selected = target();
      const session = await getSession(selected, false);
      return session && matchesGitHubSession(session, selected) ? session.accountLabel?.trim() || undefined : undefined;
    },
  };
}
