/**
 * Orchestrator - управляет процессом анализа через фазы
 * Полностью абстрактный - специфичная логика в плагинах
 */

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import type { ChildProcess } from 'child_process';
import { spawn, execSync } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import { SimpleProjectDiscovery } from './plugins/discovery/SimpleProjectDiscovery.js';
import { resolveSourceEntrypoint } from './plugins/discovery/resolveSourceEntrypoint.js';
import { Profiler } from './core/Profiler.js';
import { AnalysisQueue } from './core/AnalysisQueue.js';
import { DiagnosticCollector } from './diagnostics/DiagnosticCollector.js';
import { StrictModeFailure } from './errors/GrafemaError.js';
import { ResourceRegistryImpl } from './core/ResourceRegistry.js';
import type { Plugin, PluginContext } from './plugins/Plugin.js';
import type { GraphBackend, Logger, ServiceDefinition, RoutingRule } from '@grafema/types';
import { createLogger } from './logging/Logger.js';
import { NodeFactory } from './core/NodeFactory.js';
import { toposort } from './core/toposort.js';
import { PhaseRunner } from './PhaseRunner.js';
import type { ProgressCallback } from './PhaseRunner.js';
import { GraphInitializer } from './GraphInitializer.js';
export type { ProgressInfo, ProgressCallback } from './PhaseRunner.js';

// Re-export types from OrchestratorTypes (REG-462)
export type {
  ParallelConfig,
  OrchestratorOptions,
  ServiceInfo,
  EntrypointInfo,
  DiscoveryManifest,
  IndexingUnit,
  UnitManifest,
} from './OrchestratorTypes.js';

