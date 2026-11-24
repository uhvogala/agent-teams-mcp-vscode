import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = new URL('../', import.meta.url);
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (!/^(darwin|linux|win32)-(arm64|x64)$/.test(target)) {
  throw new Error('Expected darwin, linux, or win32 with arm64 or x64.');
}
const [os, cpu] = target.split('-');
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const output = resolve(process.argv[3] ?? `${pkg.name}-${pkg.version}-${target}.vsix`);
const stage = await mkdtemp(join(tmpdir(), 'agent-teams-vsix-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  await Promise.all(['dist', 'media', 'schemas', 'README.md', '.vscodeignore', 'package-lock.json'].map(file =>
    cp(new URL(file, root), join(stage, file), { recursive: true })));
  delete pkg.scripts['vscode:prepublish'];
  await writeFile(join(stage, 'package.json'), JSON.stringify(pkg));
  execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${os}`, `--cpu=${cpu}`],
    { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' });
  for (const native of [`@microsoft/copilot-sdk-${target}`, `@koromix/koffi-${target}`]) {
    await stat(join(stage, 'node_modules', native, 'package.json'));
  }
  const vsce = new URL('node_modules/@vscode/vsce/vsce', root);
  execFileSync(process.execPath, [vsce.pathname, 'package', '--target', target, '--out', output, '--skip-license'], {
    cwd: stage, stdio: 'inherit',
  });
} finally {
  await rm(stage, { recursive: true, force: true });
}
