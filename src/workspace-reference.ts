import { realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export function parseWorkspaceReference(text: string) {
  const match = /^(?:\.\/)?([a-z0-9._@+-]+(?:\/[a-z0-9._@+-]+)*):([1-9]\d*)(?::([1-9]\d*))?$/i.exec(text);
  if (!match || match[0] !== text || text.length > 512) return;
  const [, path, lineText, columnText] = match;
  if (!/[/.]/.test(path) || path.split('/').some(part => part === '.' || part.endsWith('.') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return;
  const line = Number(lineText);
  const column = columnText === undefined ? 1 : Number(columnText);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) return;
  return { path, line, column };
}

export async function resolveWorkspaceReference(workspace: string, text: string) {
  const reference = parseWorkspaceReference(text);
  if (!reference) throw new Error('Use a workspace-relative path with a positive line and optional column.');
  const root = await realpath(workspace);
  const candidate = resolve(root, reference.path);
  const target = await realpath(candidate);
  const fromRoot = relative(root, target);
  const unavailable = () => new Error('The reference must point to a regular, non-linked file in this workspace.');
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || target !== candidate) {
    throw unavailable();
  }
  const info = await stat(target);
  if (!info.isFile() || info.nlink !== 1) {
    throw unavailable();
  }
  return { file: target, line: reference.line - 1, column: reference.column - 1 };
}

export function checkWorkspaceReferenceRange(
  document: { lineCount: number; lineAt(line: number): { text: string } }, line: number, column: number,
) {
  if (line >= document.lineCount || column > document.lineAt(line).text.length) {
    throw new Error('The referenced line or column is beyond the end of the document or line.');
  }
}
