/**
 * PhaseRunner - Executes plugin phases with toposort ordering
 *
 * Extracted from Orchestrator.ts (RFD-16, STEP 2.5) to keep
 * Orchestrator as coordinator, PhaseRunner as executor.
 *
 * RFD-17: Enrichment dependency propagation — when an enricher's delta
 * has changedEdgeTypes, downstream enrichers consuming those types are
 * enqueued and re-run. Queue respects topological order, each enricher
 * runs at most once.
 */

import type { Plugin, PluginContext } from './plugins/Plugin.js';
import type { PluginPhase, PluginResult, Logger, IssueSpec, ServiceDefinition, RoutingRule, ResourceRegistry, CommitDelta } from '@grafema/types';
import { NodeFactory } from './core/NodeFactory.js';
import { toposort } from './core/toposort.js';
import { buildDependencyGraph } from './core/buildDependencyGraph.js';
import type { DiagnosticCollector } from './diagnostics/DiagnosticCollector.js';
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
  totalServices?: number;
  currentService?: string;
}

/**
 * Progress callback type
 */
export type ProgressCallback = (info: ProgressInfo) => void;

/**
 * Dependencies injected into PhaseRunner
 */
export interface PhaseRunnerDeps {
  plugins: Plugin[];
  onProgress: ProgressCallback;
  forceAnalysis: boolean;
  logger: Logger;
  strictMode: boolean;
  diagnosticCollector: DiagnosticCollector;
  resourceRegistry: ResourceRegistry;
  configServices?: ServiceDefinition[];
  routing?: RoutingRule[];
}

export class PhaseRunner {
  private suppressedByIgnoreCount = 0;

  constructor(private deps: PhaseRunnerDeps) {}

  getSuppressedByIgnoreCount(): number {
    return this.suppressedByIgnoreCount;
  }

  resetSuppressedByIgnoreCount(): void {
    this.suppressedByIgnoreCount = 0;
  }

  /**
   * Execute a plugin wrapped in a CommitBatch.
   * If the backend doesn't support batching, falls back to direct execution.
   * Returns the PluginResult and an optional CommitDelta.
   */
  private async runPluginWithBatch(
    plugin: Plugin,
    pluginContext: PluginContext,
    phaseName: string,
  ): Promise<{ result: PluginResult; delta: CommitDelta | null }> {
    const graph = pluginContext.graph;

    // Fallback: backend doesn't support batching
    if (!graph.beginBatch || !graph.commitBatch || !graph.abortBatch) {
      const result = await plugin.execute(pluginContext);
      return { result, delta: null };
    }

    const tags = [plugin.metadata.name, phaseName];
    // File tags from manifest path (available in ANALYSIS, not ENRICHMENT)
    const manifest = (pluginContext as { manifest?: { path?: string } }).manifest;
    if (manifest?.path) tags.push(manifest.path);

    graph.beginBatch();
    try {
      const result = await plugin.execute(pluginContext);
      const delta = await graph.commitBatch(tags);
      return { result, delta };
    } catch (error) {
      graph.abortBatch();
      throw error;
    }
  }

