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

const TRAVERSAL_EDGES = new Set([
  'CONTAINS', 'HAS_CONSEQUENT', 'HAS_ALTERNATE', 'HAS_BODY',
  'HAS_SCOPE', 'HAS_CATCH', 'HAS_FINALLY',
]);

const SENDER_PRIMITIVES = [
  // Node.js child_process
  { names: ['spawn', 'child_process.spawn', 'execFile', 'fork'], transport: 'subprocess', channelFrom: 'arg0_binary' },
  // Node.js net
  { names: ['net.connect', 'net.createConnection', 'Socket.connect'], transport: 'unix_socket', channelFrom: 'arg0_path' },
  // Generic socket write (only explicit Socket.write, not <obj>.write which catches stdout/fs)
  { names: ['Socket.write'], transport: 'unix_socket', channelFrom: 'receiver_connect' },
  // HTTP
  { names: ['fetch', 'http.request', 'http.get', 'https.request', 'https.get'], transport: 'http', channelFrom: 'arg0_url' },
  // Class-mediated IPC: constructor wraps socket/transport
  // channelHint provides fallback when arg0 can't be resolved to a literal
  { names: ['RFDBClient', 'RFDBServerBackend'], transport: 'unix_socket', channelFrom: 'arg0_path', channelHint: 'rfdb' },
  // Rust IPC: RfdbClient methods (unix socket via msgpack)
  { names: ['send_raw', 'send_command'], transport: 'unix_socket', channelFrom: 'receiver_class', channelHint: 'rfdb', lang: 'rust' },
  // Rust subprocess: detect via Command::new(binary) instead of spawn()
  { names: ['Command::new', 'std::process::Command::new'], transport: 'subprocess', channelFrom: 'arg0_binary', lang: 'rust' },
  // Rust process pool
  { names: ['request'], transport: 'subprocess_stdio', channelFrom: 'receiver_class', channelHint: 'grafema-resolve', lang: 'rust' },
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
  const unresolvedIssues = [];
  for (const sender of senderCalls) {
    const channel = await extractChannel(client, sender, serviceEntryPoints);
    if (!channel) {
      unresolvedIssues.push({
        id: `issue::unresolved-bridge::${sender.callId}`,
        type: 'ISSUE',
        name: `Unresolved IPC: ${sender.callName}`,
        file: sender.file || '',
        exported: false,
        metadata: JSON.stringify({
          _source: 'semantic-bridge-detector',
          severity: 'info',
          category: 'unresolved-bridge',
          reason: 'channel-unknown',
          callName: sender.callName,
          transport: sender.transport,
          line: sender.line,
        }),
      });
      continue;
    }

    // Step 3: Find matching receiver
    const receiver = await findReceiver(client, sender.transport, channel, serviceEntryPoints);
    if (!receiver) {
      unresolvedIssues.push({
        id: `issue::unresolved-bridge::${sender.callId}`,
        type: 'ISSUE',
        name: `Unresolved IPC receiver: ${sender.callName} → ${channel.value}`,
        file: sender.file || '',
        exported: false,
        metadata: JSON.stringify({
          _source: 'semantic-bridge-detector',
          severity: 'info',
          category: 'unresolved-bridge',
          reason: 'receiver-unknown',
          callName: sender.callName,
          transport: sender.transport,
          channel: channel.value,
          line: sender.line,
        }),
      });
      continue;
    }

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

  // Step 5a: Create CALLS_REMOTE edges
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

  // Step 5b: Create ISSUE nodes for unresolved bridges
  // Filter: skip ISSUEs for call names where ANY bridge was already resolved
  // (e.g., RFDBServerBackend unresolved when RFDBClient already resolved → skip)
  const resolvedTransports = new Set(bridges.map(b => `${b.transport}:${b.senderName}`));
  const resolvedFiles = new Set(bridges.map(b => b.src));
  const filteredIssues = unresolvedIssues.filter(issue => {
    const meta = JSON.parse(issue.metadata);
    // If this transport+callName combo already has resolved bridges, skip
    // e.g., "unix_socket:RFDBServerBackend" when "unix_socket:RFDBClient" resolved
    if (meta.transport === 'unix_socket' && bridges.some(b => b.transport === 'unix_socket' && b.senderName !== meta.callName)) {
      // Same file has a resolved socket bridge → skip
      if (bridges.some(b => b.transport === 'unix_socket')) return false;
    }
    return true;
  });
  if (filteredIssues.length > 0) {
    const BATCH = 200;
    for (let i = 0; i < filteredIssues.length; i += BATCH) {
      await client.addNodes(filteredIssues.slice(i, i + BATCH));
    }
  }

  // Step 6: Config-driven plugin bridges
  // Parse plugins[].command to extract binary/script, create bridges from
  // run_batch_plugin/run_streaming_plugin to the plugin entry point.
  const pluginBridges = await createConfigDrivenBridges(client, config);
  if (pluginBridges.length > 0) {
    await client.addEdges(pluginBridges.map(b => ({
      src: b.src,
      dst: b.dst,
      type: 'CALLS_REMOTE',
      metadata: JSON.stringify({
        _source: 'semantic-bridge-detector',
        transport: b.transport,
        channel: b.channel,
        configDriven: true,
      }),
    })));
    bridges.push(...pluginBridges);
  }

  console.error(`[semantic-bridge] Done: ${bridges.length} CALLS_REMOTE, ${filteredIssues.length} unresolved ISSUEs`);
  for (const b of bridges) {
    console.error(`  ✓ ${b.senderName} → ${b.receiverName} (${b.transport}, channel=${b.channel})`);
  }

  await client.close();
} catch (err) {
  console.error(`[semantic-bridge] Error: ${err.message}`);
  await client.close();
  process.exit(1);
}

// ── Config-driven bridges (symbolic execution of config values) ─────────────

async function createConfigDrivenBridges(client, config) {
  // Load raw YAML config (loadGrafemaConfig transforms plugins into a different format)
  const rawPlugins = await loadRawPlugins();
  if (!rawPlugins || rawPlugins.length === 0) return [];

  const results = [];

  for (const plugin of rawPlugins) {
    if (!plugin.command) continue;

    // Parse command: "node plugins/type-inference.mjs" → script path
    // Or: "grafema-resolve --mode streaming" → binary name
    const parts = plugin.command.split(/\s+/);
    let targetFile = null;

    if (parts[0] === 'node' && parts[1]) {
      // Node.js script — target is the script file
      targetFile = parts[1];
    } else {
      // Binary command — target is the binary name
      targetFile = parts[0];
    }

    if (!targetFile) continue;

    // Find the sender function: run_batch_plugin or run_streaming_plugin
    const mode = plugin.mode || 'batch';
    const senderFnName = mode === 'streaming' ? 'run_streaming_plugin' : 'run_batch_plugin';

    let senderId = null;
    for await (const fn of client.queryNodes({ type: 'FUNCTION', name: senderFnName })) {
      if (fn.file?.includes('plugin.rs')) {
        senderId = fn.semanticId || String(fn.id);
        break;
      }
    }
    if (!senderId) continue;

    // Find or create receiver node for the plugin
    let receiverId = null;
    let receiverName = plugin.name;

    // Try to find existing MODULE
    for await (const m of client.queryNodes({ type: 'MODULE' })) {
      if (m.file?.includes(targetFile) || m.name?.includes(targetFile)) {
        receiverId = m.semanticId || String(m.id);
        receiverName = m.name || plugin.name;
        break;
      }
    }

    // Plugin files aren't in analysis scope — create virtual node
    if (!receiverId) {
      receiverId = `plugin::${plugin.name}`;
      await client.addNodes([{
        id: receiverId,
        type: 'MODULE',
        name: plugin.name,
        file: targetFile,
        exported: true,
        metadata: JSON.stringify({ _source: 'semantic-bridge-detector', plugin: true, command: plugin.command }),
      }]);
      receiverName = plugin.name;
    }

    // Check dedup
    const existing = await client.getOutgoingEdges(senderId);
    if (existing.some(e => e.type === 'CALLS_REMOTE' && e.dst === receiverId)) continue;

    results.push({
      src: senderId,
      dst: receiverId,
      transport: mode === 'streaming' ? 'subprocess_stdio' : 'subprocess',
      channel: plugin.command,
      senderName: senderFnName,
      receiverName,
    });
  }

  return results;
}

function matchLanguage(file, lang) {
  if (lang === 'rust') return file.endsWith('.rs');
  // Default: JS/TS only
  return file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.tsx');
}

// ── Find sender calls ───────────────────────────────────────────────────────

async function findSenderCalls(client) {
  const results = [];

  for (const prim of SENDER_PRIMITIVES) {
    for (const name of prim.names) {
      // Search CALL nodes matching the primitive name, filtered by language
      for await (const node of client.queryNodes({ type: 'CALL', name })) {
        const file = node.file || '';
        if (!matchLanguage(file, prim.lang)) continue;

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
          channelHint: prim.channelHint || null,
          containingFnId: containingFn?.id,
          containingFnName: containingFn?.name,
        });
      }

      // Also check dotted names like "child_process.spawn" → stored as just "spawn" with object
      if (name.includes('.')) {
        const methodName = name.split('.').pop();
        for await (const node of client.queryNodes({ type: 'CALL', name: methodName })) {
          const file = node.file || '';
          if (!matchLanguage(file, prim.lang)) continue;
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
                channelHint: prim.channelHint || null,
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

async function extractChannel(client, sender, serviceEntryPoints) {
  const { channelFrom, callId } = sender;

  if (channelFrom === 'arg0_binary' || channelFrom === 'arg0_path' || channelFrom === 'arg0_url') {
    // Trace first argument to find string literal or function hint
    const argValue = await traceFirstArgToLiteral(client, callId);
    if (argValue) {
      let value = argValue;
      // Handle function name hints (e.g., __fn_hint:findOrchestratorBinary)
      if (value.startsWith('__fn_hint:')) {
        const fnName = value.replace('__fn_hint:', '');
        value = extractServiceName(fnName);
        // If extractServiceName gave nothing useful, trace the function's internal calls
        // e.g. resolveBinaryPath → calls findServerBinary → calls findRfdbBinary → "rfdb"
        if (!value) {
          value = await traceDeepServiceName(client, fnName, serviceEntryPoints);
        }
      } else if (channelFrom === 'arg0_binary') {
        value = basename(value);
      }
      if (value) {
        return { type: channelFrom.replace('arg0_', ''), value };
      }

      // Fallback: use channelHint from primitive definition
      if (!value && sender.channelHint) {
        return { type: channelFrom.replace('arg0_', ''), value: sender.channelHint };
      }
    }
  }

  if (channelFrom === 'receiver_connect') {
    return null;
  }

  // Rust: channel from receiver's class (e.g., self.send_raw in RfdbClient → "rfdb")
  if (channelFrom === 'receiver_class') {
    if (sender.channelHint) return { type: 'path', value: sender.channelHint };
    // Try to extract class name from containing function's semantic ID
    const fnName = sender.containingFnName || '';
    const svcName = extractServiceName(fnName);
    if (svcName) return { type: 'path', value: svcName };
    return null;
  }

  return null;
}

async function traceFirstArgToLiteral(client, callId, maxDepth = 10) {
  // Find PASSES_ARGUMENT edges from call, sort by index to get arg0 first
  const outEdges = await client.getOutgoingEdges(callId);
  const passesArg = outEdges
    .filter(e => e.type === 'PASSES_ARGUMENT')
    .sort((a, b) => (a.index ?? 999) - (b.index ?? 999));

  // Try each argument starting from index 0
  const candidates = [];
  for (const pa of passesArg) {
    const argNode = await client.getNode(pa.dst);
    if (!argNode) continue;

    // Skip array/object literals (those are args[] or options{})
    if (argNode.nodeType === 'LITERAL' && (argNode.name === '<array>' || argNode.name === '<object>')) continue;

    // Template literals: extract URL path from quasis (static parts)
    if (argNode.nodeType === 'LITERAL' && argNode.name === '<template>') {
      const meta = typeof argNode.metadata === 'string'
        ? JSON.parse(argNode.metadata || '{}') : argNode.metadata || {};
      if (Array.isArray(meta.quasis)) {
        // Find the quasis part that looks like a URL path
        const urlPart = meta.quasis.find(q => q.startsWith('/'));
        if (urlPart) { candidates.push(urlPart); continue; }
      }
      continue;
    }

    if (argNode.nodeType === 'LITERAL' && argNode.name) {
      candidates.push(cleanStringLiteral(argNode.name));
      continue;
    }

    // Recognize process.execPath as "self-spawn" (same binary)
    if (argNode.nodeType === 'PROPERTY_ACCESS' && argNode.name === 'execPath') {
      candidates.push('__self__');
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
    // For array literals, look at first element for a path string
    if (node.name === '<array>') {
      const arrEdges = await client.getOutgoingEdges(id);
      const elements = arrEdges.filter(e => e.type === 'HAS_ELEMENT').sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
      for (const el of elements) {
        const elNode = await client.getNode(el.dst);
        if (!elNode) continue;
        if (elNode.nodeType === 'LITERAL' && elNode.name && elNode.name !== '<array>' && elNode.name !== '<object>') {
          return cleanStringLiteral(elNode.name);
        }
        // Element is a CALL (like path.join) — check its args for path strings
        if (elNode.nodeType === 'CALL') {
          const elEdges = await client.getOutgoingEdges(String(elNode.id));
          const elArgs = elEdges.filter(e => e.type === 'PASSES_ARGUMENT')
            .sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
          for (const pa of elArgs) {
            const argNode = await client.getNode(pa.dst);
            if (argNode?.nodeType === 'LITERAL' && argNode.name) {
              const cleaned = cleanStringLiteral(argNode.name);
              if (cleaned.includes('-') || cleaned.includes('/')) return cleaned;
            }
          }
        }
      }
      return null;
    }
    return cleanStringLiteral(node.name);
  }

  // Follow READS_FROM → declaration → ASSIGNED_FROM → source
  const edges = await client.getOutgoingEdges(id);
  for (const e of edges) {
    if (e.type === 'READS_FROM' || e.type === 'ASSIGNED_FROM') {
      const target = await client.getNode(e.dst);
      if (!target) continue;

      if (target.nodeType === 'LITERAL' && target.name) {
        // For arrays/objects, recurse into them instead of returning the marker
        if (target.name === '<array>' || target.name === '<object>') {
          const result = await traceToLiteral(client, target, depth - 1);
          if (result) return result;
          continue;
        }
        return cleanStringLiteral(target.name);
      }

      if (target.nodeType === 'CALL' && target.name) {
        const callName = target.name;
        const targetId = String(target.id);
        const callEdges = await client.getOutgoingEdges(targetId);

        // For method calls (.find, .pop) — trace the receiver
        if (callName.includes('.')) {
          for (const ce of callEdges) {
            if (ce.type === 'READS_FROM' || ce.type === 'DERIVES_FROM') {
              const rn = await client.getNode(ce.dst);
              if (rn) {
                const receiverResult = await traceToLiteral(client, rn, depth - 1);
                if (receiverResult) return receiverResult;
              }
            }
          }
        }

        // For path.join and similar — check args for path-like strings
        const args = callEdges.filter(e => e.type === 'PASSES_ARGUMENT')
          .sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
        for (const pa of args) {
          const argNode = await client.getNode(pa.dst);
          if (argNode?.nodeType === 'LITERAL' && argNode.name) {
            const cleaned = cleanStringLiteral(argNode.name);
            if (cleaned.includes('-') || cleaned.includes('/')) return cleaned;
          }
        }

        return `__fn_hint:${callName}`;
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
  if (transport === 'subprocess' || transport === 'subprocess_stdio') {
    const binaryName = channel.value;

    // Self-spawn: process.execPath → find CLI entry point
    if (binaryName === '__self__') {
      return await findEntryFunction(client, 'cli');
    }

    // Match binary name to service entry point
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
    // Fallback: search for MODULE with binary name in path (e.g., gui-server → packages/gui-server/*)
    return await findEntryByPath(client, binaryName);
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
    // Match URL/path against http:route nodes (from axum-route-detector or express LibraryDef)
    const url = channel.value;
    // Extract path from URL: "http://localhost:3333/api/stats" → "/api/stats"
    let urlPath = url;
    try { urlPath = new URL(url).pathname; } catch { /* not a full URL, use as-is */ }

    for await (const route of client.queryNodes({ type: 'http:route' })) {
      const meta = typeof route.metadata === 'string' ? JSON.parse(route.metadata || '{}') : route.metadata || {};
      const routePath = meta.path || '';
      // Match exact path or path pattern (e.g., /api/hex-batch/{batch_id})
      if (routePath === urlPath || matchPathPattern(routePath, urlPath)) {
        return { id: route.semanticId || String(route.id), name: route.name, file: route.file };
      }
    }
    return null;
  }

  return null;
}

async function findEntryByPath(client, binaryName) {
  // Search for a main function in a file path matching the binary name
  // e.g., "gui-server" → find main in packages/gui-server/src/main.rs
  for (const name of ['main', 'activate', 'run', 'start']) {
    for await (const n of client.queryNodes({ type: 'FUNCTION', name })) {
      if (n.file?.includes(binaryName)) {
        return { id: n.semanticId || String(n.id), name: n.name, file: n.file };
      }
    }
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

async function loadRawPlugins() {
  try {
    const { parse } = await import('yaml');
    const configPath = join(process.cwd(), '.grafema', 'config.yaml');
    const raw = readFileSync(configPath, 'utf8');
    const doc = parse(raw);
    return Array.isArray(doc.plugins) ? doc.plugins : [];
  } catch {
    return [];
  }
}

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

/**
 * Extract service name from a function name like findOrchestratorBinary → orchestrator.
 * Splits camelCase, removes boilerplate words (find, get, resolve, binary, path, server, spawn),
 * returns the meaningful middle part.
 */
/**
 * When extractServiceName returns nothing for a function hint,
 * find the FUNCTION in the graph and trace its internal CALLS chain
 * to find a deeper function with a meaningful service name.
 * e.g. resolveBinaryPath → findServerBinary → findRfdbBinary → "rfdb"
 */
async function traceDeepServiceName(client, fnName, serviceEntryPoints, maxDepth = 3) {
  const fnQueue = [fnName];
  const visitedFns = new Set();
  const candidates = [];

  for (let depth = 0; depth < maxDepth && fnQueue.length > 0; depth++) {
    const name = fnQueue.shift();
    if (visitedFns.has(name)) continue;
    visitedFns.add(name);

    for await (const fn of client.queryNodes({ type: 'FUNCTION', name })) {
      const descendants = await collectDescendantsFromFunction(client, String(fn.id));
      for (const descId of descendants) {
        const child = await client.getNode(descId);
        if (!child || (child.nodeType || child.type) !== 'CALL') continue;
        const callName = child.name || '';
        const svcName = extractServiceName(callName);
        if (svcName) {
          // Prioritize: if it matches a known service → return immediately
          for (const [epName] of serviceEntryPoints) {
            if (epName.includes(svcName) || svcName.includes(epName)) return svcName;
          }
          candidates.push(svcName);
        }
        fnQueue.push(callName);
      }
    }
  }
  return candidates[0] || null;
}

async function collectDescendantsFromFunction(client, fnId) {
  const result = [];
  const visited = new Set();
  const fnEdges = await client.getOutgoingEdges(fnId);
  const seeds = fnEdges.filter(e => e.type === 'HAS_SCOPE').map(e => e.dst);

  const queue = [...seeds];
  for (const s of seeds) visited.add(s);

  while (queue.length > 0) {
    const id = queue.shift();
    const edges = await client.getOutgoingEdges(id);
    for (const e of edges) {
      if (TRAVERSAL_EDGES.has(e.type) && !visited.has(e.dst)) {
        visited.add(e.dst);
        result.push(e.dst);
        queue.push(e.dst);
      }
    }
  }
  return result;
}

/**
 * Match a URL path against a route pattern with {param} placeholders.
 * E.g., "/api/hex-batch/{batch_id}" matches "/api/hex-batch/123"
 */
function matchPathPattern(pattern, path) {
  if (!pattern.includes('{')) return pattern === path;
  const regex = new RegExp('^' + pattern.replace(/\{[^}]+\}/g, '[^/]+') + '$');
  return regex.test(path);
}

function extractServiceName(fnName) {
  // Split camelCase: findOrchestratorBinary → ['find', 'Orchestrator', 'Binary']
  const parts = fnName.split(/(?=[A-Z])/).map(p => p.toLowerCase());
  const boilerplate = new Set(['find', 'get', 'resolve', 'spawn', 'create', 'start',
    'binary', 'path', 'server', 'process', 'child', 'run', 'exec', 'launch']);
  const meaningful = parts.filter(p => !boilerplate.has(p) && p.length > 1);

  if (meaningful.length > 0) {
    return meaningful.join('-');
  }
  // All parts are boilerplate — no service name extractable
  return null;
}
