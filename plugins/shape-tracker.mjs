#!/usr/bin/env node
/**
 * Shape Tracker — Grafema batch plugin (Phase 3)
 *
 * Creates EXTENDS and IMPLEMENTS edges from CLASS metadata,
 * and tracks object literal shapes via WRITES_TO edges.
 *
 * Runs after type-inference (needs CLASS index).
 *
 * Environment:
 *   RFDB_SOCKET  — path to RFDB unix socket
 *   RFDB_DATABASE — database name
 *   GRAFEMA_DATALOG_PLUGINS — include "shape-tracker" to use Datalog-based impl
 */

import { RFDBClient } from '../packages/rfdb/dist/client.js';

const socketPath = process.env.RFDB_SOCKET;
const dbName = process.env.RFDB_DATABASE;

if (!socketPath) {
  console.error('[shape-tracker] RFDB_SOCKET not set');
  process.exit(1);
}

const client = new RFDBClient(socketPath, 'shape-tracker');

try {
  await client.connect();
  if (dbName) await client.openDatabase(dbName);

  const useDatalog = (process.env.GRAFEMA_DATALOG_PLUGINS ?? '').split(',').includes('shape-tracker');
  if (useDatalog) {
    await shapeTrackerDatalog(client);
  } else {
    await shapeTrackerLegacy(client);
  }

  await client.close();
} catch (err) {
  console.error(`[shape-tracker] Error: ${err.message}`);
  await client.close();
  process.exit(1);
}

// ── Datalog implementation ───────────────────────────────────────────────────

/**
 * Datalog-based shape tracker.
 *
 * Phase 3a: JS (metadata JSON.parse blocks pure Datalog) + early-exit gate
 * Phase 3b: Datalog finds ASSIGNED_FROM chains; JS extracts objectKeys from LITERAL metadata
 * Phase 3c: Pure Datalog — guarded writes via HAS_CONSEQUENT/HAS_ALTERNATE → CONTAINS → WRITES_TO
 */
