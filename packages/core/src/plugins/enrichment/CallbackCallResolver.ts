/**
 * CallbackCallResolver - creates CALLS edges for functions passed as callbacks
 *
 * This enrichment plugin runs AFTER FunctionCallResolver (priority 80) and
 * ImportExportLinker (priority 90) to resolve imported function callbacks.
 *
 * Handles cases where a function reference is passed as an argument to another
 * function (e.g., `arr.forEach(fn)`, `setTimeout(handler, 100)`).
 *
 * Analysis phase handles same-file callbacks (VARIABLE → FUNCTION → CALLS).
 * This enricher handles cross-file callbacks:
 *   1. CALL/METHOD_CALL → PASSES_ARGUMENT → IMPORT → follow chain → CALLS
 *
 * CREATES EDGES:
 * - CALL/METHOD_CALL -> CALLS -> FUNCTION (for imported callback functions)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';

// === CONSTANTS ===

/**
 * Functions/methods known to always invoke their callback argument.
 * Only create CALLS edges for these — prevents false positives
 * for store/register patterns where the function is stored, not called.
 */
const KNOWN_CALLBACK_INVOKERS = new Set([
  // Array HOFs
  'forEach', 'map', 'filter', 'find', 'findIndex',
  'some', 'every', 'reduce', 'reduceRight', 'flatMap', 'sort',
  // Timers
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
  // Promise
  'then', 'catch', 'finally',
  // DOM/Node
  'requestAnimationFrame', 'addEventListener',
]);

// === INTERFACES ===

interface CallNode extends BaseNodeRecord {
  object?: string;
  method?: string;
}

interface ImportNode extends BaseNodeRecord {
  source?: string;
  importType?: string;
  imported?: string;
  local?: string;
}

interface ExportNode extends BaseNodeRecord {
  exportType?: string;
  local?: string;
  source?: string;
}

type FunctionNode = BaseNodeRecord;

// === PLUGIN CLASS ===

export class CallbackCallResolver extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'CallbackCallResolver',
      phase: 'ENRICHMENT',
      creates: {
        edges: ['CALLS']
      },
      dependencies: ['ImportExportLinker', 'FunctionCallResolver']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting callback call resolution');
    const startTime = Date.now();

    // Step 1: Build Function Index - Map<file, Map<name, FunctionNode>>
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

    // Step 2: Build Export Index - Map<file, Map<exportKey, ExportNode>>
    const exportIndex = new Map<string, Map<string, ExportNode>>();
    for await (const node of graph.queryNodes({ nodeType: 'EXPORT' })) {
      const exp = node as ExportNode;
      if (!exp.file) continue;

      if (!exportIndex.has(exp.file)) {
        exportIndex.set(exp.file, new Map());
      }
      const fileExports = exportIndex.get(exp.file)!;
      const key = exp.exportType === 'default' ? 'default' : `named:${exp.name || exp.local || 'anonymous'}`;
      fileExports.set(key, exp);
    }
    logger.debug('Indexed exports', { files: exportIndex.size });

    // Step 3: Collect PASSES_ARGUMENT edges pointing to IMPORT nodes
    // These represent imported functions passed as callbacks
    let edgesCreated = 0;
    const skipped = {
      notImport: 0,
      noImportsFrom: 0,
      noExport: 0,
      noFunction: 0,
      notKnownHOF: 0
    };

    // Query all CALL and METHOD_CALL nodes
    const callNodes: CallNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      callNodes.push(node as CallNode);
    }
    for await (const node of graph.queryNodes({ nodeType: 'METHOD_CALL' })) {
      callNodes.push(node as CallNode);
    }
    logger.debug('Found call nodes', { count: callNodes.length });

    for (const callNode of callNodes) {
      // Only process known callback-invoking functions/methods
      // Prevents false positives for store/register patterns
      const callName = callNode.method || callNode.name;
      if (!callName || !KNOWN_CALLBACK_INVOKERS.has(callName)) {
        skipped.notKnownHOF++;
        continue;
      }

      // Get PASSES_ARGUMENT edges from this call
      const passesArgEdges = await graph.getOutgoingEdges(callNode.id, ['PASSES_ARGUMENT']);

      for (const edge of passesArgEdges) {
        const targetNode = await graph.getNode(edge.dst);
        if (!targetNode) continue;

        // Only process IMPORT targets (imported function callbacks)
        if (targetNode.type !== 'IMPORT') {
          skipped.notImport++;
          continue;
        }

        const importNode = targetNode as ImportNode;

        // Follow IMPORTS_FROM edge to find EXPORT
        const importsFromEdges = await graph.getOutgoingEdges(importNode.id, ['IMPORTS_FROM']);
        if (importsFromEdges.length === 0) {
          skipped.noImportsFrom++;
          continue;
        }

        const exportNodeId = importsFromEdges[0].dst;
        const exportNode = await graph.getNode(exportNodeId) as ExportNode | null;

        if (!exportNode) {
          skipped.noExport++;
          continue;
        }

        // Find target FUNCTION via export's local name
        const targetFile = exportNode.file;
        const targetFunctionName = exportNode.local || exportNode.name;

        if (!targetFile || !targetFunctionName) {
          skipped.noFunction++;
          continue;
        }

        const fileFunctions = functionIndex.get(targetFile);
        if (!fileFunctions) {
          skipped.noFunction++;
          continue;
        }

        const targetFunction = fileFunctions.get(targetFunctionName);
        if (!targetFunction) {
          skipped.noFunction++;
          continue;
        }

        // Create CALLS edge: CALL/METHOD_CALL -> FUNCTION
        await graph.addEdge({
          type: 'CALLS',
          src: callNode.id,
          dst: targetFunction.id,
          metadata: { callType: 'callback' }
        });

        edgesCreated++;
      }
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
        callNodesProcessed: callNodes.length,
        edgesCreated,
        skipped,
        timeMs: Date.now() - startTime
      }
    );
  }
}
