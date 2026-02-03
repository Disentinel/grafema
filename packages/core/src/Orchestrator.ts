/**
 * Orchestrator - управляет процессом анализа через фазы
 * Полностью абстрактный - специфичная логика в плагинах
 */

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync, ChildProcess } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import { SimpleProjectDiscovery } from './plugins/discovery/SimpleProjectDiscovery.js';
import { resolveSourceEntrypoint } from './plugins/discovery/resolveSourceEntrypoint.js';
import { Profiler } from './core/Profiler.js';
import { AnalysisQueue } from './core/AnalysisQueue.js';
import { DiagnosticCollector } from './diagnostics/DiagnosticCollector.js';
import type { Plugin, PluginContext } from './plugins/Plugin.js';
import type { GraphBackend, PluginPhase, Logger, LogLevel, IssueSpec, ServiceDefinition } from '@grafema/types';
import { createLogger } from './logging/Logger.js';
import { NodeFactory } from './core/NodeFactory.js';
import type { IssueSeverity } from './core/nodes/IssueNode.js';

/**
 * Progress callback info
 */
export interface ProgressInfo {
  phase: string;
  currentPlugin?: string;
  message?: string;
  totalFiles?: number;
  processedFiles?: number;
  servicesAnalyzed?: number;
}

/**
 * Progress callback type
 */
export type ProgressCallback = (info: ProgressInfo) => void;

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
interface UnitManifest {
  projectPath: string;
  service: {
    id: string;
    name: string;
    path: string;
    [key: string]: unknown;
  };
  modules: unknown[];
}

export class Orchestrator {
  private graph: GraphBackend;
  private config: OrchestratorOptions;
  private plugins: Plugin[];
  private workerCount: number;
  private onProgress: ProgressCallback;
  private forceAnalysis: boolean;
  private serviceFilter: string | null;
  private entrypoint: string | undefined;
  private indexOnly: boolean;
  private profiler: Profiler;
  private parallelConfig: ParallelConfig | null;
  private analysisQueue: AnalysisQueue | null;
  private rfdbServerProcess: ChildProcess | null;
  private _serverWasExternal: boolean;
  private diagnosticCollector: DiagnosticCollector;
  private logger: Logger;
  /** Config-provided services (REG-174) */
  private configServices: ServiceDefinition[] | undefined;
  /** Strict mode flag (REG-330) */
  private strictMode: boolean;

  constructor(options: OrchestratorOptions = {}) {
    this.graph = options.graph!;
    this.config = options;
    this.plugins = options.plugins || [];
    this.workerCount = options.workerCount || 10; // ГОРИЗОНТАЛЬНОЕ МАСШТАБИРОВАНИЕ
    this.onProgress = options.onProgress || (() => {}); // Callback для прогресса
    this.forceAnalysis = options.forceAnalysis || false; // Флаг для игнорирования кэша
    this.serviceFilter = options.serviceFilter || null; // Фильтр для одного сервиса
    this.entrypoint = options.entrypoint; // Override entrypoint, bypasses discovery
    this.indexOnly = options.indexOnly || false; // Только DISCOVERY + INDEXING (для coverage)
    this.profiler = new Profiler('Orchestrator');

    // Parallel/queue-based analysis config
    this.parallelConfig = options.parallel || null;
    this.analysisQueue = null;
    this.rfdbServerProcess = null;
    this._serverWasExternal = false;

    // Initialize diagnostic collector
    this.diagnosticCollector = new DiagnosticCollector();

    // Initialize logger (use provided or create default)
    this.logger = options.logger ?? createLogger(options.logLevel ?? 'info');

    // Store config-provided services (REG-174)
    this.configServices = options.services;

    // Strict mode configuration (REG-330)
    this.strictMode = options.strictMode ?? false;

    // Modified auto-add logic: SKIP auto-add if config services provided (REG-174)
    const hasDiscovery = this.plugins.some(p => p.metadata?.phase === 'DISCOVERY');
    const hasConfigServices = this.configServices && this.configServices.length > 0;

    if (!hasDiscovery && !hasConfigServices) {
      // Only auto-add if NO discovery plugins AND NO config services
      this.plugins.unshift(new SimpleProjectDiscovery());
    }
  }

