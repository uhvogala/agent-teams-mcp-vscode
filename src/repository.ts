import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const git = promisify(execFile);
const maxBytes = 256 * 1024;
const pageSize = 100;
const maxOutput = 12000;

const allowedPath = (path: string) => path.split('/').every(part =>
  part && part !== '.' && part !== '..' && !/[\\:\u0000-\u001f]/.test(part) &&
  !/^(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.ssh|\.aws|\.azure|\.gnupg|\.docker|secrets?|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(part) &&
  !/\.(?:pem|key|pfx|p12|jks|keystore|kdbx)$/i.test(part));

export class RepositoryReader {
  constructor(private readonly workspace: string) {}

  private async files() {
    let stdout: string;
    try {
      ({ stdout } = await git('git', ['-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        cwd: this.workspace, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      }));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error('Git is required on the workspace host to read repository files.');
      }
      throw new Error('Could not list repository files. Verify the workspace is a Git checkout and its file list fits within the tool limit.');
    }
    return [...new Set(stdout.split('\0').filter(allowedPath))].sort();
  }

  async list(prefix: string, offset: number) {
    if (prefix && !allowedPath(prefix.replace(/\/$/, ''))) throw new Error('Use a repository-relative path prefix.');
    const files = (await this.files()).filter(path => path.startsWith(prefix));
    const paths = files.slice(offset, offset + pageSize);
    return { paths, ...(offset + paths.length < files.length ? { nextOffset: offset + paths.length } : {}) };
  }

  async read(path: string, startLine: number, lineCount: number) {
    if (!allowedPath(path) || !(await this.files()).includes(path)) {
      throw new Error('File is not available. Choose a repository-relative path from list_repository_files.');
    }
    const root = await realpath(this.workspace);
    const candidate = resolve(root, path);
    const unavailable = () => new Error('Only regular, non-linked repository files are readable.');
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (!candidate.startsWith(prefix) || await realpath(candidate) !== candidate) throw unavailable();
    const before = await lstat(candidate);
    if (!before.isFile() || before.nlink !== 1) throw unavailable();
    const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let content: Buffer;
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.nlink !== 1 || current.ino !== before.ino || current.dev !== before.dev ||
          await realpath(candidate) !== candidate) throw unavailable();
      if (current.size > maxBytes) throw new Error('File exceeds the 256 KiB read limit.');
      content = Buffer.alloc(maxBytes + 1);
      let total = 0;
      while (total < content.length) {
        const { bytesRead } = await handle.read(content, total, content.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > maxBytes) throw new Error('File exceeds the 256 KiB read limit.');
      content = content.subarray(0, total);
    } finally { await handle.close(); }
    const notText = () => new Error('Only UTF-8 text files are readable.');
    if (content.includes(0)) throw notText();
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch (error) { if (error instanceof TypeError) throw notText(); throw error; }
    const lines = text.split(/\r?\n/);
    if (startLine > lines.length) throw new Error(`Start line is beyond the end of the file (${lines.length} lines).`);
    const output: string[] = [];
    let size = 0;
    let truncatedLine = false;
    for (const line of lines.slice(startLine - 1, startLine - 1 + lineCount)) {
      if (size + line.length + 1 > maxOutput && output.length) break;
      output.push(line.slice(0, maxOutput));
      size += line.length + 1;
      truncatedLine ||= line.length > maxOutput;
    }
    const nextStartLine = startLine + output.length;
    return { path, startLine, endLine: nextStartLine - 1, text: output.join('\n'),
      ...(nextStartLine <= lines.length ? { nextStartLine } : {}), ...(truncatedLine ? { truncatedLine } : {}) };
  }
}
