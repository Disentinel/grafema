#!/usr/bin/env node
/**
 * IPC Bridge Detector — Grafema batch plugin
 *
 * Detects cross-language IPC boundaries and creates CALLS_REMOTE edges.
 *
 * Strategy: match "send" methods in client classes with "dispatch/handle"
 * functions in server code by shared protocol patterns.
 *
 * Current detection: BaseRFDBClient._send() → rfdb_server::handle_request_with_cancel()
 * (extensible via bridges config below)
 *
 * Environment:
 *   RFDB_SOCKET  — path to RFDB unix socket (set by orchestrator)
 *   RFDB_DATABASE — database name (set by orchestrator)
 */

import { RFDBClient } from '../packages/rfdb/dist/client.js';

// ── Bridge definitions ──────────────────────────────────────────────────────
// Each bridge describes a send→receive pair across a process boundary.
// The plugin finds matching nodes in the graph and creates CALLS_REMOTE edges.

const BRIDGES = [
  {
    name: 'rfdb-unix-socket',
    description: 'RFDB client ↔ server communication over unix socket',
    sender: {
      // The method that serializes and sends over the wire
      type: 'METHOD',
      name: '_send',
      filePattern: 'base-client.ts',
    },
    receiver: {
      // The function that deserializes and dispatches
      type: 'FUNCTION',
      name: 'handle_request_with_cancel',
      filePattern: 'rfdb_server.rs',
    },
    metadata: {
      transport: 'unix_socket',
      protocol: 'msgpack',
      channel: '.grafema/rfdb.sock',
    },
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

const socketPath = process.env.RFDB_SOCKET;
const dbName = process.env.RFDB_DATABASE;

if (!socketPath) {
  console.error('[ipc-bridge-detector] RFDB_SOCKET not set');
  process.exit(1);
}

const client = new RFDBClient(socketPath, 'ipc-bridge-detector');

try {
  await client.connect();

  if (dbName) {
    await client.openDatabase(dbName);
  }

  let edgesCreated = 0;

  for (const bridge of BRIDGES) {
    console.error(`[ipc-bridge-detector] Processing bridge: ${bridge.name}`);

    // Find sender node
    const senderNode = await findNode(client, bridge.sender);
    if (!senderNode) {
      console.error(`  ⚠ Sender not found: ${bridge.sender.type} ${bridge.sender.name} in ${bridge.sender.filePattern}`);
      continue;
    }

    // Find receiver node
    const receiverNode = await findNode(client, bridge.receiver);
    if (!receiverNode) {
      console.error(`  ⚠ Receiver not found: ${bridge.receiver.type} ${bridge.receiver.name} in ${bridge.receiver.filePattern}`);
      continue;
    }

    // Check if edge already exists
    const existing = await client.getOutgoingEdges(senderNode.semanticId || senderNode.id);
    const alreadyBridged = existing.some(
      e => e.type === 'CALLS_REMOTE' && (e.dst === receiverNode.id || e.dst === receiverNode.semanticId)
    );

    if (alreadyBridged) {
      console.error(`  ✓ Bridge already exists: ${bridge.sender.name} → ${bridge.receiver.name}`);
      continue;
    }

    // Create CALLS_REMOTE edge
    const srcId = senderNode.semanticId || String(senderNode.id);
    const dstId = receiverNode.semanticId || String(receiverNode.id);

    await client.addEdges([{
      src: srcId,
      dst: dstId,
      type: 'CALLS_REMOTE',
      metadata: JSON.stringify({
        ...bridge.metadata,
        _source: 'ipc-bridge-detector',
        bridge: bridge.name,
      }),
    }]);

    edgesCreated++;
    console.error(`  ✓ Created CALLS_REMOTE: ${bridge.sender.name} → ${bridge.receiver.name}`);
  }

  console.error(`[ipc-bridge-detector] Done: ${edgesCreated} edge(s) created`);
  await client.close();
} catch (err) {
  console.error(`[ipc-bridge-detector] Error: ${err.message}`);
  await client.close();
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function findNode(client, spec) {
  for await (const node of client.queryNodes({ type: spec.type, name: spec.name })) {
    if (node.file && node.file.includes(spec.filePattern)) {
      return node;
    }
  }
  return null;
}
