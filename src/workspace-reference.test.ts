import { strict as assert } from 'node:assert';
import { link, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkWorkspaceReferenceRange, resolveWorkspaceReference } from './workspace-reference';

test('workspace references resolve to a file and reject escapes and nonfiles', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'agent-teams-reference-'));
  try {
    const root = join(await realpath(tmp), 'workspace');
    const file = join(root, 'src', 'main.ts');
    const sibling = `${root}-sibling`;
    const outside = join(sibling, 'outside.txt');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(sibling);
    await writeFile(file, 'first\nsecond');
    await writeFile(outside, 'outside');
    if (process.platform !== 'win32') {
      await symlink(outside, join(root, 'escape.txt'));
      await symlink(sibling, join(root, 'src', 'linked'), 'dir');
      await link(outside, join(root, 'hardlink.txt'));
    }
    assert.deepEqual(await resolveWorkspaceReference(root, 'src/main.ts:2:3'), { file, line: 1, column: 2 });
    assert.deepEqual(await resolveWorkspaceReference(root, './src/main.ts:1'), { file, line: 0, column: 0 });
    for (const reference of ['../outside.txt:1', 'src/../main.ts:1', '/outside.txt:1', 'C:\\outside.txt:1',
      'file:///outside.txt:1', 'https://host/file.ts:1', 'src:1', 'src/main.ts:0', 'src/main.ts:1:0',
      'src/main.ts:9007199254740992', 'src/missing.ts:1', 'src/main.ts:1\n',
      ...(process.platform !== 'win32' ? ['escape.txt:1', 'src/linked/outside.txt:1', 'hardlink.txt:1'] : [])]) {
      await assert.rejects(resolveWorkspaceReference(root, reference), reference);
    }
    await mkdir(join(root, 'src', 'not-file.ts'));
    await assert.rejects(resolveWorkspaceReference(root, 'src/not-file.ts:1'));
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('validate references against the open document, including the end-of-line caret', () => {
  const lines = ['first', 'second'];
  const document = { lineCount: lines.length, lineAt: (line: number) => ({ text: lines[line] }) };
  checkWorkspaceReferenceRange(document, 1, 2);
  checkWorkspaceReferenceRange(document, 1, 6);
  assert.throws(() => checkWorkspaceReferenceRange(document, 2, 0), /beyond/);
  assert.throws(() => checkWorkspaceReferenceRange(document, 1, 7), /beyond/);
});