async function shapeTrackerDatalog(client) {
  const BATCH = 500;

  // Build CLASS index (name → id) — needed for edge construction in all phases
  const classIndex = new Map();
  for await (const n of client.queryNodes({ type: 'CLASS' })) {
    if (n.name) classIndex.set(n.name, String(n.id));
  }
  for await (const n of client.queryNodes({ type: 'INTERFACE' })) {
    if (n.name) classIndex.set(n.name, String(n.id));
  }
  console.error(`[shape-tracker/datalog] ${classIndex.size} classes indexed`);

  // ── Phase 3a: EXTENDS / IMPLEMENTS (JS — requires JSON.parse on metadata) ──

  let extendsCreated = 0;
  let implementsCreated = 0;
  const phase3aEdges = [];

  for await (const cls of client.queryNodes({ type: 'CLASS' })) {
    const classId = String(cls.id);
    const meta = typeof cls.metadata === 'string' ? JSON.parse(cls.metadata || '{}') : cls.metadata || {};

    // Early-exit gate: skip if no superClass or implements
    if (!meta.superClass && !meta.implements) continue;

    const outEdges = await client.getOutgoingEdges(classId);

    if (meta.superClass) {
      const superId = classIndex.get(meta.superClass);
      if (superId && !outEdges.some(e => e.type === 'EXTENDS')) {
        phase3aEdges.push({
          src: classId,
          dst: superId,
          type: 'EXTENDS',
          metadata: JSON.stringify({ _source: 'shape-tracker' }),
        });
        extendsCreated++;
      }
    }

    if (meta.implements) {
      const hasImpl = outEdges.some(e => e.type === 'IMPLEMENTS');
      if (!hasImpl) {
        const ifaceNames = String(meta.implements).split(',').map(s => s.trim()).filter(Boolean);
        for (const ifaceName of ifaceNames) {
          const ifaceId = classIndex.get(ifaceName);
          if (ifaceId) {
            phase3aEdges.push({
              src: classId,
              dst: ifaceId,
              type: 'IMPLEMENTS',
              metadata: JSON.stringify({ _source: 'shape-tracker' }),
            });
            implementsCreated++;
          }
        }
      }
    }
  }

  for (let i = 0; i < phase3aEdges.length; i += BATCH) {
    await client.addEdges(phase3aEdges.slice(i, i + BATCH));
  }
  console.error(`[shape-tracker/datalog] Phase 3a: ${extendsCreated} EXTENDS + ${implementsCreated} IMPLEMENTS edges created`);

  // ── Phase 3c: GUARDED_WRITE — pure Datalog (priority 1) ──────────────────
  // Two rules cover then-branch and else-branch. One query issues both.

  const guardedRows = await client.executeDatalog(
    'guarded_write(Branch, Target) :- node(Branch, "BRANCH"), edge(Branch, Cons, "HAS_CONSEQUENT"), edge(Cons, Cont, "CONTAINS"), edge(Cont, Target, "WRITES_TO").\n' +
    'guarded_write(Branch, Target) :- node(Branch, "BRANCH"), edge(Branch, Alt, "HAS_ALTERNATE"), edge(Alt, Cont, "CONTAINS"), edge(Cont, Target, "WRITES_TO").\n'
  );

  const guardedEdges = [];
  const guardedSeen = new Set();
  let guardedWrites = 0;

  for (const row of (guardedRows ?? [])) {
    const branchId = row.bindings['Branch'];
    const targetId = row.bindings['Target'];
    if (!branchId || !targetId) continue;
    const key = `${branchId}|${targetId}`;
    if (guardedSeen.has(key)) continue;
    guardedSeen.add(key);
    guardedEdges.push({
      src: branchId,
      dst: targetId,
      type: 'GUARDED_WRITE',
      metadata: JSON.stringify({ _source: 'shape-tracker' }),
    });
    guardedWrites++;
  }

  for (let i = 0; i < guardedEdges.length; i += BATCH) {
    await client.addEdges(guardedEdges.slice(i, i + BATCH));
  }
  console.error(`[shape-tracker/datalog] Phase 3c: ${guardedWrites} GUARDED_WRITE edges created`);

  // ── Phase 3b: shape propagation — hybrid Datalog + JS ────────────────────
  // Datalog unrolls ASSIGNED_FROM up to 5 hops for VARIABLE/CONSTANT without
  // INSTANCE_OF, finding (source, literal) pairs. JS reads objectKeys from
  // literal metadata (requires JSON.parse — can't be done in pure Datalog).

  const CHAIN_PROGRAM =
    'needs_shape(V) :- node(V, "VARIABLE"), \\+ edge(V, _, "INSTANCE_OF").\n' +
    'needs_shape(V) :- node(V, "CONSTANT"), \\+ edge(V, _, "INSTANCE_OF").\n' +
    'chain1(A, B) :- needs_shape(A), edge(A, B, "ASSIGNED_FROM").\n' +
    'chain2(A, C) :- chain1(A, B), edge(B, C, "ASSIGNED_FROM").\n' +
    'chain3(A, C) :- chain2(A, B), edge(B, C, "ASSIGNED_FROM").\n' +
    'chain4(A, C) :- chain3(A, B), edge(B, C, "ASSIGNED_FROM").\n' +
    'chain5(A, C) :- chain4(A, B), edge(B, C, "ASSIGNED_FROM").\n' +
    'chain_literal(A, L) :- chain1(A, L), node(L, "LITERAL").\n' +
    'chain_literal(A, L) :- chain2(A, L), node(L, "LITERAL").\n' +
    'chain_literal(A, L) :- chain3(A, L), node(L, "LITERAL").\n' +
    'chain_literal(A, L) :- chain4(A, L), node(L, "LITERAL").\n' +
    'chain_literal(A, L) :- chain5(A, L), node(L, "LITERAL").\n';

  const chainRows = await client.executeDatalog(CHAIN_PROGRAM);

  // Group by source variable (first-wins: take first literal per var)
  const varToLiteral = new Map();
  for (const row of (chainRows ?? [])) {
    const varId = row.bindings['A'];
    const litId = row.bindings['L'];
    if (!varId || !litId || varToLiteral.has(varId)) continue;
    varToLiteral.set(varId, litId);
  }

  console.error(`[shape-tracker/datalog] Phase 3b: ${varToLiteral.size} var→literal pairs from Datalog`);

  const shapeEdges = [];
  let shapePropagated = 0;

  for (const [varId, litId] of varToLiteral) {
    const litNode = await client.getNode(litId);
    if (!litNode) continue;
    const meta = typeof litNode.metadata === 'string'
      ? JSON.parse(litNode.metadata || '{}') : litNode.metadata || {};
    if (meta.kind !== 'object' || !Array.isArray(meta.objectKeys)) continue;

    const targetClassId = classIndex.get('Object');
    if (!targetClassId) continue;

    shapeEdges.push({
      src: varId,
      dst: targetClassId,
      type: 'INSTANCE_OF',
      metadata: JSON.stringify({
        _source: 'shape-tracker',
        inferredType: 'Object',
        shape: meta.objectKeys,
        strategy: 'shape_propagation',
      }),
    });
    shapePropagated++;
  }

  for (let i = 0; i < shapeEdges.length; i += BATCH) {
    await client.addEdges(shapeEdges.slice(i, i + BATCH));
  }
  console.error(`[shape-tracker/datalog] Phase 3b: ${shapePropagated} shapes propagated`);
  console.error(`[shape-tracker/datalog] Done`);
}

