/**
 * CallbackCallResolver - creates CALLS edges for functions passed as callbacks
 *
 * This enrichment plugin runs AFTER FunctionCallResolver (priority 80) and
 * ImportExportLinker (priority 90) to resolve imported function callbacks.
 *
 * Handles two categories of callback resolution:
 *
 * 1. **Whitelist-based (cross-file):** Known callback-invoking functions/methods
 *    (forEach, map, setTimeout, etc.) with imported function arguments.
 *    CALL/METHOD_CALL → PASSES_ARGUMENT → IMPORT → follow chain → CALLS
 *
 * 2. **User-defined HOFs (REG-401):** Functions with `invokesParamIndexes` metadata
 *    (detected during analysis when a function calls one of its parameters).
 *    For each HOF: find call sites → check PASSES_ARGUMENT → if argIndex matches → CALLS
 *
 * CREATES EDGES:
 * - CALL/METHOD_CALL -> CALLS -> FUNCTION (for imported callback functions)
 * - CALL -> CALLS -> FUNCTION (for user-defined HOF callback arguments)
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

interface FunctionNode extends BaseNodeRecord {
  metadata?: Record<string, unknown>;
}

/** A user-defined HOF: function with invokesParamIndexes metadata */
interface UserDefinedHOF {
  functionId: string;
  invokesParamIndexes: number[];
}

// === PLUGIN CLASS ===

export class CallbackCallResolver extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'CallbackCallResolver',
      phase: 'ENRICHMENT',
      creates: {
        edges: ['CALLS']
      },
      dependencies: ['ImportExportLinker', 'FunctionCallResolver'],
      consumes: ['PASSES_ARGUMENT', 'IMPORTS_FROM'],
      produces: ['CALLS']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting callback call resolution');
    const startTime = Date.now();

    // Step 1: Build Function Index - Map<file, Map<name, FunctionNode>>
    // Also collect user-defined HOFs (functions with invokesParamIndexes metadata)
    const functionIndex = new Map<string, Map<string, FunctionNode>>();
    const userDefinedHOFs: UserDefinedHOF[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'FUNCTION' })) {
      const func = node as FunctionNode;
      if (!func.file || !func.name) continue;

      if (!functionIndex.has(func.file)) {
        functionIndex.set(func.file, new Map());
      }
      functionIndex.get(func.file)!.set(func.name, func);

      // REG-401: Collect user-defined HOFs for parameter invocation resolution
      // Check both metadata.invokesParamIndexes and top-level invokesParamIndexes
      // (RFDB backend may flatten metadata fields to top-level)
      const meta = func.metadata;
      const topLevelIndexes = (func as Record<string, unknown>).invokesParamIndexes;
      const invokesIndexes = (meta?.invokesParamIndexes ?? topLevelIndexes) as number[] | undefined;
      if (Array.isArray(invokesIndexes) && invokesIndexes.length > 0) {
        userDefinedHOFs.push({
          functionId: func.id,
          invokesParamIndexes: invokesIndexes
        });
      }
    }
    logger.debug('Indexed functions', { files: functionIndex.size, userDefinedHOFs: userDefinedHOFs.length });

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

    // Step 4 (REG-401): Resolve callback CALLS for user-defined HOFs
    // For each HOF with invokesParamIndexes, find call sites and create callback edges
    let hofEdgesCreated = 0;
    for (const hof of userDefinedHOFs) {
      // Get incoming CALLS edges to find call sites that call this HOF
      const incomingCalls = await graph.getIncomingEdges(hof.functionId, ['CALLS']);

      for (const callEdge of incomingCalls) {
        const callSiteId = callEdge.src;

        // Get PASSES_ARGUMENT edges from this call site
        const passesArgEdges = await graph.getOutgoingEdges(callSiteId, ['PASSES_ARGUMENT']);

        for (const argEdge of passesArgEdges) {
          // Check if this argument's index matches one of the invoked param indexes
          const argIndex = argEdge.metadata?.argIndex;
          if (typeof argIndex !== 'number') continue;
          if (!hof.invokesParamIndexes.includes(argIndex)) continue;

          // The target of PASSES_ARGUMENT is the argument value node
          const argTargetNode = await graph.getNode(argEdge.dst);
          if (!argTargetNode) continue;

          // Resolve to a FUNCTION node depending on argument node type
          let targetFunctionId: string | null = null;

          if (argTargetNode.type === 'FUNCTION') {
            // Direct function reference passed as argument
            targetFunctionId = argTargetNode.id;
          } else if (argTargetNode.type === 'IMPORT') {
            // Imported function reference — follow IMPORTS_FROM → EXPORT → FUNCTION
            targetFunctionId = await this.resolveImportToFunction(
              argTargetNode as ImportNode, graph, functionIndex
            );
          }

          if (targetFunctionId) {
            await graph.addEdge({
              type: 'CALLS',
              src: callSiteId,
              dst: targetFunctionId,
              metadata: { callType: 'callback' }
            });
            hofEdgesCreated++;
          }
        }
      }
    }

    edgesCreated += hofEdgesCreated;

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info('Complete', {
      edgesCreated,
      hofEdgesCreated,
      skipped,
      time: `${totalTime}s`
    });

    return createSuccessResult(
      { nodes: 0, edges: edgesCreated },
      {
        callNodesProcessed: callNodes.length,
        edgesCreated,
        hofEdgesCreated,
        skipped,
        timeMs: Date.now() - startTime
      }
    );
  }

  /**
   * Resolve an IMPORT node to the target FUNCTION ID by following the import chain:
   * IMPORT → IMPORTS_FROM → EXPORT → find FUNCTION by export's local name and file.
   *
   * Returns null if the chain can't be resolved.
   */
  private async resolveImportToFunction(
    importNode: ImportNode,
    graph: PluginContext['graph'],
    functionIndex: Map<string, Map<string, FunctionNode>>
  ): Promise<string | null> {
    const importsFromEdges = await graph.getOutgoingEdges(importNode.id, ['IMPORTS_FROM']);
    if (importsFromEdges.length === 0) return null;

    const exportNodeId = importsFromEdges[0].dst;
    const exportNode = await graph.getNode(exportNodeId) as ExportNode | null;
    if (!exportNode) return null;

    const targetFile = exportNode.file;
    const targetFunctionName = exportNode.local || exportNode.name;
    if (!targetFile || !targetFunctionName) return null;

    const fileFunctions = functionIndex.get(targetFile);
    if (!fileFunctions) return null;

    const targetFunction = fileFunctions.get(targetFunctionName);
    return targetFunction?.id ?? null;
  }
}
