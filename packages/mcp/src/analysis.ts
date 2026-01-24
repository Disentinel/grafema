/**
 * MCP Analysis Orchestration
 */

import { Orchestrator, Plugin } from '@grafema/core';
import {
  getOrCreateBackend,
  getProjectPath,
  getIsAnalyzed,
  setIsAnalyzed,
  getAnalysisStatus,
  setAnalysisStatus,
  isAnalysisRunning,
  acquireAnalysisLock,
} from './state.js';
import { loadConfig, loadCustomPlugins, createPlugins } from './config.js';
import { log } from './utils.js';
import type { GraphBackend } from '@grafema/types';

/**
 * Ensure project is analyzed, optionally filtering to a single service.
 *
 * CONCURRENCY: This function is protected by a global mutex.
 * - Only one analysis can run at a time
 * - Concurrent calls wait for the current analysis to complete
 * - force=true while analysis is running returns an error immediately
 *
 * @param serviceName - Optional service to analyze (null = all)
 * @param force - If true, clear DB and re-analyze even if already analyzed.
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
    // This is critical for worker coordination: MCP server clears DB here,
    // worker does NOT call db.clear() (see analysis-worker.ts)
    if (force || !getIsAnalyzed()) {
      log('[Grafema MCP] Clearing database before analysis...');
      await db.clear();
      setIsAnalyzed(false);
    }

    log(
      `[Grafema MCP] Analyzing project: ${projectPath}${serviceName ? ` (service: ${serviceName})` : ''}`
    );

    const config = loadConfig(projectPath);
    const { pluginMap: customPluginMap } = await loadCustomPlugins(projectPath);

    // Create plugins from config
    const plugins = createPlugins(config.plugins, customPluginMap);

    log(`[Grafema MCP] Total plugins: ${plugins.length}`);

    // Check for parallel analysis config
    const parallelConfig = (config as any).analysis?.parallel;
    log(`[Grafema MCP] Config analysis section: ${JSON.stringify((config as any).analysis)}`);

    if (parallelConfig?.enabled) {
      log(
        `[Grafema MCP] Parallel analysis enabled: maxWorkers=${parallelConfig.maxWorkers || 'auto'}, socket=${parallelConfig.socketPath || '/tmp/rfdb.sock'}`
      );
    }

    const analysisStatus = getAnalysisStatus();
    const startTime = Date.now();

    const orchestrator = new Orchestrator({
      graph: db,
      plugins: plugins as Plugin[],
      parallel: parallelConfig,
      serviceFilter: serviceName,
      onProgress: (progress: any) => {
        log(`[Grafema MCP] ${progress.phase}: ${progress.message}`);

        setAnalysisStatus({
          phase: progress.phase,
          message: progress.message,
          servicesDiscovered: progress.servicesDiscovered || analysisStatus.servicesDiscovered,
          servicesAnalyzed: progress.servicesAnalyzed || analysisStatus.servicesAnalyzed,
        });
      },
    });

    await orchestrator.run(projectPath);

    // Flush if available
    if ('flush' in db && typeof db.flush === 'function') {
      await (db as any).flush();
    }

    setIsAnalyzed(true);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    setAnalysisStatus({
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
 * Discover services without running full analysis
 */
export async function discoverServices(): Promise<unknown[]> {
  const db = await getOrCreateBackend();
  const projectPath = getProjectPath();

  log(`[Grafema MCP] Discovering services in: ${projectPath}`);

  const config = loadConfig(projectPath);
  const { pluginMap: customPluginMap } = await loadCustomPlugins(projectPath);

  const availablePlugins: Record<string, () => unknown> = {
    ...Object.fromEntries(
      Object.entries(customPluginMap).map(([name, PluginClass]) => [
        name,
        () => new PluginClass(),
      ])
    ),
  };

  const plugins: unknown[] = [];
  const discoveryPluginNames = (config.plugins as any)?.discovery || [];

  for (const name of discoveryPluginNames) {
    const factory = availablePlugins[name];
    if (factory) {
      plugins.push(factory());
      log(`[Grafema MCP] Enabled discovery plugin: ${name}`);
    } else {
      log(`[Grafema MCP] Warning: Unknown discovery plugin ${name}`);
    }
  }

  const orchestrator = new Orchestrator({
    graph: db,
    plugins: plugins as Plugin[],
  });

  const manifest = await orchestrator.discover(projectPath);

  log(`[Grafema MCP] Discovery complete: found ${manifest.services?.length || 0} services`);

  return manifest.services || [];
}
