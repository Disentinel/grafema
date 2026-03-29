/**
 * Dataflow BFS Tracing
 *
 * Full BFS-based dataflow analysis with 100% reachability.
 * Forward: 8 heuristics for complete data flow propagation.
 * Backward: structural descent + PA matching + THROWS propagation.
 *
 * Shared by MCP handler and CLI trace command.
 *
 * @module queries/traceDataflow
 */

// === PUBLIC TYPES ===

/** Minimal node interface for dataflow tracing. */
export interface DataflowNode {
  id: string;
  type: string;
  name?: string;
  file?: string;
  line?: number;
  [key: string]: unknown;
}

/** Edge record for dataflow tracing. */
export interface DataflowEdge {
  src: string;
  dst: string;
  type: string;
  index?: number;
  metadata?: Record<string, unknown>;
}

/** Backend interface for dataflow tracing — compatible with RFDBServerBackend and MCP GraphBackend. */
export interface DataflowBackend {
  getNode(id: string): Promise<DataflowNode | null>;
  queryNodes(filter: Record<string, unknown>): AsyncIterable<DataflowNode>;
  getOutgoingEdges(id: string, types?: string[] | null): Promise<DataflowEdge[]>;
  getIncomingEdges(id: string, types?: string[] | null): Promise<DataflowEdge[]>;
}

export interface TraceDataflowOptions {
  direction?: 'forward' | 'backward' | 'both';
  maxDepth?: number;
  limit?: number;
}

export interface TraceDataflowResult {
  direction: 'forward' | 'backward';
  startNode: DataflowNode;
  reached: DataflowNode[];
  totalReached: number;
}

// === CONSTANTS ===

const MUTATION_METHODS = new Set([
  'push', 'unshift', 'splice', 'set', 'add', 'append', 'insert', 'enqueue', 'prepend',
]);

const STRUCTURAL_EDGE_TYPES = ['HAS_PROPERTY', 'HAS_ELEMENT', 'HAS_CONSEQUENT', 'HAS_ALTERNATE'];

// === INTERNAL TYPES ===

interface ReceiverChain {
  base: string;
  path: string;
}

interface PAEntry {
  id: string;
  base: string;
  path: string;
}

// === SHARED HELPERS ===

/** Resolve a node ID through REFERENCE → READS_FROM to reach the declaration. */
async function resolveRef(db: DataflowBackend, nodeId: string): Promise<string | null> {
  const node = await db.getNode(nodeId);
  if (!node) return null;
  if (node.type === 'REFERENCE') {
    const edges = await db.getOutgoingEdges(nodeId, ['READS_FROM']);
    return edges.length > 0 ? edges[0].dst : null;
  }
  return nodeId;
}

/** Extract .index from edge metadata (PASSES_ARGUMENT/RECEIVES_ARGUMENT). */
function edgeIndex(edge: DataflowEdge): number | undefined {
  if (edge.metadata && typeof edge.metadata.index === 'number') return edge.metadata.index;
  if (typeof edge.index === 'number') return edge.index;
  return undefined;
}

/** Check if two argument-index values match (undefined = wildcard). */
function indexMatch(paIdx: number | undefined, raIdx: number | undefined): boolean {
  if (paIdx === undefined || raIdx === undefined) return true;
  return paIdx === raIdx;
}

/** Resolve a PROPERTY_ACCESS receiver chain: walk READS_FROM to find base var + dot-path. */
async function resolveReceiverChain(db: DataflowBackend, paId: string): Promise<ReceiverChain | null> {
  const pathParts: string[] = [];
  let cur: string | null = paId;
  const seen = new Set<string>();

  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const rf = await db.getOutgoingEdges(cur, ['READS_FROM']);
    if (!rf.length) break;

    const t = await db.getNode(rf[0].dst);
    if (!t) break;
    cur = rf[0].dst;

    if (t.type === 'PROPERTY_ACCESS') {
      if (t.name) pathParts.push(t.name);
      continue;
    }

    if (t.type === 'REFERENCE') {
      const re = await db.getOutgoingEdges(t.id, ['READS_FROM']);
      if (re.length) {
        const r = await db.getNode(re[0].dst);
        if (r && (r.type === 'CONSTANT' || r.type === 'VARIABLE')) {
          return { base: r.id, path: pathParts.join('.') };
        }
      }
      return null;
    }

    if (t.type === 'CONSTANT' || t.type === 'VARIABLE') {
      return { base: t.id, path: pathParts.join('.') };
    }

    break;
  }

  return null;
}

