#!/usr/bin/env node
/**
 * Semantic Bridge Detector — Grafema batch plugin
 *
 * Automatically detects cross-process/cross-language IPC boundaries
 * and creates CALLS_REMOTE edges based on IO effect subtypes.
 *
 * Strategy: find functions that call IO primitives (spawn, net.connect, fetch)
 * and match them with receiver entry points via channel identity
 * (socket path, binary name, URL pattern).
 *
 * Replaces the hardcoded ipc-bridge-detector.mjs.
 *
 * Environment:
 *   RFDB_SOCKET  — path to RFDB unix socket
 *   RFDB_DATABASE — database name
 */

import { RFDBClient } from '../packages/rfdb/dist/client.js';
import { readFileSync } from 'fs';
import { join, basename, dirname } from 'path';
// Use grafema util's config loader (it handles YAML)
import { loadConfig as loadGrafemaConfig } from '../packages/util/dist/config/index.js';

const socketPath = process.env.RFDB_SOCKET;
const dbName = process.env.RFDB_DATABASE;

if (!socketPath) {
  console.error('[semantic-bridge] RFDB_SOCKET not set');
  process.exit(1);
}

// ── Known IPC primitives ────────────────────────────────────────────────────
// Functions that initiate cross-process communication.
// Each entry: { callPattern, transport, channelFrom }

const FUNCTION_TYPES = new Set(['FUNCTION', 'METHOD', 'CONSTRUCTOR', 'LAMBDA']);

const SENDER_PRIMITIVES = [
  // Node.js child_process
  { names: ['spawn', 'child_process.spawn', 'execFile', 'fork'], transport: 'subprocess', channelFrom: 'arg0_binary' },
  // Node.js net
  { names: ['net.connect', 'net.createConnection', 'Socket.connect'], transport: 'unix_socket', channelFrom: 'arg0_path' },
  // Generic socket write
  { names: ['Socket.write', '<obj>.write'], transport: 'unix_socket', channelFrom: 'receiver_connect' },
  // HTTP
  { names: ['fetch', 'http.request', 'http.get', 'https.request', 'https.get'], transport: 'http', channelFrom: 'arg0_url' },
];

// ── Main ────────────────────────────────────────────────────────────────────

const client = new RFDBClient(socketPath, 'semantic-bridge-detector');

try {
  await client.connect();
  if (dbName) await client.openDatabase(dbName);

  // Load project config to get service entry points
  const config = loadConfig();
  const serviceEntryPoints = buildServiceIndex(config);

  console.error(`[semantic-bridge] ${serviceEntryPoints.size} service entry points indexed`);

  // Step 1: Find all CALL nodes that match sender primitives
  const senderCalls = await findSenderCalls(client);
  console.error(`[semantic-bridge] ${senderCalls.length} IPC sender calls found`);

  // Step 2: For each sender, extract channel identity
  const bridges = [];
  for (const sender of senderCalls) {
    const channel = await extractChannel(client, sender);
    if (!channel) continue;

    // Step 3: Find matching receiver
    const receiver = await findReceiver(client, sender.transport, channel, serviceEntryPoints);
    if (!receiver) continue;

    // Step 4: Check if bridge already exists
    const srcId = sender.containingFnId || sender.callId;
    const dstId = receiver.id;
    const existing = await client.getOutgoingEdges(srcId);
    if (existing.some(e => e.type === 'CALLS_REMOTE' && e.dst === dstId)) continue;

    bridges.push({
      src: srcId,
      dst: dstId,
      transport: sender.transport,
      channel: channel.value,
      senderName: sender.callName,
      receiverName: receiver.name,
    });
  }

  // Step 5: Create CALLS_REMOTE edges
  if (bridges.length > 0) {
    const edges = bridges.map(b => ({
      src: b.src,
      dst: b.dst,
      type: 'CALLS_REMOTE',
      metadata: JSON.stringify({
        _source: 'semantic-bridge-detector',
        transport: b.transport,
        channel: b.channel,
      }),
    }));
    await client.addEdges(edges);
  }

  console.error(`[semantic-bridge] Done: ${bridges.length} CALLS_REMOTE edge(s) created`);
  for (const b of bridges) {
    console.error(`  ✓ ${b.senderName} → ${b.receiverName} (${b.transport}, channel=${b.channel})`);
  }

  await client.close();
} catch (err) {
  console.error(`[semantic-bridge] Error: ${err.message}`);
  await client.close();
  process.exit(1);
}

// ── Find sender calls ───────────────────────────────────────────────────────

