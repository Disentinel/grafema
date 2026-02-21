/**
 * MCP Server State Management
 */

import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { RFDBServerBackend, GuaranteeManager, GuaranteeAPI } from '@grafema/core';
import type { GuaranteeGraphBackend, GuaranteeGraph } from '@grafema/core';
import { loadConfig } from './config.js';
import { log, initLogger } from './utils.js';
import type { AnalysisStatus } from './types.js';
import type { GraphBackend } from '@grafema/types';

// === GLOBAL STATE ===
let projectPath: string = process.cwd();
let backend: GraphBackend | null = null;
let isAnalyzed: boolean = false;
let backgroundPid: number | null = null;

// Guarantee managers
let guaranteeManager: GuaranteeManager | null = null;
let guaranteeAPI: GuaranteeAPI | null = null;

let analysisStatus: AnalysisStatus = {
  running: false,
  phase: null,
  message: null,
  servicesDiscovered: 0,
  servicesAnalyzed: 0,
  startTime: null,
  endTime: null,
  error: null,
  timings: {
    discovery: null,
    indexing: null,
    analysis: null,
    enrichment: null,
    validation: null,
    total: null,
  },
};

// === ANALYSIS LOCK ===
//
// Promise-based mutex for analysis serialization.
//
// Why not a simple boolean flag?
// - Boolean can indicate "analysis is running" but cannot make callers wait
// - Promise allows awaiting until analysis completes
//
// Pattern:
// - null = no analysis running, lock available
// - Promise = analysis running, await it to wait for completion
//
// Behavior on force=true during analysis:
// - Returns error immediately (does NOT wait)
// - Rationale: force=true implies "clear DB and re-analyze"
// - Clearing DB while another analysis writes = corruption
// - Better UX: immediate feedback vs mysterious wait
//
// Scope: Global Lock (not per-service) because:
// - Single RFDB backend instance
// - db.clear() affects entire database
// - Simpler reasoning about state
//
// Process Death Behavior:
// - Lock is in-memory - next process starts with fresh state (no deadlock)
// - RFDB may have partial data from incomplete analysis
// - isAnalyzed resets to false - next call will re-analyze
// - RFDB is append-only - partial data won't corrupt existing data
//
// Worker Process Coordination:
// - Worker is SEPARATE process from MCP server
// - MCP server calls db.clear() INSIDE the lock, BEFORE spawning worker
// - Worker assumes DB is already clean and does NOT call clear()
//
// Timeout:
// - Lock acquisition times out after 10 minutes
// - Matches project's execution guard policy (see CLAUDE.md)
//
let analysisLock: Promise<void> | null = null;
let analysisLockResolve: (() => void) | null = null;

/**
 * Lock timeout in milliseconds (10 minutes).
 * Matches project's execution guard policy - max 10 minutes for any operation.
 */
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

// === GETTERS ===
export function getProjectPath(): string {
  return projectPath;
}

export function getIsAnalyzed(): boolean {
  return isAnalyzed;
}

export function getAnalysisStatus(): AnalysisStatus {
  return analysisStatus;
}

export function getBackgroundPid(): number | null {
  return backgroundPid;
}

export function getGuaranteeManager(): GuaranteeManager | null {
  return guaranteeManager;
}

export function getGuaranteeAPI(): GuaranteeAPI | null {
  return guaranteeAPI;
}

// === SETTERS ===
export function setProjectPath(path: string): void {
  projectPath = path;
}

export function setIsAnalyzed(value: boolean): void {
  isAnalyzed = value;
}

export function setAnalysisStatus(status: Partial<AnalysisStatus>): void {
  analysisStatus = { ...analysisStatus, ...status };
}

export function setBackgroundPid(pid: number | null): void {
  backgroundPid = pid;
}

export function updateAnalysisTimings(timings: Partial<AnalysisStatus['timings']>): void {
  analysisStatus.timings = { ...analysisStatus.timings, ...timings };
}

// === ANALYSIS LOCK FUNCTIONS ===

/**
 * Check if analysis is currently running.
 *
 * Use this to check status before attempting operations that conflict
 * with analysis (e.g., force re-analysis while analysis is in progress).
 *
 * @returns true if analysis is in progress, false otherwise
 */
export function isAnalysisRunning(): boolean {
  return analysisLock !== null;
}

