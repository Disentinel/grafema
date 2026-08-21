// rfdb-server.ts — spawn/teardown of one rfdb-server per harness run.
// One long-lived server on one empty tmp DB serves the whole run: executeDatalog
// with ground facts in the program text is a stateless read (REG-1196 FactStats),
// so no per-seed database dance is needed (live-proven, no createDatabase either).

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ServerHandle {
  socketPath: string;
  binaryPath: string;
  proc: ChildProcess;
  stop: () => void;
}

export const DEFAULT_BINARY = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../rfdb-server/target/debug/rfdb-server',
);

export async function startServer(binaryPath: string = DEFAULT_BINARY): Promise<ServerHandle> {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`rfdb-server binary not found: ${binaryPath} (build: cd packages/rfdb-server && cargo build)`);
  }
  const dir = fs.mkdtempSync(`/tmp/rofl-conf-${process.pid}-`);
  const dbPath = path.join(dir, 'db');
  const socketPath = path.join(dir, 'rfdb.sock');
  fs.mkdirSync(dbPath, { recursive: true });
  // stdio all 'ignore': keeps the event loop clean (project test-infra precedent).
  const proc = spawn(binaryPath, [dbPath, '--socket', socketPath], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(socketPath)) {
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`rfdb-server did not create ${socketPath} within 15s`);
    }
    if (proc.exitCode !== null) {
      throw new Error(`rfdb-server exited early with code ${proc.exitCode}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const stop = (): void => {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort tmp cleanup */ }
  };
  return { socketPath, binaryPath, proc, stop };
}