  /**
   * Build a complete PluginContext from partial context + injected deps.
   * Extracted from runPhase() (RFD-17, STEP 2.5) for reuse in propagation path.
   */
  private buildPluginContext(
    baseContext: Partial<PluginContext> & { graph: PluginContext['graph'] },
    phaseName: string,
    plugin: Plugin,
  ): PluginContext {
    const { onProgress, forceAnalysis, logger, strictMode, resourceRegistry, configServices, routing } = this.deps;

    const pluginContext: PluginContext = {
      ...baseContext,
      onProgress: onProgress as unknown as PluginContext['onProgress'],
      forceAnalysis: forceAnalysis,
      logger: logger,
      strictMode: strictMode, // REG-330: Pass strict mode flag
      // REG-76: Pass rootPrefix for multi-root workspace support
      rootPrefix: (baseContext as { rootPrefix?: string }).rootPrefix,
      // REG-256: Pass resource registry for inter-plugin communication
      resources: resourceRegistry,
    };

    // REG-256: Ensure config is available with routing and services for all plugins
    if (!pluginContext.config) {
      pluginContext.config = {
        projectPath: (baseContext as { manifest?: { projectPath?: string } }).manifest?.projectPath ?? '',
        services: configServices,
        routing: routing,
      };
    } else {
      // Merge routing and services into existing config
      const cfg = pluginContext.config as unknown as Record<string, unknown>;
      if (routing && !cfg.routing) {
        cfg.routing = routing;
      }
      if (configServices && !cfg.services) {
        cfg.services = configServices;
      }
    }

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
        await baseContext.graph.addNode(node);
        if (issue.targetNodeId) {
          await baseContext.graph.addEdge({
            src: node.id,
            dst: issue.targetNodeId,
            type: 'AFFECTS',
          });
        }
        return node.id;
      };
    }

    return pluginContext;
  }

  /**
   * Extract service dependency package names from the ANALYSIS phase manifest.
   * Merges dependencies + devDependencies + peerDependencies from package.json.
   * Returns empty Set when no package.json is available (non-npm service).
   */
  /**
   * Extract service dependency package names from the manifest.
   * Handles both per-service (manifest.service) and global (manifest.services[]) contexts.
   * Returns null when no packageJson is available (cannot filter — run all plugins).
   * Returns empty Set when packageJson exists but has no dependencies (filter can be applied).
   */
  private extractServiceDependencies(context: Partial<PluginContext>): Set<string> | null {
    const manifest = context.manifest as Record<string, unknown>;

    // Collect packageJson objects from all available sources:
    // - manifest.service (per-service context from INDEXING)
    // - manifest.services[] (global context from ANALYSIS after REG-478)
    const packageJsons: Record<string, unknown>[] = [];

    const service = manifest?.service as Record<string, unknown> | undefined;
    if (service) {
      const meta = service.metadata as Record<string, unknown> | undefined;
      const pj = meta?.packageJson as Record<string, unknown> | undefined;
      if (pj) packageJsons.push(pj);
    }

    const services = manifest?.services as Record<string, unknown>[] | undefined;
    if (services && Array.isArray(services)) {
      for (const svc of services) {
        const meta = svc.metadata as Record<string, unknown> | undefined;
        const pj = meta?.packageJson as Record<string, unknown> | undefined;
        if (pj) packageJsons.push(pj);
      }
    }

    // No packageJson found anywhere — cannot filter, signal with null
    if (packageJsons.length === 0) return null;

    const deps = new Set<string>();
    for (const packageJson of packageJsons) {
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const fieldValue = packageJson[field];
        if (fieldValue && typeof fieldValue === 'object') {
          for (const pkg of Object.keys(fieldValue as Record<string, unknown>)) {
            deps.add(pkg);
          }
        }
      }
    }
    return deps;
  }

  /**
   * Execute a plugin, collect diagnostics, and check for fatal errors.
   * Shared between the fallback loop and the propagation path.
   * Returns the delta from the batch commit (if any).
   */
  private async executePlugin(
    plugin: Plugin,
    context: Partial<PluginContext> & { graph: PluginContext['graph'] },
    phaseName: string,
  ): Promise<CommitDelta | null> {
    const { logger, strictMode, diagnosticCollector } = this.deps;
    const pluginName = plugin.metadata.name;
    const pluginContext = this.buildPluginContext(context, phaseName, plugin);

    try {
      const { result, delta } = await this.runPluginWithBatch(plugin, pluginContext, phaseName);

      // Log batch delta
      if (delta) {
        logger.debug(
          `[${pluginName}] batch: +${delta.nodesAdded} nodes, +${delta.edgesAdded} edges, ` +
          `-${delta.nodesRemoved} nodes, -${delta.edgesRemoved} edges`
        );
      }

      // Collect errors into diagnostics
      diagnosticCollector.addFromPluginResult(
        phaseName as PluginPhase,
        pluginName,
        result
      );

      // REG-357: Collect suppressedByIgnore from ENRICHMENT plugin results
      if (phaseName === 'ENRICHMENT' && result.metadata) {
        const suppressed = (result.metadata as Record<string, unknown>).suppressedByIgnore;
        if (typeof suppressed === 'number') {
          this.suppressedByIgnoreCount += suppressed;
        }
      }

      // Log plugin completion with warning if errors occurred
      if (!result.success) {
        console.warn(`[Orchestrator] Plugin ${pluginName} reported failure`, {
          errors: result.errors.length,
          warnings: result.warnings.length,
        });
      }

      // Check for fatal errors - STOP immediately
      // REG-357: In strict mode ENRICHMENT, don't halt on strict mode errors.
      // The strict mode barrier after ENRICHMENT handles them collectively.
      if (diagnosticCollector.hasFatal()) {
        const allDiagnostics = diagnosticCollector.getAll();
        const fatals = allDiagnostics.filter(d => d.severity === 'fatal');

        // Skip halt only if ALL fatals are strict mode errors during ENRICHMENT.
        // If any non-strict fatal exists, halt immediately.
        const allStrictErrors = fatals.every(d => d.code.startsWith('STRICT_'));
        if (!(strictMode && phaseName === 'ENRICHMENT' && allStrictErrors)) {
          const fatal = fatals[0];
          throw new Error(`Fatal error in ${pluginName}: ${fatal?.message || 'Unknown fatal error'}`);
        }
      }

      return delta;
    } catch (e) {
      // Plugin threw an exception (not just returned errors)
      const error = e instanceof Error ? e : new Error(String(e));

      // Don't re-add if this was already a fatal error we threw
      if (!diagnosticCollector.hasFatal()) {
        diagnosticCollector.add({
          code: 'ERR_PLUGIN_THREW',
          severity: 'fatal',
          message: error.message,
          phase: phaseName as PluginPhase,
          plugin: pluginName,
        });
      }
      throw error; // Re-throw to stop analysis
    }
  }

  async runPhase(phaseName: string, context: Partial<PluginContext> & { graph: PluginContext['graph'] }): Promise<Set<string>> {
    const { plugins, onProgress, logger } = this.deps;

    // Filter plugins for this phase
    const phasePlugins = plugins.filter(plugin =>
      plugin.metadata.phase === phaseName
    );

    // Topological sort by dependencies (REG-367, RFD-2)
    const pluginMap = new Map(phasePlugins.map(p => [p.metadata.name, p]));

    // Build dependency graph for ENRICHMENT (includes consumer index for RFD-17),
    // or simple dependency list for other phases.
    let consumerIndex: Map<string, Set<string>> | null = null;
    const sortedIds = (() => {
      if (phaseName === 'ENRICHMENT') {
        const depInfo = buildDependencyGraph(phasePlugins);
        consumerIndex = depInfo.consumerIndex;
        return toposort(depInfo.items);
      }
      return toposort(
        phasePlugins.map(p => ({
          id: p.metadata.name,
          dependencies: p.metadata.dependencies ?? [],
        }))
      );
    })();

    phasePlugins.length = 0;
    for (const id of sortedIds) {
      const plugin = pluginMap.get(id);
      if (plugin) phasePlugins.push(plugin);
    }

    // Delta-driven selective enrichment (RFD-16 Phase 3)
    const supportsBatch = !!(context.graph.beginBatch && context.graph.commitBatch);

    // RFD-17: Use queue-based propagation for ENRICHMENT with batch support
    if (phaseName === 'ENRICHMENT' && supportsBatch && consumerIndex) {
      await this.runEnrichmentWithPropagation(phasePlugins, pluginMap, sortedIds, consumerIndex, context);
      return new Set<string>();
    }

    // Track accumulated changed types for ENRICHMENT skip optimization (fallback path)
    const accumulatedTypes = new Set<string>();

    // Pre-compute service dependencies for ANALYSIS plugin filter (REG-482)
    // null = no packageJson found, cannot filter → run all plugins
    // Set = packageJson available, filter by covers (even if Set is empty)
    const serviceDeps = phaseName === 'ANALYSIS' ? this.extractServiceDependencies(context) : null;

    // Execute plugins sequentially (non-ENRICHMENT phases or non-batch backends)
    for (let i = 0; i < phasePlugins.length; i++) {
      const plugin = phasePlugins[i];

      // Plugin applicability filter for ANALYSIS phase (REG-482)
      // Only filter when serviceDeps is a Set (packageJson was found).
      // When serviceDeps is null (no packageJson), skip filtering — run all plugins.
      if (serviceDeps !== null) {
        const covers = plugin.metadata.covers;
        if (covers && covers.length > 0) {
          if (!covers.some(pkg => serviceDeps.has(pkg))) {
            logger.debug(
              `[SKIP] ${plugin.metadata.name} — no covered packages [${covers.join(', ')}] in service dependencies`
            );
            continue;
          }
        }
      }

      onProgress({
        phase: phaseName.toLowerCase(),
        currentPlugin: plugin.metadata.name,
        message: `Running plugin ${i + 1}/${phasePlugins.length}: ${plugin.metadata.name}`
      });

      const delta = await this.executePlugin(plugin, context, phaseName);

      // Accumulate changed types for downstream enricher skip checks
      if (delta) {
        for (const t of delta.changedNodeTypes) accumulatedTypes.add(t);
        for (const t of delta.changedEdgeTypes) accumulatedTypes.add(t);
      }

      // Send completion for this plugin
      onProgress({
        phase: phaseName.toLowerCase(),
        currentPlugin: plugin.metadata.name,
        message: `✓ ${plugin.metadata.name} complete`
      });
    }

    return accumulatedTypes;
  }

  /**
   * Queue-based enrichment with dependency propagation (RFD-17).
   *
   * When an enricher's output changes (delta.changedEdgeTypes non-empty),
   * downstream enrichers consuming those edge types are enqueued for re-run.
   * Queue respects topological order. Each enricher runs at most once.
   * Termination guaranteed by DAG structure + processed-set deduplication.
   */
  private async runEnrichmentWithPropagation(
    phasePlugins: Plugin[],
    pluginMap: Map<string, Plugin>,
    sortedIds: string[],
    consumerIndex: Map<string, Set<string>>,
    context: Partial<PluginContext> & { graph: PluginContext['graph'] },
  ): Promise<void> {
    const { onProgress, logger } = this.deps;

    // Queue state
    const pending = new Set<string>();
    const processed = new Set<string>();

    // Seed: enqueue ALL enrichers (analysis phase already produced their consumed types)
    for (const plugin of phasePlugins) {
      pending.add(plugin.metadata.name);
    }

    // Propagation loop
    while (pending.size > 0) {
      const enricherName = this.dequeueNextEnricher(pending, sortedIds);
      if (!enricherName) break;

      if (processed.has(enricherName)) continue;

      const plugin = pluginMap.get(enricherName);
      if (!plugin) continue;

      onProgress({
        phase: 'enrichment',
        currentPlugin: enricherName,
        message: `Running enricher ${processed.size + 1}/${phasePlugins.length}: ${enricherName}`,
      });

      const delta = await this.executePlugin(plugin, context, 'ENRICHMENT');
      processed.add(enricherName);

      // Propagate: enqueue downstream enrichers for changed types.
      // Check both changedEdgeTypes and changedNodeTypes, since consumes
      // declarations can match either (consistent with RFD-16 accumulation).
      if (delta) {
        const changedTypes = [...delta.changedEdgeTypes, ...delta.changedNodeTypes];
        for (const changedType of changedTypes) {
          const consumers = consumerIndex.get(changedType);
          if (!consumers) continue;
          for (const consumer of consumers) {
            if (!processed.has(consumer)) {
              pending.add(consumer);
            }
          }
        }
      }

      onProgress({
        phase: 'enrichment',
        currentPlugin: enricherName,
        message: `✓ ${enricherName} complete`,
      });
    }

    // Log skipped enrichers (not enqueued because their consumed types never appeared)
    for (const plugin of phasePlugins) {
      if (!processed.has(plugin.metadata.name)) {
        const consumes = plugin.metadata.consumes ?? [];
        logger.debug(
          `[SKIP] ${plugin.metadata.name} — no changes in consumed types [${consumes.join(', ')}]`
        );
      }
    }
  }

  /**
   * Dequeue the next enricher from pending set, respecting topological order.
   * Returns null if pending is empty.
   */
  private dequeueNextEnricher(pending: Set<string>, sortedIds: string[]): string | null {
    for (const id of sortedIds) {
      if (pending.has(id)) {
        pending.delete(id);
        return id;
      }
    }
    return null;
  }
}
