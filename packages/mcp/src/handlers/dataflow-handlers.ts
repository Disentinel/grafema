/**
 * MCP Dataflow Handlers
 */

import { ensureAnalyzed } from '../analysis.js';
import { getProjectPath } from '../state.js';
import {
  serializeBigInt,
  textResult,
  errorResult,
} from '../utils.js';
import { isGrafemaUri, toCompactSemanticId } from '@grafema/util';
import type {
  ToolResult,
  TraceAliasArgs,
  TraceDataFlowArgs,
  CheckInvariantArgs,
  GraphNode,
} from '../types.js';

// === TRACE HANDLERS ===

export async function handleTraceAlias(args: TraceAliasArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { variableName, file } = args;
  const _projectPath = getProjectPath();

  let varNode: GraphNode | null = null;

  for await (const node of db.queryNodes({ type: 'VARIABLE' })) {
    if (node.name === variableName && node.file?.includes(file || '')) {
      varNode = node;
      break;
    }
  }

  if (!varNode) {
    for await (const node of db.queryNodes({ type: 'CONSTANT' })) {
      if (node.name === variableName && node.file?.includes(file || '')) {
        varNode = node;
        break;
      }
    }
  }

  if (!varNode) {
    return errorResult(`Variable "${variableName}" not found in ${file || 'project'}`);
  }

  const chain: unknown[] = [];
  const visited = new Set<string>();
  let current: GraphNode | null = varNode;
  const MAX_DEPTH = 20;

  while (current && chain.length < MAX_DEPTH) {
    if (visited.has(current.id)) {
      chain.push({ type: 'CYCLE_DETECTED', id: current.id });
      break;
    }
    visited.add(current.id);

    // Resolve REFERENCE → declaration transparently (don't add to chain)
    if (current.type === 'REFERENCE') {
      const resolveEdges = await db.getOutgoingEdges(current.id, ['READS_FROM']);
      if (resolveEdges.length > 0) {
        current = await db.getNode(resolveEdges[0].dst);
        continue;
      }
      break;
    }

    chain.push({
      type: current.type,
      name: current.name,
      file: current.file,
      line: current.line,
    });

    const edges = await db.getOutgoingEdges(current.id, ['ASSIGNED_FROM']);
    if (edges.length === 0) break;

    current = await db.getNode(edges[0].dst);
  }

  return textResult(
    `Alias chain for "${variableName}" (${chain.length} steps):\n\n${JSON.stringify(
      serializeBigInt(chain),
      null,
      2
    )}`
  );
}

