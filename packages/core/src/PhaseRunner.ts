/**
 * PhaseRunner - Executes plugin phases with toposort ordering
 *
 * Extracted from Orchestrator.ts (RFD-16, STEP 2.5) to keep
 * Orchestrator as coordinator, PhaseRunner as executor.
 */

import type { Plugin, PluginContext } from './plugins/Plugin.js';
import type { PluginPhase, Logger, IssueSpec, ServiceDefinition, RoutingRule, ResourceRegistry } from '@grafema/types';
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

  async runPhase(phaseName: string, context: Partial<PluginContext> & { graph: PluginContext['graph'] }): Promise<void> {
    const { plugins, onProgress, forceAnalysis, logger, strictMode, diagnosticCollector, resourceRegistry, configServices, routing } = this.deps;

    // Filter plugins for this phase
    const phasePlugins = plugins.filter(plugin =>
      plugin.metadata.phase === phaseName
    );

    // Topological sort by dependencies (REG-367, RFD-2)
    const pluginMap = new Map(phasePlugins.map(p => [p.metadata.name, p]));
    const sortedIds = phaseName === 'ENRICHMENT'
      ? toposort(buildDependencyGraph(phasePlugins))
      : toposort(
          phasePlugins.map(p => ({
            id: p.metadata.name,
            dependencies: p.metadata.dependencies ?? [],
          }))
        );
    phasePlugins.length = 0;
    for (const id of sortedIds) {
      const plugin = pluginMap.get(id);
      if (plugin) phasePlugins.push(plugin);
    }

    // Execute plugins sequentially
    for (let i = 0; i < phasePlugins.length; i++) {
      const plugin = phasePlugins[i];
      onProgress({
        phase: phaseName.toLowerCase(),
        currentPlugin: plugin.metadata.name,
        message: `Running plugin ${i + 1}/${phasePlugins.length}: ${plugin.metadata.name}`
      });
      // Build PluginContext from partial context + injected deps
      const pluginContext: PluginContext = {
        ...context,
        onProgress: onProgress as unknown as PluginContext['onProgress'],
        forceAnalysis: forceAnalysis,
        logger: logger,
        strictMode: strictMode, // REG-330: Pass strict mode flag
        // REG-76: Pass rootPrefix for multi-root workspace support
        rootPrefix: (context as { rootPrefix?: string }).rootPrefix,
        // REG-256: Pass resource registry for inter-plugin communication
        resources: resourceRegistry,
      };

      // REG-256: Ensure config is available with routing and services for all plugins
      if (!pluginContext.config) {
        pluginContext.config = {
          projectPath: (context as { manifest?: { projectPath?: string } }).manifest?.projectPath ?? '',
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
        diagnosticCollector.addFromPluginResult(
          phaseName as PluginPhase,
          plugin.metadata.name,
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
          console.warn(`[Orchestrator] Plugin ${plugin.metadata.name} reported failure`, {
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
            throw new Error(`Fatal error in ${plugin.metadata.name}: ${fatal?.message || 'Unknown fatal error'}`);
          }
        }
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
            plugin: plugin.metadata.name,
          });
        }
        throw error; // Re-throw to stop analysis
      }

      // Send completion for this plugin
      onProgress({
        phase: phaseName.toLowerCase(),
        currentPlugin: plugin.metadata.name,
        message: `✓ ${plugin.metadata.name} complete`
      });
    }
  }
}