/** Resolve dynamic callee: follow ASSIGNED_FROM/READS_FROM chains to find the actual FUNCTION. */
async function resolveDynamicCallee(db: DataflowBackend, nodeId: string): Promise<string | null> {
  const seen = new Set<string>();
  let cur: string | null = nodeId;

  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = await db.getNode(cur);
    if (!n) return null;

    if (n.type === 'FUNCTION') return cur;

    if (n.type === 'REFERENCE') {
      const rf = await db.getOutgoingEdges(cur, ['READS_FROM']);
      if (rf.length) { cur = rf[0].dst; continue; }
      return null;
    }

    if (n.type === 'PARAMETER' || n.type === 'VARIABLE' || n.type === 'CONSTANT') {
      const afs = await db.getOutgoingEdges(cur, ['ASSIGNED_FROM']);
      for (const af of afs) {
        const afN = await db.getNode(af.dst);
        if (afN?.type === 'FUNCTION') return af.dst;
        if (afN?.type === 'REFERENCE') {
          const result = await resolveDynamicCallee(db, af.dst);
          if (result) return result;
        }
      }
      if (n.type === 'PARAMETER') {
        const raIn = await db.getIncomingEdges(cur, ['RECEIVES_ARGUMENT']);
        for (const ra of raIn) {
          const fnId = ra.src;
          const raIdx = edgeIndex(ra);
          for (const ci of await db.getIncomingEdges(fnId, ['CALLS'])) {
            const pas = await db.getOutgoingEdges(ci.src, ['PASSES_ARGUMENT']);
            for (const pa of pas) {
              if (!indexMatch(raIdx, edgeIndex(pa))) continue;
              const paN = await db.getNode(pa.dst);
              if (paN?.type === 'FUNCTION') return pa.dst;
              if (paN?.type === 'REFERENCE') {
                const result = await resolveDynamicCallee(db, pa.dst);
                if (result) return result;
              }
            }
          }
        }
      }
      return null;
    }

    if (n.type === 'PROPERTY_ACCESS') {
      const rf = await db.getOutgoingEdges(cur, ['READS_FROM']);
      if (rf.length) { cur = rf[0].dst; continue; }
      return null;
    }

    return null;
  }

  return null;
}

// === FORWARD BFS ===

/**
 * Forward BFS dataflow trace.
 * Starting from a declaration node, finds all nodes where data flows TO.
 * Returns all reached nodes (including the start node at index 0).
 */