  /**
   * Запустить анализ проекта
   */
  async run(projectPath: string): Promise<DiscoveryManifest> {
    const totalStartTime = Date.now();

    // Resolve to absolute path
    const absoluteProjectPath = projectPath.startsWith('/') ? projectPath : resolve(projectPath);

    // RADICAL SIMPLIFICATION: Clear entire graph once at the start if forceAnalysis
    if (this.forceAnalysis && this.graph.clear) {
      this.logger.info('Clearing entire graph (forceAnalysis=true)');
      await this.graph.clear();
      this.logger.info('Graph cleared successfully');
    }

    this.onProgress({ phase: 'discovery', currentPlugin: 'Starting discovery...', message: 'Discovering services...', totalFiles: 0, processedFiles: 0 });

    // PHASE 0: DISCOVERY - запуск плагинов фазы DISCOVERY (or use entrypoint override)
    this.profiler.start('DISCOVERY');
    let manifest: DiscoveryManifest;
    if (this.entrypoint) {
      // Skip discovery, create synthetic manifest with single service
      const entrypointPath = this.entrypoint.startsWith('/')
        ? this.entrypoint
        : join(absoluteProjectPath, this.entrypoint);
      const serviceName = this.entrypoint.split('/').pop()?.replace(/\.[^.]+$/, '') || 'main';
      manifest = {
        services: [{
          id: `service:${serviceName}`,
          name: serviceName,
          path: entrypointPath,
          metadata: { entrypoint: entrypointPath }
        }],
        entrypoints: [],
        projectPath: absoluteProjectPath
      };
      this.logger.info('Using entrypoint override', { entrypoint: this.entrypoint, resolved: entrypointPath });
    } else {
      manifest = await this.discover(absoluteProjectPath);
    }
    this.profiler.end('DISCOVERY');

    const epCount = manifest.entrypoints?.length || 0;
    const svcCount = manifest.services?.length || 0;
    this.onProgress({
      phase: 'discovery',
      currentPlugin: 'Discovery complete',
      message: `Found ${svcCount} service(s), ${epCount} entrypoint(s)`,
      totalFiles: 0,
      processedFiles: 0
    });
    this.logger.info('Discovery complete', { services: svcCount, entrypoints: epCount });

    // Build unified list of indexing units from services AND entrypoints
    const indexingUnits = this.buildIndexingUnits(manifest);

    // Filter if specified
    let unitsToProcess: IndexingUnit[];
    if (this.serviceFilter) {
      unitsToProcess = indexingUnits.filter(u =>
        u.name === this.serviceFilter ||
        u.path === this.serviceFilter ||
        u.name.includes(this.serviceFilter!) ||
        u.path.includes(this.serviceFilter!)
      );
      this.logger.info('Filtering services', { filter: this.serviceFilter, found: unitsToProcess.length, total: indexingUnits.length });
    } else {
      unitsToProcess = indexingUnits;
    }

    this.logger.info('Processing indexing units', { count: unitsToProcess.length, strategy: 'Phase-by-phase with DFS' });

    // PHASE 1: INDEXING - каждый сервис строит своё дерево зависимостей от entrypoint
    const indexingStart = Date.now();
    this.profiler.start('INDEXING');
    this.onProgress({
      phase: 'indexing',
      currentPlugin: 'Starting indexing...',
      message: 'Building dependency trees...',
      totalFiles: unitsToProcess.length,
      processedFiles: 0
    });

    // Параллельная обработка units батчами
    const BATCH_SIZE = this.workerCount;
    let processedUnits = 0;

    for (let batchStart = 0; batchStart < unitsToProcess.length; batchStart += BATCH_SIZE) {
      const batch = unitsToProcess.slice(batchStart, batchStart + BATCH_SIZE);

      this.onProgress({
        phase: 'indexing',
        currentPlugin: 'JSModuleIndexer',
        message: `[${processedUnits + 1}-${processedUnits + batch.length}/${unitsToProcess.length}] Batch indexing...`,
        totalFiles: unitsToProcess.length,
        processedFiles: processedUnits
      });

      // Параллельно обрабатываем батч units
      await Promise.all(batch.map(async (unit, idx) => {
        const unitStart = Date.now();

        const unitManifest: UnitManifest = {
          projectPath: manifest.projectPath,
          service: {
            ...unit,  // Pass all unit fields
            id: unit.id,
            name: unit.name,
            path: unit.path
          },
          modules: []
        };

        await this.runPhase('INDEXING', {
          manifest: unitManifest,
          graph: this.graph,
          workerCount: 1,
        });
        const unitTime = ((Date.now() - unitStart) / 1000).toFixed(2);
        this.logger.debug('INDEXING complete', { unit: unit.name, duration: unitTime });

        this.onProgress({
          phase: 'indexing',
          currentPlugin: 'JSModuleIndexer',
          message: `Indexed ${unit.name || unit.path} (${unitTime}s)`,
          totalFiles: unitsToProcess.length,
          processedFiles: processedUnits + idx + 1,
          servicesAnalyzed: processedUnits + idx + 1
        });
      }));

      processedUnits += batch.length;
    }
    this.profiler.end('INDEXING');
    this.logger.info('INDEXING phase complete', { duration: ((Date.now() - indexingStart) / 1000).toFixed(2) });

    // Skip remaining phases if indexOnly mode (for coverage)
    if (this.indexOnly) {
      const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(2);
      this.logger.info('indexOnly mode - skipping remaining phases', { duration: totalTime, units: unitsToProcess.length });
      return manifest;
    }

    // PHASE 2: ANALYSIS - все units (параллельно батчами)
    const analysisStart = Date.now();
    this.profiler.start('ANALYSIS');
    this.onProgress({
      phase: 'analysis',
      currentPlugin: 'Starting analysis...',
      message: 'Analyzing all units...',
      totalFiles: unitsToProcess.length,
      processedFiles: 0
    });

    // Check if parallel analysis is enabled (new functionality under flag)
    if (this.parallelConfig?.enabled) {
      await this.runParallelAnalysis(manifest);
    } else {
      // BACKWARD COMPATIBLE: per-unit batch processing (как в JS baseline)
      processedUnits = 0;

      for (let batchStart = 0; batchStart < unitsToProcess.length; batchStart += BATCH_SIZE) {
        const batch = unitsToProcess.slice(batchStart, batchStart + BATCH_SIZE);

        this.onProgress({
          phase: 'analysis',
          currentPlugin: 'Analyzers',
          message: `[${processedUnits + 1}-${processedUnits + batch.length}/${unitsToProcess.length}] Batch analyzing...`,
          totalFiles: unitsToProcess.length,
          processedFiles: processedUnits
        });

        // Параллельно анализируем батч units
        await Promise.all(batch.map(async (unit, idx) => {
          const unitStart = Date.now();
          const unitManifest: UnitManifest = {
            projectPath: manifest.projectPath,
            service: {
              ...unit,
              id: unit.id,
              name: unit.name,
              path: unit.path
            },
            modules: []
          };

          await this.runPhase('ANALYSIS', {
          manifest: unitManifest,
          graph: this.graph,
          workerCount: 1,
        });
          const unitTime = ((Date.now() - unitStart) / 1000).toFixed(2);
          this.logger.debug('ANALYSIS complete', { unit: unit.name, duration: unitTime });

          this.onProgress({
            phase: 'analysis',
            currentPlugin: 'Analyzers',
            message: `Analyzed ${unit.name || unit.path} (${unitTime}s)`,
            totalFiles: unitsToProcess.length,
            processedFiles: processedUnits + idx + 1,
            servicesAnalyzed: processedUnits + idx + 1
          });
        }));

        processedUnits += batch.length;
      }
    }

    this.profiler.end('ANALYSIS');
    this.logger.info('ANALYSIS phase complete', { duration: ((Date.now() - analysisStart) / 1000).toFixed(2) });

    // PHASE 3: ENRICHMENT - post-processing, граф traversal, вычисления (глобально)
    const enrichmentStart = Date.now();
    this.profiler.start('ENRICHMENT');
    this.onProgress({ phase: 'enrichment', currentPlugin: 'Starting enrichment...', message: 'Enriching graph data...', totalFiles: 0, processedFiles: 0 });
    await this.runPhase('ENRICHMENT', { manifest, graph: this.graph, workerCount: this.workerCount });
    this.profiler.end('ENRICHMENT');
    this.logger.info('ENRICHMENT phase complete', { duration: ((Date.now() - enrichmentStart) / 1000).toFixed(2) });

    // STRICT MODE BARRIER: Check for fatal errors after ENRICHMENT (REG-330)
    if (this.strictMode) {
      const enrichmentDiagnostics = this.diagnosticCollector.getByPhase('ENRICHMENT');
      const strictErrors = enrichmentDiagnostics.filter(d => d.severity === 'fatal');

      if (strictErrors.length > 0) {
        this.logger.error(`Strict mode: ${strictErrors.length} unresolved reference(s) found`);
        for (const err of strictErrors) {
          this.logger.error(`  [${err.code}] ${err.message}`, {
            file: err.file,
            line: err.line,
            plugin: err.plugin,
          });
        }
        throw new Error(
          `Strict mode: ${strictErrors.length} unresolved reference(s) found during ENRICHMENT. ` +
          `Run without --strict for graceful degradation, or fix the underlying issues.`
        );
      }
    }

    // PHASE 4: VALIDATION - проверка корректности графа (глобально)
    const validationStart = Date.now();
    this.profiler.start('VALIDATION');
    this.onProgress({ phase: 'validation', currentPlugin: 'Starting validation...', message: 'Validating graph structure...', totalFiles: 0, processedFiles: 0 });
    await this.runPhase('VALIDATION', { manifest, graph: this.graph, workerCount: this.workerCount });
    this.profiler.end('VALIDATION');
    this.logger.info('VALIDATION phase complete', { duration: ((Date.now() - validationStart) / 1000).toFixed(2) });

    // Flush graph to ensure all edges are persisted and queryable
    if (this.graph.flush) {
      await this.graph.flush();
    }

    const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(2);
    this.logger.info('Analysis complete', { duration: totalTime, units: unitsToProcess.length });

    // Print profiling summary
    this.profiler.printSummary();

    return manifest;
  }

