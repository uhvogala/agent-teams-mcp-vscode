export type GitHubSession = { accessToken: string; issuer?: string; accountLabel?: string };
type GetSession = (interactive: boolean) => PromiseLike<GitHubSession | undefined>;

export type GitHubTarget = { provider: 'github' | 'github-enterprise'; host: string };

export function resolveGitHubTarget(preference: string, chatProvider: string, legacyUri: string, enterpriseUris?: string[]): GitHubTarget {
  const provider = preference === 'auto' ? chatProvider : preference;
  if (provider === 'github') return { provider, host: 'github.com' };
  if (provider !== 'github-enterprise') {
    throw new Error('Agent Teams cannot use the configured Copilot sign-in provider. Choose GitHub.com or GitHub Enterprise in Agent Teams: Auth Provider.');
  }
  const choices = [...new Set((enterpriseUris ?? (legacyUri ? [legacyUri] : [])).map(enterpriseHost))];
  const preferred = legacyUri && choices.length > 1 ? enterpriseHost(legacyUri) : undefined;
  const host = choices.length === 1 ? choices[0] : preferred && choices.includes(preferred) ? preferred : undefined;
  if (!host) {
    throw new Error('Configure one GHE.com instance under GitHub Enterprise: URIs, or set GitHub Enterprise: URI to select one of the configured instances.');
  }
  return { provider, host };
}

function enterpriseHost(uri: string) {
  let url: URL | undefined;
  try { url = new URL(uri); } catch { /* Report a safe configuration error below. */ }
  if (!url || url.protocol !== 'https:' || !/^[a-z0-9][a-z0-9-]*\.ghe\.com$/.test(url.hostname)
    || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Agent Teams requires an HTTPS GitHub Enterprise Cloud instance URL, such as https://example.ghe.com.');
  }
  return url.hostname;
}

export function matchesGitHubHost(value: string | undefined, expected: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === expected || url.hostname === `api.${expected}`);
  } catch { return false; }
}

export class SignInCancelled extends Error {
  constructor() { super('Copilot sign-in was cancelled. No worker was started.'); }
}

export function matchesGitHubSession(session: GitHubSession, target: GitHubTarget) {
  return (!session.issuer && target.provider === 'github') || matchesGitHubHost(session.issuer, target.host);
}

export async function authorizeGitHub(
  getSession: GetSession, signal: AbortSignal, target: GitHubTarget = { provider: 'github', host: 'github.com' },
): Promise<GitHubSession> {
  if (signal.aborted) throw new SignInCancelled();
  const authorize = async () => {
    let session: GitHubSession | undefined;
    try {
      session = await getSession(false);
      if ((!session || !matchesGitHubSession(session, target)) && !signal.aborted) session = await getSession(true);
    } catch (error) {
      if (error === 'Cancelled' || (error instanceof Error && (error.name === 'Canceled' || error.message === 'Cancelled'))) {
        throw new SignInCancelled();
      }
      // Do not surface provider errors that might contain OAuth details.
      throw new Error('VS Code could not authorize GitHub for Agent Teams. Check the GitHub account in VS Code Accounts, then try again.');
    }
    if (!session) throw new SignInCancelled();
    if (!matchesGitHubSession(session, target)) {
      throw new Error(`VS Code did not confirm the selected account belongs to ${target.host}. No credential was sent to the Copilot runtime.`);
    }
    return session;
  };
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new SignInCancelled());
    signal.addEventListener('abort', cancel, { once: true });
    void authorize().then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
