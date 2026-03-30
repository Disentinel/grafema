#!/usr/bin/env node
/**
 * Method Call Resolver — Grafema batch plugin
 *
 * Resolves unresolved method calls (obj.method()) by matching CALL nodes
 * to METHOD definitions via name + receiver type inference.
 *
 * Strategy:
 * 1. Find all CALL nodes without CALLS edges (unresolved)
 * 2. For each, extract method name (last segment of dotted name)
 * 3. Find METHOD nodes with that name
 * 4. Unique match → create CALLS edge
 * 5. Multiple matches → disambiguate via receiver chain
 *
 * Environment:
 *   RFDB_SOCKET  — path to RFDB unix socket
 *   RFDB_DATABASE — database name
 */

import { RFDBClient } from '../packages/rfdb/dist/client.js';

const socketPath = process.env.RFDB_SOCKET;
const dbName = process.env.RFDB_DATABASE;

if (!socketPath) {
  console.error('[method-call-resolver] RFDB_SOCKET not set');
  process.exit(1);
}

const client = new RFDBClient(socketPath, 'method-call-resolver');

try {
  await client.connect();
  if (dbName) await client.openDatabase(dbName);

  // Step 1: Build method index — name → [METHOD nodes]
  console.error('[method-call-resolver] Building method index...');
  const methodIndex = new Map();
  let methodCount = 0;
  for await (const node of client.queryNodes({ type: 'METHOD' })) {
    const name = node.name;
    if (!name) continue;
    if (!methodIndex.has(name)) methodIndex.set(name, []);
    methodIndex.get(name).push({
      id: node.semanticId || String(node.id),
      name,
      file: node.file,
      line: node.line,
      className: extractClassName(node.semanticId || ''),
    });
    methodCount++;
  }
  console.error(`[method-call-resolver] ${methodCount} METHOD nodes indexed (${methodIndex.size} unique names)`);

  // Step 2: Find unresolved CALL nodes and try to resolve
  let resolved = 0;
  let skipped = 0;
  let ambiguous = 0;
  let processed = 0;
  const batchEdges = [];

  for await (const node of client.queryNodes({ type: 'CALL' })) {
    const callName = node.name;
    if (!callName) continue;

    // Only process method calls (contain a dot: obj.method, this.method)
    const dotIdx = callName.lastIndexOf('.');
    if (dotIdx === -1) continue;

    const methodName = callName.substring(dotIdx + 1);
    if (!methodName) continue;

    processed++;

    // Check if already resolved
    const nodeId = node.semanticId || String(node.id);
    const outEdges = await client.getOutgoingEdges(nodeId);
    if (outEdges.some(e => e.type === 'CALLS' || e.type === 'CALLS_REMOTE')) {
      skipped++;
      continue;
    }

    // Look up method candidates
    const candidates = methodIndex.get(methodName);
    if (!candidates || candidates.length === 0) continue;

    if (candidates.length === 1) {
      // Unique match — resolve directly
      batchEdges.push({
        src: nodeId,
        dst: candidates[0].id,
        type: 'CALLS',
        metadata: JSON.stringify({
          _source: 'method-call-resolver',
          strategy: 'unique_name',
        }),
      });
      resolved++;
    } else {
      // Multiple candidates — try disambiguation
      const receiverName = callName.substring(0, dotIdx);
      const target = await disambiguate(client, nodeId, receiverName, methodName, candidates, node.file);
      if (target) {
        batchEdges.push({
          src: nodeId,
          dst: target.id,
          type: 'CALLS',
          metadata: JSON.stringify({
            _source: 'method-call-resolver',
            strategy: target.strategy,
          }),
        });
        resolved++;
      } else {
        ambiguous++;
      }
    }
  }

  // Commit all edges in batches
  if (batchEdges.length > 0) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < batchEdges.length; i += BATCH_SIZE) {
      await client.addEdges(batchEdges.slice(i, i + BATCH_SIZE));
    }
  }

  console.error(`[method-call-resolver] Done: ${processed} method calls processed, ${resolved} resolved, ${ambiguous} ambiguous, ${skipped} already resolved`);
  await client.close();
} catch (err) {
  console.error(`[method-call-resolver] Error: ${err.message}`);
  await client.close();
  process.exit(1);
}

// ── Disambiguation ──────────────────────────────────────────────────────────