  /**
   * Build unified list of indexing units from services and entrypoints
   * Each unit has: id, name, path, type, and original data
   */
  buildIndexingUnits(manifest: DiscoveryManifest): IndexingUnit[] {
    const units: IndexingUnit[] = [];
    const seenPaths = new Set<string>();

    // 1. Add services first (they have priority)
    for (const service of manifest.services || []) {
      const path = service.path || service.metadata?.entrypoint;
      if (path && !seenPaths.has(path)) {
        seenPaths.add(path);
        units.push({
          ...service,  // Spread first to allow overrides
          id: service.id,
          name: service.name,
          path: path,
          type: 'service' as const,
        });
      }
    }

    // 2. Add entrypoints that aren't already covered by services
    for (const ep of manifest.entrypoints || []) {
      const path = ep.file;
      if (path && !seenPaths.has(path)) {
        seenPaths.add(path);
        units.push({
          ...ep,  // Spread first to allow overrides
          id: ep.id,
          name: ep.name || ep.file.split('/').pop()!,
          path: path,
          type: 'entrypoint' as const,
          entrypointType: ep.type,
          trigger: ep.trigger,
        });
      }
    }

    console.log(`[Orchestrator] Built ${units.length} indexing units (${units.filter(u => u.type === 'service').length} services, ${units.filter(u => u.type === 'entrypoint').length} standalone entrypoints)`);
    return units;
  }

