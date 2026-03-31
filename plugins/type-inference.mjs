#!/usr/bin/env node
/**
 * Type Inference Engine — Grafema batch plugin
 *
 * Infers variable types through assignment chains and creates:
 * 1. Virtual CLASS + METHOD nodes for JS builtins (Array, String, Map, etc.)
 * 2. INSTANCE_OF edges from VARIABLE/CONSTANT to their inferred CLASS
 *
 * Runs BEFORE method-call-resolver so it can use INSTANCE_OF for disambiguation.
 *
 * Environment:
 *   RFDB_SOCKET  — path to RFDB unix socket
 *   RFDB_DATABASE — database name
 */

import { RFDBClient } from '../packages/rfdb/dist/client.js';

const socketPath = process.env.RFDB_SOCKET;
const dbName = process.env.RFDB_DATABASE;

if (!socketPath) {
  console.error('[type-inference] RFDB_SOCKET not set');
  process.exit(1);
}

// ── Builtin prototypes ──────────────────────────────────────────────────────
// Virtual CLASS + METHOD definitions for JavaScript built-in types.

const BUILTINS = {
  Array: ['push', 'pop', 'shift', 'unshift', 'map', 'filter', 'reduce', 'forEach',
    'find', 'findIndex', 'some', 'every', 'includes', 'indexOf', 'lastIndexOf',
    'join', 'slice', 'splice', 'concat', 'flat', 'flatMap', 'sort', 'reverse',
    'fill', 'keys', 'values', 'entries', 'at', 'from', 'isArray', 'of'],
  String: ['split', 'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase',
    'startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'replace',
    'replaceAll', 'slice', 'substring', 'charAt', 'charCodeAt', 'padStart',
    'padEnd', 'repeat', 'match', 'matchAll', 'search', 'normalize', 'at'],
  Object: ['keys', 'values', 'entries', 'assign', 'fromEntries', 'defineProperty',
    'getPrototypeOf', 'hasOwnProperty', 'freeze', 'create', 'is'],
  Map: ['set', 'get', 'has', 'delete', 'clear', 'entries', 'keys', 'values', 'forEach', 'size'],
  Set: ['add', 'has', 'delete', 'clear', 'entries', 'keys', 'values', 'forEach', 'size'],
  Promise: ['then', 'catch', 'finally', 'resolve', 'reject', 'all', 'allSettled', 'race', 'any'],
  JSON: ['stringify', 'parse'],
  console: ['log', 'error', 'warn', 'info', 'debug', 'trace', 'dir', 'time', 'timeEnd'],
  Math: ['max', 'min', 'ceil', 'floor', 'round', 'abs', 'random', 'sqrt', 'pow', 'sign', 'trunc'],
  Error: ['message', 'stack', 'name'],
  Date: ['now', 'parse', 'getTime', 'toISOString', 'toLocaleDateString', 'getFullYear', 'getMonth', 'getDate'],
  RegExp: ['test', 'exec', 'toString'],
  Number: ['toFixed', 'toString', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'toLocaleString'],
  Buffer: ['from', 'alloc', 'concat', 'toString', 'slice', 'write', 'readUInt32BE', 'writeUInt32BE', 'byteLength'],
};

// ── Literal type mapping ────────────────────────────────────────────────────

const LITERAL_TYPE_MAP = {
  '<array>': 'Array',
  '<object>': 'Object',
  'true': 'Boolean',
  'false': 'Boolean',
  'null': 'null',
  'undefined': 'undefined',
};

// ── Main ────────────────────────────────────────────────────────────────────

const client = new RFDBClient(socketPath, 'type-inference');

