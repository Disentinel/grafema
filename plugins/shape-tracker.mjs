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
  // For variables assigned from other variables, propagate shape through chain.
  // type-inference already stores shape on INSTANCE_OF edges for direct literal assignments.
  // Here we handle: const b = a; (where a has shape from literal).
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
  // For each BRANCH(if), traverse HAS_CONSEQUENT/HAS_ALTERNATE → SCOPE → CONTAINS
  // to find PROPERTY_ACCESS nodes with WRITES_TO. Create GUARDED_WRITE edge.
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
  await client.close();
} catch (err) {
  console.error(`[shape-tracker] Error: ${err.message}`);
  await client.close();
  process.exit(1);
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
