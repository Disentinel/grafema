/**
 * FunctionCallResolver - creates CALLS edges for imported function calls
 *
 * This enrichment plugin runs AFTER ImportExportLinker (priority 80 vs 90) and:
 * 1. Finds CALL_SITE nodes without CALLS edges (excluding method calls)
 * 2. For each, looks for IMPORT with matching local name in same file
 * 3. Follows IMPORTS_FROM -> EXPORT -> FUNCTION chain
 * 4. Creates CALLS edge to target FUNCTION
 *
 * CREATES EDGES:
 * - CALL_SITE -> CALLS -> FUNCTION (for imported functions)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';

// === INTERFACES ===

interface CallNode extends BaseNodeRecord {
  object?: string; // If present, this is a method call - skip
}

interface ImportNode extends BaseNodeRecord {
  source?: string;
  importType?: string; // 'default' | 'named' | 'namespace'
  imported?: string; // Original name in source file
  local?: string; // Local binding name
}

interface ExportNode extends BaseNodeRecord {
  exportType?: string; // 'default' | 'named' | 'all'
  local?: string; // Local name in exporting file
  source?: string; // Re-export source (if re-exporting)
}

type FunctionNode = BaseNodeRecord;

// === PLUGIN CLASS ===

export class FunctionCallResolver extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'FunctionCallResolver',
      phase: 'ENRICHMENT',
      priority: 80, // After ImportExportLinker (90)
      creates: {
        nodes: [],
        edges: ['CALLS']
      },
      dependencies: ['ImportExportLinker'] // Requires IMPORTS_FROM edges
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting function call resolution');

    const startTime = Date.now();

    // Step 1: Build Import Index - Map<file:local, ImportNode>
    const importIndex = new Map<string, ImportNode>();
    for await (const node of graph.queryNodes({ nodeType: 'IMPORT' })) {
      const imp = node as ImportNode;
      if (!imp.file || !imp.local) continue;

      // Skip external imports (non-relative)
      const isRelative = imp.source && (imp.source.startsWith('./') || imp.source.startsWith('../'));
      if (!isRelative) continue;

      const key = `${imp.file}:${imp.local}`;
      importIndex.set(key, imp);
    }
    logger.debug('Indexed imports', { count: importIndex.size });

    // Step 2: Build Function Index - Map<file, Map<name, FunctionNode>>
    const functionIndex = new Map<string, Map<string, FunctionNode>>();
    for await (const node of graph.queryNodes({ nodeType: 'FUNCTION' })) {
      const func = node as FunctionNode;
      if (!func.file || !func.name) continue;

      if (!functionIndex.has(func.file)) {
        functionIndex.set(func.file, new Map());
      }
      functionIndex.get(func.file)!.set(func.name, func);
    }
    logger.debug('Indexed functions', { files: functionIndex.size });

    // Step 3: Collect unresolved CALL_SITE nodes
    const callSitesToResolve: CallNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      const call = node as CallNode;

      // Skip method calls (have object attribute)
      if (call.object) continue;

      // Skip if already has CALLS edge
      const existingEdges = await graph.getOutgoingEdges(call.id, ['CALLS']);
      if (existingEdges.length > 0) continue;

      callSitesToResolve.push(call);
    }
    logger.info('Found call sites to resolve', { count: callSitesToResolve.length });

    // Step 4: Resolution
    let edgesCreated = 0;
    const skipped = {
      alreadyResolved: 0,
      methodCalls: 0,
      external: 0,
      missingImport: 0,
      missingImportsFrom: 0,
      reExports: 0
    };

    for (const callSite of callSitesToResolve) {
      const calledName = callSite.name;
      const file = callSite.file;

      if (!calledName || !file) continue;

      // Step 4.1: Find matching import in same file
      const importKey = `${file}:${calledName}`;
      const imp = importIndex.get(importKey);

      if (!imp) {
        skipped.missingImport++;
        continue;
      }

      // Step 4.2: Follow IMPORTS_FROM edge to find EXPORT
      const importsFromEdges = await graph.getOutgoingEdges(imp.id, ['IMPORTS_FROM']);
      if (importsFromEdges.length === 0) {
        skipped.missingImportsFrom++;
        continue;
      }

      const exportNodeId = importsFromEdges[0].dst;
      const exportNode = await graph.getNode(exportNodeId) as ExportNode | null;

      if (!exportNode) {
        skipped.missingImportsFrom++;
        continue;
      }

      // Step 4.3: Handle re-exports (EXPORT with source field)
      // For v1: skip complex re-exports
      if (exportNode.source) {
        skipped.reExports++;
        continue;
      }

      // Step 4.4: Find target FUNCTION via EXPORT.local
      const targetFile = exportNode.file;
      const targetFunctionName = exportNode.local || exportNode.name;

      if (!targetFile || !targetFunctionName) continue;

      const fileFunctions = functionIndex.get(targetFile);
      if (!fileFunctions) continue;

      const targetFunction = fileFunctions.get(targetFunctionName);
      if (!targetFunction) continue;

      // Step 4.5: Create CALLS edge
      await graph.addEdge({
        type: 'CALLS',
        src: callSite.id,
        dst: targetFunction.id
      });

      edgesCreated++;
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info('Complete', {
      edgesCreated,
      skipped,
      time: `${totalTime}s`
    });

    return createSuccessResult(
      { nodes: 0, edges: edgesCreated },
      {
        callSitesProcessed: callSitesToResolve.length,
        edgesCreated,
        skipped,
        timeMs: Date.now() - startTime
      }
    );
  }
}