  /**
   * PHASE 0: Discovery - запуск плагинов DISCOVERY фазы.
   * If config services are provided, they take precedence and plugins are skipped.
   */
  async discover(projectPath: string): Promise<DiscoveryManifest> {
    // REG-174: If config provided services, use them directly instead of running discovery plugins
    if (this.configServices && this.configServices.length > 0) {
      this.logger.info('Using config-provided services (skipping discovery plugins)', {
        serviceCount: this.configServices.length
      });

      const services: ServiceInfo[] = [];
      // For each config service:
      // 1. Resolve path relative to project root (validation ensures paths are relative)
      // 2. Auto-detect entrypoint from package.json if not specified
      // 3. Fall back to 'index.js' if detection fails
      for (const configSvc of this.configServices) {
        // All paths are relative (absolute paths rejected by ConfigLoader validation)
        const servicePath = join(projectPath, configSvc.path);

        // Resolve entrypoint
        let entrypoint: string;
        if (configSvc.entryPoint) {
          entrypoint = configSvc.entryPoint;
        } else {
          // Auto-detect if not provided
          const packageJsonPath = join(servicePath, 'package.json');
          if (existsSync(packageJsonPath)) {
            try {
              const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
              entrypoint = resolveSourceEntrypoint(servicePath, pkg) ?? pkg.main ?? 'index.js';
            } catch (e) {
              this.logger.warn('Failed to read package.json for auto-detection', {
                service: configSvc.name,
                path: packageJsonPath,
                error: (e as Error).message
              });
              entrypoint = 'index.js';
            }
          } else {
            entrypoint = 'index.js';
          }
        }

        // Create SERVICE node
        const serviceNode = NodeFactory.createService(configSvc.name, servicePath, {
          discoveryMethod: 'config',
          entrypoint: entrypoint,
        });
        await this.graph.addNode(serviceNode);

        services.push({
          id: serviceNode.id,
          name: configSvc.name,
          path: servicePath,
          metadata: {
            entrypoint: join(servicePath, entrypoint),
          },
        });

        this.logger.info('Registered config service', {
          name: configSvc.name,
          path: servicePath,
          entrypoint: entrypoint
        });
      }

      return {
        services,
        entrypoints: [],  // Config services don't provide entrypoints
        projectPath: projectPath
      };
    }

    // ORIGINAL CODE: Run discovery plugins if no config services
    const context = {
      projectPath,
      graph: this.graph,
      config: this.config,
      phase: 'DISCOVERY',
      logger: this.logger,
    };

    // Фильтруем плагины для фазы DISCOVERY
    const discoveryPlugins = this.plugins.filter(p => p.metadata.phase === 'DISCOVERY');

    // Сортируем по приоритету
    discoveryPlugins.sort((a, b) =>
      (b.metadata.priority || 0) - (a.metadata.priority || 0)
    );

    const allServices: ServiceInfo[] = [];
    const allEntrypoints: EntrypointInfo[] = [];

    // Выполняем каждый плагин
    for (let i = 0; i < discoveryPlugins.length; i++) {
      const plugin = discoveryPlugins[i];

      this.onProgress({
        phase: 'discovery',
        currentPlugin: plugin.metadata.name,
        message: `Running ${plugin.metadata.name}... (${i + 1}/${discoveryPlugins.length})`
      });

      const result = await plugin.execute(context as PluginContext);

      if (result.success && result.metadata?.services) {
        allServices.push(...(result.metadata.services as ServiceInfo[]));
      }

      // Collect entrypoints from new-style plugins
      if (result.success && result.metadata?.entrypoints) {
        allEntrypoints.push(...(result.metadata.entrypoints as EntrypointInfo[]));
      }

      this.onProgress({
        phase: 'discovery',
        currentPlugin: plugin.metadata.name,
        message: `✓ ${plugin.metadata.name} complete`
      });
    }

    return {
      services: allServices,
      entrypoints: allEntrypoints,
      projectPath: projectPath
    };
  }