export async function traceForwardBFS(
  db: DataflowBackend,
  startId: string,
  maxIterations: number,
): Promise<DataflowNode[]> {
  const visited = new Set<string>();
  const queue: string[] = [];
  const reachedNodes: DataflowNode[] = [];

  function enq(id: string | null): void {
    if (id && !visited.has(id)) {
      visited.add(id);
      queue.push(id);
    }
  }

  // Guard sets for helper functions
  const processedCalls = new Set<string>();
  const processedFns = new Set<string>();
  const climbProcessed = new Set<string>();

  // Lazy indexes
  let paReadByName: Map<string, PAEntry[]> | null = null;
  let catchParamIds: string[] | null = null;
  /** Lazy index: "file::receiverName" → CALL node IDs for method calls on that receiver. */
  let callsByReceiver: Map<string, string[]> | null = null;

  async function getPAReadByName(): Promise<Map<string, PAEntry[]>> {
    if (paReadByName) return paReadByName;
    paReadByName = new Map();
    for await (const n of db.queryNodes({ type: 'PROPERTY_ACCESS' })) {
      const wt = await db.getOutgoingEdges(n.id, ['WRITES_TO']);
      if (wt.length === 0 && n.name) {
        const chain = await resolveReceiverChain(db, n.id);
        if (chain) {
          let list = paReadByName.get(n.name);
          if (!list) { list = []; paReadByName.set(n.name, list); }
          list.push({ id: n.id, base: chain.base, path: chain.path });
        }
      }
    }
    return paReadByName;
  }

  async function getCatchParams(): Promise<string[]> {
    if (catchParamIds) return catchParamIds;
    catchParamIds = [];
    for await (const p of db.queryNodes({ type: 'PARAMETER' })) {
      const decls = await db.getIncomingEdges(p.id, ['DECLARES']);
      for (const d of decls) {
        const scope = await db.getNode(d.src);
        if (scope?.name === 'catch') { catchParamIds.push(p.id); break; }
      }
    }
    return catchParamIds;
  }

  /**
   * Build index of CALL nodes keyed by "file::receiverName".
   * Used to find method calls on a declaration when CALL→DERIVED_FROM→PA→READS_FROM→REF
   * edges are missing. CALL names encode the receiver: "db.getNode" → receiver "db".
   */
  async function getCallsByReceiver(): Promise<Map<string, string[]>> {
    if (callsByReceiver) return callsByReceiver;
    callsByReceiver = new Map();
    for await (const c of db.queryNodes({ type: 'CALL' })) {
      if (c.name?.includes('.') && c.file) {
        const dotIdx = c.name.indexOf('.');
        const receiver = c.name.substring(0, dotIdx);
        // Skip computed receivers like "<obj>.method"
        if (receiver.startsWith('<')) continue;
        const key = `${c.file}::${receiver}`;
        let list = callsByReceiver.get(key);
        if (!list) { list = []; callsByReceiver.set(key, list); }
        list.push(c.id);
      }
    }
    return callsByReceiver;
  }

  // --- Helper: enqueue call result consumers ---
  async function enqueueCallConsumers(callId: string): Promise<void> {
    if (processedCalls.has(callId)) return;
    processedCalls.add(callId);

    for (const af of await db.getIncomingEdges(callId, ['ASSIGNED_FROM'])) enq(af.src);

    // Structural climb
    for (const se of await db.getIncomingEdges(callId, [...STRUCTURAL_EDGE_TYPES])) {
      await enqueueClimb(se.src, 3);
    }

    // CALL result passed as arg to another CALL
    for (const pa of await db.getIncomingEdges(callId, ['PASSES_ARGUMENT'])) {
      for (const ce of await db.getOutgoingEdges(pa.src, ['CALLS'])) {
        for (const ra of await db.getOutgoingEdges(ce.dst, ['RECEIVES_ARGUMENT'])) enq(ra.dst);
      }
      // Mutation on call result
      for (const df of await db.getOutgoingEdges(pa.src, ['DERIVED_FROM'])) {
        const dfN = await db.getNode(df.dst);
        if (dfN?.type === 'PROPERTY_ACCESS' && dfN.name && MUTATION_METHODS.has(dfN.name)) {
          for (const rf of await db.getOutgoingEdges(df.dst, ['READS_FROM'])) {
            enq(await resolveRef(db, rf.dst));
          }
        }
      }
      // Outer call result
      await enqueueCallConsumers(pa.src);
    }

    // Chained calls: another CALL uses this as callee (fn()())
    for (const df of await db.getIncomingEdges(callId, ['DERIVED_FROM'])) {
      const dfN = await db.getNode(df.src);
      if (dfN?.type === 'CALL') await enqueueCallConsumers(df.src);
    }

    // CALL result returned by FUNCTION
    for (const ret of await db.getIncomingEdges(callId, ['RETURNS'])) {
      await enqueueFnCallers(ret.src);
    }

    // CALL result read via PA (call().value)
    for (const rf of await db.getIncomingEdges(callId, ['READS_FROM'])) {
      const rfN = await db.getNode(rf.src);
      if (rfN?.type === 'PROPERTY_ACCESS') enq(rf.src);
    }

    // Dynamic callee resolution
    const callsEdges = await db.getOutgoingEdges(callId, ['CALLS']);
    let hasStaticCallee = false;
    for (const ce of callsEdges) {
      const ceN = await db.getNode(ce.dst);
      if (ceN?.type === 'FUNCTION') { hasStaticCallee = true; break; }
    }
    if (!hasStaticCallee) {
      for (const df of await db.getOutgoingEdges(callId, ['DERIVED_FROM'])) {
        const resolved = await resolveDynamicCallee(db, df.dst);
        if (resolved) {
          for (const ra of await db.getOutgoingEdges(resolved, ['RECEIVES_ARGUMENT'])) enq(ra.dst);
        }
      }
      for (const ce of callsEdges) {
        const ceN = await db.getNode(ce.dst);
        if (ceN?.type === 'PARAMETER') {
          const resolved = await resolveDynamicCallee(db, ce.dst);
          if (resolved) {
            for (const ra of await db.getOutgoingEdges(resolved, ['RECEIVES_ARGUMENT'])) enq(ra.dst);
          }
        }
      }
    }

    // Callback injection: if CALL passes a FUNCTION as argument, trace into callback params
    for (const pa of await db.getOutgoingEdges(callId, ['PASSES_ARGUMENT'])) {
      const paN = await db.getNode(pa.dst);
      if (paN?.type === 'FUNCTION') {
        for (const ra of await db.getOutgoingEdges(pa.dst, ['RECEIVES_ARGUMENT'])) enq(ra.dst);
      }
    }
  }

  // --- Helper: enqueue callers of a function ---
  async function enqueueFnCallers(fnId: string): Promise<void> {
    if (processedFns.has(fnId)) return;
    processedFns.add(fnId);

    for (const ci of await db.getIncomingEdges(fnId, ['CALLS'])) {
      await enqueueCallConsumers(ci.src);
    }
    for (const fpa of await db.getIncomingEdges(fnId, ['PASSES_ARGUMENT'])) {
      await enqueueCallConsumers(fpa.src);
    }
    for (const faf of await db.getIncomingEdges(fnId, ['ASSIGNED_FROM'])) {
      for (const vc of await db.getIncomingEdges(faf.src, ['CALLS'])) {
        await enqueueCallConsumers(vc.src);
      }
    }
    for (const df of await db.getIncomingEdges(fnId, ['DERIVED_FROM'])) {
      const dfN = await db.getNode(df.src);
      if (dfN?.type === 'CALL') await enqueueCallConsumers(df.src);
    }
  }

  // --- Helper: climb structural containers ---
  async function enqueueClimb(nodeId: string, maxClimb: number): Promise<void> {
    if (maxClimb <= 0 || climbProcessed.has(nodeId)) return;
    climbProcessed.add(nodeId);

    enq(nodeId);

    for (const af of await db.getIncomingEdges(nodeId, ['ASSIGNED_FROM'])) enq(af.src);
    for (const ret of await db.getIncomingEdges(nodeId, ['RETURNS'])) await enqueueFnCallers(ret.src);
    for (const se of await db.getIncomingEdges(nodeId, [...STRUCTURAL_EDGE_TYPES, 'PASSES_ARGUMENT'])) {
      await enqueueClimb(se.src, maxClimb - 1);
    }
  }

  // --- Helper: follow PASSES_ARGUMENT to callee params + mutation + call result ---
  async function followPassesArgument(pa: DataflowEdge): Promise<void> {
    const callId = pa.src;
    const paIdx = edgeIndex(pa);

    // A. To params (with index matching)
    for (const ce of await db.getOutgoingEdges(callId, ['CALLS'])) {
      const raEdges = await db.getOutgoingEdges(ce.dst, ['RECEIVES_ARGUMENT']);
      for (const ra of raEdges) {
        if (!indexMatch(paIdx, edgeIndex(ra))) continue;
        enq(ra.dst);
      }
    }

    // B. Mutation detection
    for (const df of await db.getOutgoingEdges(callId, ['DERIVED_FROM'])) {
      const dfN = await db.getNode(df.dst);
      if (dfN?.type === 'PROPERTY_ACCESS' && dfN.name && MUTATION_METHODS.has(dfN.name)) {
        for (const rf of await db.getOutgoingEdges(df.dst, ['READS_FROM'])) {
          enq(await resolveRef(db, rf.dst));
        }
      }
    }

    // C. Call result consumers
    await enqueueCallConsumers(callId);
  }

  // === Main BFS loop ===
  enq(startId);
  let iterations = 0;

  while (queue.length > 0) {
    const declId = queue.shift()!;
    iterations++;
    if (iterations > maxIterations) break;

    const node = await db.getNode(declId);
    if (!node) continue;

    reachedNodes.push(node);

    // --- 1. Follow refs that read this declaration ---
    const refsToDecl = await db.getIncomingEdges(declId, ['READS_FROM']);

    for (const refEdge of refsToDecl) {
      const refId = refEdge.src;

      // 1a. ASSIGNED_FROM incoming on ref
      for (const af of await db.getIncomingEdges(refId, ['ASSIGNED_FROM'])) enq(af.src);

      // 1b. WRITES_TO incoming on ref
      for (const wt of await db.getIncomingEdges(refId, ['WRITES_TO'])) {
        enq(await resolveRef(db, wt.src));
      }

      // 1c. PASSES_ARGUMENT incoming on ref
      for (const pa of await db.getIncomingEdges(refId, ['PASSES_ARGUMENT'])) {
        await followPassesArgument(pa);
      }

      // 1d. Structural climb
      for (const se of await db.getIncomingEdges(refId, [...STRUCTURAL_EDGE_TYPES])) {
        await enqueueClimb(se.src, 4);
      }

      // 1e. DERIVED_FROM incoming on ref: EXPRESSION/CALL uses this ref
      for (const df of await db.getIncomingEdges(refId, ['DERIVED_FROM'])) {
        const dfN = await db.getNode(df.src);
        if (dfN) {
          if (dfN.type === 'EXPRESSION') enq(df.src);
          else if (dfN.type === 'CALL') await enqueueCallConsumers(df.src);
        }
      }

      // 1f. RETURNS / YIELDS — enqueue function callers + function itself
      for (const ret of await db.getIncomingEdges(refId, ['RETURNS'])) {
        await enqueueFnCallers(ret.src);
        enq(ret.src);
      }
      for (const y of await db.getIncomingEdges(refId, ['YIELDS'])) {
        await enqueueFnCallers(y.src);
        enq(y.src);
      }

      // 1g. THROWS → all catch PARAMETERs
      const throwsEdges = await db.getIncomingEdges(refId, ['THROWS']);
      if (throwsEdges.length > 0) {
        const cps = await getCatchParams();
        for (const cpId of cps) enq(cpId);
      }

      // 1h. ITERATES_OVER incoming on ref
      for (const io of await db.getIncomingEdges(refId, ['ITERATES_OVER'])) enq(io.src);

      // 1i. PA reads from ref (receiver chain)
      for (const paRead of await db.getIncomingEdges(refId, ['READS_FROM'])) {
        const paN = await db.getNode(paRead.src);
        if (paN?.type === 'PROPERTY_ACCESS') enq(paRead.src);
      }

      // 1j. DERIVED_FROM incoming (CALL consumers)
      for (const df of await db.getIncomingEdges(refId, ['DERIVED_FROM'])) {
        const dfN = await db.getNode(df.src);
        if (dfN?.type === 'CALL') await enqueueCallConsumers(df.src);
      }
    }

    // --- 2. Direct edges on declaration ---
    for (const hel of await db.getIncomingEdges(declId, ['HAS_ELEMENT'])) enq(hel.src);
    for (const hp of await db.getIncomingEdges(declId, ['HAS_PROPERTY'])) enq(hp.src);
    for (const ret of await db.getIncomingEdges(declId, ['RETURNS'])) await enqueueFnCallers(ret.src);
    for (const y of await db.getIncomingEdges(declId, ['YIELDS'])) await enqueueFnCallers(y.src);
    for (const io of await db.getIncomingEdges(declId, ['ITERATES_OVER'])) enq(io.src);
    for (const af of await db.getIncomingEdges(declId, ['ASSIGNED_FROM'])) enq(af.src);

    // WRITES_TO incoming on declaration
    for (const wt of await db.getIncomingEdges(declId, ['WRITES_TO'])) {
      enq(await resolveRef(db, wt.src));
    }

    // PASSES_ARGUMENT incoming on declaration
    for (const pa of await db.getIncomingEdges(declId, ['PASSES_ARGUMENT'])) {
      await followPassesArgument(pa);
    }

    // --- 2b. Method call receiver heuristic ---
    // When graph lacks CALL→DERIVED_FROM→PA→READS_FROM→REF edges for method calls,
    // use CALL naming convention ("db.getNode" → receiver "db") to find method calls
    // on this declaration and trace their consumers.
    if ((node.type === 'CONSTANT' || node.type === 'VARIABLE' || node.type === 'PARAMETER') && node.name && node.file) {
      const idx = await getCallsByReceiver();
      const key = `${node.file}::${node.name}`;
      const methodCalls = idx.get(key);
      if (methodCalls) {
        for (const callId of methodCalls) enq(callId);
      }
    }

    // --- 3. PA write→read propagation via receiver chain matching ---
    if (node.type === 'PROPERTY_ACCESS') {
      const myChain = await resolveReceiverChain(db, declId);
      if (myChain) {
        const wt = await db.getOutgoingEdges(declId, ['WRITES_TO']);
        if (wt.length > 0 && node.name) {
          const idx = await getPAReadByName();
          const readers = idx.get(node.name) || [];
          for (const r of readers) {
            if (r.base === myChain.base && r.path === myChain.path) enq(r.id);
          }
        }
      }
    }

    // --- 4. DERIVED_FROM incoming on declaration ---
    for (const df of await db.getIncomingEdges(declId, ['DERIVED_FROM'])) {
      const dfN = await db.getNode(df.src);
      if (dfN?.type === 'CALL') await enqueueCallConsumers(df.src);
      else if (dfN?.type === 'EXPRESSION') enq(df.src);
    }

    // --- 5. FUNCTION type → enqueueFnCallers ---
    if (node.type === 'FUNCTION') await enqueueFnCallers(declId);

    // --- 6. CALL type → enqueueCallConsumers ---
    if (node.type === 'CALL') await enqueueCallConsumers(declId);
  }

  return reachedNodes;
}

