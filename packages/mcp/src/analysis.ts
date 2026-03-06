/**
 * MCP Analysis Orchestration
 *
 * Shells out to the `grafema-orchestrator` Rust binary instead of using
 * the JS Orchestrator class. The binary handles file discovery, parsing,
 * analysis, resolution, and RFDB ingestion.
 */

import { existsSync } from 'fs';
import { join, delimiter, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  getOrCreateBackend,
  getProjectPath,
  getIsAnalyzed,
  setIsAnalyzed,
  getAnalysisStatus,
  setAnalysisStatus,
  isAnalysisRunning,
  acquireAnalysisLock,
  getKnowledgeBase,
} from './state.js';
import { loadConfig } from './config.js';
import { log } from './utils.js';
import type { GraphBackend } from '@grafema/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Find the grafema-orchestrator binary.
 *
 * Search order:
 * 1. GRAFEMA_ORCHESTRATOR environment variable
 * 2. Monorepo target/release (development)
 * 3. Monorepo target/debug (development)
 * 4. System PATH
 * 5. ~/.local/bin
 */
function findOrchestratorBinary(): string | null {
  // 1. Environment variable
  const envBinary = process.env.GRAFEMA_ORCHESTRATOR;
  if (envBinary && existsSync(envBinary)) {
    return envBinary;
  }

  // 2-3. Monorepo development builds
  const monorepoRoot = dirname(dirname(dirname(__dirname)));
  for (const profile of ['release', 'debug']) {
    const path = join(monorepoRoot, 'packages', 'grafema-orchestrator', 'target', profile, 'grafema-orchestrator');
    if (existsSync(path)) return path;
  }

  // 4. System PATH
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, 'grafema-orchestrator');
    if (existsSync(path)) return path;
  }

  // 5. ~/.local/bin
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    const path = join(home, '.local', 'bin', 'grafema-orchestrator');
    if (existsSync(path)) return path;
  }

  return null;
}

/**
 * Resolve the config file path for grafema-orchestrator.
 *
 * The orchestrator expects a YAML config with `root`, `include`, `exclude` fields.
 * Looks for:
 * 1. grafema.config.yaml in project root
 * 2. .grafema/config.yaml as fallback
 */
function findConfigPath(projectPath: string): string | null {
  const candidates = [
    join(projectPath, 'grafema.config.yaml'),
    join(projectPath, '.grafema', 'config.yaml'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Resolve the RFDB socket path for the current project.
 *
 * Uses the same logic as state.ts getOrCreateBackend():
 * config.analysis.parallel.socketPath > default derived from dbPath
 */
function resolveSocketPath(projectPath: string): string {
  const config = loadConfig(projectPath);
  const configSocket = (config as any).analysis?.parallel?.socketPath;
  if (configSocket) return configSocket;

  // Default: same as RFDBServerBackend derives from dbPath
  return join(projectPath, '.grafema', 'rfdb.sock');
}

/**
 * Spawn grafema-orchestrator and wait for it to complete.
 *
 * @returns Promise that resolves on success, rejects on failure
 */
function runOrchestrator(
  binaryPath: string,
  args: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`[Grafema MCP] Spawning: ${binaryPath} ${args.join(' ')}`);

    const child = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      // Forward orchestrator output to MCP log
      for (const line of text.split('\n').filter(Boolean)) {
        log(`[orchestrator] ${line}`);
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      for (const line of text.split('\n').filter(Boolean)) {
        log(`[orchestrator] ${line}`);
      }
    });

    child.on('error', (err: Error) => {
      reject(new Error(`Failed to spawn grafema-orchestrator: ${err.message}`));
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `grafema-orchestrator exited with code ${code}\n` +
              (stderr || stdout || '(no output)')
          )
        );
      }
    });
  });
}

/**
 * Ensure project is analyzed, optionally filtering to a single service.
 *
 * CONCURRENCY: This function is protected by a global mutex.
 * - Only one analysis can run at a time
 * - Concurrent calls wait for the current analysis to complete
 * - force=true while analysis is running returns an error immediately
 *
 * @param serviceName - Optional service to analyze (null = all) — currently unused by the orchestrator
 * @param force - If true, add --force flag to re-analyze all files.
 *                ERROR if another analysis is already running.
 * @throws Error if force=true and analysis is already running
 */
