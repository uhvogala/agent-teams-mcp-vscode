import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { authorizeGitHub, resolveGitHubTarget, SignInCancelled } from './auth';

test('follows Copilot Chat onto GHE.com unless explicitly overridden', () => {
  const uri = 'https://work.ghe.com';
  assert.deepEqual(resolveGitHubTarget('auto', 'github-enterprise', uri), { provider: 'github-enterprise', host: 'work.ghe.com' });
  assert.deepEqual(resolveGitHubTarget('github', 'github-enterprise', uri), { provider: 'github', host: 'github.com' });
  assert.deepEqual(resolveGitHubTarget('github-enterprise', 'github', '', [uri]), { provider: 'github-enterprise', host: 'work.ghe.com' });
});

test('Enterprise configuration fails closed for ambiguous or non-GHE.com hosts', () => {
  const uris = ['https://work.ghe.com', 'https://other.ghe.com'];
  assert.throws(() => resolveGitHubTarget('auto', 'github-enterprise', '', uris), /Configure one GHE.com instance/);
  assert.equal(resolveGitHubTarget('auto', 'github-enterprise', uris[0], uris).host, 'work.ghe.com');
  assert.throws(() => resolveGitHubTarget('auto', 'github-enterprise', 'https://work.ghe.com.example.org'), /requires an HTTPS/);
});

test('an Enterprise credential from a different or unverified issuer never leaves the auth helper', async () => {
  const target = { provider: 'github-enterprise', host: 'work.ghe.com' } as const;
  const signal = new AbortController().signal;
  for (const issuer of ['https://other.ghe.com/login/oauth', undefined]) {
    const getSession = async () => ({ accessToken: 'do-not-forward', issuer });
    await assert.rejects(authorizeGitHub(getSession, signal, target), /No credential was sent to the Copilot runtime/);
  }
  const getSession = async (interactive: boolean) => interactive
    ? { accessToken: 'approved', issuer: 'https://work.ghe.com/login/oauth', accountLabel: 'octocat' }
    : { accessToken: 'wrong', issuer: 'https://other.ghe.com/login/oauth', accountLabel: 'other-user' };
  const session = await authorizeGitHub(getSession, signal, target);
  assert.equal(session.accessToken, 'approved');
  assert.equal(session.accountLabel, 'octocat');
});

test('uses an authorized GitHub session without prompting', async () => {
  const session = await authorizeGitHub(async interactive => {
    assert.equal(interactive, false);
    return { accessToken: 'existing' };
  }, new AbortController().signal);
  assert.equal(session.accessToken, 'existing');
});

test('requests access if needed and reports cancellation without leaking provider details', async () => {
  const signal = new AbortController().signal;
  assert.equal((await authorizeGitHub(async interactive => interactive ? { accessToken: 'new' } : undefined, signal)).accessToken, 'new');
  await assert.rejects(authorizeGitHub(async interactive => {
    if (interactive) throw new Error('Cancelled');
    return undefined;
  }, signal), SignInCancelled);
  await assert.rejects(authorizeGitHub(async () => { throw new Error('token-shaped provider data'); }, signal), {
    message: 'VS Code could not authorize GitHub for Agent Teams. Check the GitHub account in VS Code Accounts, then try again.',
  });
});

test('closing the workspace does not wait for the account picker', async () => {
  const controller = new AbortController();
  let resolvePrompt!: (session: { accessToken: string }) => void;
  const prompt = new Promise<{ accessToken: string }>(resolve => { resolvePrompt = resolve; });
  const pending = authorizeGitHub(async interactive => {
    if (!interactive) return undefined;
    controller.abort();
    return prompt;
  }, controller.signal);
  await assert.rejects(pending, SignInCancelled);
  resolvePrompt({ accessToken: 'too-late' });
});