import type {
  ParallelConfig,
  OrchestratorOptions,
  ServiceInfo,
  EntrypointInfo,
  DiscoveryManifest,
  IndexingUnit,
  UnitManifest,
} from './OrchestratorTypes.js';

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
  /** Multi-root workspace roots (REG-76) */
  private workspaceRoots: string[] | undefined;
  /** Resource registry for inter-plugin communication (REG-256) */
  private resourceRegistry = new ResourceRegistryImpl();
  /** Routing rules from config (REG-256) */
  private routing: RoutingRule[] | undefined;
  /** Phase executor (extracted from runPhase, RFD-16) */
  private phaseRunner!: PhaseRunner;
  /** Graph setup: plugin nodes, field declarations, meta node (REG-462) */
  private graphInitializer!: GraphInitializer;

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

    // Multi-root workspace configuration (REG-76)
    this.workspaceRoots = options.workspaceRoots;

    // Routing rules from config (REG-256)
    this.routing = options.routing;

    // Initialize phase runner (RFD-16: extracted from runPhase)
    this.phaseRunner = new PhaseRunner({
      plugins: this.plugins,
      onProgress: this.onProgress,
      forceAnalysis: this.forceAnalysis,
      logger: this.logger,
      strictMode: this.strictMode,
      diagnosticCollector: this.diagnosticCollector,
      resourceRegistry: this.resourceRegistry,
      configServices: this.configServices,
      routing: this.routing,
    });

    // Initialize graph initializer (REG-462: extracted from Orchestrator)
    this.graphInitializer = new GraphInitializer(this.graph, this.plugins, this.logger);

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

    // REG-357: Reset suppressed count for each run
    this.phaseRunner.resetSuppressedByIgnoreCount();

    // REG-256: Reset resource registry for each run
    this.resourceRegistry.clear();

    // Resolve to absolute path
    const absoluteProjectPath = projectPath.startsWith('/') ? projectPath : resolve(projectPath);

    // REG-76: Multi-root workspace support
    // If workspaceRoots is provided, run analysis for each root with rootPrefix
    if (this.workspaceRoots && this.workspaceRoots.length > 0) {
      return this.runMultiRoot(absoluteProjectPath);
    }

    // RADICAL SIMPLIFICATION: Clear entire graph once at the start if forceAnalysis
    if (this.forceAnalysis && this.graph.clear) {
      this.logger.info('Clearing entire graph (forceAnalysis=true)');
      await this.graph.clear();
      this.logger.info('Graph cleared successfully');
    }

    // Initialize graph: plugin nodes, field declarations (REG-386, REG-398)
    await this.graphInitializer.init(absoluteProjectPath);

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
    const enrichmentTypes = await this.runPhase('ENRICHMENT', { manifest, graph: this.graph, workerCount: this.workerCount });
    this.profiler.end('ENRICHMENT');
    this.logger.info('ENRICHMENT phase complete', { duration: ((Date.now() - enrichmentStart) / 1000).toFixed(2) });

    // STRICT MODE BARRIER: Check for fatal errors after ENRICHMENT (REG-330, REG-332)
    if (this.strictMode) {
      const enrichmentDiagnostics = this.diagnosticCollector.getByPhase('ENRICHMENT');
      const strictErrors = enrichmentDiagnostics.filter(d => d.severity === 'fatal');

      if (strictErrors.length > 0) {
        this.logger.error(`Strict mode: ${strictErrors.length} unresolved reference(s) found`);
        // REG-357: Pass suppressedByIgnore count from enrichment plugin results
        throw new StrictModeFailure(strictErrors, this.phaseRunner.getSuppressedByIgnoreCount());
      }
    }

    // GUARANTEE CHECK: Verify invariants after enrichment, before validation (RFD-18)
    await this.runGuaranteeCheck(enrichmentTypes, absoluteProjectPath);

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

    // REG-256: Clear resources after run
    this.resourceRegistry.clear();

    return manifest;
  }

  /**
   * REG-76: Run analysis for multi-root workspace.
   * Each root is analyzed separately with rootPrefix in context.
   * All results go to the same unified graph.
   */
  private async runMultiRoot(workspacePath: string): Promise<DiscoveryManifest> {
    const totalStartTime = Date.now();
    const roots = this.workspaceRoots!;

    this.logger.info('Multi-root workspace mode', { roots: roots.length });

    // Clear graph once at the start if forceAnalysis
    if (this.forceAnalysis && this.graph.clear) {
      this.logger.info('Clearing entire graph (forceAnalysis=true)');
      await this.graph.clear();
      this.logger.info('Graph cleared successfully');
    }

    // Initialize graph: plugin nodes, field declarations, meta node (REG-386, REG-398, REG-408)
    await this.graphInitializer.init(workspacePath);

    // Collect all services from all roots
    const allServices: ServiceInfo[] = [];
    const allEntrypoints: EntrypointInfo[] = [];

    // Process each root
    for (let rootIdx = 0; rootIdx < roots.length; rootIdx++) {
      const rootRelativePath = roots[rootIdx];
      const rootName = basename(rootRelativePath);
      const rootAbsolutePath = join(workspacePath, rootRelativePath);

      this.logger.info(`Processing root ${rootIdx + 1}/${roots.length}`, {
        root: rootName,
        path: rootAbsolutePath
      });

      // Discover services in this root
      const rootManifest = await this.discoverInRoot(rootAbsolutePath, rootName);

      // Build indexing units for this root
      const units = this.buildIndexingUnits(rootManifest);

      // INDEXING phase for this root
      for (const unit of units) {
        const unitManifest: UnitManifest = {
          projectPath: rootAbsolutePath,
          service: {
            ...unit,
            id: unit.id,
            name: unit.name,
            path: unit.path
          },
          modules: [],
          rootPrefix: rootName,  // REG-76: Pass root prefix
        };

        await this.runPhase('INDEXING', {
          manifest: unitManifest,
          graph: this.graph,
          workerCount: 1,
          rootPrefix: rootName,  // Pass to context
        });
      }

      // ANALYSIS phase for this root
      if (!this.indexOnly) {
        for (const unit of units) {
          const unitManifest: UnitManifest = {
            projectPath: rootAbsolutePath,
            service: {
              ...unit,
              id: unit.id,
              name: unit.name,
              path: unit.path
            },
            modules: [],
            rootPrefix: rootName,
          };

          await this.runPhase('ANALYSIS', {
            manifest: unitManifest,
            graph: this.graph,
            workerCount: 1,
            rootPrefix: rootName,
          });
        }
      }

      // Collect services with root prefix in path for unified manifest
      for (const svc of rootManifest.services) {
        allServices.push({
          ...svc,
          // Prefix path with root name for unified manifest
          path: svc.path ? `${rootName}/${svc.path.replace(rootAbsolutePath + '/', '')}` : undefined,
        });
      }

      for (const ep of rootManifest.entrypoints) {
        allEntrypoints.push({
          ...ep,
          file: `${rootName}/${ep.file.replace(rootAbsolutePath + '/', '')}`,
        });
      }
    }

    // Create unified manifest
    const unifiedManifest: DiscoveryManifest = {
      services: allServices,
      entrypoints: allEntrypoints,
      projectPath: workspacePath,
    };

    // Skip remaining phases if indexOnly
    if (this.indexOnly) {
      const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(2);
      this.logger.info('indexOnly mode - skipping remaining phases', { duration: totalTime });
      return unifiedManifest;
    }

    // ENRICHMENT phase (global - operates on unified graph)
    this.profiler.start('ENRICHMENT');
    const enrichmentTypes = await this.runPhase('ENRICHMENT', {
      manifest: unifiedManifest,
      graph: this.graph,
      workerCount: this.workerCount
    });
    this.profiler.end('ENRICHMENT');

    // STRICT MODE BARRIER: Check for fatal errors after ENRICHMENT (REG-391)
    // Same barrier as single-root run() path (REG-330, REG-332)
    if (this.strictMode) {
      const enrichmentDiagnostics = this.diagnosticCollector.getByPhase('ENRICHMENT');
      const strictErrors = enrichmentDiagnostics.filter(d => d.severity === 'fatal');

      if (strictErrors.length > 0) {
        this.logger.error(`Strict mode: ${strictErrors.length} unresolved reference(s) found`);
        throw new StrictModeFailure(strictErrors, this.phaseRunner.getSuppressedByIgnoreCount());
      }
    }

    // GUARANTEE CHECK: Verify invariants after enrichment, before validation (RFD-18)
    await this.runGuaranteeCheck(enrichmentTypes, workspacePath);

    // VALIDATION phase (global)
    this.profiler.start('VALIDATION');
    await this.runPhase('VALIDATION', {
      manifest: unifiedManifest,
      graph: this.graph,
      workerCount: this.workerCount
    });
    this.profiler.end('VALIDATION');

    // Flush graph
    if (this.graph.flush) {
      await this.graph.flush();
    }

    const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(2);
    this.logger.info('Multi-root analysis complete', {
      duration: totalTime,
      roots: roots.length,
      services: allServices.length
    });

    this.profiler.printSummary();

    // REG-256: Clear resources after run
    this.resourceRegistry.clear();

    return unifiedManifest;
  }

  /**
   * Discover services in a specific root directory.
   * Uses the same discovery logic but scoped to the root.
   */
  private async discoverInRoot(rootPath: string, _rootName: string): Promise<DiscoveryManifest> {
    // For now, use the same discovery mechanism
    // rootName is available for future use if needed
    return this.discover(rootPath);
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

    this.logger.debug('Built indexing units', {
      total: units.length,
      services: units.filter(u => u.type === 'service').length,
      entrypoints: units.filter(u => u.type === 'entrypoint').length
    });
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
              const message = e instanceof Error ? e.message : String(e);
              this.logger.warn('Failed to read package.json for auto-detection', {
                service: configSvc.name,
                path: packageJsonPath,
                error: message
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

    // Topological sort by dependencies (REG-367)
    const discoveryPluginMap = new Map(discoveryPlugins.map(p => [p.metadata.name, p]));
    const sortedDiscoveryIds = toposort(
      discoveryPlugins.map(p => ({
        id: p.metadata.name,
        dependencies: p.metadata.dependencies ?? [],
      }))
    );
    discoveryPlugins.length = 0;
    for (const id of sortedDiscoveryIds) {
      const plugin = discoveryPluginMap.get(id);
      if (plugin) discoveryPlugins.push(plugin);
    }

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

      // Warn if plugin created nodes but didn't return services/entrypoints in metadata
      // This catches common mistake of not returning services via result.metadata.services
      if (result.success && result.created.nodes > 0 &&
          !result.metadata?.services && !result.metadata?.entrypoints) {
        this.logger.warn('Discovery plugin created nodes but returned no services/entrypoints in metadata', {
          plugin: plugin.metadata.name,
          nodesCreated: result.created.nodes,
          hint: 'Services must be returned via result.metadata.services for Orchestrator to index them'
        });
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
  async runPhase(phaseName: string, context: Partial<PluginContext> & { graph: PluginContext['graph'] }): Promise<Set<string>> {
    return this.phaseRunner.runPhase(phaseName, context);
  }

  /**
   * Get the diagnostic collector for retrieving all collected diagnostics
   */
  getDiagnostics(): DiagnosticCollector {
    return this.diagnosticCollector;
  }

  /**
   * Run guarantee checks after enrichment, before validation (RFD-18).
   * Uses selective checking when enrichment produced type changes,
   * falls back to checkAll when no type info is available.
   */
  private async runGuaranteeCheck(changedTypes: Set<string>, projectPath: string): Promise<void> {
    const { GuaranteeManager } = await import('./core/GuaranteeManager.js');

    const manager = new GuaranteeManager(this.graph as any, projectPath);
    const guarantees = await manager.list();

    if (guarantees.length === 0) {
      this.logger.debug('No guarantees to check');
      this.checkCoverageGaps(changedTypes);
      return;
    }

    const startTime = Date.now();
    this.profiler.start('GUARANTEE_CHECK');
    this.onProgress({ phase: 'guarantee', currentPlugin: 'GuaranteeCheck', message: 'Checking guarantees...' });

    const result = changedTypes.size > 0
      ? await manager.checkSelective(changedTypes)
      : await manager.checkAll();

    // Collect violations into diagnostics
    for (const r of result.results) {
      if (!r.passed && !r.error) {
        for (const violation of r.violations) {
          this.diagnosticCollector.add({
            code: 'GUARANTEE_VIOLATION',
            severity: r.severity === 'error' ? 'fatal' : 'warning',
            message: `Guarantee "${r.name}" violated: ${violation.type} ${violation.name || violation.nodeId}`,
            phase: 'ENRICHMENT',
            plugin: 'GuaranteeCheck',
            file: violation.file,
            line: violation.line,
          });
        }
      }
    }

    this.profiler.end('GUARANTEE_CHECK');
    this.logger.info('GUARANTEE_CHECK complete', {
      duration: ((Date.now() - startTime) / 1000).toFixed(2),
      total: result.total,
      checked: result.results.length,
      passed: result.passed,
      failed: result.failed,
    });

    this.checkCoverageGaps(changedTypes);
  }

  /**
   * Coverage monitoring canary (RFD-18).
   * Logs a warning if enrichment produced no type changes at all,
   * which may indicate a coverage gap (content changed but analysis unchanged).
   * Full per-file delta tracking requires per-file deltas (RFD-19+).
   */
  private checkCoverageGaps(changedTypes: Set<string>): void {
    if (changedTypes.size === 0) {
      this.logger.debug('Coverage canary: enrichment produced no type changes');
    }
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

    this.logger.debug('Starting queue-based parallel analysis', { database: mainDbPath });

    // Start RFDB server using the SAME database as main graph
    await this.startRfdbServer(socketPath, mainDbPath);

    // Get ANALYSIS plugins that should run in workers
    const analysisPlugins = this.plugins
      .filter(p => p.metadata?.phase === 'ANALYSIS')
      .map(p => p.metadata.name);

    this.logger.debug('Analysis plugins', { plugins: analysisPlugins });

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

    this.logger.debug('Queued modules for analysis', { count: moduleCount });

    // Subscribe to progress events
    this.analysisQueue.on('taskCompleted', ({ file, stats, duration }: { file: string; stats?: { nodes?: number }; duration: number }) => {
      this.onProgress({
        phase: 'analysis',
        currentPlugin: 'AnalysisQueue',
        message: `${file.split('/').pop()} (${stats?.nodes || 0} nodes, ${duration}ms)`,
      });
    });

    this.analysisQueue.on('taskFailed', ({ file, error }: { file: string; error: string }) => {
      this.logger.error('Analysis failed', { file, error });
    });

    // Wait for all tasks to complete (barrier)
    const stats = await this.analysisQueue.waitForCompletion();

    this.logger.debug('Queue complete', {
      nodesCreated: stats.nodesCreated,
      edgesCreated: stats.edgesCreated,
      succeeded: stats.tasksCompleted,
      failed: stats.tasksFailed
    });

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
        this.logger.debug('Using existing RFDB server', { socketPath });
        this.rfdbServerProcess = null; // Mark that we didn't start the server
        this._serverWasExternal = true;
        return;
      } catch {
        // Socket exists but server not responding, remove stale socket
        this.logger.debug('Stale socket found, removing');
        unlinkSync(socketPath);
      }
    }

    // Check if server binary exists
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const serverBinary = join(projectRoot, 'packages/rfdb-server/target/release/rfdb-server');
    const debugBinary = join(projectRoot, 'packages/rfdb-server/target/debug/rfdb-server');

    let binaryPath = existsSync(serverBinary) ? serverBinary : debugBinary;

    if (!existsSync(binaryPath)) {
      this.logger.debug('RFDB server binary not found, building', { path: binaryPath });
      execSync('cargo build --bin rfdb-server', {
        cwd: join(projectRoot, 'packages/rfdb-server'),
        stdio: 'inherit',
      });
      binaryPath = debugBinary;
    }

    this.logger.debug('Starting RFDB server', { binary: binaryPath, database: dbPath });
    this.rfdbServerProcess = spawn(binaryPath, [dbPath, '--socket', socketPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this._serverWasExternal = false;

    this.rfdbServerProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (!msg.includes('FLUSH') && !msg.includes('WRITER')) {
        this.logger.debug('rfdb-server', { message: msg });
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

    this.logger.debug('RFDB server started', { socketPath });
  }

  /**
   * Stop RFDB server process (only if we started it)
   */
  async stopRfdbServer(): Promise<void> {
    // Don't stop external server (started by MCP or another process)
    if (this._serverWasExternal) {
      this.logger.debug('Leaving external RFDB server running');
      return;
    }

    if (this.rfdbServerProcess) {
      this.rfdbServerProcess.kill('SIGTERM');
      await sleep(200);
      this.rfdbServerProcess = null;
      this.logger.debug('RFDB server stopped');
    }
  }
}
