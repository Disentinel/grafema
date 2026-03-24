/**
 * Resolve command action — re-runs the resolution phase via grafema-orchestrator.
 *
 * Requires an already-analyzed project (graph.rfdb must exist).
 * Spawns grafema-orchestrator with the `resolve` subcommand to re-run
 * only the resolution phase without re-parsing or re-analyzing files.
 */

import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import {
  RFDBServerBackend,
  createLogger,
  findOrchestratorBinary,
  getBinaryNotFoundMessage,
  findAnalyzerBinary,
  ensureBinary,
} from '@grafema/util';
import type { LogLevel } from '@grafema/util';
import { fetchNodeEdgeCounts, exitWithCode } from './analyzeAction.js';

/**
 * Determine log level from CLI options.
 * Priority: --log-level > --quiet > --verbose > default ('silent')
 */
function getLogLevel(options: { quiet?: boolean; verbose?: boolean; logLevel?: string }): LogLevel {
  if (options.logLevel) {
    const validLevels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];
    if (validLevels.includes(options.logLevel as LogLevel)) {
      return options.logLevel as LogLevel;
    }
  }
  if (options.quiet) return 'silent';
  if (options.verbose) return 'info';
  return 'silent';
}

/**
 * Find the grafema.config.yaml config file for the orchestrator.
 *
 * Search order:
 * 1. <projectPath>/grafema.config.yaml
 * 2. <projectPath>/.grafema/config.yaml (legacy location)
 */
