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

  const rfdbBackend = new RFDBServerBackend({ socketPath, dbPath });
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
