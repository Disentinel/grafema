/**
 * MethodCallResolver - enriches METHOD_CALL nodes with CALLS edges to method definitions.
 *
 * Finds method calls (CALL nodes with "object" attribute) and links them to:
 * 1. Class methods in the same file
 * 2. Class methods in imported modules
 * 3. Object variable methods
 *
 * CREATES EDGES:
 * - METHOD_CALL -> CALLS -> METHOD (for class methods)
 * - METHOD_CALL -> CALLS -> FUNCTION (for object methods)
 *
 * Implementation split into focused modules under ./method-call/ (REG-463):
 * - MethodCallData: constants, types, data sets
 * - MethodCallDetectors: external/built-in detection
 * - MethodCallIndexers: class-method and variable-type index building
 * - MethodCallResolution: core resolution logic
 * - MethodCallErrorAnalysis: strict mode error analysis and suggestions
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { StrictModeError } from '../../errors/GrafemaError.js';

// Import from extracted modules
import { BUILTIN_PROTOTYPE_METHODS } from './method-call/MethodCallData.js';
import type { MethodCallNode, LibraryCallStats } from './method-call/MethodCallData.js';
import { isExternalMethod, isBuiltInObject, trackLibraryCall } from './method-call/MethodCallDetectors.js';
import {
  buildClassMethodIndex,
  buildVariableTypeIndex,
  buildInterfaceMethodIndex,
  buildInterfaceImplementationIndex
} from './method-call/MethodCallIndexers.js';
import { resolveMethodCall } from './method-call/MethodCallResolution.js';
import { analyzeResolutionFailure, generateContextualSuggestion } from './method-call/MethodCallErrorAnalysis.js';

// Re-export for backward compatibility (used by packages/core/src/index.ts)
export { LIBRARY_SEMANTIC_GROUPS } from './method-call/MethodCallData.js';
export type { LibraryCallStats } from './method-call/MethodCallData.js';

export class MethodCallResolver extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'MethodCallResolver',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['CALLS']
      },
      dependencies: ['ImportExportLinker'],
      consumes: ['CONTAINS', 'INSTANCE_OF', 'DERIVES_FROM', 'IMPLEMENTS', 'EXTENDS'],
      produces: ['CALLS']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting method call resolution');

    let methodCallsProcessed = 0;
    let edgesCreated = 0;
    let unresolved = 0;
    let externalSkipped = 0;
    let suppressedByIgnore = 0;  // REG-332: Count of errors suppressed by grafema-ignore
    const errors: Error[] = [];

    // Track library calls for coverage reporting
    const libraryCallStats = new Map<string, LibraryCallStats>();

    // Collect all METHOD_CALL nodes (CALL with object attribute)
    // REG-332: Deduplicate by (object, method, file, line), preferring nodes with grafemaIgnore
    const methodCallMap = new Map<string, MethodCallNode>();
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      const callNode = node as MethodCallNode;
      if (callNode.object) {
        // REG-332: Extract grafemaIgnore from metadata if present
        if (callNode.metadata) {
          try {
            const meta = typeof callNode.metadata === 'string'
              ? JSON.parse(callNode.metadata)
              : callNode.metadata;
            if (meta.grafemaIgnore) {
              callNode.grafemaIgnore = meta.grafemaIgnore;
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Deduplicate: prefer node with grafemaIgnore if one exists
        const key = `${callNode.object}.${callNode.method}:${callNode.file}:${callNode.line}`;
        const existing = methodCallMap.get(key);
        if (!existing || (callNode.grafemaIgnore && !existing.grafemaIgnore)) {
          methodCallMap.set(key, callNode);
        }
      }
    }
    const methodCalls = Array.from(methodCallMap.values());

    logger.info('Found method calls to resolve', { count: methodCalls.length });

    // Build indexes for fast lookup
    const classMethodIndex = await buildClassMethodIndex(graph, logger);
    logger.info('Indexed classes', { count: classMethodIndex.size });

    const variableTypes = await buildVariableTypeIndex(graph, logger);

    // Build interface indexes for CHA fallback (REG-485)
    const methodToInterfaces = await buildInterfaceMethodIndex(graph, logger);
    logger.info('Indexed interface methods', { methods: methodToInterfaces.size });

    const interfaceImpls = await buildInterfaceImplementationIndex(graph, logger);
    logger.info('Indexed interface implementations', { interfaces: interfaceImpls.size });

    // Cache for containing class lookups (local to this execution)
    const containingClassCache = new Map<string, BaseNodeRecord | null>();

    const startTime = Date.now();

    for (const methodCall of methodCalls) {
      methodCallsProcessed++;

      // Report progress every 50 calls
      if (onProgress && methodCallsProcessed % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'MethodCallResolver',
          message: `Resolving method calls ${methodCallsProcessed}/${methodCalls.length} (${elapsed}s)`,
          totalFiles: methodCalls.length,
          processedFiles: methodCallsProcessed
        });
      }

      // Log every 10 calls with timing
      if (methodCallsProcessed % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const avgTime = ((Date.now() - startTime) / methodCallsProcessed).toFixed(0);
        logger.debug('Progress', {
          processed: methodCallsProcessed,
          total: methodCalls.length,
          elapsed: `${elapsed}s`,
          avgTime: `${avgTime}ms/call`
        });
      }

      // Skip external methods (console, Array.prototype, etc.)
      if (isExternalMethod(methodCall.object!, methodCall.method!)) {
        externalSkipped++;

        // Track library calls for coverage reporting (skip built-in objects)
        const obj = methodCall.object!;
        const method = methodCall.method!;
        if (!isBuiltInObject(obj) && !BUILTIN_PROTOTYPE_METHODS.has(method)) {
          trackLibraryCall(libraryCallStats, obj, method);
        }

        continue;
      }

      // Check if CALLS edge already exists
      const existingEdges = await graph.getOutgoingEdges(methodCall.id, ['CALLS']);
      if (existingEdges.length > 0) {
        continue; // Already linked
      }

      // Try to find method definition
      const targetMethod = await resolveMethodCall(
        methodCall,
        classMethodIndex,
        variableTypes,
        graph,
        containingClassCache,
        methodToInterfaces,
        interfaceImpls
      );

      if (targetMethod) {
        await graph.addEdge({
          src: methodCall.id,
          dst: targetMethod.id,
          type: 'CALLS'
        });
        edgesCreated++;
      } else {
        unresolved++;

        // In strict mode, collect error with context-aware analysis (REG-332)
        if (context.strictMode) {
          // REG-332: Check for grafema-ignore suppression
          if (methodCall.grafemaIgnore?.code === 'STRICT_UNRESOLVED_METHOD') {
            suppressedByIgnore++;
            logger.debug('Suppressed by grafema-ignore', {
              call: `${methodCall.object}.${methodCall.method}`,
              reason: methodCall.grafemaIgnore.reason,
            });
            continue;
          }

          // Analyze WHY resolution failed
          const { reason, chain } = analyzeResolutionFailure(
            methodCall,
            classMethodIndex,
            variableTypes
          );

          // Generate context-aware suggestion based on failure reason
          const suggestion = generateContextualSuggestion(
            methodCall.object!,
            methodCall.method!,
            reason,
            chain
          );

          const error = new StrictModeError(
            `Cannot resolve method call: ${methodCall.object}.${methodCall.method}`,
            'STRICT_UNRESOLVED_METHOD',
            {
              filePath: methodCall.file,
              lineNumber: methodCall.line as number | undefined,
              phase: 'ENRICHMENT',
              plugin: 'MethodCallResolver',
              object: methodCall.object,
              method: methodCall.method,
              resolutionChain: chain,
              failureReason: reason,
            },
            suggestion
          );
          errors.push(error);
        }
      }
    }

    // Convert library stats to array for reporting
    const libraryStats = Array.from(libraryCallStats.values())
      .sort((a, b) => b.totalCalls - a.totalCalls);

    const summary = {
      methodCallsProcessed,
      edgesCreated,
      unresolved,
      externalSkipped,
      suppressedByIgnore,  // REG-332
      classesIndexed: classMethodIndex.size,
      libraryStats
    };

    logger.info('Summary', {
      methodCallsProcessed,
      edgesCreated,
      unresolved,
      externalSkipped,
      suppressedByIgnore,  // REG-332
      libraryCallsTracked: libraryStats.length
    });

    // Log library coverage report if there are tracked calls
    if (libraryStats.length > 0) {
      logger.info('Library coverage report', {
        libraries: libraryStats.map(s => ({
          library: s.object,
          calls: s.totalCalls,
          semantic: s.semantic,
          suggestion: s.suggestedPlugin
        }))
      });
    }

    return createSuccessResult({ nodes: 0, edges: edgesCreated }, summary, errors);
  }
}