  /**
   * Запустить плагины для конкретной фазы
   */
  async runPhase(phaseName: string, context: Partial<PluginContext> & { graph: PluginContext['graph'] }): Promise<void> {
    // Фильтруем плагины для данной фазы
    const phasePlugins = this.plugins.filter(plugin =>
      plugin.metadata.phase === phaseName
    );

    // Сортируем по priority (больше = раньше)
    phasePlugins.sort((a, b) =>
      (b.metadata.priority || 0) - (a.metadata.priority || 0)
    );

    // Выполняем плагины последовательно
    for (let i = 0; i < phasePlugins.length; i++) {
      const plugin = phasePlugins[i];
      this.onProgress({
        phase: phaseName.toLowerCase(),
        currentPlugin: plugin.metadata.name,
        message: `Running plugin ${i + 1}/${phasePlugins.length}: ${plugin.metadata.name}`
      });
      // Передаем onProgress и forceAnalysis в контекст для плагинов
      const pluginContext: PluginContext = {
        ...context,
        onProgress: this.onProgress as unknown as PluginContext['onProgress'],
        forceAnalysis: this.forceAnalysis,
        logger: this.logger,
        strictMode: this.strictMode, // REG-330: Pass strict mode flag
      };

      // Add reportIssue for VALIDATION phase
      if (phaseName === 'VALIDATION') {
        pluginContext.reportIssue = async (issue: IssueSpec): Promise<string> => {
          const node = NodeFactory.createIssue(
            issue.category,
            issue.severity as IssueSeverity,
            issue.message,
            plugin.metadata.name,
            issue.file,
            issue.line,
            issue.column || 0,
            { context: issue.context }
          );
          await context.graph.addNode(node);
          if (issue.targetNodeId) {
            await context.graph.addEdge({
              src: node.id,
              dst: issue.targetNodeId,
              type: 'AFFECTS',
            });
          }
          return node.id;
        };
      }

      try {
        const result = await plugin.execute(pluginContext);

        // Collect errors into diagnostics
        this.diagnosticCollector.addFromPluginResult(
          phaseName as PluginPhase,
          plugin.metadata.name,
          result
        );

        // Log plugin completion with warning if errors occurred
        if (!result.success) {
          console.warn(`[Orchestrator] Plugin ${plugin.metadata.name} reported failure`, {
            errors: result.errors.length,
            warnings: result.warnings.length,
          });
        }

        // Check for fatal errors - STOP immediately
        if (this.diagnosticCollector.hasFatal()) {
          const allDiagnostics = this.diagnosticCollector.getAll();
          const fatal = allDiagnostics.find(d => d.severity === 'fatal');
          throw new Error(`Fatal error in ${plugin.metadata.name}: ${fatal?.message || 'Unknown fatal error'}`);
        }
      } catch (e) {
        // Plugin threw an exception (not just returned errors)
        const error = e instanceof Error ? e : new Error(String(e));

        // Don't re-add if this was already a fatal error we threw
        if (!this.diagnosticCollector.hasFatal()) {
          this.diagnosticCollector.add({
            code: 'ERR_PLUGIN_THREW',
            severity: 'fatal',
            message: error.message,
            phase: phaseName as PluginPhase,
            plugin: plugin.metadata.name,
          });
        }
        throw error; // Re-throw to stop analysis
      }

      // Send completion for this plugin
      this.onProgress({
        phase: phaseName.toLowerCase(),
        currentPlugin: plugin.metadata.name,
        message: `✓ ${plugin.metadata.name} complete`
      });
    }
  }

