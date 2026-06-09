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

  // Early-exit gate: skip if there are no unresolved CALL nodes.
  // One Datalog round-trip beats walking the whole CALL set via N+1 IPC.
  const unresolvedProbe = await client.executeDatalog(
    'violation(C) :- node(C, "CALL"), \\+ edge(C, _, "CALLS").'
  );
  if (!unresolvedProbe || unresolvedProbe.length === 0) {
    console.error('[method-call-resolver] No unresolved CALL nodes — skipping');
    await client.close();
    process.exit(0);
  }
  console.error(`[method-call-resolver] ${unresolvedProbe.length} unresolved CALL nodes`);

  // Step 1: Build method index — name → [METHOD nodes]
  console.error('[method-call-resolver] Building method index...');
  const methodIndex = new Map();
  let methodCount = 0;
  for await (const node of client.queryNodes({ type: 'METHOD' })) {
    const name = node.name;
    if (!name) continue;
    if (!methodIndex.has(name)) methodIndex.set(name, []);
    let className = extractClassName(node.semanticId || '');
    // Fallback: find parent CLASS via incoming HAS_METHOD edge
    if (!className) {
      const nodeId = String(node.id);
      const incoming = await client.getIncomingEdges(nodeId);
      const hasMethod = incoming.find(e => e.type === 'HAS_METHOD');
      if (hasMethod) {
        const parentClass = await client.getNode(hasMethod.src);
        if (parentClass) className = parentClass.name || null;
      }
    }
    methodIndex.get(name).push({
      id: String(node.id), // numeric ID required for addEdges
      name,
      file: node.file,
      line: node.line,
      className,
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
    const nodeId = String(node.id);
    const numericId = String(node.id); // for addEdges (requires numeric)
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
        src: numericId,
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
          src: numericId,
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
  // Strategy 0 (highest priority): INSTANCE_OF type resolution
  // Trace receiver → variable → INSTANCE_OF → CLASS → HAS_METHOD → match
  const instanceOfType = await resolveReceiverType(client, callId);
  if (instanceOfType) {
    const match = candidates.find(c => c.className === instanceOfType);
    if (match) return { ...match, strategy: 'instance_of' };
  }

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
  // Path B: CALL → DERIVES_FROM → PROPERTY_ACCESS → READS_FROM → VARIABLE → ASSIGNED_FROM → source
  const callEdges = await client.getOutgoingEdges(callId);
  let readsFrom = callEdges.filter(e => e.type === 'READS_FROM');

  // If no direct READS_FROM, follow DERIVES_FROM → PROPERTY_ACCESS → READS_FROM
  if (readsFrom.length === 0) {
    const derivedFrom = callEdges.filter(e => e.type === 'DERIVES_FROM');
    for (const df of derivedFrom) {
      const paNode = await client.getNode(df.dst);
      if (!paNode || paNode.nodeType !== 'PROPERTY_ACCESS') continue;
      const paId = String(paNode.id);
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
      const refId = String(varNode.id);
      const refEdges = (await client.getOutgoingEdges(refId)).filter(e => e.type === 'READS_FROM');
      if (refEdges.length > 0) {
        varNode = await client.getNode(refEdges[0].dst);
        if (!varNode) continue;
      }
    }

    // Follow ASSIGNED_FROM to find what's assigned to this variable
    const varId = String(varNode.id);
    const assignedFrom = (await client.getOutgoingEdges(varId)).filter(e => e.type === 'ASSIGNED_FROM');
    for (const af of assignedFrom) {
      const sourceNode = await client.getNode(af.dst);
      if (!sourceNode) continue;

      // If source is a CALL that resolves to a function, check return type
      if (sourceNode.nodeType === 'CALL') {
        const sourceId = String(sourceNode.id);
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

// ── INSTANCE_OF-based type resolution ────────────────────────────────────────

async function resolveReceiverType(client, callId) {
  // Path: CALL → DERIVES_FROM → PROPERTY_ACCESS → READS_FROM → REF → READS_FROM → VARIABLE → INSTANCE_OF → CLASS
  const callEdges = await client.getOutgoingEdges(callId);

  // Try direct READS_FROM first
  let readsFrom = callEdges.filter(e => e.type === 'READS_FROM');

  // If not, follow DERIVES_FROM → PROPERTY_ACCESS → READS_FROM
  if (readsFrom.length === 0) {
    for (const df of callEdges.filter(e => e.type === 'DERIVES_FROM')) {
      const paNode = await client.getNode(df.dst);
      if (!paNode || (paNode.nodeType !== 'PROPERTY_ACCESS' && paNode.nodeType !== 'REFERENCE')) continue;
      const paId = String(paNode.id);
      readsFrom = (await client.getOutgoingEdges(paId)).filter(e => e.type === 'READS_FROM');
      if (readsFrom.length > 0) break;
    }
  }

  // Follow READS_FROM chain to find VARIABLE with INSTANCE_OF
  for (const rf of readsFrom) {
    let node = await client.getNode(rf.dst);
    if (!node) continue;

    // If REFERENCE, follow one more READS_FROM
    if (node.nodeType === 'REFERENCE') {
      const refId = String(node.id);
      const refEdges = (await client.getOutgoingEdges(refId)).filter(e => e.type === 'READS_FROM');
      if (refEdges.length > 0) node = await client.getNode(refEdges[0].dst);
      if (!node) continue;
    }

    // Check for INSTANCE_OF edge
    const varId = String(node.id);
    const varEdges = await client.getOutgoingEdges(varId);
    const instanceOf = varEdges.find(e => e.type === 'INSTANCE_OF');
    if (instanceOf) {
      const classNode = await client.getNode(instanceOf.dst);
      if (classNode) return classNode.name;
    }
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractClassName(semanticId) {
  // Extract class name from semantic ID
  // Format 1: ...#METHOD->addNode[in:KnowledgeBase] (URL-encoded: %5Bin:...%5D)
  // Format 2: METHOD:push@<builtin> (builtin nodes)
  const decoded = decodeURIComponent(semanticId);
  const match = decoded.match(/\[in:([^\]]+)\]/);
  if (match) return match[1];

  // Builtin format: CLASS:Array@<builtin> or METHOD:push[in:Array]@<builtin>
  const builtinMatch = decoded.match(/\[in:([^\]]+)\]@/);
  if (builtinMatch) return builtinMatch[1];

  // Fallback: use HAS_METHOD edge to find parent class (done at index time)
  return null;
}
