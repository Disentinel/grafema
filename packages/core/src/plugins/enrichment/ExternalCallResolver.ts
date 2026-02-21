/**
 * ExternalCallResolver - creates CALLS edges for external package calls (REG-226)
 *
 * This enrichment plugin runs AFTER FunctionCallResolver (priority 70 vs 80) and:
 * 1. Finds CALL nodes without CALLS edges (excluding method calls)
 * 2. For each, looks for IMPORT with matching local name in same file
 * 3. If import source is non-relative (external package), creates CALLS edge to EXTERNAL_MODULE
 * 4. Recognizes JS built-in global functions (no edge needed, just counts them)
 *
 * CREATES NODES:
 * - EXTERNAL_MODULE (for external packages like lodash, @tanstack/react-query)
 *
 * CREATES EDGES:
 * - CALL -> CALLS -> EXTERNAL_MODULE (for imported external functions)
 * - CALL -> HANDLED_BY -> IMPORT (links call to its import declaration)
 *
 * Architecture:
 * - Runs after FunctionCallResolver handles relative imports
 * - Skips method calls (have 'object' attribute)
 * - Skips already resolved calls (have CALLS edge)
 * - Creates EXTERNAL_MODULE nodes lazily (only when needed)
 * - Uses import index for O(1) lookups
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { JS_GLOBAL_FUNCTIONS } from '../../data/builtins/index.js';
import { NodeFactory } from '../../core/NodeFactory.js';

// === INTERFACES ===

interface CallNode extends BaseNodeRecord {
  object?: string; // If present, this is a method call - skip
  isDynamic?: boolean; // If true, call target is computed at runtime
}

interface ImportNode extends BaseNodeRecord {
  source?: string;
  importType?: string; // 'default' | 'named' | 'namespace'
  importBinding?: string; // 'value' | 'type' | 'typeof'
  imported?: string; // Original name in source file
  local?: string; // Local binding name
}

// === PLUGIN CLASS ===

export class ExternalCallResolver extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ExternalCallResolver',
      phase: 'ENRICHMENT',
      creates: {
        nodes: ['EXTERNAL_MODULE'],
        edges: ['CALLS', 'HANDLED_BY']
      },
      dependencies: ['FunctionCallResolver'], // Requires relative imports to be resolved first
      consumes: ['CALLS'],
      produces: ['CALLS', 'HANDLED_BY']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const factory = this.getFactory(context);
    const logger = this.log(context);

    logger.info('Starting external call resolution');

    const startTime = Date.now();

    // Step 1: Build Import Index
    const importIndex = await this.buildImportIndex(graph, logger);

    // Step 2: Collect unresolved CALL nodes
    const callsToProcess = await this.collectUnresolvedCalls(graph, logger);

    // Step 3: Track created EXTERNAL_MODULE nodes to avoid duplicates
    const createdExternalModules = new Set<string>();
    for await (const node of graph.queryNodes({ nodeType: 'EXTERNAL_MODULE' })) {
      createdExternalModules.add(node.id as string);
    }
    logger.debug('Existing EXTERNAL_MODULE nodes', { count: createdExternalModules.size });

    // Step 4: Resolution
    let nodesCreated = 0;
    let edgesCreated = 0;
    let handledByEdgesCreated = 0;
    let callsProcessed = 0;
    let externalResolved = 0;
    let builtinResolved = 0;
    const unresolvedByReason: Record<string, number> = {
      unknown: 0,
      dynamic: 0
    };

    for (const callNode of callsToProcess) {
      callsProcessed++;

      // Progress reporting
      if (onProgress && callsProcessed % 100 === 0) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'ExternalCallResolver',
          message: `Processing calls ${callsProcessed}/${callsToProcess.length}`,
          totalFiles: callsToProcess.length,
          processedFiles: callsProcessed
        });
      }

      const result = await this.resolveCall(
        callNode, importIndex, graph, createdExternalModules, factory
      );

      if (result.type === 'external') {
        nodesCreated += result.nodesCreated;
        edgesCreated++;
        handledByEdgesCreated += result.handledByCreated;
        externalResolved++;
      } else if (result.type === 'builtin') {
        builtinResolved++;
      } else {
        unresolvedByReason[result.reason]++;
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info('Complete', {
      nodesCreated,
      edgesCreated,
      handledByEdgesCreated,
      callsProcessed,
      externalResolved,
      builtinResolved,
      unresolvedByReason,
      time: `${totalTime}s`
    });

    return createSuccessResult(
      { nodes: nodesCreated, edges: edgesCreated + handledByEdgesCreated },
      {
        callsProcessed,
        externalResolved,
        builtinResolved,
        handledByEdgesCreated,
        unresolvedByReason,
        timeMs: Date.now() - startTime
      }
    );
  }

  /**
   * Build import index mapping file:local to ImportNode.
   * Only indexes non-relative imports (external packages).
   */
  private async buildImportIndex(
    graph: PluginContext['graph'],
    logger: ReturnType<Plugin['log']>
  ): Promise<Map<string, ImportNode>> {
    const importIndex = new Map<string, ImportNode>();
    for await (const node of graph.queryNodes({ nodeType: 'IMPORT' })) {
      const imp = node as ImportNode;
      if (!imp.file || !imp.local || !imp.source) continue;

      // Only index external imports (non-relative)
      const isRelative = imp.source.startsWith('./') || imp.source.startsWith('../');
      if (isRelative) continue;

      const key = `${imp.file}:${imp.local}`;
      importIndex.set(key, imp);
    }
    logger.debug('Indexed external imports', { count: importIndex.size });
    return importIndex;
  }

  /**
   * Collect CALL nodes without existing CALLS edges, excluding method calls.
   */
  private async collectUnresolvedCalls(
    graph: PluginContext['graph'],
    logger: ReturnType<Plugin['log']>
  ): Promise<CallNode[]> {
    const callsToProcess: CallNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      const call = node as CallNode;

      // Skip method calls (have object attribute)
      if (call.object) continue;

      // Skip if already has CALLS edge
      const existingEdges = await graph.getOutgoingEdges(call.id, ['CALLS']);
      if (existingEdges.length > 0) continue;

      callsToProcess.push(call);
    }
    logger.info('Found calls to process', { count: callsToProcess.length });
    return callsToProcess;
  }

  /**
   * Resolve a single call node against the import index.
   * Creates CALLS edge to EXTERNAL_MODULE and HANDLED_BY edge to IMPORT node.
   */
  private async resolveCall(
    callNode: CallNode,
    importIndex: Map<string, ImportNode>,
    graph: PluginContext['graph'],
    createdExternalModules: Set<string>,
    factory: PluginContext['factory'],
  ): Promise<
    | { type: 'external'; nodesCreated: number; handledByCreated: number }
    | { type: 'builtin' }
    | { type: 'unresolved'; reason: 'unknown' | 'dynamic' }
  > {
    const calledName = callNode.name as string;
    const file = callNode.file;

    if (!calledName || !file) {
      return { type: 'unresolved', reason: 'unknown' };
    }

    // Check if this is a JS builtin
    if (JS_GLOBAL_FUNCTIONS.has(calledName)) {
      return { type: 'builtin' };
    }

    // Check if this is a dynamic call
    if (callNode.isDynamic) {
      return { type: 'unresolved', reason: 'dynamic' };
    }

    // Find matching import in same file
    const importKey = `${file}:${calledName}`;
    const imp = importIndex.get(importKey);

    if (!imp) {
      return { type: 'unresolved', reason: 'unknown' };
    }

    // Extract package name from import source
    const packageName = this.extractPackageName(imp.source!);
    if (!packageName) {
      return { type: 'unresolved', reason: 'unknown' };
    }

    // Create or reuse EXTERNAL_MODULE node
    const externalModuleId = `EXTERNAL_MODULE:${packageName}`;
    let nodesCreated = 0;

    if (!createdExternalModules.has(externalModuleId)) {
      // Check if node already exists in graph
      const existingNode = await graph.getNode(externalModuleId);
      if (!existingNode) {
        await factory!.store(NodeFactory.createExternalModule(packageName));
        nodesCreated++;
      }
      createdExternalModules.add(externalModuleId);
    }

    // Create CALLS edge with metadata
    // Use 'imported' field for exportedName (the original name in source module)
    // For default imports, 'imported' is 'default'
    // For named imports with alias, 'imported' is the original name
    const exportedName = imp.imported || calledName;

    await factory!.link({
      type: 'CALLS',
      src: callNode.id,
      dst: externalModuleId,
      metadata: { exportedName }
    });

    // Create HANDLED_BY edge from CALL to IMPORT node
    // Skip type-only imports — they have no runtime relationship
    let handledByCreated = 0;
    if (imp.importBinding !== 'type') {
      await factory!.link({
        type: 'HANDLED_BY',
        src: callNode.id,
        dst: imp.id
      });
      handledByCreated = 1;
    }

    return { type: 'external', nodesCreated, handledByCreated };
  }

  /**
   * Extract package name from import source.
   *
   * Handles:
   * - Simple packages: 'lodash' -> 'lodash'
   * - Scoped packages: '@tanstack/react-query' -> '@tanstack/react-query'
   * - Subpath imports: 'lodash/map' -> 'lodash'
   * - Scoped subpath: '@scope/pkg/sub' -> '@scope/pkg'
   *
   * @param source - Import source string
   * @returns Package name or null if invalid
   */
  private extractPackageName(source: string): string | null {
    if (!source) return null;

    // Handle scoped packages (@scope/package)
    if (source.startsWith('@')) {
      // @scope/package or @scope/package/subpath
      const parts = source.split('/');
      if (parts.length >= 2) {
        // Return @scope/package (first two parts)
        return `${parts[0]}/${parts[1]}`;
      }
      return null; // Invalid scoped package
    }

    // Non-scoped package: lodash or lodash/map
    const slashIndex = source.indexOf('/');
    if (slashIndex === -1) {
      return source; // Simple package name
    }
    return source.substring(0, slashIndex); // Package name before subpath
  }
}
