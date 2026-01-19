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
} from './state.js';
import { loadConfig, loadCustomPlugins, BUILTIN_PLUGINS } from './config.js';
import { log } from './utils.js';
import type { GraphBackend } from '@grafema/types';

/**
 * Ensure project is analyzed, optionally filtering to a single service
 */
export async function ensureAnalyzed(serviceName: string | null = null): Promise<GraphBackend> {
  const db = await getOrCreateBackend();
  const projectPath = getProjectPath();
  const isAnalyzed = getIsAnalyzed();

  if (!isAnalyzed || serviceName) {
    log(
      `[Grafema MCP] Analyzing project: ${projectPath}${serviceName ? ` (service: ${serviceName})` : ''}`
    );

    const config = loadConfig(projectPath);
    const { pluginMap: customPluginMap } = await loadCustomPlugins(projectPath);

    // Merge builtin and custom plugins
    const availablePlugins: Record<string, () => unknown> = {
      ...BUILTIN_PLUGINS,
      ...Object.fromEntries(
        Object.entries(customPluginMap).map(([name, PluginClass]) => [
          name,
          () => new PluginClass(),
        ])
      ),
    };

    // Build plugin list from config
    const plugins: unknown[] = [];
    for (const [phase, pluginNames] of Object.entries(config.plugins || {})) {
      for (const name of pluginNames as string[]) {
        const factory = availablePlugins[name];
        if (factory) {
          plugins.push(factory());
          log(`[Grafema MCP] Enabled plugin: ${name} (${phase})`);
        } else {
          log(`[Grafema MCP] Warning: Unknown plugin ${name} in config`);
        }
      }
    }

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

    log(`[Grafema MCP] ✅ Analysis complete in ${totalTime}s`);
  }

  return db;
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