export async function ensureAnalyzed(
  serviceName: string | null = null,
  force: boolean = false
): Promise<GraphBackend> {
  const db = await getOrCreateBackend();
  const projectPath = getProjectPath();

  // CONCURRENCY CHECK: If force=true and analysis is running, error immediately
  // This check is BEFORE acquiring lock to fail fast
  if (force && isAnalysisRunning()) {
    throw new Error(
      'Analysis is already in progress. Cannot force re-analysis while another analysis is running. ' +
        'Wait for the current analysis to complete or check status with get_analysis_status.'
    );
  }

  // Skip if already analyzed (and not forcing, and no service filter)
  if (getIsAnalyzed() && !serviceName && !force) {
    return db;
  }

  // Acquire lock (waits if another analysis is running)
  const releaseLock = await acquireAnalysisLock();

  try {
    // Double-check after acquiring lock (another call might have completed analysis while we waited)
    if (getIsAnalyzed() && !serviceName && !force) {
      return db;
    }

    // Clear DB inside lock, BEFORE running analysis
    if (force || !getIsAnalyzed()) {
      log('[Grafema MCP] Clearing database before analysis...');
      if (db.clear) {
        await db.clear();
      }
      setIsAnalyzed(false);
    }

    log(
      `[Grafema MCP] Analyzing project: ${projectPath}${serviceName ? ` (service: ${serviceName})` : ''}`
    );

    // Find the orchestrator binary
    const binaryPath = findOrchestratorBinary();
    if (!binaryPath) {
      throw new Error(
        'grafema-orchestrator binary not found.\n' +
          'Options:\n' +
          '1. Build from source: cd packages/grafema-orchestrator && cargo build --release\n' +
          '2. Set environment variable: export GRAFEMA_ORCHESTRATOR=/path/to/grafema-orchestrator\n' +
          '3. Install to PATH or ~/.local/bin\n'
      );
    }

    // Find config file
    const configPath = findConfigPath(projectPath);
    if (!configPath) {
      throw new Error(
        `No config file found for grafema-orchestrator.\n` +
          `Expected one of:\n` +
          `  - ${join(projectPath, 'grafema.config.yaml')}\n` +
          `  - ${join(projectPath, '.grafema', 'config.yaml')}\n`
      );
    }

    // Resolve socket path
    const socketPath = resolveSocketPath(projectPath);

    const analysisStatus = getAnalysisStatus();
    const startTime = Date.now();

    setAnalysisStatus({
      phase: 'starting',
      message: 'Spawning grafema-orchestrator...',
      servicesDiscovered: analysisStatus.servicesDiscovered,
      servicesAnalyzed: analysisStatus.servicesAnalyzed,
    });

    // Build args
    const args = ['analyze', '--config', configPath, '--socket', socketPath];
    if (force) {
      args.push('--force');
    }

    log(`[Grafema MCP] Binary: ${binaryPath}`);
    log(`[Grafema MCP] Config: ${configPath}`);
    log(`[Grafema MCP] Socket: ${socketPath}`);

    // Run the orchestrator
    await runOrchestrator(binaryPath, args);

    // Flush if available
    if ('flush' in db && typeof db.flush === 'function') {
      await (db as any).flush();
    }

    setIsAnalyzed(true);

    // Bump KB resolver generation so cached resolutions are re-evaluated
    const kb = getKnowledgeBase();
    if (kb) {
      kb.invalidateResolutionCache();
      log('[Grafema MCP] KnowledgeBase resolution cache invalidated after analysis');
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    setAnalysisStatus({
      phase: 'complete',
      message: `Analysis complete in ${totalTime}s`,
      timings: {
        ...analysisStatus.timings,
        total: parseFloat(totalTime),
      },
    });

    log(`[Grafema MCP] Analysis complete in ${totalTime}s`);

    return db;
  } finally {
    // ALWAYS release the lock, even on error
    releaseLock();
  }
}

/**
 * Discover services without running full analysis.
 *
 * Service discovery is now handled by grafema-orchestrator's file discovery.
 * This returns an empty array — the orchestrator handles discovery internally.
 */
export async function discoverServices(): Promise<unknown[]> {
  const projectPath = getProjectPath();
  log(`[Grafema MCP] Service discovery is handled by grafema-orchestrator. Project: ${projectPath}`);
  return [];
}
