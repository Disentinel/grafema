/**
 * MethodCallResolver - enriches METHOD_CALL nodes with CALLS edges to method definitions.
 *
 * Finds method calls (CALL nodes with "object" attribute) and links them to:
 * 1. Class methods in the same file
 * 2. Class methods in imported modules
 * 3. Object variable methods
 * 4. Runtime-typed builtin nodes (ECMASCRIPT_BUILTIN, WEB_API, BROWSER_API, NODEJS_STDLIB)
 * 5. npm package EXTERNAL_MODULE nodes
 * 6. UNKNOWN_CALL_TARGET for unresolved variable-based calls
 *
 * CREATES NODES (REG-583):
 * - ECMASCRIPT_BUILTIN (for ECMAScript spec objects: Math, JSON, etc.)
 * - WEB_API (for WHATWG/W3C APIs: console, fetch, etc.)
 * - BROWSER_API (for browser-only APIs: document, window, etc.)
 * - NODEJS_STDLIB (for Node.js globals/modules: process, Buffer, fs, etc.)
 * - EXTERNAL_MODULE (for npm packages: axios, lodash, etc.)
 * - UNKNOWN_CALL_TARGET (for unresolved variable-based calls: res, socket, db, etc.)
 *
 * CREATES EDGES:
 * - METHOD_CALL -> CALLS -> METHOD (for class methods)
 * - METHOD_CALL -> CALLS -> FUNCTION (for object methods)
 * - METHOD_CALL -> CALLS -> ECMASCRIPT_BUILTIN|WEB_API|BROWSER_API|NODEJS_STDLIB (for builtins)
 * - METHOD_CALL -> CALLS -> EXTERNAL_MODULE (for npm packages)
 * - METHOD_CALL -> CALLS -> UNKNOWN_CALL_TARGET (for unknown variables)
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
import { NodeFactory } from '../../core/NodeFactory.js';

// Import from extracted modules
import { BUILTIN_PROTOTYPE_METHODS, NPM_NAMESPACE_OBJECTS } from './method-call/MethodCallData.js';
import type { MethodCallNode, LibraryCallStats } from './method-call/MethodCallData.js';
import { trackLibraryCall } from './method-call/MethodCallDetectors.js';
import {
  buildClassMethodIndex,
  buildVariableTypeIndex,
  buildInterfaceMethodIndex,
  buildInterfaceImplementationIndex
} from './method-call/MethodCallIndexers.js';
import { resolveMethodCall } from './method-call/MethodCallResolution.js';
import { analyzeResolutionFailure, generateContextualSuggestion } from './method-call/MethodCallErrorAnalysis.js';

// Import from runtime categories (REG-583)
import { resolveBuiltinObjectId, getBuiltinNodeType } from '../../data/builtins/runtimeCategories.js';

// Re-export for backward compatibility (used by packages/core/src/index.ts)
export { LIBRARY_SEMANTIC_GROUPS } from './method-call/MethodCallData.js';
export type { LibraryCallStats } from './method-call/MethodCallData.js';

/**
 * Helper: ensure a builtin node exists in the graph, creating lazily if needed.
 */
async function ensureBuiltinNode(
  nodeId: string,
  createdNodes: Set<string>,
  graph: PluginContext['graph'],
  factory: PluginContext['factory']
): Promise<void> {
  if (createdNodes.has(nodeId)) return;
  const existing = await graph.getNode(nodeId);
  if (!existing) {
    const type = getBuiltinNodeType(nodeId);
    const name = nodeId.slice(nodeId.indexOf(':') + 1);
    if (type === 'ECMASCRIPT_BUILTIN') {
      await factory!.store(NodeFactory.createEcmascriptBuiltin(name));
    } else if (type === 'WEB_API') {
      await factory!.store(NodeFactory.createWebApi(name));
    } else if (type === 'BROWSER_API') {
      await factory!.store(NodeFactory.createBrowserApi(name));
    } else if (type === 'NODEJS_STDLIB') {
      await factory!.store(NodeFactory.createNodejsStdlib(name));
    }
  }
  createdNodes.add(nodeId);
}

