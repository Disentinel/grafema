import { readFileSync } from 'fs';
import { Plugin } from './Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from './Plugin.js';
import { createSuccessResult, createErrorResult } from './Plugin.js';
import type { InfraResource, ResourceMapping, InfraResourceMap } from '@grafema/types';
import { INFRA_RESOURCE_MAP_ID } from '@grafema/types';
import { createInfraResourceMap } from '../resources/InfraResourceMapImpl.js';

/**
 * InfraAnalyzer — Base class for infrastructure analysis plugins.
 *
 * AGENT DOCUMENTATION:
 *
 * Extend this class to analyze infrastructure-as-code files:
 * - Kubernetes YAML manifests
 * - Terraform .tf files
 * - Docker Compose files
 * - Helm charts
 * - Cloud resource configs (CloudFormation, ARM, Bicep)
 * - Observability configs (Prometheus, Grafana)
 *
 * THREE-LAYER PATTERN:
 *
 * 1. Your analyzer creates CONCRETE nodes (infra:k8s:deployment:api)
 * 2. mapToAbstract() maps concrete -> abstract (compute:service:api)
 * 3. Enrichers (Phase 2) create abstract nodes + cross-layer edges
 *
 * LIFECYCLE:
 *
 * 1. discoverFiles(context)  — find infrastructure files
 * 2. parseFile(filePath, content) — extract InfraResource[] (pure, no side effects)
 * 3. execute() creates concrete graph nodes from resources
 * 4. mapToAbstract(resource) — map each resource to abstract type
 * 5. Mappings registered in InfraResourceMap for enrichers
 *
 * EXAMPLE:
 *
 * ```typescript
 * class K8sYamlAnalyzer extends InfraAnalyzer {
 *   declareNodeTypes() { return ['infra:k8s:deployment', 'infra:k8s:service']; }
 *   declareEdgeTypes() { return []; }  // Enrichers create cross-layer edges
 *
 *   async discoverFiles(context) {
 *     const config = context.config?.infrastructure?.kubernetes;
 *     if (!config?.enabled) return [];
 *     return glob(config.paths, { cwd: context.projectPath });
 *   }
 *
 *   parseFile(filePath, content) {
 *     return YAML.parseAllDocuments(content).map(doc => ({
 *       id: `infra:k8s:${doc.kind.toLowerCase()}:${doc.metadata.name}`,
 *       type: `infra:k8s:${doc.kind.toLowerCase()}`,
 *       name: doc.metadata.name,
 *       file: filePath,
 *       tool: 'kubernetes',
 *       env: doc.metadata.labels?.env,
 *       metadata: { namespace: doc.metadata.namespace },
 *     }));
 *   }
 *
 *   mapToAbstract(resource) {
 *     const KIND_MAP = {
 *       'infra:k8s:deployment': 'compute:service',
 *       'infra:k8s:cronjob': 'compute:job',
 *       'infra:k8s:service': 'networking:service',
 *       'infra:k8s:ingress': 'networking:ingress',
 *       'infra:k8s:configmap': 'config:map',
 *       'infra:k8s:secret': 'config:secret',
 *     };
 *     const abstractType = KIND_MAP[resource.type];
 *     if (!abstractType) return null;
 *     return {
 *       concreteId: resource.id,
 *       concreteType: resource.type,
 *       abstractType,
 *       abstractId: `${abstractType}:${resource.name}`,
 *       name: resource.name,
 *       metadata: resource.metadata ?? {},
 *       env: resource.env,
 *       sourceFile: resource.file,
 *       sourceTool: resource.tool,
 *     };
 *   }
 * }
 * ```
 */
export abstract class InfraAnalyzer extends Plugin {
  /**
   * Plugin metadata — auto-generated from declare*() methods.
   * Override if you need custom dependencies.
   */
  get metadata(): PluginMetadata {
    return {
      name: this.constructor.name,
      phase: 'ANALYSIS',
      creates: {
        nodes: this.declareNodeTypes(),
        edges: this.declareEdgeTypes(),
      },
    };
  }

  /** Declare concrete node types this analyzer creates. */
  abstract declareNodeTypes(): string[];

  /** Declare edge types this analyzer creates (usually empty — enrichers create edges). */
  abstract declareEdgeTypes(): string[];

  /** Find infrastructure files to analyze. */
  abstract discoverFiles(context: PluginContext): Promise<string[]>;

  /**
   * Parse a single file into concrete resources.
   * Pure function — no side effects, no graph operations.
   */
  abstract parseFile(filePath: string, content: string): InfraResource[];

  /**
   * Map concrete resource to abstract type.
   * Returns null if resource type has no abstract mapping.
   */
  abstract mapToAbstract(resource: InfraResource): ResourceMapping | null;

  /**
   * Execute infrastructure analysis.
   * Orchestrates: discover -> parse -> create nodes -> register mappings.
   */
  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const factory = this.getFactory(context);

      // Step 1: Discover files
      const files = await this.discoverFiles(context);
      logger.info(`Discovered ${files.length} infrastructure files`);

      if (files.length === 0) {
        return createSuccessResult();
      }

      // Get or create InfraResourceMap
      const infraMap = context.resources?.getOrCreate<InfraResourceMap>(
        INFRA_RESOURCE_MAP_ID,
        createInfraResourceMap,
      );

      let nodesCreated = 0;
      let mappingsRegistered = 0;
      const errors: Error[] = [];

      // Step 2: Process each file
      for (const filePath of files) {
        try {
          const content = readFileSync(filePath, 'utf-8');
          const resources = this.parseFile(filePath, content);

          // Step 3: Create concrete graph nodes
          for (const resource of resources) {
            try {
              await factory!.store({
                id: resource.id,
                type: resource.type,
                name: resource.name,
                file: resource.file,
                line: resource.line,
                metadata: {
                  ...resource.metadata,
                  env: resource.env,
                  tool: resource.tool,
                },
              } as any); // Concrete infra nodes don't have branded types yet
              nodesCreated++;

              // Step 4: Register abstract mapping
              if (infraMap) {
                const mapping = this.mapToAbstract(resource);
                if (mapping) {
                  infraMap.register(mapping);
                  mappingsRegistered++;
                }
              }
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              logger.warn(`Failed to process resource ${resource.id}: ${err.message}`);
              errors.push(err);
            }
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn(`Failed to process file ${filePath}: ${err.message}`);
          errors.push(err);
        }
      }

      logger.info(`Analysis complete: ${nodesCreated} nodes, ${mappingsRegistered} mappings`);

      return createSuccessResult(
        { nodes: nodesCreated, edges: 0 },
        { filesProcessed: files.length, mappingsRegistered },
        errors,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }
}