try {
  await client.connect();
  if (dbName) await client.openDatabase(dbName);

  // Phase 1: Create builtin CLASS + METHOD nodes
  const builtinClassIds = await createBuiltinNodes(client);
  console.error(`[type-inference] ${builtinClassIds.size} builtin classes created`);

  // Phase 2: Build CLASS index (name → numericId)
  // RFDB requires numeric IDs for addEdges, not semantic IDs
  const classIndex = new Map(); // className → numericId
  for await (const n of client.queryNodes({ type: 'CLASS' })) {
    const name = n.name;
    if (name) {
      classIndex.set(name, String(n.id));
    }
  }
  console.error(`[type-inference] ${classIndex.size} classes indexed`);

  // Phase 3: Infer types for VARIABLE/CONSTANT nodes
  let instanceOfCreated = 0;
  let processed = 0;
  const edges = [];

  for (const nodeType of ['CONSTANT', 'VARIABLE']) {
    for await (const node of client.queryNodes({ type: nodeType })) {
      processed++;
      const varId = String(node.id); // Use numeric ID for edges

      // Check if already has INSTANCE_OF
      const existing = await client.getOutgoingEdges(varId);
      if (existing.some(e => e.type === 'INSTANCE_OF')) continue;

      // Trace ASSIGNED_FROM to infer type
      const inferredType = await inferType(client, varId, classIndex);
      if (!inferredType) continue;

      const classId = classIndex.get(inferredType);
      if (!classId) continue;

      edges.push({
        src: varId,
        dst: classId,
        type: 'INSTANCE_OF',
        metadata: JSON.stringify({ _source: 'type-inference', inferredType }),
      });
      instanceOfCreated++;
    }
  }

  // Commit edges in batches
  const BATCH = 500;
  for (let i = 0; i < edges.length; i += BATCH) {
    await client.addEdges(edges.slice(i, i + BATCH));
  }

  console.error(`[type-inference] Done: ${processed} variables processed, ${instanceOfCreated} INSTANCE_OF edges created`);
  await client.close();
} catch (err) {
  console.error(`[type-inference] Error: ${err.message}`);
  await client.close();
  process.exit(1);
}

// ── Create builtin nodes ────────────────────────────────────────────────────

async function createBuiltinNodes(client) {
  const classIds = new Map();
  const nodes = [];
  const edgesBatch = [];

  for (const [className, methods] of Object.entries(BUILTINS)) {
    // Check if class already exists
    let classNodeId = null;
    for await (const n of client.queryNodes({ type: 'CLASS', name: className })) {
      if (n.file === '<builtin>') {
        classNodeId = n.semanticId || String(n.id);
        break;
      }
    }

    if (!classNodeId) {
      // Create CLASS node
      await client.addNodes([{
        id: `builtin::${className}`,
        type: 'CLASS',
        name: className,
        file: '<builtin>',
        exported: true,
        metadata: JSON.stringify({ _source: 'type-inference', builtin: true }),
      }]);
      // Re-fetch to get the actual stored ID
      for await (const n of client.queryNodes({ type: 'CLASS', name: className })) {
        if (n.file === '<builtin>') {
          classNodeId = n.semanticId || String(n.id);
          break;
        }
      }
    }

    if (!classNodeId) continue;
    classIds.set(className, classNodeId);

    // Create METHOD nodes and HAS_METHOD edges
    for (const methodName of methods) {
      // Check if method already exists
      let methodExists = false;
      for await (const n of client.queryNodes({ type: 'METHOD', name: methodName })) {
        if (n.file === '<builtin>') { methodExists = true; break; }
      }
      if (methodExists) continue;

      const tempMethodId = `builtin::${className}::${methodName}`;
      await client.addNodes([{
        id: tempMethodId,
        type: 'METHOD',
        name: methodName,
        file: '<builtin>',
        exported: true,
        metadata: JSON.stringify({ _source: 'type-inference', builtin: true, kind: 'method' }),
      }]);

      // Re-fetch to get stored ID
      let methodNodeId = null;
      for await (const n of client.queryNodes({ type: 'METHOD', name: methodName })) {
        if (n.file === '<builtin>') {
          methodNodeId = n.semanticId || String(n.id);
          break;
        }
      }

      if (methodNodeId) {
        // Use numeric IDs for edges (RFDB requires them, not semantic IDs)
        let methodNumId = null;
        for await (const mn of client.queryNodes({ type: 'METHOD', name: methodName })) {
          if (mn.file === '<builtin>') { methodNumId = String(mn.id); break; }
        }
        let classNumId = null;
        for await (const cn of client.queryNodes({ type: 'CLASS', name: className })) {
          if (cn.file === '<builtin>') { classNumId = String(cn.id); break; }
        }
        if (classNumId && methodNumId) {
          edgesBatch.push({
            src: classNumId,
            dst: methodNumId,
            type: 'HAS_METHOD',
            metadata: JSON.stringify({ _source: 'type-inference' }),
          });
        }
      }
    }
  }

  if (nodes.length > 0) {
    await client.addNodes(nodes);
    console.error(`[type-inference] Created ${nodes.length} builtin nodes`);
  }
  if (edgesBatch.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < edgesBatch.length; i += BATCH) {
      await client.addEdges(edgesBatch.slice(i, i + BATCH));
    }
  }

  return classIds;
}

