import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProbe } from './probe.js';

const dir = await mkdtemp(join(tmpdir(), 'agent-teams-idle-wake-'));
try {
  await runProbe(dir, Number(process.argv[2] ?? 10));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  // Keep the trace and the runtime logs together once a delivery has been recorded.
  if (!statSync(join(dir, 'trace.jsonl'), { throwIfNoEntry: false })) {
    await rm(dir, { recursive: true, force: true });
  }
}