export async function handleTraceDataFlow(args: TraceDataFlowArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { source, direction = 'forward', max_depth = 10, limit = 10 } = args;

  // Find source node
  let sourceNode: GraphNode | null = await db.getNode(source);
  if (!sourceNode) {
    for await (const node of db.queryNodes({ name: source })) {
      sourceNode = node;
      break;
    }
  }
  if (!sourceNode) {
    const displaySource = isGrafemaUri(source) ? toCompactSemanticId(source) : source;
    return errorResult(`Source "${displaySource}" not found`);
  }

  // Resolve REFERENCE to its declaration before starting
  let startId = sourceNode.id;
  if (sourceNode.type === 'REFERENCE') {
    const resolveEdges = await db.getOutgoingEdges(startId, ['READS_FROM']);
    if (resolveEdges.length > 0) {
      startId = resolveEdges[0].dst;
    }
  }

  const paths: string[][] = [];

  // Helper: resolve REFERENCE → declaration via READS_FROM
  async function resolveRef(nodeId: string): Promise<string | null> {
    const node = await db.getNode(nodeId);
    if (!node) return null;
    if (node.type === 'REFERENCE') {
      const edges = await db.getOutgoingEdges(nodeId, ['READS_FROM']);
      return edges.length > 0 ? edges[0].dst : null;
    }
    return nodeId;
  }

  // Helper: climb structural edges from a node to find the declaration it feeds into.
  // E.g., SEED_ref ←HAS_PROPERTY← obj_expr ←ASSIGNED_FROM← CONSTANT:obj
  // Returns IDs of declarations that contain this node's value.
  async function climbToAssignment(nodeId: string, maxClimb: number): Promise<string[]> {
    if (maxClimb <= 0) return [];
    const results: string[] = [];

    // Check if something is ASSIGNED_FROM this node directly
    const afEdges = await db.getIncomingEdges(nodeId, ['ASSIGNED_FROM']);
    for (const af of afEdges) {
      results.push(af.src);
    }

    // Check if this node is WRITES_TO target (someone writes from this)
    const wtEdges = await db.getIncomingEdges(nodeId, ['WRITES_TO']);
    for (const wt of wtEdges) {
      const decl = await resolveRef(wt.src);
      if (decl) results.push(decl);
    }

    if (results.length > 0) return results;

    // Climb up structural edges: HAS_PROPERTY, HAS_ELEMENT, HAS_CONSEQUENT, HAS_ALTERNATE
    const structural = await db.getIncomingEdges(nodeId, [
      'HAS_PROPERTY', 'HAS_ELEMENT', 'HAS_CONSEQUENT', 'HAS_ALTERNATE',
    ]);
    for (const edge of structural) {
      const higher = await climbToAssignment(edge.src, maxClimb - 1);
      results.push(...higher);
    }
    return results;
  }

  // Forward: where does the value of this declaration flow TO?
  //
  // Data flow edges (ASSIGNED_FROM, WRITES_TO) point from receiver → source.
  // So "forward" = follow these edges INCOMING (find who receives value from us).
  // READS_FROM connects references to declarations — used to bridge the gap.
  //
  // Chain: Declaration ←READS_FROM← Reference ←ASSIGNED_FROM← NextDeclaration
  //    or: Declaration ←READS_FROM← Reference ←WRITES_TO← LHS_Ref →READS_FROM→ TargetDecl
  //    or: Declaration ←READS_FROM← Reference ←HAS_PROP← Obj ←ASSIGNED_FROM← Var
  //    or: Declaration ←READS_FROM← Reference ←PASSES_ARG← Call →RECEIVES_ARG→ Param
  async function traceForward(declId: string, depth: number, path: string[], visited: Set<string>): Promise<void> {
    if (depth > max_depth || visited.has(declId) || paths.length >= limit) return;
    visited.add(declId);

    const currentPath = [...path, declId];
    let foundNext = false;

    // Find all references that read this declaration
    const refsToDecl = await db.getIncomingEdges(declId, ['READS_FROM']);

    for (const refEdge of refsToDecl) {
      if (paths.length >= limit) break;
      const refId = refEdge.src;

      // Case A: ref is RHS of `const x = ref` → incoming ASSIGNED_FROM on ref
      const afEdges = await db.getIncomingEdges(refId, ['ASSIGNED_FROM']);
      for (const af of afEdges) {
        foundNext = true;
        await traceForward(af.src, depth + 1, currentPath, visited);
      }

      // Case B: ref is RHS of `x = ref` (imperative) → incoming WRITES_TO on ref
      const wtEdges = await db.getIncomingEdges(refId, ['WRITES_TO']);
      for (const wt of wtEdges) {
        const targetDecl = await resolveRef(wt.src);
        if (targetDecl && !visited.has(targetDecl)) {
          foundNext = true;
          await traceForward(targetDecl, depth + 1, currentPath, visited);
        }
      }

      // Case C: ref passed as argument → incoming PASSES_ARGUMENT on ref
      // PASSES_ARGUMENT(CALL, arg_ref): CALL passes arg_ref as argument
      // To reach PARAMETER: CALL →CALLS→ FUNCTION →RECEIVES_ARGUMENT→ PARAMETER
      const paEdges = await db.getIncomingEdges(refId, ['PASSES_ARGUMENT']);
      for (const pa of paEdges) {
        // pa.src is the CALL node. Follow CALLS to find the target FUNCTION.
        const callsEdges = await db.getOutgoingEdges(pa.src, ['CALLS']);
        for (const callEdge of callsEdges) {
          // callEdge.dst is the FUNCTION. Follow RECEIVES_ARGUMENT to PARAMETER.
          const raEdges = await db.getOutgoingEdges(callEdge.dst, ['RECEIVES_ARGUMENT']);
          for (const ra of raEdges) {
            foundNext = true;
            await traceForward(ra.dst, depth + 1, currentPath, visited);
          }
        }
        // Also check what variable captures the call result (climb from CALL)
        const callTargets = await climbToAssignment(pa.src, 3);
        for (const target of callTargets) {
          if (!visited.has(target)) {
            foundNext = true;
            await traceForward(target, depth + 1, currentPath, visited);
          }
        }
      }

      // Case D: ref in structural container → climb to assignment target
      // { key: ref }, [ref, ...], cond ? ref : alt
      const structural = await db.getIncomingEdges(refId, [
        'HAS_PROPERTY', 'HAS_ELEMENT', 'HAS_CONSEQUENT', 'HAS_ALTERNATE',
      ]);
      for (const se of structural) {
        const targets = await climbToAssignment(se.src, 3);
        for (const target of targets) {
          if (!visited.has(target)) {
            foundNext = true;
            await traceForward(target, depth + 1, currentPath, visited);
          }
        }
      }
    }

    if (!foundNext && depth > 0) {
      paths.push(currentPath);
    }
  }

  // Helper: descend into an expression node to find value sources.
  // E.g., CALL node → follow PASSES_ARGUMENT to find arguments
  //        Object/Array → follow HAS_PROPERTY/HAS_ELEMENT to find contained values
  async function descendToSources(nodeId: string, maxDescend: number): Promise<string[]> {
    if (maxDescend <= 0) return [];
    const results: string[] = [];
    const node = await db.getNode(nodeId);
    if (!node) return [];

    // If it's a reference, resolve it
    if (node.type === 'REFERENCE') {
      const resolved = await resolveRef(nodeId);
      if (resolved) results.push(resolved);
      return results;
    }

    // If it's a declaration/literal, it's a terminal
    if (['CONSTANT', 'VARIABLE', 'PARAMETER', 'LITERAL'].includes(node.type)) {
      results.push(nodeId);
      return results;
    }

    // Descend into structural children
    const children = await db.getOutgoingEdges(nodeId, [
      'HAS_PROPERTY', 'HAS_ELEMENT', 'HAS_CONSEQUENT', 'HAS_ALTERNATE',
      'PASSES_ARGUMENT',
    ]);
    for (const child of children) {
      const deeper = await descendToSources(child.dst, maxDescend - 1);
      results.push(...deeper);
    }
    return results;
  }

  // Backward: where does the value come FROM?
  //
  // Follow ASSIGNED_FROM/WRITES_TO outgoing (toward the source).
  // Resolve REFERENCEs via READS_FROM to reach the source declaration.
  async function traceBackward(declId: string, depth: number, path: string[], visited: Set<string>): Promise<void> {
    if (depth > max_depth || visited.has(declId) || paths.length >= limit) return;
    visited.add(declId);

    const currentPath = [...path, declId];
    let foundNext = false;

    // Case A: declaration-time init → outgoing ASSIGNED_FROM
    const afEdges = await db.getOutgoingEdges(declId, ['ASSIGNED_FROM']);
    for (const af of afEdges) {
      const sourceDecl = await resolveRef(af.dst);
      if (sourceDecl && !visited.has(sourceDecl)) {
        foundNext = true;
        await traceBackward(sourceDecl, depth + 1, currentPath, visited);
      } else {
        // Terminal: LITERAL, CALL, unresolvable — descend to find inner sources
        const innerSources = await descendToSources(af.dst, 3);
        if (innerSources.length > 0) {
          for (const inner of innerSources) {
            if (!visited.has(inner)) {
              foundNext = true;
              await traceBackward(inner, depth + 1, currentPath, visited);
            }
          }
        } else {
          foundNext = true;
          paths.push([...currentPath, af.dst]);
        }
      }
    }

    // Case B: imperative assignment → refs to this decl that are LHS of WRITES_TO
    const refsToDecl = await db.getIncomingEdges(declId, ['READS_FROM']);
    for (const refEdge of refsToDecl) {
      // If this ref is LHS (src) of WRITES_TO, dst is the value source
      const wtEdges = await db.getOutgoingEdges(refEdge.src, ['WRITES_TO']);
      for (const wt of wtEdges) {
        const sourceDecl = await resolveRef(wt.dst);
        if (sourceDecl && sourceDecl !== declId && !visited.has(sourceDecl)) {
          foundNext = true;
          await traceBackward(sourceDecl, depth + 1, currentPath, visited);
        } else if (!sourceDecl || sourceDecl === declId) {
          foundNext = true;
          paths.push([...currentPath, wt.dst]);
        }
      }
    }

    // Case C: if this is a PARAMETER, trace back to call site arguments
    // PARAMETER ←RECEIVES_ARGUMENT← FUNCTION ←CALLS← CALL →PASSES_ARGUMENT→ arg_ref
    const node = await db.getNode(declId);
    if (node?.type === 'PARAMETER') {
      // Find the FUNCTION that has this parameter
      const raEdges = await db.getIncomingEdges(declId, ['RECEIVES_ARGUMENT']);
      for (const ra of raEdges) {
        // ra.src is the FUNCTION. Find CALLs that call this function.
        const callsEdges = await db.getIncomingEdges(ra.src, ['CALLS']);
        for (const callEdge of callsEdges) {
          // callEdge.src is the CALL. Find PASSES_ARGUMENT to get actual arguments.
          const paEdges = await db.getOutgoingEdges(callEdge.src, ['PASSES_ARGUMENT']);
          for (const pa of paEdges) {
            const argSource = await resolveRef(pa.dst);
            if (argSource && !visited.has(argSource)) {
              foundNext = true;
              await traceBackward(argSource, depth + 1, currentPath, visited);
            }
          }
        }
      }
    }

    if (!foundNext && depth > 0) {
      paths.push(currentPath);
    }
  }

  if (direction === 'forward' || direction === 'both') {
    await traceForward(startId, 0, [], new Set());
  }

  if (direction === 'backward' || direction === 'both') {
    await traceBackward(startId, 0, [], new Set());
  }

  return textResult(
    `Data flow from "${source}" (${paths.length} paths):\n\n${JSON.stringify(paths, null, 2)}`
  );
}