// === BACKWARD BFS ===

/**
 * Backward BFS dataflow trace.
 * Starting from a declaration node, finds all nodes where data comes FROM.
 * Returns all reached nodes (including the start node at index 0).
 */
export async function traceBackwardBFS(
  db: DataflowBackend,
  startId: string,
  maxIterations: number,
): Promise<DataflowNode[]> {
  const visited = new Set<string>();
  const queue: string[] = [];
  const reachedNodes: DataflowNode[] = [];

  function enq(id: string | null): void {
    if (id && !visited.has(id)) {
      visited.add(id);
      queue.push(id);
    }
  }

  // Lazy PA writer index
  let paWriterByName: Map<string, PAEntry[]> | null = null;

  async function getPAWriterByName(): Promise<Map<string, PAEntry[]>> {
    if (paWriterByName) return paWriterByName;
    paWriterByName = new Map();
    for await (const n of db.queryNodes({ type: 'PROPERTY_ACCESS' })) {
      const wt = await db.getOutgoingEdges(n.id, ['WRITES_TO']);
      if (wt.length > 0 && n.name) {
        const chain = await resolveReceiverChain(db, n.id);
        if (chain) {
          let list = paWriterByName.get(n.name);
          if (!list) { list = []; paWriterByName.set(n.name, list); }
          list.push({ id: n.id, base: chain.base, path: chain.path });
        }
      }
    }
    return paWriterByName;
  }

  enq(startId);
  let iterations = 0;

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    iterations++;
    if (iterations > maxIterations) break;

    const node = await db.getNode(nodeId);
    if (!node) continue;

    reachedNodes.push(node);

    // 1. ASSIGNED_FROM outgoing → resolve ref → enqueue source
    for (const af of await db.getOutgoingEdges(nodeId, ['ASSIGNED_FROM'])) {
      const src = await resolveRef(db, af.dst);
      enq(src);
      const afNode = await db.getNode(af.dst);
      if (afNode && !['CONSTANT', 'VARIABLE', 'PARAMETER', 'REFERENCE'].includes(afNode.type)) {
        for (const ch of await db.getOutgoingEdges(af.dst, [...STRUCTURAL_EDGE_TYPES])) {
          const resolved = await resolveRef(db, ch.dst);
          enq(resolved);
        }
      }
    }

    // 2. Refs that write to this node → trace back to what was written
    const refsToNode = await db.getIncomingEdges(nodeId, ['READS_FROM']);
    for (const refEdge of refsToNode) {
      const wtEdges = await db.getOutgoingEdges(refEdge.src, ['WRITES_TO']);
      for (const wt of wtEdges) {
        const resolved = await resolveRef(db, wt.dst);
        enq(resolved);
      }
    }

    // 3. PARAMETER: incoming RECEIVES_ARGUMENT → FUNCTION → incoming CALLS → CALL → PASSES_ARGUMENT
    if (node.type === 'PARAMETER') {
      const raEdges = await db.getIncomingEdges(nodeId, ['RECEIVES_ARGUMENT']);
      for (const ra of raEdges) {
        const fnId = ra.src;
        const raIdx = edgeIndex(ra);
        const callsIn = await db.getIncomingEdges(fnId, ['CALLS']);
        for (const callEdge of callsIn) {
          const paEdges = await db.getOutgoingEdges(callEdge.src, ['PASSES_ARGUMENT']);
          for (const pa of paEdges) {
            if (!indexMatch(raIdx, edgeIndex(pa))) continue;
            const argSrc = await resolveRef(db, pa.dst);
            enq(argSrc);
          }
        }
      }
    }

    // 4. Structural descent: outgoing HAS_ELEMENT, HAS_PROPERTY → descend, resolveRef
    for (const ch of await db.getOutgoingEdges(nodeId, ['HAS_ELEMENT', 'HAS_PROPERTY'])) {
      const resolved = await resolveRef(db, ch.dst);
      enq(resolved);
    }

    // 5. CALL node: trace arguments and receiver chain
    if (node.type === 'CALL') {
      for (const pa of await db.getOutgoingEdges(nodeId, ['PASSES_ARGUMENT'])) {
        const argSrc = await resolveRef(db, pa.dst);
        enq(argSrc);
      }
      for (const df of await db.getOutgoingEdges(nodeId, ['DERIVED_FROM'])) {
        const dfN = await db.getNode(df.dst);
        if (dfN?.type === 'PROPERTY_ACCESS') {
          for (const rf of await db.getOutgoingEdges(df.dst, ['READS_FROM'])) {
            const resolved = await resolveRef(db, rf.dst);
            enq(resolved);
          }
        }
      }
      // 5b. Receiver heuristic: when CALL→DERIVED_FROM→PA→READS_FROM chain is missing,
      // parse receiver name from CALL name ("db.getNode" → "db") and find its declaration.
      if (node.name?.includes('.')) {
        const dotIdx = node.name.indexOf('.');
        const receiverName = node.name.substring(0, dotIdx);
        if (!receiverName.startsWith('<')) {
          for (const declType of ['CONSTANT', 'VARIABLE', 'PARAMETER'] as const) {
            for await (const decl of db.queryNodes({ type: declType, name: receiverName })) {
              if (decl.file === node.file) enq(decl.id);
            }
          }
        }
      }
    }

    // 6. PA node: READS_FROM → resolveRef (the receiver's data source)
    if (node.type === 'PROPERTY_ACCESS') {
      for (const rf of await db.getOutgoingEdges(nodeId, ['READS_FROM'])) {
        const resolved = await resolveRef(db, rf.dst);
        enq(resolved);
      }
    }

    // 7. ITERATES_OVER outgoing → resolveRef → enqueue (the iterable)
    for (const io of await db.getOutgoingEdges(nodeId, ['ITERATES_OVER'])) {
      const resolved = await resolveRef(db, io.dst);
      enq(resolved);
    }

    // 8. Property read→write propagation: if this is a PA reader, find matching writers
    if (node.type === 'PROPERTY_ACCESS' && node.name) {
      const wt = await db.getOutgoingEdges(nodeId, ['WRITES_TO']);
      if (wt.length === 0) {
        const myChain = await resolveReceiverChain(db, nodeId);
        if (myChain) {
          const idx = await getPAWriterByName();
          const writers = idx.get(node.name) || [];
          for (const w of writers) {
            if (w.base === myChain.base && w.path === myChain.path) enq(w.id);
          }
        }
      }
    }

    // 9. THROWS: if this is a catch PARAMETER, find thrown values
    if (node.type === 'PARAMETER') {
      const decls = await db.getIncomingEdges(nodeId, ['DECLARES']);
      let isCatch = false;
      for (const d of decls) {
        const scope = await db.getNode(d.src);
        if (scope?.name === 'catch') { isCatch = true; break; }
      }
      if (isCatch) {
        for await (const fn of db.queryNodes({ type: 'FUNCTION' })) {
          for (const t of await db.getOutgoingEdges(fn.id, ['THROWS'])) {
            const resolved = await resolveRef(db, t.dst);
            enq(resolved);
          }
        }
        for await (const mod of db.queryNodes({ type: 'MODULE' })) {
          for (const t of await db.getOutgoingEdges(mod.id, ['THROWS'])) {
            const resolved = await resolveRef(db, t.dst);
            enq(resolved);
          }
        }
      }
    }

    // 10. DERIVED_FROM outgoing: trace expression operands
    for (const df of await db.getOutgoingEdges(nodeId, ['DERIVED_FROM'])) {
      const resolved = await resolveRef(db, df.dst);
      enq(resolved);
    }

    // 11. RETURNS incoming → if someone returns this node, trace the function's callers' arguments
    for (const ret of await db.getIncomingEdges(nodeId, ['RETURNS'])) {
      const callsIn = await db.getIncomingEdges(ret.src, ['CALLS']);
      for (const callEdge of callsIn) {
        for (const pa of await db.getOutgoingEdges(callEdge.src, ['PASSES_ARGUMENT'])) {
          const argSrc = await resolveRef(db, pa.dst);
          enq(argSrc);
        }
      }
    }
  }

  return reachedNodes;
}

