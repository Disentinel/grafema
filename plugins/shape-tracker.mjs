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

  // Phase 3b: Object literal shape tracking
  // For LITERAL nodes with kind='object', collect HAS_PROPERTY children
  // and create shape metadata. (Deferred — needs analyzer to emit property keys)

  // Phase 3c: Branch-aware shape intersection (deferred — needs execution order tracking)

  console.error(`[shape-tracker] Done`);
  await client.close();
} catch (err) {
  console.error(`[shape-tracker] Error: ${err.message}`);
  await client.close();
  process.exit(1);
}