async function disambiguate(client, callId, receiverName, methodName, candidates, callFile) {
  // Strategy 1: same file preference
  const sameFile = candidates.filter(c => c.file === callFile);
  if (sameFile.length === 1) {
    return { ...sameFile[0], strategy: 'same_file' };
  }

  // Strategy 2: receiver name matches class name (e.g., kb matches KnowledgeBase → unlikely,
  // but ClassName.method() or this.method())
  if (receiverName === 'this' || receiverName === 'super') {
    // Find enclosing class from call's file
    const sameFileClasses = candidates.filter(c => c.file === callFile);
    if (sameFileClasses.length === 1) {
      return { ...sameFileClasses[0], strategy: 'this_same_file' };
    }
  }

  // Strategy 3: trace receiver variable to find type
  // Path A: CALL → READS_FROM → VARIABLE → ASSIGNED_FROM → source
  // Path B: CALL → DERIVED_FROM → PROPERTY_ACCESS → READS_FROM → VARIABLE → ASSIGNED_FROM → source
  const callEdges = await client.getOutgoingEdges(callId);
  let readsFrom = callEdges.filter(e => e.type === 'READS_FROM');

  // If no direct READS_FROM, follow DERIVED_FROM → PROPERTY_ACCESS → READS_FROM
  if (readsFrom.length === 0) {
    const derivedFrom = callEdges.filter(e => e.type === 'DERIVED_FROM');
    for (const df of derivedFrom) {
      const paNode = await client.getNode(df.dst);
      if (!paNode || paNode.nodeType !== 'PROPERTY_ACCESS') continue;
      const paId = paNode.semanticId || String(paNode.id);
      const paEdges = await client.getOutgoingEdges(paId);
      readsFrom = paEdges.filter(e => e.type === 'READS_FROM');
      if (readsFrom.length > 0) break;
    }
  }
  for (const rf of readsFrom) {
    let varNode = await client.getNode(rf.dst);
    if (!varNode) continue;

    // If READS_FROM points to REFERENCE, follow one more READS_FROM to reach the declaration
    if (varNode.nodeType === 'REFERENCE') {
      const refId = varNode.semanticId || String(varNode.id);
      const refEdges = (await client.getOutgoingEdges(refId)).filter(e => e.type === 'READS_FROM');
      if (refEdges.length > 0) {
        varNode = await client.getNode(refEdges[0].dst);
        if (!varNode) continue;
      }
    }

    // Follow ASSIGNED_FROM to find what's assigned to this variable
    const varId = varNode.semanticId || String(varNode.id);
    const assignedFrom = (await client.getOutgoingEdges(varId)).filter(e => e.type === 'ASSIGNED_FROM');
    for (const af of assignedFrom) {
      const sourceNode = await client.getNode(af.dst);
      if (!sourceNode) continue;

      // If source is a CALL that resolves to a function, check return type
      if (sourceNode.nodeType === 'CALL') {
        const sourceId = sourceNode.semanticId || String(sourceNode.id);
        const sourceCallsEdges = (await client.getOutgoingEdges(sourceId)).filter(e => e.type === 'CALLS');
        for (const sc of sourceCallsEdges) {
          const fnNode = await client.getNode(sc.dst);
          if (!fnNode) continue;

          // Check if function name hints at class (e.g., getOrCreateKnowledgeBase → KnowledgeBase)
          const fnName = fnNode.name || '';
          for (const candidate of candidates) {
            if (candidate.className && fnName.toLowerCase().includes(candidate.className.toLowerCase())) {
              return { ...candidate, strategy: 'return_type_hint' };
            }
          }

          // Check function's file for CLASS that has this METHOD
          const fnFile = fnNode.file;
          if (fnFile) {
            const sameFileMethods = candidates.filter(c => c.file === fnFile);
            if (sameFileMethods.length === 1) {
              return { ...sameFileMethods[0], strategy: 'return_file_class' };
            }
          }
        }
      }

      // If source is a constructor call (new ClassName())
      const sourceName = sourceNode.name || '';
      for (const candidate of candidates) {
        if (candidate.className && sourceName === candidate.className) {
          return { ...candidate, strategy: 'constructor' };
        }
      }
    }
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractClassName(semanticId) {
  // Extract class name from semantic ID like ...#METHOD->addNode[in:KnowledgeBase]
  // Handles both raw and URL-encoded forms (%5B = [, %5D = ])
  const decoded = decodeURIComponent(semanticId);
  const match = decoded.match(/\[in:([^\]]+)\]/);
  return match ? match[1] : null;
}
