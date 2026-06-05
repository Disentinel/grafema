#!/usr/bin/env node
/**
 * Shape Verifier — Grafema batch plugin (Phase 5)
 *
 * Verifies method/property calls against object shapes.
 * Creates ISSUE nodes for violations: calls to methods that don't exist
 * on the receiver's inferred type.
 *
 * Runs AFTER type-inference + method-call-resolver + shape-tracker.
 *
 * Environment:
 *   RFDB_SOCKET  — path to RFDB unix socket
 *   RFDB_DATABASE — database name
 *   GRAFEMA_DATALOG_PLUGINS — comma-separated list of plugins to use Datalog path
 *                             (e.g. "shape-verifier" to enable this plugin's Datalog impl)
 */

import { RFDBClient } from '../packages/rfdb/dist/client.js';

const socketPath = process.env.RFDB_SOCKET;
const dbName = process.env.RFDB_DATABASE;

if (!socketPath) {
  console.error('[shape-verifier] RFDB_SOCKET not set');
  process.exit(1);
}

const client = new RFDBClient(socketPath, 'shape-verifier');

try {
  await client.connect();
  if (dbName) await client.openDatabase(dbName);

  const useDatalog = process.env.GRAFEMA_DATALOG_PLUGINS?.split(',').includes('shape-verifier');
  if (useDatalog) {
    await shapeVerifierDatalog(client);
  } else {
    await shapeVerifierLegacy(client);
  }

  await client.close();
} catch (err) {
  console.error(`[shape-verifier] Error: ${err.message}`);
  await client.close();
  process.exit(1);
}

// ── Datalog implementation ────────────────────────────────────────────────────

/**
 * Datalog-based implementation of shape verification.
 *
 * Uses two executeDatalog() calls instead of ~600k individual IPC calls:
 *   1. Build has_method(ClassId, MethodName) with recursive EXTENDS chain
 *   2. Find unresolved CALL nodes that have an INSTANCE_OF receiver path
 * Then cross-references in JS to produce violations.
 *
 * Expected speedup: ×20–50 vs legacy on large codebases.
 *
 * Recursive Datalog is supported by rfdb-server (max_recursion_depth=64),
 * which is sufficient for any realistic class hierarchy depth.
 */
