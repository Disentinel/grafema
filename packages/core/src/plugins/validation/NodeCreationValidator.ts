/**
 * NodeCreationValidator - validates that nodes are created through NodeFactory
 *
 * GUARANTEE: All nodes passed to graph.addNode() or graph.addNodes() must be
 * created through NodeFactory methods, not constructed inline.
 *
 * This validator uses the data flow tracking (HAS_PROPERTY, HAS_ELEMENT, FLOWS_INTO edges)
 * to trace object literals back to their source and verify they come from
 * NodeFactory calls.
 *
 * FLOWS_INTO traversal: When an array variable is passed to addNodes(), we check:
 * 1. Static array contents via HAS_ELEMENT edges
 * 2. Dynamic array contents via FLOWS_INTO edges (from push, unshift, splice, indexed assignment)
 *
 * DATALOG RULES (conceptual):
 *
 * % Find all calls to addNodes (batch)
 * add_nodes_call(Call) :-
 *     node(Call, "CALL"),
 *     attr(Call, "name", "addNodes").
 *
 * % Find array argument passed to addNodes (arg 0)
 * add_nodes_array(Call, Arr) :-
 *     add_nodes_call(Call),
 *     edge(Call, Arr, "PASSES_ARGUMENT"),
 *     node(Arr, "ARRAY_LITERAL").
 *
 * % Find objects inside the array (static elements)
 * add_nodes_object(Call, Obj) :-
 *     add_nodes_array(Call, Arr),
 *     edge(Arr, Obj, "HAS_ELEMENT"),
 *     node(Obj, "OBJECT_LITERAL").
 *
 * % Find objects pushed/unshifted/spliced into array (dynamic elements)
 * add_nodes_object(Call, Obj) :-
 *     add_nodes_call(Call),
 *     edge(Call, ArrVar, "PASSES_ARGUMENT"),
 *     node(ArrVar, "VARIABLE"),
 *     incoming(ArrVar, Obj, "FLOWS_INTO"),  % value --FLOWS_INTO--> array
 *     node(Obj, "OBJECT_LITERAL").
 *
 * % Object created via NodeFactory
 * from_node_factory(Obj) :-
 *     incoming(Obj, Creator, "ASSIGNED_FROM"),
 *     node(Creator, "CALL"),
 *     attr(Creator, "object", "NodeFactory").
 *
 * % Violation: object in addNodes not from NodeFactory
 * violation_batch(Call, Obj) :-
 *     add_nodes_object(Call, Obj),
 *     \+ from_node_factory(Obj).
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';

/**
 * Edge structure for querying
 */
