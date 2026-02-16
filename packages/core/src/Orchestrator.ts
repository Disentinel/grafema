/**
 * Orchestrator - управляет процессом анализа через фазы
 * Полностью абстрактный - специфичная логика в плагинах
 */

import { join, resolve, basename } from 'path';
import { SimpleProjectDiscovery } from './plugins/discovery/SimpleProjectDiscovery.js';
import { Profiler } from './core/Profiler.js';
import { DiagnosticCollector } from './diagnostics/DiagnosticCollector.js';
import { StrictModeFailure } from './errors/GrafemaError.js';
import { ResourceRegistryImpl } from './core/ResourceRegistry.js';
import type { Plugin, PluginContext } from './plugins/Plugin.js';
import type { GraphBackend, Logger, ServiceDefinition, RoutingRule } from '@grafema/types';
import { createLogger } from './logging/Logger.js';
import { PhaseRunner } from './PhaseRunner.js';
import type { ProgressCallback } from './PhaseRunner.js';
import { GraphInitializer } from './GraphInitializer.js';
import { DiscoveryManager } from './DiscoveryManager.js';
import { GuaranteeChecker } from './GuaranteeChecker.js';
import { ParallelAnalysisRunner } from './ParallelAnalysisRunner.js';
import { COVERED_PACKAGES_RESOURCE_ID, createCoveredPackagesResource } from './plugins/validation/PackageCoverageValidator.js';
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
  /** Service/entrypoint discovery (REG-462) */
  private discoveryManager!: DiscoveryManager;
  /** Guarantee checking after enrichment (REG-462) */
  private guaranteeChecker!: GuaranteeChecker;
  /** Parallel analysis runner (REG-462) */
  private parallelRunner: ParallelAnalysisRunner | null = null;

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

    // Initialize discovery manager (REG-462: extracted from Orchestrator)
    this.discoveryManager = new DiscoveryManager(
      this.plugins, this.graph, this.config, this.logger, this.onProgress, this.configServices,
    );

    // Initialize guarantee checker (REG-462: extracted from Orchestrator)
    this.guaranteeChecker = new GuaranteeChecker(
      this.graph, this.diagnosticCollector, this.profiler, this.onProgress, this.logger,
    );

    // Initialize parallel runner if enabled (REG-462: extracted from Orchestrator)
    if (this.parallelConfig?.enabled) {
      this.parallelRunner = new ParallelAnalysisRunner(
        this.graph, this.plugins, this.parallelConfig, this.onProgress, this.logger,
      );
    }

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

    // PHASE 0: DISCOVERY
    this.profiler.start('DISCOVERY');
    const manifest = await this.discoveryManager.discover(absoluteProjectPath, this.entrypoint);
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
    const indexingUnits = this.discoveryManager.buildIndexingUnits(manifest);

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

    // PHASE 1: INDEXING
    this.profiler.start('INDEXING');
    this.onProgress({ phase: 'indexing', currentPlugin: 'Starting indexing...', message: 'Building dependency trees...', totalFiles: unitsToProcess.length, processedFiles: 0 });
    await this.runBatchPhase('INDEXING', unitsToProcess, manifest);
    this.profiler.end('INDEXING');

    // Skip remaining phases if indexOnly mode (for coverage)
    if (this.indexOnly) {
      const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(2);
      this.logger.info('indexOnly mode - skipping remaining phases', { duration: totalTime, units: unitsToProcess.length });
      return manifest;
    }

    // PHASE 2: ANALYSIS
    this.profiler.start('ANALYSIS');
    this.onProgress({ phase: 'analysis', currentPlugin: 'Starting analysis...', message: 'Analyzing all units...', totalFiles: unitsToProcess.length, processedFiles: 0 });
    if (this.parallelRunner) {
      await this.parallelRunner.run(manifest);
    } else {
      await this.runBatchPhase('ANALYSIS', unitsToProcess, manifest);
    }
    this.profiler.end('ANALYSIS');

    // PHASES 3-4: ENRICHMENT → strict barrier → guarantee → VALIDATION → flush
    await this.runPipelineEpilogue(manifest, absoluteProjectPath);

    const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(2);
    this.logger.info('Analysis complete', { duration: totalTime, units: unitsToProcess.length });

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
      const rootManifest = await this.discoveryManager.discoverInRoot(rootAbsolutePath);

      // Build indexing units for this root
      const units = this.discoveryManager.buildIndexingUnits(rootManifest);

      // INDEXING + ANALYSIS phases for this root
      const rootOpts = { rootPrefix: rootName };
      await this.runBatchPhase('INDEXING', units, rootManifest, rootOpts);
      if (!this.indexOnly) {
        await this.runBatchPhase('ANALYSIS', units, rootManifest, rootOpts);
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

    // ENRICHMENT → strict barrier → guarantee → VALIDATION → flush
    await this.runPipelineEpilogue(unifiedManifest, workspacePath);

    const totalTime = ((Date.now() - totalStartTime) / 1000).toFixed(2);
    this.logger.info('Multi-root analysis complete', { duration: totalTime, roots: roots.length, services: allServices.length });

    return unifiedManifest;
  }

  /**
   * Run a per-unit phase (INDEXING or ANALYSIS) in batches.
   * Common batch processing logic extracted from run() (REG-462).
   */
  private async runBatchPhase(
    phaseName: string,
    units: IndexingUnit[],
    manifest: DiscoveryManifest,
    options?: { rootPrefix?: string },
  ): Promise<void> {
    const phase = phaseName.toLowerCase() as 'indexing' | 'analysis';
    const pluginLabel = phaseName === 'INDEXING' ? 'JSModuleIndexer' : 'Analyzers';
    const BATCH_SIZE = this.workerCount;
    let processedUnits = 0;

    for (let batchStart = 0; batchStart < units.length; batchStart += BATCH_SIZE) {
      const batch = units.slice(batchStart, batchStart + BATCH_SIZE);

      this.onProgress({
        phase,
        currentPlugin: pluginLabel,
        message: `[${processedUnits + 1}-${processedUnits + batch.length}/${units.length}] Batch ${phase}...`,
        totalFiles: units.length,
        processedFiles: processedUnits
      });

      for (let idx = 0; idx < batch.length; idx++) {
        const unit = batch[idx];
        const unitStart = Date.now();
        const unitManifest: UnitManifest = {
          projectPath: manifest.projectPath,
          service: { ...unit, id: unit.id, name: unit.name, path: unit.path },
          modules: [],
          rootPrefix: options?.rootPrefix,
        };

        await this.runPhase(phaseName, {
          manifest: unitManifest,
          graph: this.graph,
          workerCount: 1,
          ...(options?.rootPrefix ? { rootPrefix: options.rootPrefix } : {}),
        });
        const unitTime = ((Date.now() - unitStart) / 1000).toFixed(2);
        this.logger.debug(`${phaseName} complete`, { unit: unit.name, duration: unitTime });

        this.onProgress({
          phase,
          currentPlugin: pluginLabel,
          message: `${unit.name || unit.path} (${unitTime}s)`,
          totalFiles: units.length,
          processedFiles: processedUnits + idx + 1,
          servicesAnalyzed: processedUnits + idx + 1
        });
      }

      processedUnits += batch.length;
    }
  }

  /**
   * Run post-indexing pipeline: ENRICHMENT → strict barrier → guarantee → VALIDATION → flush.
   * Common epilogue shared by run() and runMultiRoot() (REG-462).
   */
  private async runPipelineEpilogue(manifest: DiscoveryManifest, projectPath: string): Promise<void> {
    // ENRICHMENT phase (global)
    const enrichmentStart = Date.now();
    this.profiler.start('ENRICHMENT');
    this.onProgress({ phase: 'enrichment', currentPlugin: 'Starting enrichment...', message: 'Enriching graph data...', totalFiles: 0, processedFiles: 0 });
    const enrichmentTypes = await this.runPhase('ENRICHMENT', { manifest, graph: this.graph, workerCount: this.workerCount });
    this.profiler.end('ENRICHMENT');
    this.logger.info('ENRICHMENT phase complete', { duration: ((Date.now() - enrichmentStart) / 1000).toFixed(2) });

    // STRICT MODE BARRIER (REG-330, REG-332)
    if (this.strictMode) {
      const enrichmentDiagnostics = this.diagnosticCollector.getByPhase('ENRICHMENT');
      const strictErrors = enrichmentDiagnostics.filter(d => d.severity === 'fatal');

      if (strictErrors.length > 0) {
        this.logger.error(`Strict mode: ${strictErrors.length} unresolved reference(s) found`);
        throw new StrictModeFailure(strictErrors, this.phaseRunner.getSuppressedByIgnoreCount());
      }
    }

    // GUARANTEE CHECK (RFD-18)
    await this.guaranteeChecker.check(enrichmentTypes, projectPath);

    // REG-259: Compute covered packages from plugin metadata before validation
    this.storeCoveredPackages();

    // VALIDATION phase (global)
    const validationStart = Date.now();
    this.profiler.start('VALIDATION');
    this.onProgress({ phase: 'validation', currentPlugin: 'Starting validation...', message: 'Validating graph structure...', totalFiles: 0, processedFiles: 0 });
    await this.runPhase('VALIDATION', { manifest, graph: this.graph, workerCount: this.workerCount });
    this.profiler.end('VALIDATION');
    this.logger.info('VALIDATION phase complete', { duration: ((Date.now() - validationStart) / 1000).toFixed(2) });

    // Flush and cleanup
    if (this.graph.flush) {
      await this.graph.flush();
    }
    this.profiler.printSummary();
    this.resourceRegistry.clear();
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
   * Run discovery for a project path.
   * Delegates to DiscoveryManager. Public API for MCP and other callers.
   */
  async discover(projectPath: string): Promise<DiscoveryManifest> {
    return this.discoveryManager.discover(projectPath);
  }

  /**
   * REG-259: Collect package names from plugin `covers` metadata
   * and store them in the ResourceRegistry for PackageCoverageValidator.
   */
  private storeCoveredPackages(): void {
    const coveredPackages = new Set<string>();
    for (const plugin of this.plugins) {
      const covers = plugin.metadata?.covers ?? [];
      for (const pkg of covers) {
        coveredPackages.add(pkg);
      }
    }

    this.resourceRegistry.getOrCreate(COVERED_PACKAGES_RESOURCE_ID, () =>
      createCoveredPackagesResource(coveredPackages)
    );

    this.logger.debug('Stored covered packages for validation', {
      count: coveredPackages.size,
      packages: [...coveredPackages],
    });
  }

  /**
   * Build unified list of indexing units from manifest.
   * Delegates to DiscoveryManager. Public API for external callers.
   */
  buildIndexingUnits(manifest: DiscoveryManifest): IndexingUnit[] {
    return this.discoveryManager.buildIndexingUnits(manifest);
  }

}