async function shapeVerifierDatalog(client) {
  // Step 1: Build complete has_method index via recursive Datalog.
  // Covers CLASS and INTERFACE nodes (both use HAS_METHOD / HAS_PROPERTY edges).
  // Recursive rule follows EXTENDS chain to include inherited methods.
  const hasMethodResults = await client.executeDatalog(
    'has_method(Class, Name) :- edge(Class, M, "HAS_METHOD"), attr(M, "name", Name).\n' +
    'has_method(Class, Name) :- edge(Class, M, "HAS_PROPERTY"), attr(M, "name", Name).\n' +
    'has_method(Class, Name) :- edge(Class, P, "EXTENDS"), has_method(P, Name).\n'
  );

  // Build classId → Set<methodName> (deduplicated)
  const classMethodMap = new Map();
  for (const row of hasMethodResults) {
    const classId = row.bindings['Class'];
    const name = row.bindings['Name'];
    if (!classId || !name) continue;
    let methods = classMethodMap.get(classId);
    if (!methods) { methods = new Set(); classMethodMap.set(classId, methods); }
    methods.add(name);
  }
  console.error(`[shape-verifier/datalog] ${classMethodMap.size} classes/interfaces indexed`);

  // Step 2: Find unresolved CALL nodes that have a receiver with INSTANCE_OF.
  // Covers four receiver path variants from resolveReceiverType():
  //   A2: CALL -READS_FROM→ Decl -INSTANCE_OF→ Class         (direct, 2 hops)
  //   A3: CALL -READS_FROM→ Ref -READS_FROM→ Decl -INSTANCE_OF→ Class  (via REF, 3 hops)
  //   B3: CALL -DERIVED_FROM→ PA -READS_FROM→ Decl -INSTANCE_OF→ Class  (via PA, 3 hops)
  //   B4: CALL -DERIVED_FROM→ PA -READS_FROM→ Ref -READS_FROM→ Decl -INSTANCE_OF→ Class (4 hops)
  const callResults = await client.executeDatalog(
    'call_receiver(C, CallName, Class) :- node(C, "CALL"), attr(C, "name", CallName), ' +
      '\\+ edge(C, _, "CALLS"), \\+ edge(C, _, "CALLS_REMOTE"), ' +
      'edge(C, Decl, "READS_FROM"), edge(Decl, Class, "INSTANCE_OF").\n' +
    'call_receiver(C, CallName, Class) :- node(C, "CALL"), attr(C, "name", CallName), ' +
      '\\+ edge(C, _, "CALLS"), \\+ edge(C, _, "CALLS_REMOTE"), ' +
      'edge(C, Ref, "READS_FROM"), edge(Ref, Decl, "READS_FROM"), edge(Decl, Class, "INSTANCE_OF").\n' +
    'call_receiver(C, CallName, Class) :- node(C, "CALL"), attr(C, "name", CallName), ' +
      '\\+ edge(C, _, "CALLS"), \\+ edge(C, _, "CALLS_REMOTE"), ' +
      'edge(C, PA, "DERIVED_FROM"), edge(PA, Decl, "READS_FROM"), edge(Decl, Class, "INSTANCE_OF").\n' +
    'call_receiver(C, CallName, Class) :- node(C, "CALL"), attr(C, "name", CallName), ' +
      '\\+ edge(C, _, "CALLS"), \\+ edge(C, _, "CALLS_REMOTE"), ' +
      'edge(C, PA, "DERIVED_FROM"), edge(PA, Ref, "READS_FROM"), edge(Ref, Decl, "READS_FROM"), edge(Decl, Class, "INSTANCE_OF").\n'
  );

  // Step 3: Cross-reference to find violations.
  const issueNodes = [];
  const seen = new Set();
  const classNameCache = new Map();
  let verified = 0;
  let violations = 0;

  for (const row of callResults) {
    const callId = row.bindings['C'];
    const callName = row.bindings['CallName'];
    const classId = row.bindings['Class'];
    if (!callId || !callName || !classId) continue;

    // Extract method name (after last '.')
    const dotIdx = callName.lastIndexOf('.');
    if (dotIdx === -1) continue;
    const methodName = callName.substring(dotIdx + 1);
    if (!methodName) continue;

    // Deduplicate: same (call, class) pair can appear via multiple paths
    const key = `${callId}::${classId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    verified++;

    const classMethods = classMethodMap.get(classId);
    if (!classMethods) continue; // Unknown class, can't verify

    if (!classMethods.has(methodName)) {
      violations++;

      // Fetch call node for file/line metadata (violations are rare)
      const callNode = await client.getNode(callId);
      if (!classNameCache.has(classId)) {
        const classNode = await client.getNode(classId);
        classNameCache.set(classId, classNode?.name || '?');
      }
      const className = classNameCache.get(classId);

      issueNodes.push({
        id: `issue::shape-violation::${callId}`,
        type: 'ISSUE',
        name: `Method .${methodName} not found on ${className}`,
        file: callNode?.file || '',
        exported: false,
        metadata: JSON.stringify({
          _source: 'shape-verifier',
          severity: 'warning',
          category: 'shape-violation',
          method: methodName,
          receiverType: className,
          callName,
          line: callNode?.line,
        }),
      });
    }
  }

  // Commit ISSUE nodes
  if (issueNodes.length > 0) {
    const BATCH = 200;
    for (let i = 0; i < issueNodes.length; i += BATCH) {
      await client.addNodes(issueNodes.slice(i, i + BATCH));
    }
  }

  console.error(`[shape-verifier/datalog] Done: ${verified} calls verified, ${violations} violations found`);
}

// ── Legacy implementation ─────────────────────────────────────────────────────

async function shapeVerifierLegacy(client) {
  // Build class → methods index
  const classMethodIndex = new Map(); // classId → Set<methodName>
  const classNameIndex = new Map();   // classId → className

  for await (const cls of client.queryNodes({ type: 'CLASS' })) {
    const classId = String(cls.id);
    const methods = new Set();
    classNameIndex.set(classId, cls.name || '?');

    // Use numeric ID for edge queries (semantic IDs don't always resolve for builtins)
    const edges = await client.getOutgoingEdges(classId);
    for (const e of edges) {
      if (e.type === 'HAS_METHOD') {
        const method = await client.getNode(e.dst);
        if (method?.name) methods.add(method.name);
      }
    }

    // Follow EXTENDS chain to include inherited methods
    const extendsEdge = edges.find(e => e.type === 'EXTENDS');
    if (extendsEdge) {
      const parentMethods = await collectMethods(client, extendsEdge.dst, new Set());
      for (const m of parentMethods) methods.add(m);
    }

    classMethodIndex.set(classId, methods);
  }

  // Also index INTERFACE methods
  for await (const iface of client.queryNodes({ type: 'INTERFACE' })) {
    const ifaceId = String(iface.id);
    const methods = new Set();
    classNameIndex.set(ifaceId, iface.name || '?');

    const edges = await client.getOutgoingEdges(ifaceId);
    for (const e of edges) {
      if (e.type === 'HAS_METHOD' || e.type === 'HAS_PROPERTY') {
        const member = await client.getNode(e.dst);
        if (member?.name) methods.add(member.name);
      }
    }
    classMethodIndex.set(ifaceId, methods);
  }

  console.error(`[shape-verifier] ${classMethodIndex.size} classes/interfaces indexed`);

  // Verify: for each unresolved method call where receiver has INSTANCE_OF,
  // check if method exists in the class shape
  let verified = 0;
  let violations = 0;
  const issueNodes = [];

  for await (const call of client.queryNodes({ type: 'CALL' })) {
    const callName = call.name || '';
    const dotIdx = callName.lastIndexOf('.');
    if (dotIdx === -1) continue;

    const methodName = callName.substring(dotIdx + 1);
    if (!methodName) continue;

    // Only check unresolved calls (no CALLS edge)
    const callId = String(call.id);
    const callEdges = await client.getOutgoingEdges(callId);
    if (callEdges.some(e => e.type === 'CALLS' || e.type === 'CALLS_REMOTE')) continue;

    // Trace receiver to find INSTANCE_OF
    const receiverType = await resolveReceiverType(client, callId, callEdges);
    if (!receiverType) continue; // can't verify without type info

    verified++;

    // Check if method exists in the class shape
    const classMethods = classMethodIndex.get(receiverType.classId);
    if (!classMethods) continue;

    if (!classMethods.has(methodName)) {
      violations++;
      const className = classNameIndex.get(receiverType.classId) || '?';
      issueNodes.push({
        id: `issue::shape-violation::${callId}`,
        type: 'ISSUE',
        name: `Method .${methodName} not found on ${className}`,
        file: call.file || '',
        exported: false,
        metadata: JSON.stringify({
          _source: 'shape-verifier',
          severity: 'warning',
          category: 'shape-violation',
          method: methodName,
          receiverType: className,
          callName,
          line: call.line,
        }),
      });
    }
  }

  // Commit ISSUE nodes
  if (issueNodes.length > 0) {
    const BATCH = 200;
    for (let i = 0; i < issueNodes.length; i += BATCH) {
      await client.addNodes(issueNodes.slice(i, i + BATCH));
    }
  }

  console.error(`[shape-verifier] Done: ${verified} calls verified, ${violations} violations found`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function collectMethods(client, classId, visited) {
  if (visited.has(classId)) return new Set();
  visited.add(classId);

  const methods = new Set();
  const node = await client.getNode(classId);
  if (!node) return methods;

  const edges = await client.getOutgoingEdges(String(node.id));
  for (const e of edges) {
    if (e.type === 'HAS_METHOD') {
      const method = await client.getNode(e.dst);
      if (method?.name) methods.add(method.name);
    }
  }

  // Follow EXTENDS
  const extendsEdge = edges.find(e => e.type === 'EXTENDS');
  if (extendsEdge) {
    const parentMethods = await collectMethods(client, extendsEdge.dst, visited);
    for (const m of parentMethods) methods.add(m);
  }

  return methods;
}

async function resolveReceiverType(client, callId, callEdges) {
  // Path: CALL → DERIVED_FROM → PA → READS_FROM → REF → READS_FROM → DECL → INSTANCE_OF → CLASS
  let readsFrom = callEdges.filter(e => e.type === 'READS_FROM');

  if (readsFrom.length === 0) {
    for (const df of callEdges.filter(e => e.type === 'DERIVED_FROM')) {
      const paNode = await client.getNode(df.dst);
      if (!paNode || paNode.nodeType !== 'PROPERTY_ACCESS') continue;
      const paEdges = await client.getOutgoingEdges(String(paNode.id));
      readsFrom = paEdges.filter(e => e.type === 'READS_FROM');
      if (readsFrom.length > 0) break;
    }
  }

  for (const rf of readsFrom) {
    let node = await client.getNode(rf.dst);
    if (!node) continue;

    if (node.nodeType === 'REFERENCE') {
      const refEdges = await client.getOutgoingEdges(String(node.id));
      const rf2 = refEdges.find(e => e.type === 'READS_FROM');
      if (rf2) node = await client.getNode(rf2.dst);
      if (!node) continue;
    }

    const declEdges = await client.getOutgoingEdges(String(node.id));
    const instanceOf = declEdges.find(e => e.type === 'INSTANCE_OF');
    if (instanceOf) {
      return { classId: instanceOf.dst };
    }
  }

  return null;
}