  /**
   * Get the diagnostic collector for retrieving all collected diagnostics
   */
  getDiagnostics(): DiagnosticCollector {
    return this.diagnosticCollector;
  }

  /**
   * Run queue-based parallel analysis using worker_threads and RFDB server
   *
   * Architecture:
   * - Tasks are queued per-file with list of applicable plugins
   * - Workers pick tasks, run plugins, write directly to RFDB
   * - Barrier waits for all tasks before ENRICHMENT phase
   */
  async runParallelAnalysis(manifest: DiscoveryManifest): Promise<void> {
    const socketPath = this.parallelConfig!.socketPath || '/tmp/rfdb.sock';
    const maxWorkers = this.parallelConfig!.maxWorkers || null;

    // Get the database path from the main graph backend
    const mainDbPath = (this.graph as unknown as { dbPath?: string }).dbPath || join(manifest.projectPath, '.grafema', 'graph.rfdb');

    console.log(`[Orchestrator] Starting queue-based parallel analysis...`);
    console.log(`[Orchestrator] Using database: ${mainDbPath}`);

    // Start RFDB server using the SAME database as main graph
    await this.startRfdbServer(socketPath, mainDbPath);

    // Get ANALYSIS plugins that should run in workers
    const analysisPlugins = this.plugins
      .filter(p => p.metadata?.phase === 'ANALYSIS')
      .map(p => p.metadata.name);

    console.log(`[Orchestrator] Analysis plugins: ${analysisPlugins.join(', ')}`);

    // Create analysis queue
    this.analysisQueue = new AnalysisQueue({
      socketPath,
      maxWorkers: maxWorkers || undefined,
      plugins: analysisPlugins,
    });

    // Start workers
    await this.analysisQueue.start();

    // Get all MODULE nodes from graph and queue them
    let moduleCount = 0;
    for await (const node of this.graph.queryNodes({ type: 'MODULE' })) {
      // Skip non-JS/TS files
      if (!node.file?.match(/\.(js|jsx|ts|tsx|mjs|cjs)$/)) continue;

      this.analysisQueue.addTask({
        file: node.file,
        moduleId: node.id,
        moduleName: node.name as string,
        plugins: analysisPlugins, // All plugins for now; workers filter by imports
      });
      moduleCount++;
    }

    console.log(`[Orchestrator] Queued ${moduleCount} modules for analysis...`);

    // Subscribe to progress events
    this.analysisQueue.on('taskCompleted', ({ file, stats, duration }: { file: string; stats?: { nodes?: number }; duration: number }) => {
      this.onProgress({
        phase: 'analysis',
        currentPlugin: 'AnalysisQueue',
        message: `${file.split('/').pop()} (${stats?.nodes || 0} nodes, ${duration}ms)`,
      });
    });

    this.analysisQueue.on('taskFailed', ({ file, error }: { file: string; error: string }) => {
      console.error(`[Orchestrator] Analysis failed for ${file}: ${error}`);
    });

    // Wait for all tasks to complete (barrier)
    const stats = await this.analysisQueue.waitForCompletion();

    console.log(`[Orchestrator] Queue complete: ${stats.nodesCreated} nodes, ${stats.edgesCreated} edges`);
    console.log(`[Orchestrator] ${stats.tasksCompleted} succeeded, ${stats.tasksFailed} failed`);

    // Stop workers and server
    await this.analysisQueue.stop();
    this.analysisQueue = null;
    await this.stopRfdbServer();
  }

