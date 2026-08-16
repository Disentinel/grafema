/**
 * `grafema start` — unified command to bring up the entire Grafema stack.
 *
 * Starts RFDB server (with HTTP) and prints connection info.
 * Foreground by default; `--background` detaches.
 *
 * `grafema stop` — graceful shutdown of everything.
 */

import { Command } from 'commander';
import { resolve, join, dirname } from 'path';
import { existsSync, mkdirSync, unlinkSync, readFileSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import { RFDBClient, findRfdbBinary, loadConfig, startRfdbServer, rfdbPidPath } from '@grafema/util';
import { exitWithError } from '../utils/errorFormatter.js';

interface StartOptions {
  project: string;
  binary?: string;
  background?: boolean;
  httpPort?: string;
}

function getProjectPaths(projectPath: string) {
  const grafemaDir = join(projectPath, '.grafema');
  const socketPath = join(grafemaDir, 'rfdb.sock');
  const dbPath = join(grafemaDir, 'graph.rfdb');
  // Derived from the socket so the CLI and the backend agree (REG-1199).
  const pidPath = rfdbPidPath(socketPath);
  const httpPortFile = join(grafemaDir, 'rfdb-http.port');
  const logFile = join(grafemaDir, 'rfdb.log');
  return { grafemaDir, socketPath, dbPath, pidPath, httpPortFile, logFile };
}

function resolveBinaryPath(projectPath: string, explicitBinary?: string): string | null {
  if (explicitBinary) {
    return findRfdbBinary({ explicitPath: explicitBinary });
  }
  try {
    const config = loadConfig(projectPath);
    const serverConfig = (config as unknown as { server?: { binaryPath?: string } }).server;
    if (serverConfig?.binaryPath) {
      return findRfdbBinary({ explicitPath: serverConfig.binaryPath });
    }
  } catch { /* continue */ }
  return findRfdbBinary();
}

async function isServerRunning(socketPath: string): Promise<{ running: boolean; version?: string }> {
  if (!existsSync(socketPath)) return { running: false };
  const client = new RFDBClient(socketPath, 'cli');
  client.on('error', () => {});
  try {
    await client.connect();
    const version = await client.ping();
    await client.close();
    return { running: true, version: version || undefined };
  } catch {
    return { running: false };
  }
}

async function waitForHttpPort(httpPortFile: string, timeoutMs: number): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(httpPortFile)) {
      try {
        const port = parseInt(readFileSync(httpPortFile, 'utf-8').trim(), 10);
        if (port > 0) return port;
      } catch { /* retry */ }
    }
    await sleep(100);
  }
  return null;
}

function printBanner(socketPath: string, httpPort: number | null, pid: number | null, version: string | null, logFile: string | null) {
  console.log('');
  console.log('  Grafema is running');
  console.log('');
  console.log(`  RFDB socket : ${socketPath}`);
  if (httpPort) {
    console.log(`  HTTP         : http://localhost:${httpPort}`);
    console.log(`  UI           : http://localhost:${httpPort}/ui`);
  }
  if (version) {
    console.log(`  Version      : ${version}`);
  }
  if (pid) {
    console.log(`  PID          : ${pid}`);
  }
  if (logFile) {
    console.log(`  Log          : ${logFile}`);
  }
  console.log('');
}

// ─── grafema start ───────────────────────────────────────────────────────────

