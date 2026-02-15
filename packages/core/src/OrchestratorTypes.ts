/**
 * Types and interfaces for Orchestrator and related classes.
 * Extracted from Orchestrator.ts (REG-462) to keep the main file focused on coordination logic.
 */

import type { Plugin } from './plugins/Plugin.js';
import type { GraphBackend, Logger, LogLevel, ServiceDefinition, RoutingRule } from '@grafema/types';
import type { ProgressCallback } from './PhaseRunner.js';

/**
 * Parallel analysis config
 */
export interface ParallelConfig {
  enabled: boolean;
  socketPath?: string;
  maxWorkers?: number;
}

/**
 * Orchestrator options
 */
export interface OrchestratorOptions {
  graph?: GraphBackend;
  plugins?: Plugin[];
  workerCount?: number;
  onProgress?: ProgressCallback;
  forceAnalysis?: boolean;
  serviceFilter?: string | null;
  /** Override entrypoint, bypasses auto-detection. Path relative to project root. */
  entrypoint?: string;
  indexOnly?: boolean;
  parallel?: ParallelConfig | null;
  /** Logger instance for structured logging. */
  logger?: Logger;
  /** Log level for the default logger. Ignored if logger is provided. */
  logLevel?: LogLevel;
  /**
   * Config-provided services (REG-174).
   * If provided and non-empty, discovery plugins are skipped.
   */
  services?: ServiceDefinition[];
  /**
   * Enable strict mode for fail-fast debugging.
   * When true, enrichers report unresolved references as fatal errors.
   */
  strictMode?: boolean;
  /**
   * Multi-root workspace configuration (REG-76).
   * If provided, each root is indexed with rootPrefix in context.
   */
  workspaceRoots?: string[];
  /**
   * Routing rules from config (REG-256).
   * Passed through to plugins via PluginContext.config.routing.
   */
  routing?: RoutingRule[];
}

/**
 * Service info from discovery
 */
export interface ServiceInfo {
  id: string;
  name: string;
  path?: string;
  metadata?: {
    entrypoint?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Entrypoint info from discovery
 */
export interface EntrypointInfo {
  id: string;
  name?: string;
  file: string;
  type?: string;
  trigger?: string;
  [key: string]: unknown;
}

/**
 * Discovery manifest
 */
export interface DiscoveryManifest {
  services: ServiceInfo[];
  entrypoints: EntrypointInfo[];
  projectPath: string;
  modules?: unknown[];
}

/**
 * Indexing unit (service or entrypoint)
 */
export interface IndexingUnit {
  id: string;
  name: string;
  path: string;
  type: 'service' | 'entrypoint';
  entrypointType?: string;
  trigger?: string;
  [key: string]: unknown;
}

/**
 * Unit manifest for indexing phase
 */
export interface UnitManifest {
  projectPath: string;
  service: {
    id: string;
    name: string;
    path: string;
    [key: string]: unknown;
  };
  modules: unknown[];
  /** Root prefix for multi-root workspace (REG-76) */
  rootPrefix?: string;
}
