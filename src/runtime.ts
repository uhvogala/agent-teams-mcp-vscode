import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeConnection } from '@microsoft/copilot-sdk';

export function teamRuntime(baseDirectory: string, authHost?: string) {
  if (process.platform !== 'linux' && !authHost) return RuntimeConnection.forInProcess({ baseDirectory });

  // VS Code can omit glibc metadata from Node's process report. Use the
  // runtime selected and verified when the Linux package was built instead.
  const platforms = process.platform === 'linux' ? ['linux', 'linuxmusl'] : [process.platform];
  const executable = process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime';
  const paths = platforms.map(platform => {
    const target = `${platform}-${process.arch}`;
    return join(__dirname, '..', 'node_modules', '@microsoft', `copilot-sdk-${target}`, 'prebuilds', target, executable);
  }).filter(path => existsSync(path));
  if (paths.length !== 1) {
    throw new Error('Agent Teams needs exactly one bundled Copilot runtime. Reinstall for the workspace host’s platform and architecture.');
  }
  let env: NodeJS.ProcessEnv | undefined;
  if (authHost) {
    // Keep host selection local to the child, and don't inherit alternate API
    // endpoints or other credentials when using an explicit VS Code token.
    const overrides = /^(GH_HOST|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB(_ENTERPRISE)?_TOKEN|GITHUB_COPILOT_API_TOKEN|COPILOT_(GH_HOST|GITHUB_TOKEN|SDK_AUTH_TOKEN|API_URL|DEBUG_.*URL|PROVIDER_.*))$/i;
    env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !overrides.test(key)));
    env.GH_HOST = authHost;
  }
  return RuntimeConnection.forSpawnedStdio({ path: paths[0], baseDirectory, env });
}
