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
  await client.close();
} catch (err) {
  console.error(`[shape-verifier] Error: ${err.message}`);
  await client.close();
  process.exit(1);
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
