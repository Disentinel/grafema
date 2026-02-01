/**
 * ValueDomainAnalyzer - Value Set Analysis for computed member access
 *
 * Purpose: Determine the set of possible values for a variable and resolve
 * computed member access obj[method]() when method is deterministic.
 *
 * USES:
 * - VARIABLE -> ASSIGNED_FROM -> LITERAL (from JSASTAnalyzer)
 * - VARIABLE -> ASSIGNED_FROM -> VARIABLE (transitive chains)
 * - ConditionalExpression → multiple ASSIGNED_FROM edges
 *
 * CREATES:
 * - CALL -> CALLS -> METHOD (with isConditional: true for conditional calls)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginMetadata, PluginContext, PluginResult } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import type { EdgeRecord } from '@grafema/types';
import {
  traceValues,
  aggregateValues,
  NONDETERMINISTIC_PATTERNS,
  NONDETERMINISTIC_OBJECTS,
} from '../../queries/traceValues.js';

// Re-export for backward compatibility
export { NONDETERMINISTIC_PATTERNS, NONDETERMINISTIC_OBJECTS };

interface ComputedCallNode {
  id: string;
  type: string;
  name: string;
  file: string;
  line: number;
  computed: boolean;
  object?: string;
  property?: string;
}

interface VariableNode {
  id: string;
  type: string;
  name: string;
  file: string;
  line: number;
  attrs?: {
    name?: string;
    file?: string;
  };
  [key: string]: unknown;
}

interface ScopeNode {
  id: string;
  type: string;
  name?: string;
  file?: string;
  line?: number;
  originalId?: string;
  parentScopeId?: string;
  constraints?: Constraint[];
}

interface Constraint {
  variable?: string;
  operator?: string;
  value?: unknown;
  values?: unknown[];
  type?: 'or' | 'and';
  constraints?: Constraint[];
}

interface ValueSetResult {
  values: unknown[];
  hasUnknown: boolean;
}

interface ValueSetAtNodeResult extends ValueSetResult {
  constraints: Constraint[];
  globalValues: unknown[];
  globalHasUnknown: boolean;
}

interface Graph {
  queryNodes(filter: { nodeType: string }): AsyncIterable<NodeRecord>;
  getNode(id: string): Promise<NodeRecord | null>;
  getOutgoingEdges(nodeId: string): Promise<EdgeRecord[]>;
  getIncomingEdges(nodeId: string): Promise<EdgeRecord[]>;
  addEdge(edge: { src: string; dst: string; type: string; metadata?: Record<string, unknown> }): Promise<void> | void;
  deleteEdge?(src: string, dst: string, type: string): Promise<void>;  // Optional for edge updates
}

interface ProgressCallback {
  (info: {
    phase: string;
    currentPlugin: string;
    message: string;
    totalFiles: number;
    processedFiles: number;
  }): void;
}

export class ValueDomainAnalyzer extends Plugin {
  static MAX_DEPTH = 10; // Maximum depth for tracing

  get metadata(): PluginMetadata {
    return {
      name: 'ValueDomainAnalyzer',
      phase: 'ENRICHMENT',
      priority: 65, // After AliasTracker (60)
      creates: {
        nodes: [],
        edges: ['CALLS', 'FLOWS_INTO']  // Added FLOWS_INTO (modifies existing)
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);
    const onProgress = (context as unknown as { onProgress?: ProgressCallback }).onProgress;
    const graphTyped = graph as unknown as Graph;

    logger.info('Starting value domain analysis');

    let callsProcessed = 0;
    let callsResolved = 0;
    let edgesCreated = 0;
    let conditionalCalls = 0;
    let partialCalls = 0;

    // 1. Find all CALL nodes with computed member access
    const computedCalls: ComputedCallNode[] = [];
    for await (const node of graphTyped.queryNodes({ nodeType: 'CALL' })) {
      // Cast through unknown since node types vary
      const callNode = node as unknown as ComputedCallNode;
      if (callNode.computed === true) {
        computedCalls.push(callNode);
      }
    }

    logger.info('Found computed member calls', { count: computedCalls.length });

    // 2. For each computed call get value set
    for (const call of computedCalls) {
      callsProcessed++;

      // Report progress every 20 calls
      if (onProgress && callsProcessed % 20 === 0) {
        (onProgress as ProgressCallback)({
          phase: 'enrichment',
          currentPlugin: 'ValueDomainAnalyzer',
          message: `Analyzing value domains ${callsProcessed}/${computedCalls.length}`,
          totalFiles: computedCalls.length,
          processedFiles: callsProcessed
        });
      }

      const objectName = call.object;
      const propertyExpr = call.property; // variable name with method name

      if (!objectName || !propertyExpr) continue;

      // 3. Get value set for property expression
      const valueSet = await this.getValueSet(propertyExpr, call.file, graphTyped);

      if (valueSet.hasUnknown && valueSet.values.length === 0) {
        // Completely nondeterministic - skip
        continue;
      }

      if (valueSet.values.length === 0) {
        // No known values - skip
        continue;
      }

      // 4. Create CALLS edges for each known value
      callsResolved++;
      const isConditional = valueSet.values.length > 1 || valueSet.hasUnknown;
      const partial = valueSet.hasUnknown;

      for (const methodName of valueSet.values) {
        // Find method by name in the same file
        const targetMethod = await this.findMethod(objectName, methodName as string, call.file, graphTyped);

        if (targetMethod) {
          await graphTyped.addEdge({
            src: call.id,
            dst: targetMethod.id,
            type: 'CALLS',
            metadata: {
              isConditional,
              partial: partial || undefined, // undefined to not store false
              source: 'computed_member_access'
            }
          });
          edgesCreated++;

          if (isConditional) {
            conditionalCalls++;
          }
          if (partial) {
            partialCalls++;
          }
        }
      }
    }

    // 5. Resolve computed property mutations in FLOWS_INTO edges
    logger.debug('Resolving computed property mutations');
    const mutationStats = await this.resolveComputedMutations(graphTyped, logger);
    logger.debug('Mutation resolution stats', mutationStats);

    const summary = {
      callsProcessed,
      callsResolved,
      edgesCreated,
      conditionalCalls,
      partialCalls,
      computedMutations: mutationStats
    };

    logger.info('Summary', summary);

    return createSuccessResult(
      { nodes: 0, edges: edgesCreated + mutationStats.resolved + mutationStats.conditional },
      summary
    );
  }

  /**
   * Get set of possible values for a variable
   */
  async getValueSet(variableName: string, file: string, graph: Graph): Promise<ValueSetResult> {
    const result: ValueSetResult = {
      values: [],
      hasUnknown: false
    };

    // Find variable
    const variables: VariableNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'VARIABLE' })) {
      const varNode = node as VariableNode;
      const nodeName = varNode.name || varNode.attrs?.name;
      const nodeFile = varNode.file || varNode.attrs?.file;
      if (nodeName === variableName && nodeFile === file) {
        variables.push(varNode);
      }
    }
    for await (const node of graph.queryNodes({ nodeType: 'CONSTANT' })) {
      const varNode = node as VariableNode;
      const nodeName = varNode.name || varNode.attrs?.name;
      const nodeFile = varNode.file || varNode.attrs?.file;
      if (nodeName === variableName && nodeFile === file) {
        variables.push(varNode);
      }
    }

    if (variables.length === 0) {
      result.hasUnknown = true;
      return result;
    }

    // Trace ASSIGNED_FROM to LITERAL or nondeterministic sources
    const visited = new Set<string>();
    const valueSet = new Set<unknown>();

    for (const variable of variables) {
      const { values, hasUnknown } = await this.traceValueSet(
        variable,
        graph,
        visited,
        0
      );

      values.forEach(v => valueSet.add(v));
      if (hasUnknown) {
        result.hasUnknown = true;
      }
    }

    result.values = Array.from(valueSet);
    return result;
  }

  /**
   * Get value set for a variable at a specific node, considering path constraints
   * This is path-sensitive: it collects constraints from enclosing scopes and applies them
   */
  async getValueSetAtNode(
    variableName: string,
    node: NodeRecord & { parentScopeId?: string },
    graph: Graph
  ): Promise<ValueSetAtNodeResult> {
    // 1. Get global value set
    const file = (node as { file?: string; attrs?: { file?: string } }).file ||
                 (node as { attrs?: { file?: string } }).attrs?.file || '';
    const globalResult = await this.getValueSet(variableName, file, graph);

    // 2. Collect constraints from enclosing scopes
    const constraints = await this.collectPathConstraints(node, graph);

    // 3. Filter constraints relevant to this variable
    const relevantConstraints = constraints.filter(c =>
      c.variable === variableName ||
      (c.type === 'or' && c.constraints?.some(sub => sub.variable === variableName)) ||
      (c.type === 'and' && c.constraints?.some(sub => sub.variable === variableName))
    );

    // 4. Apply constraints to narrow the value set
    const refinedResult = this.applyConstraints(globalResult, relevantConstraints, variableName);

    return {
      ...refinedResult,
      constraints: relevantConstraints,
      globalValues: globalResult.values,
      globalHasUnknown: globalResult.hasUnknown
    };
  }

  /**
   * Collect all constraints from the scope chain leading to this node
   */
  async collectPathConstraints(
    node: NodeRecord & { parentScopeId?: string },
    graph: Graph
  ): Promise<Constraint[]> {
    const constraints: Constraint[] = [];
    let currentScopeId = node.parentScopeId;
    const visited = new Set<string>();

    while (currentScopeId && !visited.has(currentScopeId)) {
      visited.add(currentScopeId);

      // Find the scope node
      let scope: ScopeNode | null = null;
      for await (const s of graph.queryNodes({ nodeType: 'SCOPE' })) {
        const scopeNode = s as ScopeNode;
        if (scopeNode.id === currentScopeId ||
            scopeNode.originalId === currentScopeId) {
          scope = scopeNode;
          break;
        }
      }

      if (!scope) break;

      // Add constraints from this scope
      if (scope.constraints && Array.isArray(scope.constraints)) {
        constraints.push(...scope.constraints);
      }

      // Move up to parent scope
      currentScopeId = scope.parentScopeId;
    }

    return constraints;
  }

  /**
   * Apply constraints to narrow a value set
   */
  applyConstraints(
    valueSet: ValueSetResult,
    constraints: Constraint[],
    variableName: string
  ): ValueSetResult {
    if (constraints.length === 0) {
      return valueSet;
    }

    let result: ValueSetResult = {
      values: [...valueSet.values],
      hasUnknown: valueSet.hasUnknown
    };

    for (const constraint of constraints) {
      result = this.applySingleConstraint(result, constraint, variableName);
    }

    return result;
  }

  /**
   * Apply a single constraint to a value set
   */
  applySingleConstraint(
    valueSet: ValueSetResult,
    constraint: Constraint,
    variableName: string
  ): ValueSetResult {
    if (constraint.variable !== variableName) {
      // Constraint is for a different variable - no change
      return valueSet;
    }

    switch (constraint.operator) {
      case '===':
      case '==':
        // Exact match - narrow to single value
        return {
          values: [constraint.value],
          hasUnknown: false
        };

      case '!==':
      case '!=':
        // Exclusion - remove specific value from set
        return {
          values: valueSet.values.filter(v => v !== constraint.value),
          hasUnknown: valueSet.hasUnknown
        };

      case 'in':
        // Value must be one of the specified values
        if (constraint.values) {
          if (valueSet.hasUnknown) {
            // Unknown narrowed to specific set
            return {
              values: constraint.values,
              hasUnknown: false
            };
          } else {
            // Intersect with known values
            return {
              values: valueSet.values.filter(v => constraint.values!.includes(v)),
              hasUnknown: false
            };
          }
        }
        return valueSet;

      case 'not_in':
        // Value must NOT be one of the specified values
        if (constraint.values) {
          return {
            values: valueSet.values.filter(v => !constraint.values!.includes(v)),
            hasUnknown: valueSet.hasUnknown
          };
        }
        return valueSet;

      case 'truthy':
        // Variable is truthy - can't narrow much, but excludes falsy values
        return {
          values: valueSet.values.filter(v =>
            v !== null && v !== undefined && v !== false && v !== 0 && v !== ''
          ),
          hasUnknown: valueSet.hasUnknown
        };

      case 'falsy':
        // Variable is falsy
        return {
          values: valueSet.values.filter(v =>
            v === null || v === undefined || v === false || v === 0 || v === ''
          ),
          hasUnknown: false // We know it's falsy
        };

      default:
        return valueSet;
    }
  }

  /**
   * Recursive value set tracing through ASSIGNED_FROM edges.
   * Delegates to shared traceValues utility (REG-244).
   */
  async traceValueSet(
    node: NodeRecord,
    graph: Graph,
    _visited: Set<string>,
    depth: number
  ): Promise<ValueSetResult> {
    // Create adapter from Graph interface to TraceValuesGraphBackend
    const backend = {
      getNode: async (id: string) => {
        const n = await graph.getNode(id);
        if (!n) return null;
        return {
          id: n.id,
          type: (n as { type?: string }).type,
          nodeType: (n as { nodeType?: string }).nodeType,
          value: (n as { value?: unknown }).value,
          file: (n as { file?: string }).file,
          line: (n as { line?: number }).line,
          expressionType: (n as { expressionType?: string }).expressionType,
          object: (n as { object?: string }).object,
          property: (n as { property?: string }).property,
        };
      },
      getOutgoingEdges: async (nodeId: string, edgeTypes: string[] | null) => {
        const edges = await graph.getOutgoingEdges(nodeId);
        const filtered = edgeTypes === null
          ? edges
          : edges.filter(e => edgeTypes.includes(e.type));
        return filtered.map(e => ({
          src: (e as { src?: string; source_id?: string }).src ||
               (e as { source_id?: string }).source_id || '',
          dst: (e as { dst?: string; target_id?: string }).dst ||
               (e as { target_id?: string }).target_id || '',
          type: e.type,
        }));
      },
    };

    // Use shared utility
    const traced = await traceValues(backend, node.id, {
      maxDepth: ValueDomainAnalyzer.MAX_DEPTH - depth,
      followDerivesFrom: true,
      detectNondeterministic: true,
    });

    return aggregateValues(traced);
  }

  /**
   * Find method by object name and method name
   */
  async findMethod(
    objectName: string,
    methodName: string,
    file: string,
    graph: Graph
  ): Promise<NodeRecord | null> {
    // Find methods in the same file
    for await (const node of graph.queryNodes({ nodeType: 'FUNCTION' })) {
      const funcNode = node as { file?: string; name?: string };
      if (funcNode.file === file && funcNode.name === methodName) {
        // Check if this is a method of the right object
        // Simplified: check via incoming CONTAINS edges from CLASS
        const incoming = await graph.getIncomingEdges(node.id);
        const containsEdges = incoming.filter(e => e.type === 'CONTAINS');

        for (const edge of containsEdges) {
          const sourceId = (edge as { src?: string; source_id?: string }).src ||
                           (edge as { source_id?: string }).source_id;
          if (!sourceId) continue;

          const container = await graph.getNode(sourceId);
          // node_type (from DB) or type (from addNodes)
          const containerType = (container as { node_type?: string; type?: string })?.node_type ||
                                (container as { type?: string })?.type;
          const containerName = (container as { name?: string })?.name;
          if (container && containerType === 'CLASS' && containerName === objectName) {
            return node;
          }
        }
      }
    }

    return null;
  }

  /**
   * Resolve computed property names for object mutations.
   * Finds FLOWS_INTO edges with mutationType: 'computed' and resolves
   * the property name using value set tracing.
   *
   * @param graph - Graph backend with edge operations
   * @returns Statistics about resolution
   */
  async resolveComputedMutations(graph: Graph, logger: ReturnType<typeof this.log>): Promise<{
    resolved: number;
    conditional: number;
    unknownParameter: number;
    unknownRuntime: number;
    deferredCrossFile: number;
    total: number;
  }> {
    const stats = {
      resolved: 0,
      conditional: 0,
      unknownParameter: 0,
      unknownRuntime: 0,
      deferredCrossFile: 0,
      total: 0
    };

    // Process edges by finding all VARIABLE and CONSTANT nodes and checking their outgoing edges
    const processedEdges = new Set<string>();

    // Helper to process a node's outgoing edges
    const processNodeEdges = async (node: NodeRecord): Promise<void> => {
      const outgoing = await graph.getOutgoingEdges(node.id);

      for (const edge of outgoing) {
        if (edge.type !== 'FLOWS_INTO') continue;

        const edgeKey = `${edge.src}->${edge.dst}:FLOWS_INTO`;
        if (processedEdges.has(edgeKey)) continue;
        processedEdges.add(edgeKey);

        const mutationType = edge.metadata?.mutationType as string | undefined;
        const computedPropertyVar = edge.metadata?.computedPropertyVar as string | undefined;

        if (mutationType !== 'computed' || !computedPropertyVar) continue;

        stats.total++;

        // Get file from source node
        const sourceNode = await graph.getNode(edge.src);
        const file = (sourceNode as { file?: string })?.file;
        if (!file) continue;

        // Resolve the computed property variable using existing getValueSet
        const valueSet = await this.getValueSet(computedPropertyVar, file, graph);

        // Check if the variable is a PARAMETER node
        let isParameter = false;
        for await (const node of graph.queryNodes({ nodeType: 'PARAMETER' })) {
          const paramNode = node as { name?: string; file?: string; attrs?: { name?: string; file?: string } };
          const nodeName = paramNode.name || paramNode.attrs?.name;
          const nodeFile = paramNode.file || paramNode.attrs?.file;
          if (nodeName === computedPropertyVar && nodeFile === file) {
            isParameter = true;
            break;
          }
        }

        // Determine resolution status based on value set
        let resolutionStatus: string;
        let resolvedPropertyNames: string[] = [];

        if (valueSet.values.length === 0 && isParameter) {
          // Variable is a function parameter - cannot be statically resolved
          resolutionStatus = 'UNKNOWN_PARAMETER';
          stats.unknownParameter++;
        } else if (valueSet.values.length === 0 && valueSet.hasUnknown) {
          // Completely nondeterministic - runtime value (function call result, etc.)
          resolutionStatus = 'UNKNOWN_RUNTIME';
          stats.unknownRuntime++;
        } else if (valueSet.values.length === 0) {
          // No values found at all - treat as unknown
          resolutionStatus = 'UNKNOWN_RUNTIME';
          stats.unknownRuntime++;
        } else if (valueSet.values.length === 1 && !valueSet.hasUnknown) {
          // Single deterministic value
          resolutionStatus = 'RESOLVED';
          resolvedPropertyNames = valueSet.values.map(v => String(v));
          stats.resolved++;
        } else {
          // Multiple values (conditional) or partial resolution
          resolutionStatus = 'RESOLVED_CONDITIONAL';
          resolvedPropertyNames = valueSet.values.map(v => String(v));
          stats.conditional++;
        }

        // Update edge: delete old, create new with resolved data
        // Following the same pattern as InstanceOfResolver
        if (graph.deleteEdge) {
          await graph.deleteEdge(edge.src, edge.dst, 'FLOWS_INTO');
        }

        // Preserve original edge data and add resolution info
        // For UNKNOWN cases, keep propertyName as '<computed>' and resolvedPropertyNames empty
        await graph.addEdge({
          src: edge.src,
          dst: edge.dst,
          type: 'FLOWS_INTO',
          metadata: {
            mutationType,
            propertyName: resolvedPropertyNames[0] || '<computed>',
            computedPropertyVar,
            resolvedPropertyNames,
            resolutionStatus
          }
        });
      }
    };

    // Process VARIABLE nodes
    for await (const node of graph.queryNodes({ nodeType: 'VARIABLE' })) {
      await processNodeEdges(node);
    }

    // Process CONSTANT nodes
    for await (const node of graph.queryNodes({ nodeType: 'CONSTANT' })) {
      await processNodeEdges(node);
    }

    return stats;
  }
}

export default ValueDomainAnalyzer;