  /**
   * Start RFDB server process (or connect to existing one)
   * @param socketPath - Unix socket path for the server
   * @param dbPath - Database path (should be same as main graph)
   */
  async startRfdbServer(socketPath: string, dbPath: string): Promise<void> {
    // Check if server is already running (socket exists and is connectable)
    if (existsSync(socketPath)) {
      // Try to connect to existing server
      try {
        const { RFDBClient } = await import('@grafema/rfdb-client');
        const testClient = new RFDBClient(socketPath);
        await testClient.connect();
        await testClient.ping();
        await testClient.close();
        console.log(`[Orchestrator] Using existing RFDB server at ${socketPath}`);
        this.rfdbServerProcess = null; // Mark that we didn't start the server
        this._serverWasExternal = true;
        return;
      } catch (e) {
        // Socket exists but server not responding, remove stale socket
        console.log(`[Orchestrator] Stale socket found, removing...`);
        unlinkSync(socketPath);
      }
    }

    // Check if server binary exists
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const serverBinary = join(projectRoot, 'packages/rfdb-server/target/release/rfdb-server');
    const debugBinary = join(projectRoot, 'packages/rfdb-server/target/debug/rfdb-server');

    let binaryPath = existsSync(serverBinary) ? serverBinary : debugBinary;

    if (!existsSync(binaryPath)) {
      console.log(`[Orchestrator] RFDB server binary not found at ${binaryPath}, building...`);
      execSync('cargo build --bin rfdb-server', {
        cwd: join(projectRoot, 'packages/rfdb-server'),
        stdio: 'inherit',
      });
      binaryPath = debugBinary;
    }

    console.log(`[Orchestrator] Starting RFDB server: ${binaryPath} with db: ${dbPath}`);
    this.rfdbServerProcess = spawn(binaryPath, [dbPath, '--socket', socketPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this._serverWasExternal = false;

    this.rfdbServerProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (!msg.includes('FLUSH') && !msg.includes('WRITER')) {
        console.log(`[rfdb-server] ${msg}`);
      }
    });

    // Wait for server to start
    let attempts = 0;
    while (!existsSync(socketPath) && attempts < 30) {
      await sleep(100);
      attempts++;
    }

    if (!existsSync(socketPath)) {
      throw new Error('RFDB server failed to start');
    }

    console.log(`[Orchestrator] RFDB server started on ${socketPath}`);
  }

  /**
   * Stop RFDB server process (only if we started it)
   */
  async stopRfdbServer(): Promise<void> {
    // Don't stop external server (started by MCP or another process)
    if (this._serverWasExternal) {
      console.log(`[Orchestrator] Leaving external RFDB server running`);
      return;
    }

    if (this.rfdbServerProcess) {
      this.rfdbServerProcess.kill('SIGTERM');
      await sleep(200);
      this.rfdbServerProcess = null;
      console.log(`[Orchestrator] RFDB server stopped`);
    }
  }
}