/**
 * Acquire the analysis lock.
 *
 * This function implements a Promise-based mutex for serializing analysis operations.
 * Only one analysis can run at a time. If another analysis is running, this function
 * waits for it to complete (up to LOCK_TIMEOUT_MS).
 *
 * Usage:
 * ```typescript
 * const releaseLock = await acquireAnalysisLock();
 * try {
 *   // ... perform analysis ...
 * } finally {
 *   releaseLock();
 * }
 * ```
 *
 * @returns A release function to call when analysis is complete
 * @throws Error if timeout (10 minutes) expires while waiting for existing analysis
 */
export async function acquireAnalysisLock(): Promise<() => void> {
  const start = Date.now();

  // Wait for any existing analysis to complete (with timeout)
  while (analysisLock !== null) {
    if (Date.now() - start > LOCK_TIMEOUT_MS) {
      throw new Error(
        'Analysis lock timeout (10 minutes). Previous analysis may have failed. ' +
          'Check .grafema/mcp.log for errors or restart MCP server.'
      );
    }
    await analysisLock;
  }

  // Create new lock - a Promise that will be resolved when analysis completes
  analysisLock = new Promise<void>((resolve) => {
    analysisLockResolve = resolve;
  });

  // Update status to reflect that analysis is running
  setAnalysisStatus({ running: true });

  // Return release function
  return () => {
    setAnalysisStatus({ running: false });
    const resolve = analysisLockResolve;
    analysisLock = null;
    analysisLockResolve = null;
    resolve?.();
  };
}

/**
 * Wait for any running analysis to complete without acquiring the lock.
 *
 * Use this when you need to wait for analysis completion but don't need
 * to start a new analysis yourself.
 *
 * @returns Promise that resolves when no analysis is running
 */
export async function waitForAnalysis(): Promise<void> {
  if (analysisLock) {
    await analysisLock;
  }
}

// === BACKEND ===
export async function getOrCreateBackend(): Promise<GraphBackend> {
  if (backend) return backend;

  const grafemaDir = join(projectPath, '.grafema');
  const dbPath = join(grafemaDir, 'graph.rfdb');

  if (!existsSync(grafemaDir)) {
    mkdirSync(grafemaDir, { recursive: true });
  }

  const config = loadConfig(projectPath);
  // Socket path from config, or let RFDBServerBackend derive it from dbPath
  const socketPath = (config as any).analysis?.parallel?.socketPath;

  log(`[Grafema MCP] Using RFDB server backend: socket=${socketPath || 'auto'}, db=${dbPath}`);

  const rfdbBackend = new RFDBServerBackend({ socketPath, dbPath, clientName: 'mcp' });
  await rfdbBackend.connect();
  backend = rfdbBackend as unknown as GraphBackend;

  const nodeCount = await backend.nodeCount();
  if (nodeCount > 0) {
    isAnalyzed = true;
    log(`[Grafema MCP] Connected to existing database: ${nodeCount} nodes`);
  } else {
    log(`[Grafema MCP] Empty database, analysis needed`);
  }

  // Initialize guarantee managers
  initializeGuaranteeManagers(rfdbBackend);

  return backend;
}

/**
 * Initialize GuaranteeManager (Datalog-based) and GuaranteeAPI (contract-based)
 */
function initializeGuaranteeManagers(rfdbBackend: RFDBServerBackend): void {
  // GuaranteeManager for Datalog-based guarantees
  // Cast to GuaranteeGraph interface expected by GuaranteeManager
  const guaranteeGraph = rfdbBackend as unknown as GuaranteeGraph;
  guaranteeManager = new GuaranteeManager(guaranteeGraph, projectPath);
  log(`[Grafema MCP] GuaranteeManager initialized`);

  // GuaranteeAPI for contract-based guarantees
  const guaranteeGraphBackend = rfdbBackend as unknown as GuaranteeGraphBackend;
  guaranteeAPI = new GuaranteeAPI(guaranteeGraphBackend);
  log(`[Grafema MCP] GuaranteeAPI initialized`);
}

export function getBackendIfExists(): GraphBackend | null {
  return backend;
}

// === LOGGING SETUP ===
export function setupLogging(): void {
  const grafemaDir = join(projectPath, '.grafema');
  if (!existsSync(grafemaDir)) {
    mkdirSync(grafemaDir, { recursive: true });
  }
  initLogger(grafemaDir);
}

// === INITIALIZATION ===
export function initializeFromArgs(): void {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      projectPath = args[i + 1];
      i++;
    }
  }
}

// === CLEANUP ===
export async function cleanup(): Promise<void> {
  if (backend && 'close' in backend && typeof backend.close === 'function') {
    await backend.close();
  }
}