// ── Type inference rules ────────────────────────────────────────────────────

async function inferType(client, varId, classIndex) {
  const outEdges = await client.getOutgoingEdges(varId);
  const assignedFrom = outEdges.filter(e => e.type === 'ASSIGNED_FROM');
  if (assignedFrom.length === 0) return null;

  for (const edge of assignedFrom) {
    const source = await client.getNode(edge.dst);
    if (!source) continue;
    const sourceType = source.nodeType || source.type;

    // Rule 1: Literal type
    if (sourceType === 'LITERAL') {
      const litType = LITERAL_TYPE_MAP[source.name];
      if (litType) return litType;
      // String literals
      if (source.name && source.name.startsWith("'") || source.name?.startsWith('"')) return 'String';
      // Number literals
      if (source.name && /^\d/.test(source.name)) return 'Number';
      continue;
    }

    // Rule 2: CALL → constructor or function return
    if (sourceType === 'CALL') {
      const callId = String(source.id);
      const callName = source.name || '';

      // Check what this CALL resolves to
      const callEdges = await client.getOutgoingEdges(callId);
      const callsEdge = callEdges.find(e => e.type === 'CALLS');

      if (callsEdge) {
        const target = await client.getNode(callsEdge.dst);
        if (target) {
          const targetType = target.nodeType || target.type;
          const targetName = target.name || '';

          // Constructor: CALL → CALLS → CLASS
          if (targetType === 'CLASS') return targetName;

          // Constructor: CALL → CALLS → IMPORT_BINDING → find CLASS with same name
          if (targetType === 'IMPORT_BINDING' && classIndex.has(targetName)) {
            return targetName;
          }

          // Constructor: CALL → CALLS → METHOD(constructor) → enclosing class
          if (targetType === 'METHOD') {
            const meta = typeof target.metadata === 'string'
              ? JSON.parse(target.metadata || '{}') : target.metadata || {};
            if (meta.kind === 'constructor') {
              // Extract class name from semantic ID
              const className = extractClassName(target.semanticId || '');
              if (className && classIndex.has(className)) return className;
            }
          }
        }
      }

      // Heuristic: function name contains class name
      // getOrCreateKnowledgeBase → KnowledgeBase
      // createRFDBClient → RFDBClient
      for (const [className] of classIndex) {
        if (className.length >= 3 && callName.toLowerCase().includes(className.toLowerCase())) {
          return className;
        }
      }

      // Common factory patterns
      if (callName === 'new Map' || callName === 'Map') return 'Map';
      if (callName === 'new Set' || callName === 'Set') return 'Set';
      if (callName === 'new Date' || callName === 'Date') return 'Date';
      if (callName === 'new Error' || callName === 'Error') return 'Error';
      if (callName === 'new RegExp' || callName === 'RegExp') return 'RegExp';
      if (callName === 'new Promise' || callName === 'Promise') return 'Promise';
      if (callName === 'Buffer.from' || callName === 'Buffer.alloc') return 'Buffer';
      if (callName === 'Array.from' || callName === 'Array.of') return 'Array';

      continue;
    }

    // Rule 3: EXPRESSION — might be array/object spread
    if (sourceType === 'EXPRESSION') {
      const meta = typeof source.metadata === 'string'
        ? JSON.parse(source.metadata || '{}') : source.metadata || {};
      if (meta.expressionType === 'ArrayExpression') return 'Array';
      if (meta.expressionType === 'ObjectExpression') return 'Object';
      continue;
    }
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractClassName(semanticId) {
  const decoded = decodeURIComponent(semanticId);
  const match = decoded.match(/\[in:([^\]]+)\]/);
  return match ? match[1] : null;
}