function findConfigFile(projectPath: string): string | null {
  const candidates = [
    join(projectPath, 'grafema.config.yaml'),
    join(projectPath, '.grafema', 'config.yaml'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Map of file extensions to required resolve binaries only. */
const EXT_TO_RESOLVE_BINARIES: Record<string, string[]> = {
  js: ['grafema-resolve'],
  ts: ['grafema-resolve'],
  jsx: ['grafema-resolve'],
  tsx: ['grafema-resolve'],
  mjs: ['grafema-resolve'],
  cjs: ['grafema-resolve'],
  py: ['python-resolve'],
  pyi: ['python-resolve'],
  hs: ['haskell-resolve'],
  rs: ['grafema-rust-resolve'],
  java: ['java-resolve'],
  kt: ['kotlin-resolve'],
  kts: ['kotlin-resolve'],
  go: ['go-resolve'],
  c: ['cpp-resolve'],
  cpp: ['cpp-resolve'],
  h: ['cpp-resolve'],
  hpp: ['cpp-resolve'],
  swift: ['swift-resolve'],
  ex: ['beam-resolve'],
  exs: ['beam-resolve'],
  erl: ['beam-resolve'],
};

/**
 * Detect languages from config include patterns and ensure their resolve binaries exist.
 * Reads the config file as text, extracts file extensions from include globs,
 * and pre-downloads missing binaries before the orchestrator needs them.
 */
async function ensureResolveBinaries(configPath: string, log: (...args: unknown[]) => void): Promise<void> {
  const configText = readFileSync(configPath, 'utf-8');

  const neededBinaries = new Set<string>();
  for (const match of configText.matchAll(/\*\.(\w+)/g)) {
    const ext = match[1];
    const bins = EXT_TO_RESOLVE_BINARIES[ext];
    if (bins) bins.forEach(b => neededBinaries.add(b));
  }

  // Always ensure JS/TS resolve binary (most common, default language)
  neededBinaries.add('grafema-resolve');

  for (const binName of neededBinaries) {
    if (findAnalyzerBinary(binName)) continue;
    const downloaded = await ensureBinary(binName, null, log);
    if (downloaded) {
      log(`Downloaded ${binName} → ${downloaded}`);
    }
  }
}

export async function resolveAction(path: string, options: {
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  logLevel?: string;
  logFile?: string;
  autoStart?: boolean;
}): Promise<void> {
  const projectPath = resolve(path);
  const grafemaDir = join(projectPath, '.grafema');
  const dbPath = join(grafemaDir, 'graph.rfdb');

  if (!existsSync(dbPath)) {
    console.error('');
    console.error('No analyzed database found.');
    console.error('Run `grafema analyze` first to analyze the project.');
    console.error('');
    process.exit(1);
  }

  const info = options.quiet ? () => {} : console.log;
  const debug = options.verbose ? console.log : () => {};

  const logLevel = getLogLevel(options);
  const logFile = options.logFile ? resolve(options.logFile) : undefined;
  const _logger = createLogger(logLevel, logFile ? { logFile } : undefined);

  if (logFile) {
    debug(`Log file: ${logFile}`);
  }
  debug(`Re-running resolution: ${projectPath}`);

  // Find grafema-orchestrator binary (lazy download if missing)
  let orchestratorBinary = findOrchestratorBinary();
  if (!orchestratorBinary) {
    const downloaded = await ensureBinary('grafema-orchestrator', null, info);
    if (downloaded) {
      debug(`Downloaded grafema-orchestrator → ${downloaded}`);
      orchestratorBinary = downloaded;
    }
  }
  if (!orchestratorBinary) {
    console.error('');
    console.error(getBinaryNotFoundMessage('grafema-orchestrator'));
    process.exit(1);
  }

  debug(`Using orchestrator: ${orchestratorBinary}`);

  // Find config file for the orchestrator
  const configPath = findConfigFile(projectPath);
  if (!configPath) {
    console.error('');
    console.error('No grafema config file found.');
    console.error('');
    console.error('Expected one of:');
    console.error(`  ${join(projectPath, 'grafema.config.yaml')}`);
    console.error(`  ${join(projectPath, '.grafema', 'config.yaml')}`);
    console.error('');
    console.error('Run `grafema analyze` first (or `grafema analyze --quickstart`).');
    console.error('');
    process.exit(1);
  }

  debug(`Using config: ${configPath}`);

  // Ensure resolve binaries exist for detected languages (lazy download if missing)
  await ensureResolveBinaries(configPath, debug);

  // Connect to RFDB server — auto-start by default (zero-config UX)
  const backend = new RFDBServerBackend({
    dbPath,
    autoStart: options.autoStart ?? true,
    silent: !options.verbose,
    clientName: 'cli'
  });

  try {
    await backend.connect();
  } catch (err) {
    if (err instanceof Error && err.message.includes('not running')) {
      console.error('');
      console.error('RFDB server failed to start.');
      console.error('');
      console.error('Try starting manually:');
      console.error('  grafema server start');
      console.error('');
      console.error('Or run diagnostics:');
      console.error('  grafema doctor');
      console.error('');
      process.exit(1);
    }
    throw err;
  }

  const startTime = Date.now();

  // Build orchestrator args — resolve subcommand
  const args: string[] = ['resolve', '--config', configPath, '--socket', backend.socketPath];

  debug(`Spawning: ${orchestratorBinary} ${args.join(' ')}`);

  let exitCode = 0;

  try {
    exitCode = await new Promise<number>((resolvePromise, reject) => {
      const child = spawn(orchestratorBinary, args, {
        stdio: [
          'ignore',
          options.quiet ? 'ignore' : 'inherit',
          options.quiet ? 'ignore' : 'inherit',
        ],
        env: {
          ...process.env,
          RUST_LOG: options.debug ? 'debug' : (options.quiet ? 'warn' : 'info'),
        },
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn grafema-orchestrator: ${err.message}`));
      });

      child.on('close', (code) => {
        resolvePromise(code ?? 1);
      });
    });

    if (exitCode === 0) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const stats = await fetchNodeEdgeCounts(backend);

      info('');
      info(`Resolution complete in ${elapsedSeconds.toFixed(2)}s`);
      info(`  Nodes: ${stats.nodeCount}`);
      info(`  Edges: ${stats.edgeCount}`);
    } else {
      console.error('');
      console.error(`Resolution failed with exit code ${exitCode}`);
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    console.error('');
    console.error(`Resolution failed: ${error.message}`);
    exitCode = 1;
  } finally {
    if (backend.connected) {
      await backend.close();
    }

    exitWithCode(exitCode);
  }
}