// === HIGH-LEVEL API ===

/**
 * Trace dataflow from a starting node.
 * Handles REFERENCE resolution, runs BFS in requested direction(s).
 * Returns results with start node excluded from reached lists.
 */
export async function traceDataflow(
  db: DataflowBackend,
  sourceId: string,
  options: TraceDataflowOptions = {},
): Promise<TraceDataflowResult[]> {
  const { direction = 'forward', maxDepth = 10, limit } = options;
  const maxIterations = Math.min((maxDepth || 10) * 100, 5000);

  // Resolve REFERENCE to declaration
  let startId = sourceId;
  const sourceNode = await db.getNode(sourceId);
  if (sourceNode?.type === 'REFERENCE') {
    const edges = await db.getOutgoingEdges(sourceId, ['READS_FROM']);
    if (edges.length > 0) startId = edges[0].dst;
  }

  const resolvedStart = await db.getNode(startId);
  if (!resolvedStart) return [];

  const results: TraceDataflowResult[] = [];

  if (direction === 'forward' || direction === 'both') {
    const nodes = await traceForwardBFS(db, startId, maxIterations);
    const reached = nodes.slice(1); // skip start node
    results.push({
      direction: 'forward',
      startNode: resolvedStart,
      reached: limit ? reached.slice(0, limit) : reached,
      totalReached: reached.length,
    });
  }

  if (direction === 'backward' || direction === 'both') {
    const nodes = await traceBackwardBFS(db, startId, maxIterations);
    const reached = nodes.slice(1);
    results.push({
      direction: 'backward',
      startNode: resolvedStart,
      reached: limit ? reached.slice(0, limit) : reached,
      totalReached: reached.length,
    });
  }

  return results;
}
