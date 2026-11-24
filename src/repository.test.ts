import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RepositoryReader } from './repository';

test('repository reads support uncommitted source but reject private, linked and binary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-repo-'));
  const repo = join(dir, 'repo');
  try {
    await mkdir(repo);
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(repo, 'ignored.txt'), 'ignored');
    await writeFile(join(repo, '.env.local'), 'secret');
    await writeFile(join(repo, 'README.md'), 'First\nSecond\nThird');
    await writeFile(join(repo, 'binary'), Buffer.from([0, 1, 2]));
    await writeFile(join(dir, 'outside.txt'), 'private');
    const reader = new RepositoryReader(repo);
    assert.deepEqual(await reader.list('README', 0), { paths: ['README.md'] });
    assert.deepEqual(await reader.read('README.md', 2, 1), {
      path: 'README.md', startLine: 2, endLine: 2, text: 'Second', nextStartLine: 3,
    });
    for (const path of ['../outside.txt', '.env.local', 'ignored.txt', '.git/config']) {
      await assert.rejects(reader.read(path, 1, 1), /File is not available/);
    }
    await assert.rejects(reader.read('binary', 1, 1), /Only UTF-8/);
    if (process.platform !== 'win32') {
      await symlink(join(dir, 'outside.txt'), join(repo, 'linked.txt'));
      await link(join(dir, 'outside.txt'), join(repo, 'hard.txt'));
      for (const path of ['linked.txt', 'hard.txt']) {
        await assert.rejects(reader.read(path, 1, 1), /non-linked/);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