// ── Legacy implementation ────────────────────────────────────────────────────

async function shapeTrackerLegacy(client) {
  // Phase 3a: Create EXTENDS and IMPLEMENTS edges from CLASS metadata
  const classIndex = new Map(); // name → numericId
  for await (const n of client.queryNodes({ type: 'CLASS' })) {
    if (n.name) classIndex.set(n.name, String(n.id));
  }
  for await (const n of client.queryNodes({ type: 'INTERFACE' })) {
    if (n.name) classIndex.set(n.name, String(n.id));
  }

  let extendsCreated = 0;
  let implementsCreated = 0;

  for await (const cls of client.queryNodes({ type: 'CLASS' })) {
    const classId = String(cls.id);
    const meta = typeof cls.metadata === 'string' ? JSON.parse(cls.metadata || '{}') : cls.metadata || {};

    // EXTENDS
    if (meta.superClass) {
      const superId = classIndex.get(meta.superClass);
      if (superId) {
        // Check if edge already exists
        const existing = await client.getOutgoingEdges(classId);
        if (!existing.some(e => e.type === 'EXTENDS')) {
          await client.addEdges([{
            src: classId,
            dst: superId,
            type: 'EXTENDS',
            metadata: JSON.stringify({ _source: 'shape-tracker' }),
          }]);
          extendsCreated++;
        }
      }
    }

    // IMPLEMENTS
    if (meta.implements) {
      const ifaceNames = String(meta.implements).split(',').map(s => s.trim()).filter(Boolean);
      const existing = await client.getOutgoingEdges(classId);
      const hasImpl = existing.some(e => e.type === 'IMPLEMENTS');
      if (!hasImpl) {
        for (const ifaceName of ifaceNames) {
          const ifaceId = classIndex.get(ifaceName);
          if (ifaceId) {
            await client.addEdges([{
              src: classId,
              dst: ifaceId,
              type: 'IMPLEMENTS',
              metadata: JSON.stringify({ _source: 'shape-tracker' }),
            }]);
            implementsCreated++;
          }
        }
      }
    }
  }

  console.error(`[shape-tracker] Phase 3a: ${extendsCreated} EXTENDS + ${implementsCreated} IMPLEMENTS edges created`);

  // Phase 3b: Object literal shape propagation
  let shapePropagated = 0;
  const shapeEdges = [];

  for (const nodeType of ['CONSTANT', 'VARIABLE']) {
    for await (const node of client.queryNodes({ type: nodeType })) {
      const varId = String(node.id);

      // Skip if already has INSTANCE_OF with shape
      const outEdges = await client.getOutgoingEdges(varId);
      const existingIO = outEdges.find(e => e.type === 'INSTANCE_OF');
      if (existingIO && Array.isArray(existingIO.shape)) continue;

      // Follow ASSIGNED_FROM chain (max 5 hops) to find shape source
      const shape = await traceShape(client, varId, 5, new Set());
      if (!shape) continue;

      // Create INSTANCE_OF edge with propagated shape
      const targetClassId = classIndex.get(shape.type);
      if (!targetClassId) continue;

      // Don't duplicate if already has INSTANCE_OF to same class
      if (existingIO) continue;

      shapeEdges.push({
        src: varId,
        dst: targetClassId,
        type: 'INSTANCE_OF',
        metadata: JSON.stringify({
          _source: 'shape-tracker',
          inferredType: shape.type,
          shape: shape.keys,
          strategy: 'shape_propagation',
        }),
      });
      shapePropagated++;
    }
  }

  const BATCH = 500;
  for (let i = 0; i < shapeEdges.length; i += BATCH) {
    await client.addEdges(shapeEdges.slice(i, i + BATCH));
  }
  console.error(`[shape-tracker] Phase 3b: ${shapePropagated} shapes propagated through assignment chains`);

  // Phase 3c: GUARDED_WRITE edges — mark property writes inside branches
  let guardedWrites = 0;
  const guardedEdges = [];

  for await (const branch of client.queryNodes({ type: 'BRANCH' })) {
    if (branch.name !== 'if' && branch.name !== 'ternary') continue;
    const branchId = String(branch.id);
    const branchEdges = await client.getOutgoingEdges(branchId);

    // Collect SCOPE nodes from both arms
    for (const armEdge of branchEdges) {
      if (armEdge.type !== 'HAS_CONSEQUENT' && armEdge.type !== 'HAS_ALTERNATE') continue;
      const arm = armEdge.type === 'HAS_CONSEQUENT' ? 'if' : 'else';

      // Collect all descendants via CONTAINS (BFS, max depth 10)
      const descendants = await collectDescendants(client, armEdge.dst, 10);

      for (const descId of descendants) {
        const descEdges = await client.getOutgoingEdges(descId);
        const hasWrite = descEdges.some(e => e.type === 'WRITES_TO');
        if (!hasWrite) continue;

        const descNode = await client.getNode(descId);
        if (!descNode) continue;
        const descType = descNode.nodeType || descNode.type;
        if (descType !== 'PROPERTY_ACCESS') continue;

        guardedEdges.push({
          src: branchId,
          dst: descId,
          type: 'GUARDED_WRITE',
          metadata: JSON.stringify({
            _source: 'shape-tracker',
            property: descNode.name || '',
            arm,
          }),
        });
        guardedWrites++;
      }
    }
  }

  for (let i = 0; i < guardedEdges.length; i += BATCH) {
    await client.addEdges(guardedEdges.slice(i, i + BATCH));
  }
  console.error(`[shape-tracker] Phase 3c: ${guardedWrites} GUARDED_WRITE edges created`);
  console.error(`[shape-tracker] Done`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * BFS collect all descendant node IDs reachable via CONTAINS edges.
 */
async function collectDescendants(client, rootId, maxDepth) {
  const result = [];
  const queue = [{ id: rootId, depth: 0 }];
  const visited = new Set([rootId]);

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (depth > 0) result.push(id); // don't include root itself

    if (depth >= maxDepth) continue;
    const edges = await client.getOutgoingEdges(id);
    for (const e of edges) {
      if (e.type === 'CONTAINS' && !visited.has(e.dst)) {
        visited.add(e.dst);
        queue.push({ id: e.dst, depth: depth + 1 });
      }
    }
  }
  return result;
}

/**
 * Trace assignment chain to find a shape source (LITERAL with objectKeys).
 * Returns { type, keys } or null.
 */
async function traceShape(client, varId, maxDepth, visited) {
  if (maxDepth <= 0 || visited.has(varId)) return null;
  visited.add(varId);

  const outEdges = await client.getOutgoingEdges(varId);

  // Check if this node already has INSTANCE_OF with shape
  const instanceOf = outEdges.find(e => e.type === 'INSTANCE_OF');
  if (instanceOf && Array.isArray(instanceOf.shape)) {
    return {
      type: instanceOf.inferredType || 'Object',
      keys: instanceOf.shape,
    };
  }

  // Follow ASSIGNED_FROM to source
  const assignedFrom = outEdges.filter(e => e.type === 'ASSIGNED_FROM');
  for (const af of assignedFrom) {
    const source = await client.getNode(af.dst);
    if (!source) continue;
    const srcType = source.nodeType || source.type;

    // Direct literal source — read objectKeys from metadata
    if (srcType === 'LITERAL') {
      const meta = typeof source.metadata === 'string'
        ? JSON.parse(source.metadata || '{}') : source.metadata || {};
      if (meta.kind === 'object' && Array.isArray(meta.objectKeys)) {
        return {
          type: 'Object',
          keys: meta.objectKeys,
        };
      }
      continue;
    }

    // Variable-to-variable — recurse
    if (srcType === 'VARIABLE' || srcType === 'CONSTANT') {
      const result = await traceShape(client, String(source.id), maxDepth - 1, visited);
      if (result) return result;
    }
  }

  return null;
}
