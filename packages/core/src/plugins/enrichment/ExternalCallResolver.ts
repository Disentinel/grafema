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
        edges: ['CALLS']
      },
      dependencies: ['FunctionCallResolver'], // Requires relative imports to be resolved first
      consumes: ['CALLS'],
      produces: ['CALLS']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting external call resolution');

    const startTime = Date.now();

    // Step 1: Build Import Index - Map<file:local, ImportNode>
    // Only index non-relative imports (external packages)
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

    // Step 2: Collect unresolved CALL nodes (excluding method calls)
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

    // Step 3: Track created EXTERNAL_MODULE nodes to avoid duplicates
    const createdExternalModules = new Set<string>();

    // Pre-check existing EXTERNAL_MODULE nodes
    for await (const node of graph.queryNodes({ nodeType: 'EXTERNAL_MODULE' })) {
      createdExternalModules.add(node.id as string);
    }
    logger.debug('Existing EXTERNAL_MODULE nodes', { count: createdExternalModules.size });

    // Step 4: Resolution
    let nodesCreated = 0;
    let edgesCreated = 0;
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

      const calledName = callNode.name as string;
      const file = callNode.file;

      if (!calledName || !file) {
        unresolvedByReason.unknown++;
        continue;
      }

      // Step 4.1: Check if this is a JS builtin
      if (JS_GLOBAL_FUNCTIONS.has(calledName)) {
        builtinResolved++;
        continue; // No edge needed, just count it
      }

      // Step 4.2: Check if this is a dynamic call
      if (callNode.isDynamic) {
        unresolvedByReason.dynamic++;
        continue;
      }

      // Step 4.3: Find matching import in same file
      const importKey = `${file}:${calledName}`;
      const imp = importIndex.get(importKey);

      if (!imp) {
        // No import found - this is an unknown call
        unresolvedByReason.unknown++;
        continue;
      }

      // Step 4.4: Extract package name from import source
      const packageName = this.extractPackageName(imp.source!);
      if (!packageName) {
        unresolvedByReason.unknown++;
        continue;
      }

      // Step 4.5: Create or reuse EXTERNAL_MODULE node
      const externalModuleId = `EXTERNAL_MODULE:${packageName}`;

      if (!createdExternalModules.has(externalModuleId)) {
        // Check if node already exists in graph
        const existingNode = await graph.getNode(externalModuleId);
        if (!existingNode) {
          await graph.addNode(NodeFactory.createExternalModule(packageName));
          nodesCreated++;
        }
        createdExternalModules.add(externalModuleId);
      }

      // Step 4.6: Create CALLS edge with metadata
      // Use 'imported' field for exportedName (the original name in source module)
      // For default imports, 'imported' is 'default'
      // For named imports with alias, 'imported' is the original name
      const exportedName = imp.imported || calledName;

      await graph.addEdge({
        type: 'CALLS',
        src: callNode.id,
        dst: externalModuleId,
        metadata: { exportedName }
      });

      edgesCreated++;
      externalResolved++;
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info('Complete', {
      nodesCreated,
      edgesCreated,
      callsProcessed,
      externalResolved,
      builtinResolved,
      unresolvedByReason,
      time: `${totalTime}s`
    });

    return createSuccessResult(
      { nodes: nodesCreated, edges: edgesCreated },
      {
        callsProcessed,
        externalResolved,
        builtinResolved,
        unresolvedByReason,
        timeMs: Date.now() - startTime
      }
    );
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