export class MethodCallResolver extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'MethodCallResolver',
      phase: 'ENRICHMENT',
      creates: {
        nodes: ['ECMASCRIPT_BUILTIN', 'WEB_API', 'BROWSER_API', 'NODEJS_STDLIB', 'EXTERNAL_MODULE', 'UNKNOWN_CALL_TARGET'],
        edges: ['CALLS']
      },
      dependencies: ['ImportExportLinker'],
      consumes: ['CONTAINS', 'INSTANCE_OF', 'DERIVES_FROM', 'IMPLEMENTS', 'EXTENDS'],
      produces: ['CALLS']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const factory = this.getFactory(context);
    const logger = this.log(context);

    logger.info('Starting method call resolution');

    let methodCallsProcessed = 0;
    let edgesCreated = 0;
    let unresolved = 0;
    let builtinResolved = 0;
    let npmResolved = 0;
    let unknownResolved = 0;
    let suppressedByIgnore = 0;  // REG-332: Count of errors suppressed by grafema-ignore
    const errors: Error[] = [];

    // Track library calls for coverage reporting
    const libraryCallStats = new Map<string, LibraryCallStats>();

    // Pre-seed dedup sets from existing graph nodes (GAP 6 fix)
    const existingBuiltins = await Promise.all([
      this.collectNodeIds(graph, 'ECMASCRIPT_BUILTIN'),
      this.collectNodeIds(graph, 'WEB_API'),
      this.collectNodeIds(graph, 'BROWSER_API'),
      this.collectNodeIds(graph, 'NODEJS_STDLIB'),
    ]);
    const createdBuiltinNodes = new Set<string>(existingBuiltins.flat());

    const createdExternalModuleNodes = new Set<string>(
      await this.collectNodeIds(graph, 'EXTERNAL_MODULE')
    );

    const createdUnknownNodes = new Set<string>(
      await this.collectNodeIds(graph, 'UNKNOWN_CALL_TARGET')
    );

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

      // --- STEP 1: Pre-check existing CALLS edge (duplicate-edge prevention) ---
      // MUST be first. If NodejsBuiltinsResolver already created CALLS -> EXTERNAL_FUNCTION:fs.readFile,
      // skip this call node entirely — no second edge.
      const existingEdges = await graph.getOutgoingEdges(methodCall.id, ['CALLS']);
      if (existingEdges.length > 0) {
        continue;
      }

      const obj = methodCall.object!;
      const method = methodCall.method!;

      // --- STEP 2: Try to resolve as a known runtime builtin object ---
      // Checks ECMASCRIPT_BUILTIN_OBJECTS, WEB_API_OBJECTS, BROWSER_API_OBJECTS, NODEJS_STDLIB_OBJECTS.
      const builtinTargetId = resolveBuiltinObjectId(obj);
      if (builtinTargetId !== null) {
        await ensureBuiltinNode(builtinTargetId, createdBuiltinNodes, graph, factory);
        await factory!.link({ src: methodCall.id, dst: builtinTargetId, type: 'CALLS' });
        builtinResolved++;
        continue;
      }

      // --- STEP 3: npm package namespace ---
      // Objects that are known npm namespaces (axios, express, lodash, ws, etc.).
      // Must be checked BEFORE prototype methods — e.g., axios.get() should resolve
      // to EXTERNAL_MODULE:axios, not ECMASCRIPT_BUILTIN:prototype (because 'get'
      // is also in BUILTIN_PROTOTYPE_METHODS via Map.prototype.get).
      if (NPM_NAMESPACE_OBJECTS.has(obj)) {
        const externalModuleId = `EXTERNAL_MODULE:${obj}`;
        if (!createdExternalModuleNodes.has(externalModuleId)) {
          const existing = await graph.getNode(externalModuleId);
          if (!existing) {
            await factory!.store(NodeFactory.createExternalModule(obj));
          }
          createdExternalModuleNodes.add(externalModuleId);
        }
        await factory!.link({ src: methodCall.id, dst: externalModuleId, type: 'CALLS' });
        trackLibraryCall(libraryCallStats, obj, method);
        npmResolved++;
        continue;
      }

      // --- STEP 4: Try to resolve in user code (class methods, etc.) ---
      // Must run BEFORE prototype-method heuristic — user-defined classes with
      // methods named push/get/set/map/then/etc. must resolve to the actual
      // class method, not ECMASCRIPT_BUILTIN:prototype.
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
        await factory!.link({
          src: methodCall.id,
          dst: targetMethod.id,
          type: 'CALLS'
        });
        edgesCreated++;
        continue;
      }

      // --- STEP 4b: Prototype method call on unknown variable (fallback) ---
      // User code didn't resolve. The object is not a known builtin (Step 2),
      // not a known npm namespace (Step 3), but the METHOD name is a built-in
      // prototype method. This captures arr.map(fn), str.split(','), items.forEach(), etc.
      if (BUILTIN_PROTOTYPE_METHODS.has(method)) {
        const protoId = 'ECMASCRIPT_BUILTIN:prototype';
        await ensureBuiltinNode(protoId, createdBuiltinNodes, graph, factory);
        await factory!.link({ src: methodCall.id, dst: protoId, type: 'CALLS' });
        builtinResolved++;
        continue;
      }

      // --- STEP 5: UNKNOWN_CALL_TARGET for all remaining variable-based method calls ---
      // The object is not a known builtin (Step 2), not a known npm namespace (Step 3),
      // not a prototype method pattern (Step 4), not resolved to user code.
      // It is an application variable whose type is opaque at analysis time
      // (res, socket, db, req, next, app, etc.).
      // Create or reuse UNKNOWN_CALL_TARGET:{obj}.
      const unknownTargetId = `UNKNOWN_CALL_TARGET:${obj}`;
      if (!createdUnknownNodes.has(unknownTargetId)) {
        const existing = await graph.getNode(unknownTargetId);
        if (!existing) {
          await factory!.store(NodeFactory.createUnknownCallTarget(obj));
        }
        createdUnknownNodes.add(unknownTargetId);
      }
      await factory!.link({ src: methodCall.id, dst: unknownTargetId, type: 'CALLS' });
      unknownResolved++;

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

    // Convert library stats to array for reporting
    const libraryStats = Array.from(libraryCallStats.values())
      .sort((a, b) => b.totalCalls - a.totalCalls);

    const summary = {
      methodCallsProcessed,
      edgesCreated,
      builtinResolved,
      npmResolved,
      unknownResolved,
      unresolved,
      suppressedByIgnore,  // REG-332
      classesIndexed: classMethodIndex.size,
      libraryStats
    };

    logger.info('MethodCallResolver complete', {
      builtinResolved,
      npmResolved,
      unknownResolved,
      total: builtinResolved + npmResolved + unknownResolved,
    });

    logger.info('Summary', {
      methodCallsProcessed,
      edgesCreated,
      builtinResolved,
      npmResolved,
      unknownResolved,
      unresolved,
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

  /**
   * Collect all node IDs of a given type from the graph.
   */
  private async collectNodeIds(graph: PluginContext['graph'], nodeType: string): Promise<string[]> {
    const ids: string[] = [];
    for await (const node of graph.queryNodes({ nodeType })) {
      ids.push(node.id as string);
    }
    return ids;
  }
}
