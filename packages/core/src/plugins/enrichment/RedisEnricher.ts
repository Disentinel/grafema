/**
 * RedisEnricher - creates redis:* side-effect nodes from ioredis CALL nodes
 *
 * Phase: ENRICHMENT
 * Dependencies: JSASTAnalyzer, ImportExportLinker, MethodCallResolver
 *
 * Algorithm:
 * 1. Find all IMPORT nodes from 'ioredis' / 'redis' packages
 * 2. Build a set of local variable names that reference Redis clients
 * 3. Find CALL nodes where the object matches a Redis client variable
 * 4. For each matching CALL, look up the method in LibraryRegistry
 * 5. Create redis:* node with metadata (key expression, operation type)
 * 6. Create PERFORMS_REDIS edge from containing FUNCTION to the redis:* node
 *
 * CREATES:
 * - redis:read, redis:write, redis:delete, redis:publish, redis:subscribe,
 *   redis:transaction, redis:connection nodes
 * - PERFORMS_REDIS edges (FUNCTION → redis:* node)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { NodeFactory } from '../../core/NodeFactory.js';
import { LibraryRegistry } from '../../data/libraries/LibraryRegistry.js';

interface ImportNode extends BaseNodeRecord {
  source?: string;
  specifiers?: Array<{ local: string; imported?: string; type: string }>;
  isDefault?: boolean;
  isNamespace?: boolean;
}

interface CallNode extends BaseNodeRecord {
  callee?: string;
  objectName?: string;
  isMethodCall?: boolean;
  arguments?: number;
}

const REDIS_PACKAGES = new Set(['ioredis', 'redis']);

export class RedisEnricher extends Plugin {
  private registry = new LibraryRegistry();

  get metadata(): PluginMetadata {
    return {
      name: 'RedisEnricher',
      phase: 'ENRICHMENT',
      creates: {
        nodes: ['redis:read', 'redis:write', 'redis:delete', 'redis:publish', 'redis:subscribe', 'redis:transaction', 'redis:connection'],
        edges: ['PERFORMS_REDIS'],
      },
      dependencies: ['JSASTAnalyzer', 'ImportExportLinker', 'MethodCallResolver'],
      consumes: [],
      produces: ['PERFORMS_REDIS'],
      covers: ['ioredis', 'redis'],
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const factory = this.getFactory(context);
    const logger = this.log(context);

    logger.info('Starting Redis enrichment');

    // Step 1: Find all Redis import variable names
    const redisVarNames = await this.findRedisVariables(graph, logger);

    if (redisVarNames.size === 0) {
      logger.info('No Redis imports found, skipping');
      return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: 'no Redis imports' });
    }

    logger.info('Found Redis variables', { count: redisVarNames.size, names: [...redisVarNames] });

    // Step 2: Build FUNCTION index for CONTAINS lookup (file → functions)
    const functionsByFile = await this.buildFunctionIndex(graph);

    // Step 3: Find CALL nodes that match Redis clients and create nodes/edges
    let nodesCreated = 0;
    let edgesCreated = 0;
    let callsProcessed = 0;

    const nodesToStore: ReturnType<typeof NodeFactory.createRedisOperation>[] = [];
    const edgesToLink: Array<{ src: string; dst: string; type: string; metadata?: Record<string, unknown> }> = [];

    for await (const node of graph.queryNodes({ type: 'CALL' })) {
      const call = node as CallNode;

      if (!call.isMethodCall || !call.objectName) continue;
      if (!redisVarNames.has(call.objectName)) continue;

      callsProcessed++;

      // Extract method name from callee (e.g., "redis.set" → "set")
      const method = this.extractMethodName(call);
      if (!method) continue;

      // Look up in LibraryRegistry
      const funcDef = this.registry.getFunction('ioredis', method);
      if (!funcDef) continue;

      // Skip non-side-effect operations if they're just utility
      if (!funcDef.sideEffect && funcDef.operation === 'utility') continue;

      // Extract key expression from call arguments
      const key = await this.extractKeyExpression(graph, call, funcDef.keyArgIndex);

      // Create redis:* node
      const redisNode = NodeFactory.createRedisOperation(
        call.file ?? '',
        method,
        call.line ?? 0,
        funcDef.nodeType,
        funcDef.operation,
        {
          column: call.column ?? 0,
          object: call.objectName,
          key,
          package: funcDef.package,
        }
      );

      nodesToStore.push(redisNode);
      nodesCreated++;

      // Find containing function for PERFORMS_REDIS edge
      const containingFunctionId = await this.findContainingFunction(
        graph, call, functionsByFile
      );

      if (containingFunctionId) {
        edgesToLink.push({
          src: containingFunctionId,
          dst: redisNode.id,
          type: 'PERFORMS_REDIS',
          metadata: {
            method,
            operation: funcDef.operation,
            key,
          },
        });
        edgesCreated++;
      }

      // Progress reporting
      if (onProgress && callsProcessed % 100 === 0) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'RedisEnricher',
          message: `Processing Redis calls: ${callsProcessed}`,
        });
      }
    }

    // Flush all nodes and edges
    if (nodesToStore.length > 0) {
      await factory!.storeMany(nodesToStore);
    }
    if (edgesToLink.length > 0) {
      await factory!.linkMany(edgesToLink);
    }

    const summary = {
      redisVariables: redisVarNames.size,
      callsProcessed,
      nodesCreated,
      edgesCreated,
    };

    logger.info('Summary', summary);

    return createSuccessResult({ nodes: nodesCreated, edges: edgesCreated }, summary);
  }

  /**
   * Find all local variable names that reference Redis clients.
   * Looks at IMPORT nodes from ioredis/redis packages.
   */
  private async findRedisVariables(
    graph: PluginContext['graph'],
    logger: ReturnType<Plugin['log']>
  ): Promise<Set<string>> {
    const varNames = new Set<string>();

    for await (const node of graph.queryNodes({ type: 'IMPORT' })) {
      const importNode = node as ImportNode;

      if (!importNode.source) continue;

      // Check if import is from a Redis package
      const source = importNode.source;
      const isRedisPackage = REDIS_PACKAGES.has(source) ||
        source.startsWith('ioredis/') ||
        source.startsWith('redis/');

      if (!isRedisPackage) continue;

      // Collect all local names from import specifiers
      if (importNode.specifiers) {
        for (const spec of importNode.specifiers) {
          if (spec.local) {
            varNames.add(spec.local);
          }
        }
      }

      // For default imports: the name is in the node's name field
      if (importNode.isDefault && importNode.name) {
        // Parse variable name from import node name
        // Import node names follow pattern like "Redis" from "import Redis from 'ioredis'"
        const parts = importNode.name.split(':');
        if (parts.length > 0) {
          const lastPart = parts[parts.length - 1];
          if (lastPart && !lastPart.includes('/')) {
            varNames.add(lastPart);
          }
        }
      }
    }

    // Also look for common Redis variable patterns from VARIABLE nodes
    // that are assigned from constructor calls: const redis = new Redis()
    for await (const node of graph.queryNodes({ type: 'CALL' })) {
      const call = node as CallNode;
      if (call.callee === 'Redis' || call.callee === 'new Redis' || call.callee === 'new IORedis') {
        // Find what variable this is assigned to via ASSIGNED_FROM edges
        const incomingEdges = await graph.getIncomingEdges(call.id, ['ASSIGNED_FROM']);
        for (const edge of incomingEdges) {
          const varNode = await graph.getNode(edge.src);
          if (varNode && varNode.name) {
            varNames.add(varNode.name);
            logger.debug('Found Redis client variable from constructor', { name: varNode.name });
          }
        }
      }
    }

    return varNames;
  }

  /**
   * Build index of functions by file for fast lookup.
   */
  private async buildFunctionIndex(
    graph: PluginContext['graph']
  ): Promise<Map<string, BaseNodeRecord[]>> {
    const index = new Map<string, BaseNodeRecord[]>();

    for await (const node of graph.queryNodes({ type: 'FUNCTION' })) {
      if (!node.file) continue;
      const fns = index.get(node.file) || [];
      fns.push(node);
      index.set(node.file, fns);
    }

    return index;
  }

  /**
   * Extract method name from a CALL node.
   * Callee might be "redis.set" → returns "set"
   */
  private extractMethodName(call: CallNode): string | null {
    if (!call.callee) return null;

    const dot = call.callee.lastIndexOf('.');
    if (dot >= 0) {
      return call.callee.substring(dot + 1);
    }

    // If callee has no dot, check the name field
    if (call.name) {
      const nameDot = call.name.lastIndexOf('.');
      if (nameDot >= 0) {
        return call.name.substring(nameDot + 1);
      }
    }

    return null;
  }

  /**
   * Extract key expression from CALL arguments.
   * Uses keyArgIndex from LibraryFunctionDef.
   */
  private async extractKeyExpression(
    graph: PluginContext['graph'],
    call: CallNode,
    keyArgIndex: number | undefined
  ): Promise<string | undefined> {
    if (keyArgIndex === undefined) return undefined;

    // Look at PASSES_ARGUMENT edges from this CALL
    const argEdges = await graph.getOutgoingEdges(call.id, ['PASSES_ARGUMENT']);

    for (const edge of argEdges) {
      if (edge.index === keyArgIndex) {
        const argNode = await graph.getNode(edge.dst);
        if (!argNode) continue;

        // String literal → use value directly
        if (argNode.type === 'LITERAL' && typeof argNode.name === 'string') {
          return argNode.name;
        }

        // Template literal → try to reconstruct
        if (argNode.type === 'EXPRESSION' && argNode.name) {
          return argNode.name;
        }

        // Variable reference → use the variable name
        if ((argNode.type === 'VARIABLE' || argNode.type === 'PARAMETER') && argNode.name) {
          return argNode.name;
        }

        // Fallback: use the argument node name if available
        if (argNode.name) {
          return String(argNode.name);
        }
      }
    }

    return undefined;
  }

  /**
   * Find the FUNCTION node that contains a given CALL node.
   * Uses file + line proximity as heuristic.
   */
  private async findContainingFunction(
    graph: PluginContext['graph'],
    call: CallNode,
    functionsByFile: Map<string, BaseNodeRecord[]>
  ): Promise<string | null> {
    if (!call.file) return null;

    // First try: look for CONTAINS edges pointing to this CALL
    const incomingEdges = await graph.getIncomingEdges(call.id, ['CONTAINS']);
    for (const edge of incomingEdges) {
      const parent = await graph.getNode(edge.src);
      if (parent && parent.type === 'FUNCTION') {
        return parent.id;
      }
    }

    // Fallback: find nearest function by line number in the same file
    const functions = functionsByFile.get(call.file);
    if (!functions || !call.line) return null;

    let best: BaseNodeRecord | null = null;
    let bestLine = -1;

    for (const fn of functions) {
      if (fn.line !== undefined && fn.line <= call.line && fn.line > bestLine) {
        best = fn;
        bestLine = fn.line;
      }
    }

    return best?.id ?? null;
  }
}