export async function handleCheckInvariant(args: CheckInvariantArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { rule, name: description } = args;

  if (!('checkGuarantee' in db)) {
    return errorResult('Backend does not support Datalog queries');
  }

  try {
    const checkFn = (db as unknown as { checkGuarantee: (q: string) => Promise<Array<{ bindings: Array<{ name: string; value: string }> }>> }).checkGuarantee;
    const violations = await checkFn.call(db, rule);
    const total = violations.length;

    if (total === 0) {
      return textResult(`✅ Invariant holds: ${description || 'No violations found'}`);
    }

    const enrichedViolations: unknown[] = [];
    for (const v of violations.slice(0, 20)) {
      const xBinding = v.bindings?.find((b: { name: string; value: string }) => b.name === 'X');
      if (xBinding) {
        const node = await db.getNode(xBinding.value);
        if (node) {
          enrichedViolations.push({
            id: xBinding.value,
            type: node.type,
            name: node.name,
            file: node.file,
            line: node.line,
          });
        } else {
          // Non-node-ID binding (e.g. attr() string value) — return raw bindings map
          const bindingsMap: Record<string, string> = {};
          for (const b of v.bindings!) {
            bindingsMap[b.name] = b.value;
          }
          enrichedViolations.push(bindingsMap);
        }
      }
    }

    return textResult(
      `❌ ${total} violation(s) found:\n\n${JSON.stringify(
        serializeBigInt(enrichedViolations),
        null,
        2
      )}${total > 20 ? `\n\n... and ${total - 20} more` : ''}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message);
  }
}