export const startCommand = new Command('start')
  .description('Start Grafema (RFDB server + HTTP)')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-b, --binary <path>', 'Path to rfdb-server binary')
  .option('--background', 'Run in background (detached)')
  .option('--http-port <port>', 'HTTP port (0 = auto-assign)', '0')
  .action(async (options: StartOptions) => {
    const projectPath = resolve(options.project);
    const { grafemaDir, socketPath, dbPath, pidPath, httpPortFile, logFile } = getProjectPaths(projectPath);

    if (!existsSync(grafemaDir)) {
      mkdirSync(grafemaDir, { recursive: true });
    }

    // Already running?
    const status = await isServerRunning(socketPath);
    if (status.running) {
      const httpPort = existsSync(httpPortFile)
        ? parseInt(readFileSync(httpPortFile, 'utf-8').trim(), 10) || null
        : null;

      let pid: number | null = null;
      if (existsSync(pidPath)) {
        try { pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10); } catch { /* ignore */ }
      }

      printBanner(socketPath, httpPort, pid, status.version || null, existsSync(logFile) ? logFile : null);
      console.log('  Already running. Use `grafema stop` to shut down.');
      return;
    }

    const binaryPath = resolveBinaryPath(projectPath, options.binary);
    if (!binaryPath) {
      exitWithError('RFDB server binary not found', [
        'Install: npm install @grafema/rfdb',
        'Or build: cargo build --release -p rfdb',
        'Or specify: grafema start --binary /path/to/rfdb-server',
      ]);
    }

    const httpPort = options.httpPort ?? '0';
    const dataDir = dirname(socketPath);

    // ─── Background mode ───────────────────────────────────────────────

    if (options.background) {
      // Remove stale HTTP port lockfile so we don't read a previous port
      if (existsSync(httpPortFile)) {
        try { unlinkSync(httpPortFile); } catch { /* ignore */ }
      }

      const serverProcess = await startRfdbServer({
        dbPath,
        socketPath,
        binaryPath,
        pidPath,
        waitTimeoutMs: 30_000,
        extraArgs: ['--http-port', httpPort],
      });

      if (serverProcess === null) {
        console.log('Server already running (detected via PID file)');
        return;
      }

      const verifyStatus = await isServerRunning(socketPath);
      if (!verifyStatus.running) {
        exitWithError('Server started but not responding', [
          'Check server logs for errors',
        ]);
      }

      const actualHttpPort = await waitForHttpPort(httpPortFile, 15_000);

      printBanner(socketPath, actualHttpPort, serverProcess.pid ?? null, verifyStatus.version || null, logFile);
      return;
    }

    // ─── Foreground mode (default) ─────────────────────────────────────

    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch { /* ignore */ }
    }
    if (existsSync(httpPortFile)) {
      try { unlinkSync(httpPortFile); } catch { /* ignore */ }
    }

    const args = [dbPath, '--socket', socketPath, '--data-dir', dataDir, '--http-port', httpPort];

    const child: ChildProcess = spawn(binaryPath, args, {
      stdio: ['ignore', 'inherit', 'pipe'],
    });

    // Buffer stderr until banner is printed, then forward
    let bannerPrinted = false;
    const stderrLines: string[] = [];

    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line) continue;
        if (bannerPrinted) {
          process.stderr.write(line + '\n');
        } else {
          stderrLines.push(line);
        }
      }
    });

    const shutdown = () => {
      process.stderr.write('\nStopping Grafema...\n');
      child.kill('SIGTERM');
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Wait for socket
    const deadline = Date.now() + 30_000;
    while (!existsSync(socketPath) && Date.now() < deadline) {
      await sleep(100);
      if (child.exitCode !== null) {
        for (const line of stderrLines) process.stderr.write(line + '\n');
        exitWithError('Server exited before becoming ready', [
          'Check the error output above',
        ]);
      }
    }

    if (!existsSync(socketPath)) {
      child.kill('SIGTERM');
      exitWithError('Server failed to start within 30 seconds');
    }

    // Wait for HTTP port lockfile (warmup may take a while for large graphs)
    const actualHttpPort = await waitForHttpPort(httpPortFile, 30_000);

    const version = await (async () => {
      try {
        const s = await isServerRunning(socketPath);
        return s.version || null;
      } catch { return null; }
    })();

    printBanner(socketPath, actualHttpPort, child.pid ?? null, version, null);
    console.log('  Press Ctrl+C to stop\n');

    // Flush buffered stderr
    for (const line of stderrLines) process.stderr.write(line + '\n');
    bannerPrinted = true;

    // Keep process alive
    child.on('close', (code) => {
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch { /* ignore */ }
      }
      if (existsSync(pidPath)) {
        try { unlinkSync(pidPath); } catch { /* ignore */ }
      }
      process.exit(code ?? 0);
    });
  });

// ─── grafema stop ────────────────────────────────────────────────────────────

export const stopCommand = new Command('stop')
  .description('Stop Grafema')
  .option('-p, --project <path>', 'Project path', '.')
  .action(async (options: { project: string }) => {
    const projectPath = resolve(options.project);
    const { socketPath, pidPath } = getProjectPaths(projectPath);

    const status = await isServerRunning(socketPath);
    if (!status.running) {
      console.log('Grafema is not running');
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch { /* ignore */ }
      }
      if (existsSync(pidPath)) {
        try { unlinkSync(pidPath); } catch { /* ignore */ }
      }
      return;
    }

    console.log('Stopping Grafema...');

    const client = new RFDBClient(socketPath, 'cli');
    client.on('error', () => {});
    try {
      await client.connect();
      await client.shutdown();
    } catch { /* expected */ }

    let attempts = 0;
    while (existsSync(socketPath) && attempts < 30) {
      await sleep(100);
      attempts++;
    }

    if (existsSync(pidPath)) {
      try { unlinkSync(pidPath); } catch { /* ignore */ }
    }

    console.log('Grafema stopped');
  });