async function findSenderCalls(client) {
  const results = [];

  for (const prim of SENDER_PRIMITIVES) {
    for (const name of prim.names) {
      // Search CALL nodes matching the primitive name
      for await (const node of client.queryNodes({ type: 'CALL', name })) {
        const id = node.semanticId || String(node.id);

        // Find containing function (walk up CONTAINS)
        const containingFn = await findContainingFunction(client, id);

        results.push({
          callId: id,
          callName: node.name,
          file: node.file,
          line: node.line,
          transport: prim.transport,
          channelFrom: prim.channelFrom,
          containingFnId: containingFn?.id,
          containingFnName: containingFn?.name,
        });
      }

      // Also check dotted names like "child_process.spawn" → stored as just "spawn" with object
      if (name.includes('.')) {
        const methodName = name.split('.').pop();
        for await (const node of client.queryNodes({ type: 'CALL', name: methodName })) {
          // Verify the object/receiver matches
          const fullName = node.name || '';
          if (fullName === methodName || fullName.endsWith('.' + methodName)) {
            const id = node.semanticId || String(node.id);
            const containingFn = await findContainingFunction(client, id);
            // Deduplicate
            if (!results.some(r => r.callId === id)) {
              results.push({
                callId: id,
                callName: node.name,
                file: node.file,
                line: node.line,
                transport: prim.transport,
                channelFrom: prim.channelFrom,
                containingFnId: containingFn?.id,
                containingFnName: containingFn?.name,
              });
            }
          }
        }
      }
    }
  }

  return results;
}

// ── Extract channel identity ────────────────────────────────────────────────

async function extractChannel(client, sender) {
  const { channelFrom, callId } = sender;

  if (channelFrom === 'arg0_binary' || channelFrom === 'arg0_path' || channelFrom === 'arg0_url') {
    // Trace first argument to find string literal or function hint
    const argValue = await traceFirstArgToLiteral(client, callId);
    if (argValue) {
      let value = argValue;
      // Handle function name hints (e.g., __fn_hint:findOrchestratorBinary)
      if (value.startsWith('__fn_hint:')) {
        const fnName = value.replace('__fn_hint:', '');
        // Extract meaningful keywords from function name
        // findOrchestratorBinary → orchestrator, findRfdbServer → rfdb-server
        value = fnName
          .replace(/^find|^get|^resolve|Binary$|Path$|Server$/gi, '')
          .replace(/([A-Z])/g, '-$1').toLowerCase()
          .replace(/^-/, '').replace(/-+/g, '-');
      } else if (channelFrom === 'arg0_binary') {
        value = basename(value);
      }
      if (value) {
        return { type: channelFrom.replace('arg0_', ''), value };
      }
    }
  }

  if (channelFrom === 'receiver_connect') {
    // For Socket.write — the channel is determined by prior Socket.connect call
    // This is complex — skip for now, the connect call itself is the sender
    return null;
  }

  return null;
}

async function traceFirstArgToLiteral(client, callId, maxDepth = 5) {
  // Find PASSES_ARGUMENT edges from call
  const outEdges = await client.getOutgoingEdges(callId);
  const passesArg = outEdges.filter(e => e.type === 'PASSES_ARGUMENT');

  // Try each argument — PASSES_ARGUMENT order isn't guaranteed,
  // so resolve all and take the first that looks like a path/binary name
  const candidates = [];
  for (const pa of passesArg) {
    const argNode = await client.getNode(pa.dst);
    if (!argNode) continue;

    // Skip array/object literals (those are args[] or options{})
    if (argNode.nodeType === 'LITERAL' && (argNode.name === '<array>' || argNode.name === '<object>')) continue;

    if (argNode.nodeType === 'LITERAL' && argNode.name) {
      candidates.push(cleanStringLiteral(argNode.name));
      continue;
    }

    // Trace REFERENCE/VARIABLE backward to find string literal
    const value = await traceToLiteral(client, argNode, maxDepth);
    if (value) candidates.push(value);
  }

  // Return best candidate — prefer path-like strings
  return candidates.find(c => c.includes('/') || c.includes('-') || !c.startsWith('[')) || candidates[0] || null;
}

async function traceToLiteral(client, node, depth) {
  if (depth <= 0) return null;
  const id = node.semanticId || String(node.id);

  // Check if node itself has a literal value
  if (node.nodeType === 'LITERAL' && node.name) {
    return cleanStringLiteral(node.name);
  }

  // Follow READS_FROM → declaration → ASSIGNED_FROM → source
  const edges = await client.getOutgoingEdges(id);
  for (const e of edges) {
    if (e.type === 'READS_FROM' || e.type === 'ASSIGNED_FROM') {
      const target = await client.getNode(e.dst);
      if (!target) continue;

      if (target.nodeType === 'LITERAL' && target.name) {
        return cleanStringLiteral(target.name);
      }

      // If assigned from a CALL, use function name as hint
      // e.g., findOrchestratorBinary() → hint "orchestrator"
      if (target.nodeType === 'CALL' && target.name) {
        return `__fn_hint:${target.name}`;
      }

      const result = await traceToLiteral(client, target, depth - 1);
      if (result) return result;
    }
  }

  return null;
}