interface EdgeRecord {
  type: string;
  src: string;
  dst: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Extended node with call properties
 */
interface CallNode extends BaseNodeRecord {
  method?: string;
  object?: string;
}

/**
 * Validation issue
 */
interface NodeCreationIssue {
  type: 'INLINE_OBJECT_LITERAL' | 'INLINE_ARRAY_ELEMENT' | 'UNKNOWN_SOURCE';
  severity: 'ERROR' | 'WARNING';
  message: string;
  callSiteId: string;
  objectId?: string;
  file?: string;
  line?: number;
  suggestion: string;
}

/**
 * Validation summary
 */
interface ValidationSummary {
  addNodeCalls: number;
  addNodesCalls: number;
  inlineObjects: number;
  factoryObjects: number;
  unknownObjects: number;
  totalViolations: number;
  timeSeconds: string;
}

export class NodeCreationValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'NodeCreationValidator',
      phase: 'VALIDATION',
      priority: 90, // Run after data flow analysis
      creates: {
        nodes: [],
        edges: []
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;

    console.log('[NodeCreationValidator] Checking NodeFactory usage...');
    const startTime = Date.now();

    const issues: NodeCreationIssue[] = [];
    let addNodeCalls = 0;
    let addNodesCalls = 0;
    let inlineObjects = 0;
    let factoryObjects = 0;
    let unknownObjects = 0;

    // Check if graph supports required methods
    if (!graph.getAllEdges || !graph.getAllNodes) {
      console.log('[NodeCreationValidator] Graph does not support getAllEdges/getAllNodes, skipping validation');
      return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: true });
    }

    const allNodes = await graph.getAllNodes();
    const allEdges = await graph.getAllEdges() as EdgeRecord[];

    // Build lookup maps for efficient queries
    const nodesById = new Map<string, BaseNodeRecord>();
    for (const node of allNodes) {
      nodesById.set(node.id, node);
    }

    const edgesBySrc = new Map<string, EdgeRecord[]>();
    const edgesByDst = new Map<string, EdgeRecord[]>();
    for (const edge of allEdges) {
      if (!edgesBySrc.has(edge.src)) edgesBySrc.set(edge.src, []);
      edgesBySrc.get(edge.src)!.push(edge);
      if (!edgesByDst.has(edge.dst)) edgesByDst.set(edge.dst, []);
      edgesByDst.get(edge.dst)!.push(edge);
    }

    // 1. Find all calls to addNode and addNodes
    console.log('[NodeCreationValidator] Searching for addNode/addNodes calls...');

    for (const node of allNodes) {
      if (node.type !== 'CALL') continue;
      const callNode = node as CallNode;

      // Check for addNode() method call
      if (callNode.method === 'addNode' || callNode.name === 'addNode' ||
          (callNode.name && callNode.name.endsWith('.addNode'))) {
        addNodeCalls++;
        const argIssues = await this.validateAddNodeCall(
          callNode,
          edgesBySrc,
          edgesByDst,
          nodesById
        );
        issues.push(...argIssues);
      }

      // Check for addNodes() method call
      if (callNode.method === 'addNodes' || callNode.name === 'addNodes' ||
          (callNode.name && callNode.name.endsWith('.addNodes'))) {
        addNodesCalls++;
        const argIssues = await this.validateAddNodesCall(
          callNode,
          edgesBySrc,
          edgesByDst,
          nodesById
        );
        issues.push(...argIssues);
      }
    }

    // Count violation types
    for (const issue of issues) {
      if (issue.type === 'INLINE_OBJECT_LITERAL' || issue.type === 'INLINE_ARRAY_ELEMENT') {
        inlineObjects++;
      } else if (issue.type === 'UNKNOWN_SOURCE') {
        unknownObjects++;
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const summary: ValidationSummary = {
      addNodeCalls,
      addNodesCalls,
      inlineObjects,
      factoryObjects,  // Would need positive tracking to count
      unknownObjects,
      totalViolations: issues.length,
      timeSeconds: totalTime
    };

    console.log('[NodeCreationValidator] Summary:', summary);

    if (issues.length > 0) {
      console.log('[NodeCreationValidator] ❌ NodeFactory violations found:');
      for (const issue of issues.slice(0, 10)) {  // Limit output
        console.log(`  🚫 [${issue.type}] ${issue.message}`);
        console.log(`     Suggestion: ${issue.suggestion}`);
      }
      if (issues.length > 10) {
        console.log(`  ... and ${issues.length - 10} more violations`);
      }
    } else {
      console.log('[NodeCreationValidator] ✅ All nodes created through NodeFactory');
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary, issues }
    );
  }

  /**
   * Validate a single addNode(node) call
   */
  private async validateAddNodeCall(
    callNode: CallNode,
    edgesBySrc: Map<string, EdgeRecord[]>,
    edgesByDst: Map<string, EdgeRecord[]>,
    nodesById: Map<string, BaseNodeRecord>
  ): Promise<NodeCreationIssue[]> {
    const issues: NodeCreationIssue[] = [];

    // Find PASSES_ARGUMENT edge (arg 0)
    const passedArgs = edgesBySrc.get(callNode.id)?.filter(e =>
      e.type === 'PASSES_ARGUMENT'
    ) || [];

    for (const argEdge of passedArgs) {
      const argNode = nodesById.get(argEdge.dst);
      if (!argNode) continue;

      // Check if it's an inline object literal
      if (argNode.type === 'OBJECT_LITERAL') {
        const isFromFactory = this.isFromNodeFactory(argNode.id, edgesByDst, nodesById);
        if (!isFromFactory) {
          issues.push({
            type: 'INLINE_OBJECT_LITERAL',
            severity: 'ERROR',
            message: `Inline object literal passed to addNode() at ${callNode.file}:${callNode.line}`,
            callSiteId: callNode.id,
            objectId: argNode.id,
            file: callNode.file,
            line: callNode.line as number | undefined,
            suggestion: 'Use NodeFactory.createX() to create the node instead of an inline object'
          });
        }
      }

      // Check if it's a variable - trace its origin
      if (argNode.type === 'VARIABLE' || argNode.type === 'VARIABLE_DECLARATION') {
        const source = this.traceVariableSource(argNode.id, edgesBySrc, nodesById);
        if (source && source.type === 'OBJECT_LITERAL') {
          const isFromFactory = this.isFromNodeFactory(source.id, edgesByDst, nodesById);
          if (!isFromFactory) {
            issues.push({
              type: 'INLINE_OBJECT_LITERAL',
              severity: 'ERROR',
              message: `Variable "${argNode.name}" assigned from inline object literal, passed to addNode() at ${callNode.file}:${callNode.line}`,
              callSiteId: callNode.id,
              objectId: source.id,
              file: callNode.file,
              line: callNode.line as number | undefined,
              suggestion: 'Use NodeFactory.createX() to create the node instead of an inline object'
            });
          }
        }
      }
    }

    return issues;
  }

  /**
   * Validate addNodes([...]) call
   * Also checks for objects that flow into arrays via FLOWS_INTO edges
   */
  private async validateAddNodesCall(
    callNode: CallNode,
    edgesBySrc: Map<string, EdgeRecord[]>,
    edgesByDst: Map<string, EdgeRecord[]>,
    nodesById: Map<string, BaseNodeRecord>
  ): Promise<NodeCreationIssue[]> {
    const issues: NodeCreationIssue[] = [];

    // Find PASSES_ARGUMENT edge (arg 0 - the array)
    const passedArgs = edgesBySrc.get(callNode.id)?.filter(e =>
      e.type === 'PASSES_ARGUMENT'
    ) || [];

    for (const argEdge of passedArgs) {
      const argNode = nodesById.get(argEdge.dst);
      if (!argNode) continue;

      // Check if it's an array literal
      if (argNode.type === 'ARRAY_LITERAL') {
        // Find all HAS_ELEMENT edges
        const elements = edgesBySrc.get(argNode.id)?.filter(e =>
          e.type === 'HAS_ELEMENT'
        ) || [];

        for (const elemEdge of elements) {
          const elemNode = nodesById.get(elemEdge.dst);
          if (!elemNode) continue;

          // Check if element is an inline object literal
          if (elemNode.type === 'OBJECT_LITERAL') {
            const isFromFactory = this.isFromNodeFactory(elemNode.id, edgesByDst, nodesById);
            if (!isFromFactory) {
              const elemIndex = elemEdge.metadata?.elementIndex ?? '?';
              issues.push({
                type: 'INLINE_ARRAY_ELEMENT',
                severity: 'ERROR',
                message: `Inline object literal at index ${elemIndex} in addNodes() array at ${callNode.file}:${callNode.line}`,
                callSiteId: callNode.id,
                objectId: elemNode.id,
                file: callNode.file,
                line: callNode.line as number | undefined,
                suggestion: 'Use NodeFactory.createX() to create each node in the array'
              });
            }
          }

          // Check if element is a variable - trace its origin
          if (elemNode.type === 'VARIABLE' || elemNode.type === 'VARIABLE_DECLARATION') {
            const source = this.traceVariableSource(elemNode.id, edgesBySrc, nodesById);
            if (source && source.type === 'OBJECT_LITERAL') {
              const isFromFactory = this.isFromNodeFactory(source.id, edgesByDst, nodesById);
              if (!isFromFactory) {
                const elemIndex = elemEdge.metadata?.elementIndex ?? '?';
                issues.push({
                  type: 'INLINE_ARRAY_ELEMENT',
                  severity: 'ERROR',
                  message: `Variable "${elemNode.name}" at index ${elemIndex} assigned from inline object, passed to addNodes() at ${callNode.file}:${callNode.line}`,
                  callSiteId: callNode.id,
                  objectId: source.id,
                  file: callNode.file,
                  line: callNode.line as number | undefined,
                  suggestion: 'Use NodeFactory.createX() to create the node'
                });
              }
            }
          }
        }
      }

      // Check if it's a variable containing an array
      if (argNode.type === 'VARIABLE' || argNode.type === 'VARIABLE_DECLARATION') {
        // Check what flows INTO this variable (array mutations via push/unshift/splice/indexed)
        const incomingFlows = this.getArrayContents(argNode.id, edgesByDst, nodesById);

        for (const sourceNode of incomingFlows) {
          // Check if the pushed value is an object literal
          if (sourceNode.type === 'OBJECT_LITERAL') {
            const isFromFactory = this.isFromNodeFactory(sourceNode.id, edgesByDst, nodesById);
            if (!isFromFactory) {
              issues.push({
                type: 'INLINE_ARRAY_ELEMENT',
                severity: 'ERROR',
                message: `Object pushed into array "${argNode.name}" is not from NodeFactory, passed to addNodes() at ${callNode.file}:${callNode.line}`,
                callSiteId: callNode.id,
                objectId: sourceNode.id,
                file: callNode.file,
                line: callNode.line as number | undefined,
                suggestion: 'Use NodeFactory.createX() to create nodes before pushing to array'
              });
            }
          }

          // Also trace if the pushed value is a variable
          if (sourceNode.type === 'VARIABLE' || sourceNode.type === 'VARIABLE_DECLARATION') {
            const source = this.traceVariableSource(sourceNode.id, edgesBySrc, nodesById);
            if (source && source.type === 'OBJECT_LITERAL') {
              const isFromFactory = this.isFromNodeFactory(source.id, edgesByDst, nodesById);
              if (!isFromFactory) {
                issues.push({
                  type: 'INLINE_ARRAY_ELEMENT',
                  severity: 'ERROR',
                  message: `Variable "${sourceNode.name}" pushed into array "${argNode.name}" is not from NodeFactory, passed to addNodes() at ${callNode.file}:${callNode.line}`,
                  callSiteId: callNode.id,
                  objectId: source.id,
                  file: callNode.file,
                  line: callNode.line as number | undefined,
                  suggestion: 'Use NodeFactory.createX() to create the node'
                });
              }
            }
          }
        }

        // Also check static array contents (HAS_ELEMENT) - existing logic
        const source = this.traceVariableSource(argNode.id, edgesBySrc, nodesById);
        if (source && source.type === 'ARRAY_LITERAL') {
          // Recursively check array elements
          const elements = edgesBySrc.get(source.id)?.filter(e =>
            e.type === 'HAS_ELEMENT'
          ) || [];

          for (const elemEdge of elements) {
            const elemNode = nodesById.get(elemEdge.dst);
            if (!elemNode) continue;

            if (elemNode.type === 'OBJECT_LITERAL') {
              const isFromFactory = this.isFromNodeFactory(elemNode.id, edgesByDst, nodesById);
              if (!isFromFactory) {
                const elemIndex = elemEdge.metadata?.elementIndex ?? '?';
                issues.push({
                  type: 'INLINE_ARRAY_ELEMENT',
                  severity: 'ERROR',
                  message: `Inline object at index ${elemIndex} in array "${argNode.name}" passed to addNodes() at ${callNode.file}:${callNode.line}`,
                  callSiteId: callNode.id,
                  objectId: elemNode.id,
                  file: callNode.file,
                  line: callNode.line as number | undefined,
                  suggestion: 'Use NodeFactory.createX() to create each node in the array'
                });
              }
            }
          }
        }
      }
    }

    return issues;
  }

  /**
   * Get all nodes that flow INTO an array variable via FLOWS_INTO edges
   * These are objects/values that were pushed, unshifted, spliced, or assigned to the array
   *
   * Edge direction: value --FLOWS_INTO--> array
   * So we look for INCOMING edges where dst === arrayNodeId
   */
  private getArrayContents(
    arrayNodeId: string,
    edgesByDst: Map<string, EdgeRecord[]>,
    nodesById: Map<string, BaseNodeRecord>
  ): BaseNodeRecord[] {
    const contents: BaseNodeRecord[] = [];

    // Find INCOMING FLOWS_INTO edges to this array
    const incomingFlows = edgesByDst.get(arrayNodeId)?.filter(e =>
      e.type === 'FLOWS_INTO'
    ) || [];

    for (const edge of incomingFlows) {
      const sourceNode = nodesById.get(edge.src);
      if (sourceNode) {
        contents.push(sourceNode);
      }
    }

    return contents;
  }

  /**
   * Check if a node is created from NodeFactory
   * Traces ASSIGNED_FROM edges to find the source call
   */
  private isFromNodeFactory(
    nodeId: string,
    edgesByDst: Map<string, EdgeRecord[]>,
    nodesById: Map<string, BaseNodeRecord>,
    visited: Set<string> = new Set()
  ): boolean {
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);

    // Find incoming ASSIGNED_FROM edges
    const incomingEdges = edgesByDst.get(nodeId)?.filter(e =>
      e.type === 'ASSIGNED_FROM'
    ) || [];

    for (const edge of incomingEdges) {
      const sourceNode = nodesById.get(edge.src);
      if (!sourceNode) continue;

      // Check if source is a CALL to NodeFactory
      if (sourceNode.type === 'CALL') {
        const callNode = sourceNode as CallNode;
        // Check various ways NodeFactory calls can appear
        if (callNode.object === 'NodeFactory' ||
            callNode.name?.startsWith('NodeFactory.') ||
            callNode.name === 'NodeFactory') {
          return true;
        }
      }

      // Continue tracing through variables
      if (sourceNode.type === 'VARIABLE' || sourceNode.type === 'VARIABLE_DECLARATION') {
        if (this.isFromNodeFactory(sourceNode.id, edgesByDst, nodesById, visited)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Trace a variable back to its source node (through ASSIGNED_FROM edges)
   */
  private traceVariableSource(
    nodeId: string,
    edgesBySrc: Map<string, EdgeRecord[]>,
    nodesById: Map<string, BaseNodeRecord>,
    visited: Set<string> = new Set()
  ): BaseNodeRecord | null {
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);

    // Find outgoing ASSIGNED_FROM edges (variable -> source)
    const outgoingEdges = edgesBySrc.get(nodeId)?.filter(e =>
      e.type === 'ASSIGNED_FROM'
    ) || [];

    for (const edge of outgoingEdges) {
      const targetNode = nodesById.get(edge.dst);
      if (!targetNode) continue;

      // If target is a literal/call/object, return it
      if (targetNode.type === 'OBJECT_LITERAL' ||
          targetNode.type === 'ARRAY_LITERAL' ||
          targetNode.type === 'CALL' ||
          targetNode.type === 'LITERAL') {
        return targetNode;
      }

      // Continue tracing through variables
      if (targetNode.type === 'VARIABLE' || targetNode.type === 'VARIABLE_DECLARATION') {
        const source = this.traceVariableSource(targetNode.id, edgesBySrc, nodesById, visited);
        if (source) return source;
      }
    }

    return null;
  }
}
