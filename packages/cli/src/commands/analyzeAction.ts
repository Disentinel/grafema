/**
 * Analyze command action — spawns grafema-orchestrator for project analysis.
 *
 * The Rust grafema-orchestrator binary handles the full analysis pipeline:
 * discovery, parsing (OXC), analysis (grafema-analyzer), resolution,
 * and RFDB ingestion. This action finds the binary, spawns it with
 * the correct args, streams output, and prints a summary.
 */

import { resolve, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
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

export interface NodeEdgeCountBackend {
  nodeCount: () => Promise<number>;
  edgeCount: () => Promise<number>;
}

export async function fetchNodeEdgeCounts(backend: NodeEdgeCountBackend): Promise<{ nodeCount: number; edgeCount: number }> {
  const [nodeCount, edgeCount] = await Promise.all([backend.nodeCount(), backend.edgeCount()]);
  return { nodeCount, edgeCount };
}

export function exitWithCode(code: number, exitFn: (code: number) => void = process.exit): void {
  exitFn(code);
}

/**
 * Determine log level from CLI options.
 * Priority: --log-level > --quiet > --verbose > default ('silent')
 *
 * By default, logs are silent to allow clean progress UI.
 * Use --verbose to see detailed logs (disables interactive progress).
 */
function getLogLevel(options: { quiet?: boolean; verbose?: boolean; logLevel?: string }): LogLevel {
  if (options.logLevel) {
    const validLevels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];
    if (validLevels.includes(options.logLevel as LogLevel)) {
      return options.logLevel as LogLevel;
    }
  }
  if (options.quiet) return 'silent';
  if (options.verbose) return 'info';  // --verbose shows logs instead of progress UI
  return 'silent';  // Default: silent logs, clean progress UI
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

export async function analyzeAction(path: string, options: { service?: string; entrypoint?: string; clear?: boolean; quiet?: boolean; verbose?: boolean; debug?: boolean; logLevel?: string; logFile?: string; strict?: boolean; autoStart?: boolean }): Promise<void> {
  const projectPath = resolve(path);
  const grafemaDir = join(projectPath, '.grafema');
  const dbPath = join(grafemaDir, 'graph.rfdb');

  if (!existsSync(grafemaDir)) {
    mkdirSync(grafemaDir, { recursive: true });
  }

  // Two log levels for CLI output:
  // - info: important results (shows unless --quiet)
  // - debug: verbose details (shows only with --verbose)
  const info = options.quiet ? () => {} : console.log;
  const debug = options.verbose ? console.log : () => {};

  // Create logger based on CLI flags
  const logLevel = getLogLevel(options);
  const logFile = options.logFile ? resolve(options.logFile) : undefined;
  const _logger = createLogger(logLevel, logFile ? { logFile } : undefined);

  if (logFile) {
    debug(`Log file: ${logFile}`);
  }
  debug(`Analyzing project: ${projectPath}`);

  // Find grafema-orchestrator binary
  const orchestratorBinary = findOrchestratorBinary();
  if (!orchestratorBinary) {
    console.error('');
    console.error(getBinaryNotFoundMessage('grafema-orchestrator'));
    process.exit(1);
  }

  debug(`Using orchestrator: ${orchestratorBinary}`);

  // Ensure JS/TS analyzer binaries exist (lazy download if missing)
  for (const binName of ['grafema-analyzer', 'grafema-resolve']) {
    const existing = findAnalyzerBinary(binName);
    if (!existing) {
      const downloaded = await ensureBinary(binName, null, info);
      if (downloaded) {
        debug(`Downloaded ${binName} → ${downloaded}`);
      }
    }
  }

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
    console.error('Create a config file with at least:');
    console.error('  root: "."');
    console.error('  include:');
    console.error('    - "**/*.js"');
    console.error('');
    process.exit(1);
  }

  debug(`Using config: ${configPath}`);

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

  if (options.clear) {
    debug('Clearing existing database...');
    await backend.clear();
  }

  const startTime = Date.now();

  // Build orchestrator args
  const args: string[] = ['analyze', '--config', configPath, '--socket', backend.socketPath];

  if (options.clear) {
    args.push('--force');
  }

  debug(`Spawning: ${orchestratorBinary} ${args.join(' ')}`);

  let exitCode = 0;

  try {
    // Spawn grafema-orchestrator
    exitCode = await new Promise<number>((resolvePromise, reject) => {
      const child = spawn(orchestratorBinary, args, {
        stdio: [
          'ignore',
          options.quiet ? 'ignore' : 'inherit',
          options.quiet ? 'ignore' : 'inherit',
        ],
        env: {
          ...process.env,
          // Pass RUST_LOG for tracing verbosity
          RUST_LOG: options.verbose ? 'info' : (options.debug ? 'debug' : 'warn'),
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
      info(`Analysis complete in ${elapsedSeconds.toFixed(2)}s`);
      info(`  Nodes: ${stats.nodeCount}`);
      info(`  Edges: ${stats.edgeCount}`);
    } else {
      console.error('');
      console.error(`Analysis failed with exit code ${exitCode}`);
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    console.error('');
    console.error(`Analysis failed: ${error.message}`);
    exitCode = 1;
  } finally {
    if (backend.connected) {
      await backend.close();
    }

    // Exit with appropriate code
    exitWithCode(exitCode);
  }
}