function cleanStringLiteral(s) {
  // Remove quotes from string literals
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ── Find receiver ───────────────────────────────────────────────────────────

async function findReceiver(client, transport, channel, serviceEntryPoints) {
  if (transport === 'subprocess') {
    // Match binary name to service entry point
    const binaryName = channel.value;
    const entryPoint = serviceEntryPoints.get(binaryName);
    if (entryPoint) {
      // Find the main/entry function in that file
      return await findEntryFunction(client, entryPoint.file);
    }
    // Also try partial match (grafema-orchestrator → orchestrator)
    for (const [name, ep] of serviceEntryPoints) {
      if (name.includes(binaryName) || binaryName.includes(name)) {
        return await findEntryFunction(client, ep.file);
      }
    }
    return null;
  }

  if (transport === 'unix_socket') {
    // Match socket path → find the server that listens on it
    // Strategy: find functions that call net.createServer or Server.listen in the project
    // For RFDB specifically: match .grafema/rfdb.sock → rfdb_server main
    const socketName = basename(channel.value);
    if (socketName.includes('rfdb')) {
      // Find rfdb_server entry point
      for await (const n of client.queryNodes({ type: 'FUNCTION', name: 'handle_request_with_cancel' })) {
        if (n.file?.includes('rfdb_server')) {
          return { id: n.semanticId || String(n.id), name: n.name, file: n.file };
        }
      }
    }
    return null;
  }

  if (transport === 'http') {
    // Match URL pattern to HTTP handler
    // For GUI server: match /api/* to route handlers
    const url = channel.value;
    // Search for route definitions (simplified — looks for the URL path in LITERAL nodes)
    for await (const n of client.queryNodes({ type: 'LITERAL', name: `"${url}"` })) {
      // TODO: more sophisticated HTTP route matching
      break;
    }
    return null;
  }

  return null;
}

async function findEntryFunction(client, filePath) {
  // Look for main function or module-level entry point
  for (const name of ['main', 'activate', 'run', 'start']) {
    for await (const n of client.queryNodes({ type: 'FUNCTION', name })) {
      if (n.file?.includes(filePath)) {
        return { id: n.semanticId || String(n.id), name: n.name, file: n.file };
      }
    }
  }
  // Fallback: find MODULE node for the file
  for await (const n of client.queryNodes({ type: 'MODULE' })) {
    if (n.file?.includes(filePath)) {
      return { id: n.semanticId || String(n.id), name: n.name, file: n.file };
    }
  }
  return null;
}

// ── Containing function ─────────────────────────────────────────────────────

async function findContainingFunction(client, nodeId) {
  let currentId = nodeId;
  const seen = new Set();

  for (let i = 0; i < 10; i++) {
    if (seen.has(currentId)) return null;
    seen.add(currentId);

    const incoming = await client.getIncomingEdges(currentId);
    const containsEdge = incoming.find(e => e.type === 'CONTAINS' || e.type === 'HAS_SCOPE');
    if (!containsEdge) return null;

    const parent = await client.getNode(containsEdge.src);
    if (!parent) return null;
    if (FUNCTION_TYPES.has(parent.nodeType)) {
      return { id: parent.semanticId || String(parent.id), name: parent.name, file: parent.file };
    }
    currentId = parent.semanticId || String(parent.id);
  }
  return null;
}

// ── Config loading ──────────────────────────────────────────────────────────

function loadConfig() {
  try {
    return loadGrafemaConfig(process.cwd());
  } catch {
    return {};
  }
}

function buildServiceIndex(config) {
  const index = new Map();
  if (!config.services) return index;

  for (const svc of config.services) {
    if (svc.name && svc.entryPoint) {
      const fullPath = svc.path ? join(svc.path, svc.entryPoint) : svc.entryPoint;
      // Map service name → entry point file
      index.set(svc.name, { file: fullPath, path: svc.path });
      // Also map common binary names
      const binaryVariants = [
        svc.name,
        `grafema-${svc.name}`,
        svc.name.replace(/-/g, '_'),
      ];
      for (const v of binaryVariants) {
        index.set(v, { file: fullPath, path: svc.path });
      }
    }
  }

  return index;
}
