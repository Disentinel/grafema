#!/usr/bin/env node
/**
 * Type Inference Engine — Grafema batch plugin
 *
 * Infers variable types through assignment chains and creates:
 * 1. Virtual CLASS + METHOD nodes for JS builtins (Array, String, Map, etc.)
 * 2. INSTANCE_OF edges from VARIABLE/CONSTANT to their inferred CLASS
 *
 * Runs BEFORE the in-engine method_calls.dl stdlib pack (derive), which reads
 * INSTANCE_OF for disambiguation.
 *
 * Environment:
 *   RFDB_SOCKET  — path to RFDB unix socket
 *   RFDB_DATABASE — database name
 *   GRAFEMA_DATALOG_PLUGINS — include "type-inference" to use Datalog-based impl
 */

import { RFDBClient } from '../packages/rfdb/dist/client.js';

const socketPath = process.env.RFDB_SOCKET;
const dbName = process.env.RFDB_DATABASE;

if (!socketPath) {
  console.error('[type-inference] RFDB_SOCKET not set');
  process.exit(1);
}

// ── Builtin prototypes ──────────────────────────────────────────────────────

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
  process: ['exit', 'cwd', 'env', 'argv', 'on', 'stdout', 'stderr', 'stdin', 'kill', 'pid', 'execPath'],
  Boolean: ['valueOf', 'toString'],
  EventEmitter: ['on', 'once', 'off', 'emit', 'removeListener', 'removeAllListeners', 'addListener', 'listeners'],
  Command: ['option', 'addCommand', 'action', 'argument', 'addHelpText', 'description',
    'name', 'version', 'parse', 'parseAsync', 'command', 'alias', 'usage',
    'helpOption', 'exitOverride', 'outputHelp', 'opts', 'args'],
  TreeItem: ['label', 'description', 'tooltip', 'iconPath', 'collapsibleState', 'command', 'contextValue'],
  EventEmitter2: ['fire', 'event', 'dispose'],
  vscode: ['TreeItem', 'ThemeIcon', 'Uri', 'Range', 'Position', 'Selection',
    'EventEmitter', 'TreeItemCollapsibleState', 'MarkdownString', 'Diagnostic',
    'DiagnosticSeverity', 'StatusBarAlignment', 'ViewColumn', 'CodeLens',
    'registerCommand', 'showInformationMessage', 'showWarningMessage',
    'showErrorMessage', 'createOutputChannel'],
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

// ── Global singletons ───────────────────────────────────────────────────────

const GLOBAL_SINGLETONS = new Set([
  'console', 'JSON', 'Math', 'Date', 'Array', 'Object', 'String',
  'Number', 'Boolean', 'Promise', 'Map', 'Set', 'RegExp', 'Error',
  'Buffer', 'process', 'Reflect', 'Proxy', 'Symbol',
  'vscode',
]);

// ── Return type map ─────────────────────────────────────────────────────────

const RETURN_TYPE_MAP = {
  'Object.keys': 'Array',
  'Object.values': 'Array',
  'Object.entries': 'Array',
};

// ── Main ────────────────────────────────────────────────────────────────────

const client = new RFDBClient(socketPath, 'type-inference');

try {
  await client.connect();
  // Negotiate protocol v3 so queryNodes streams in chunks. Without hello() the
  // client stays on the non-streaming path, and a single QueryNodes over a large
  // node type (e.g. ~93k CALL nodes on the Grafema dogfood graph) exceeds the
  // client's fixed 60s request timeout — the plugin then exits 1 every run.
  await client.hello();
  if (dbName) await client.openDatabase(dbName);

  // Phase 1: Create builtin CLASS + METHOD nodes (same in both paths)
  const builtinClassIds = await createBuiltinNodes(client);
  console.error(`[type-inference] ${builtinClassIds.size} builtin classes created`);

  const useDatalog = (process.env.GRAFEMA_DATALOG_PLUGINS ?? '').split(',').includes('type-inference');
  if (useDatalog) {
    await typeInferenceDatalog(client);
  } else {
    await typeInferenceLegacy(client);
  }

  // Publish staged writes: under MVCC (visibility=publish) addNodes/addEdges are
  // not visible to other connections — or durable — until a flush. Without this,
  // every INSTANCE_OF edge created above is silently dropped when the process exits.
  await client.flush();
  await client.close();
} catch (err) {
  console.error(`[type-inference] Error: ${err.message}`);
  await client.close();
  process.exit(1);
}

// ── Datalog implementation ────────────────────────────────────────────────────

/**
 * Datalog-based type inference.
 *
 * Replaces ~1.27M IPC calls with 8 Datalog queries:
 *   Q1  early-exit gate (VARIABLE/CONSTANT without INSTANCE_OF)
 *   Q2  infer from LITERAL assignment
 *   Q3  infer via constructor CALL → CLASS
 *   Q4  infer via CALL → IMPORT_BINDING (class index hit)
 *   Q4b factory-call JS fallback (RETURN_TYPE_MAP + suffix heuristic)
 *   Q5  TypeScript annotation-based INSTANCE_OF for PARAMETERs
 *   Q6  global singleton CALLS resolution (Q6a + Q6b combined)
 *   Q7  parameter type propagation via RECEIVES_ARGUMENT
 */
async function typeInferenceDatalog(client) {
  const BATCH = 500;

  // Build CLASS index (name → numericId) — needed for JS edge construction
  const classIndex = new Map();
  for await (const n of client.queryNodes({ type: 'CLASS' })) {
    if (n.name) classIndex.set(n.name, String(n.id));
  }
  console.error(`[type-inference/datalog] ${classIndex.size} classes indexed`);

  // Shared needs_inference auxiliary rules (inlined into each query program)
  const NEEDS_INFERENCE_RULES =
    'needs_inference(V) :- node(V, "CONSTANT"), \\+ edge(V, _, "INSTANCE_OF").\n' +
    'needs_inference(V) :- node(V, "VARIABLE"), \\+ edge(V, _, "INSTANCE_OF").\n';

  // Q1 — early-exit gate
  const needsProbe = await client.executeDatalog(NEEDS_INFERENCE_RULES);
  if (!needsProbe || needsProbe.length === 0) {
    console.error('[type-inference/datalog] No variables need type inference — skipping Phases 3-4');
  } else {
    console.error(`[type-inference/datalog] ${needsProbe.length} variables need type inference`);
  }

  const phase3Edges = [];
  const inferredVars = new Set(); // first-wins: prevent double-typing a variable
  let instanceOfCreated = 0;

  // Q2 — infer type from LITERAL assignment
  const literalRows = await client.executeDatalog(
    'infer_literal(V, LitName) :- needs_inference(V), edge(V, L, "ASSIGNED_FROM"), node(L, "LITERAL"), attr(L, "name", LitName).\n' +
    NEEDS_INFERENCE_RULES
  );
  for (const row of literalRows) {
    const varId = row.bindings['V'];
    const litName = row.bindings['LitName'];
    if (!varId || litName === undefined || inferredVars.has(varId)) continue;
    const className = inferLiteralType(litName);
    if (!className) continue;
    const classId = classIndex.get(className);
    if (!classId) continue;
    phase3Edges.push({ src: varId, dst: classId, type: 'INSTANCE_OF',
      metadata: JSON.stringify({ _source: 'type-inference', inferredType: className }) });
    inferredVars.add(varId);
    instanceOfCreated++;
  }

  // Q3 — infer via constructor CALL → CLASS
  const ctorRows = await client.executeDatalog(
    'infer_constructor(V, ClassName) :- needs_inference(V), edge(V, C, "ASSIGNED_FROM"), node(C, "CALL"), edge(C, Cls, "CALLS"), node(Cls, "CLASS"), attr(Cls, "name", ClassName).\n' +
    NEEDS_INFERENCE_RULES
  );
  for (const row of ctorRows) {
    const varId = row.bindings['V'];
    const className = row.bindings['ClassName'];
    if (!varId || !className || inferredVars.has(varId)) continue;
    const classId = classIndex.get(className);
    if (!classId) continue;
    phase3Edges.push({ src: varId, dst: classId, type: 'INSTANCE_OF',
      metadata: JSON.stringify({ _source: 'type-inference', inferredType: className }) });
    inferredVars.add(varId);
    instanceOfCreated++;
  }

  // Q4 — infer via IMPORT_BINDING (CALL resolves to an imported class)
  const importRows = await client.executeDatalog(
    'infer_import_ctor(V, BndName) :- needs_inference(V), edge(V, C, "ASSIGNED_FROM"), node(C, "CALL"), edge(C, B, "CALLS"), node(B, "IMPORT_BINDING"), attr(B, "name", BndName).\n' +
    NEEDS_INFERENCE_RULES
  );
  for (const row of importRows) {
    const varId = row.bindings['V'];
    const bndName = row.bindings['BndName'];
    if (!varId || !bndName || inferredVars.has(varId)) continue;
    if (!classIndex.has(bndName)) continue;
    const classId = classIndex.get(bndName);
    phase3Edges.push({ src: varId, dst: classId, type: 'INSTANCE_OF',
      metadata: JSON.stringify({ _source: 'type-inference', inferredType: bndName }) });
    inferredVars.add(varId);
    instanceOfCreated++;
  }

  // Q4b — factory call JS fallback (RETURN_TYPE_MAP + common patterns + suffix heuristic)
  // Gets all (V, CallName) pairs where V needs inference and is assigned from a CALL.
  const factoryRows = await client.executeDatalog(
    'factory_call(V, CallName) :- needs_inference(V), edge(V, C, "ASSIGNED_FROM"), node(C, "CALL"), attr(C, "name", CallName).\n' +
    NEEDS_INFERENCE_RULES
  );
  for (const row of factoryRows) {
    const varId = row.bindings['V'];
    const callName = row.bindings['CallName'];
    if (!varId || !callName || inferredVars.has(varId)) continue;
    const className = inferCallType(callName, classIndex);
    if (!className) continue;
    const classId = classIndex.get(className);
    if (!classId) continue;
    phase3Edges.push({ src: varId, dst: classId, type: 'INSTANCE_OF',
      metadata: JSON.stringify({ _source: 'type-inference', inferredType: className }) });
    inferredVars.add(varId);
    instanceOfCreated++;
  }

  // Flush Phase 3 edges before subsequent queries
  for (let i = 0; i < phase3Edges.length; i += BATCH) {
    await client.addEdges(phase3Edges.slice(i, i + BATCH));
  }
  console.error(`[type-inference/datalog] Phase 3: ${instanceOfCreated} INSTANCE_OF edges created`);

  // Q5 — TypeScript annotation-based INSTANCE_OF for PARAMETERs
  // attr() reads metadata JSON fields, so "typeAnnotation" resolves from stored metadata
  const annoRows = await client.executeDatalog(
    'infer_annotation(P, TypeAnno) :- node(P, "PARAMETER"), \\+ edge(P, _, "INSTANCE_OF"), attr(P, "typeAnnotation", TypeAnno).\n'
  );
  const annotationEdges = [];
  let annotationTyped = 0;
  for (const row of annoRows) {
    const paramId = row.bindings['P'];
    const typeAnno = row.bindings['TypeAnno'];
    if (!paramId || !typeAnno) continue;
    const classId = classIndex.get(typeAnno);
    if (!classId) continue;
    annotationEdges.push({ src: paramId, dst: classId, type: 'INSTANCE_OF',
      metadata: JSON.stringify({ _source: 'type-inference', strategy: 'ts_annotation', confidence: 'medium' }) });
    annotationTyped++;
  }
  for (let i = 0; i < annotationEdges.length; i += BATCH) {
    await client.addEdges(annotationEdges.slice(i, i + BATCH));
  }
  console.error(`[type-inference/datalog] Phase 3b: ${annotationTyped} parameters typed via TS annotations`);

  // Q6 — Global singleton CALLS resolution
  // Q6a: CALL nodes without CALLS edges (need singleton resolution)
  const callSingletonRows = await client.executeDatalog(
    'call_needs_singleton(C, CallName) :- node(C, "CALL"), \\+ edge(C, _, "CALLS"), attr(C, "name", CallName).\n'
  );
  // Q6b: builtin METHOD nodes (ClassName, MethodName, MethodId)
  const builtinMethodRows = await client.executeDatalog(
    'builtin_method(ClassName, MethodName, MethodId) :- node(ClassId, "CLASS"), attr(ClassId, "file", "<builtin>"), attr(ClassId, "name", ClassName), edge(ClassId, MethodId, "HAS_METHOD"), attr(MethodId, "name", MethodName).\n'
  );

  // Build (className::methodName) → methodId map (dedup: first wins per pair)
  const builtinMethodMap = new Map();
  for (const row of builtinMethodRows) {
    const className = row.bindings['ClassName'];
    const methodName = row.bindings['MethodName'];
    const methodId = row.bindings['MethodId'];
    if (!className || !methodName || !methodId) continue;
    const key = `${className}::${methodName}`;
    if (!builtinMethodMap.has(key)) builtinMethodMap.set(key, methodId);
  }

  const singletonEdges = [];
  let singletonResolved = 0;
  for (const row of callSingletonRows) {
    const callId = row.bindings['C'];
    const callName = row.bindings['CallName'];
    if (!callId || !callName) continue;
    const dotIdx = callName.indexOf('.');
    if (dotIdx === -1) continue;
    const receiver = callName.substring(0, dotIdx);
    if (!GLOBAL_SINGLETONS.has(receiver)) continue;
    const methodName = callName.substring(dotIdx + 1);
    const methodId = builtinMethodMap.get(`${receiver}::${methodName}`);
    if (!methodId) continue;
    singletonEdges.push({ src: callId, dst: methodId, type: 'CALLS',
      metadata: JSON.stringify({ _source: 'type-inference', strategy: 'global_singleton' }) });
    singletonResolved++;
  }
  for (let i = 0; i < singletonEdges.length; i += BATCH) {
    await client.addEdges(singletonEdges.slice(i, i + BATCH));
  }
  console.error(`[type-inference/datalog] Phase 4: ${singletonResolved} global singleton calls resolved`);

  // Q7 — Parameter type propagation
  // Two path variants combined under single head (executeDatalog queries first rule head)
  const paramRows = await client.executeDatalog(
    // Path A: CALL argument is a direct node with INSTANCE_OF
    'param_typed(P, ClassId) :- node(P, "PARAMETER"), \\+ edge(P, _, "INSTANCE_OF"), ' +
      'edge(P, C, "RECEIVES_ARGUMENT"), edge(C, Arg, "PASSES_ARGUMENT"), ' +
      'edge(Arg, Decl, "READS_FROM"), edge(Decl, ClassId, "INSTANCE_OF").\n' +
    // Path B: CALL argument is a REFERENCE → follow READS_FROM to decl
    'param_typed(P, ClassId) :- node(P, "PARAMETER"), \\+ edge(P, _, "INSTANCE_OF"), ' +
      'edge(P, C, "RECEIVES_ARGUMENT"), edge(C, Ref, "PASSES_ARGUMENT"), ' +
      'node(Ref, "REFERENCE"), edge(Ref, Decl, "READS_FROM"), edge(Decl, ClassId, "INSTANCE_OF").\n'
  );

  const paramEdges = [];
  const paramTypedSet = new Set(); // one type per param
  let paramTyped = 0;
  for (const row of paramRows) {
    const paramId = row.bindings['P'];
    const classId = row.bindings['ClassId'];
    if (!paramId || !classId || paramTypedSet.has(paramId)) continue;
    paramEdges.push({ src: paramId, dst: classId, type: 'INSTANCE_OF',
      metadata: JSON.stringify({ _source: 'type-inference', strategy: 'param_propagation' }) });
    paramTypedSet.add(paramId);
    paramTyped++;
  }
  for (let i = 0; i < paramEdges.length; i += BATCH) {
    await client.addEdges(paramEdges.slice(i, i + BATCH));
  }
  console.error(`[type-inference/datalog] Phase 5: ${paramTyped} parameter types propagated`);

  console.error(`[type-inference/datalog] Done: ${instanceOfCreated + annotationTyped + paramTyped} INSTANCE_OF + ${singletonResolved} singleton CALLS`);
}

// ── Legacy implementation ─────────────────────────────────────────────────────

async function typeInferenceLegacy(client) {
  // Phase 2: Build CLASS index (name → numericId)
  const classIndex = new Map();
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
      const varId = String(node.id);

      const existing = await client.getOutgoingEdges(varId);
      if (existing.some(e => e.type === 'INSTANCE_OF')) continue;

      const result = await inferType(client, varId, classIndex);
      if (!result) continue;

      const classId = classIndex.get(result.type);
      if (!classId) continue;

      edges.push({
        src: varId,
        dst: classId,
        type: 'INSTANCE_OF',
        metadata: JSON.stringify({ _source: 'type-inference', inferredType: result.type }),
      });
      instanceOfCreated++;
    }
  }

  const BATCH = 500;
  for (let i = 0; i < edges.length; i += BATCH) {
    await client.addEdges(edges.slice(i, i + BATCH));
  }
  console.error(`[type-inference] Phase 3: ${processed} variables processed, ${instanceOfCreated} INSTANCE_OF edges created`);

  // Phase 3b: TypeScript annotation-based INSTANCE_OF for PARAMETERs
  let annotationTyped = 0;
  const annotationEdges = [];

  for await (const param of client.queryNodes({ type: 'PARAMETER' })) {
    const paramId = String(param.id);

    const paramOut = await client.getOutgoingEdges(paramId);
    if (paramOut.some(e => e.type === 'INSTANCE_OF')) continue;

    const meta = typeof param.metadata === 'string' ? JSON.parse(param.metadata || '{}') : param.metadata || {};
    const typeAnno = meta.typeAnnotation;
    if (!typeAnno) continue;

    const targetClassId = classIndex.get(typeAnno);
    if (!targetClassId) continue;

    annotationEdges.push({
      src: paramId,
      dst: targetClassId,
      type: 'INSTANCE_OF',
      metadata: JSON.stringify({ _source: 'type-inference', strategy: 'ts_annotation', confidence: 'medium' }),
    });
    annotationTyped++;
  }

  for (let i = 0; i < annotationEdges.length; i += BATCH) {
    await client.addEdges(annotationEdges.slice(i, i + BATCH));
  }
  console.error(`[type-inference] Phase 3b: ${annotationTyped} parameters typed via TS annotations`);

  // Phase 4: Global singleton direct resolution
  let singletonResolved = 0;
  const singletonEdges = [];

  for await (const node of client.queryNodes({ type: 'CALL' })) {
    const callName = node.name || '';
    const dotIdx = callName.indexOf('.');
    if (dotIdx === -1) continue;

    const receiver = callName.substring(0, dotIdx);
    if (!GLOBAL_SINGLETONS.has(receiver)) continue;

    const callId = String(node.id);
    const out = await client.getOutgoingEdges(callId);
    if (out.some(e => e.type === 'CALLS')) continue;

    const methodName = callName.substring(dotIdx + 1);
    const targetClassId = classIndex.get(receiver);
    if (!targetClassId) continue;

    const classOut = await client.getOutgoingEdges(targetClassId);
    const hasMethod = classOut.filter(e => e.type === 'HAS_METHOD');
    for (const hm of hasMethod) {
      const methodNode = await client.getNode(hm.dst);
      if (methodNode && methodNode.name === methodName) {
        singletonEdges.push({
          src: callId,
          dst: String(methodNode.id),
          type: 'CALLS',
          metadata: JSON.stringify({ _source: 'type-inference', strategy: 'global_singleton' }),
        });
        singletonResolved++;
        break;
      }
    }
  }

  for (let i = 0; i < singletonEdges.length; i += BATCH) {
    await client.addEdges(singletonEdges.slice(i, i + BATCH));
  }
  console.error(`[type-inference] Phase 4: ${singletonResolved} global singleton calls resolved`);

  // Phase 5: Parameter type propagation
  let paramTyped = 0;
  const paramEdges = [];

  for await (const param of client.queryNodes({ type: 'PARAMETER' })) {
    const paramId = String(param.id);

    const paramOut = await client.getOutgoingEdges(paramId);
    if (paramOut.some(e => e.type === 'INSTANCE_OF')) continue;

    const recvArgs = paramOut.filter(e => e.type === 'RECEIVES_ARGUMENT');
    for (const ra of recvArgs) {
      const callNode = await client.getNode(ra.dst);
      if (!callNode) continue;

      const callOut = await client.getOutgoingEdges(String(callNode.id));
      const passArgs = callOut.filter(e => e.type === 'PASSES_ARGUMENT');
      for (const pa of passArgs) {
        const argNode = await client.getNode(pa.dst);
        if (!argNode) continue;

        let declNode = argNode;
        if (argNode.nodeType === 'REFERENCE') {
          const refOut = await client.getOutgoingEdges(String(argNode.id));
          const rf = refOut.find(e => e.type === 'READS_FROM');
          if (rf) declNode = await client.getNode(rf.dst);
          if (!declNode) continue;
        }

        const declOut = await client.getOutgoingEdges(String(declNode.id));
        const instanceOf = declOut.find(e => e.type === 'INSTANCE_OF');
        if (instanceOf) {
          paramEdges.push({
            src: paramId,
            dst: instanceOf.dst,
            type: 'INSTANCE_OF',
            metadata: JSON.stringify({ _source: 'type-inference', strategy: 'param_propagation' }),
          });
          paramTyped++;
          break;
        }
      }
      if (paramEdges.length > paramTyped - 1) break;
    }
  }

  for (let i = 0; i < paramEdges.length; i += BATCH) {
    await client.addEdges(paramEdges.slice(i, i + BATCH));
  }
  console.error(`[type-inference] Phase 5: ${paramTyped} parameter types propagated`);

  console.error(`[type-inference] Done: ${instanceOfCreated + paramTyped} INSTANCE_OF + ${singletonResolved} singleton CALLS`);
}

// ── Create builtin nodes ────────────────────────────────────────────────────

async function createBuiltinNodes(client) {
  const classIds = new Map();
  const nodes = [];
  const edgesBatch = [];

  for (const [className, methods] of Object.entries(BUILTINS)) {
    let classNodeId = null;
    for await (const n of client.queryNodes({ type: 'CLASS', name: className })) {
      if (n.file === '<builtin>') {
        classNodeId = String(n.id);
        break;
      }
    }

    if (!classNodeId) {
      await client.addNodes([{
        id: `builtin::${className}`,
        type: 'CLASS',
        name: className,
        file: '<builtin>',
        exported: true,
        metadata: JSON.stringify({ _source: 'type-inference', builtin: true }),
      }]);
      for await (const n of client.queryNodes({ type: 'CLASS', name: className })) {
        if (n.file === '<builtin>') {
          classNodeId = String(n.id);
          break;
        }
      }
    }

    if (!classNodeId) continue;
    classIds.set(className, classNodeId);

    for (const methodName of methods) {
      let exists = false;
      for await (const n of client.queryNodes({ type: 'METHOD', name: methodName })) {
        if (n.file === '<builtin>') {
          const meta = typeof n.metadata === 'string' ? JSON.parse(n.metadata || '{}') : {};
          if (meta.parentClass === className) { exists = true; break; }
        }
      }
      if (exists) continue;

      await client.addNodes([{
        id: `builtin::${className}::${methodName}`,
        type: 'METHOD',
        name: methodName,
        file: '<builtin>',
        exported: true,
        metadata: JSON.stringify({
          _source: 'type-inference', builtin: true, kind: 'method',
          parentClass: className,
        }),
      }]);

      let methodNumId = null;
      for await (const n of client.queryNodes({ type: 'METHOD', name: methodName })) {
        if (n.file === '<builtin>') {
          const meta = typeof n.metadata === 'string' ? JSON.parse(n.metadata || '{}') : {};
          if (meta.parentClass === className) { methodNumId = String(n.id); break; }
        }
      }
      if (methodNumId) {
        edgesBatch.push({
          src: classNodeId,
          dst: methodNumId,
          type: 'HAS_METHOD',
          metadata: JSON.stringify({ _source: 'type-inference' }),
        });
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

// ── Type inference rules (legacy path) ─────────────────────────────────────

async function inferType(client, varId, classIndex) {
  const outEdges = await client.getOutgoingEdges(varId);
  const assignedFrom = outEdges.filter(e => e.type === 'ASSIGNED_FROM');
  if (assignedFrom.length === 0) return null;

  for (const edge of assignedFrom) {
    const source = await client.getNode(edge.dst);
    if (!source) continue;
    const sourceType = source.nodeType || source.type;

    if (sourceType === 'LITERAL') {
      const litType = LITERAL_TYPE_MAP[source.name];
      if (litType) return { type: litType };
      if (source.name && source.name.startsWith("'") || source.name?.startsWith('"')) return { type: 'String' };
      if (source.name && /^\d/.test(source.name)) return { type: 'Number' };
      continue;
    }

    if (sourceType === 'CALL') {
      const callId = String(source.id);
      const callName = source.name || '';
      const callEdges = await client.getOutgoingEdges(callId);
      const callsEdge = callEdges.find(e => e.type === 'CALLS');

      if (callsEdge) {
        const target = await client.getNode(callsEdge.dst);
        if (target) {
          const targetType = target.nodeType || target.type;
          const targetName = target.name || '';
          if (targetType === 'CLASS') return { type: targetName };
          if (targetType === 'IMPORT_BINDING' && classIndex.has(targetName)) return { type: targetName };
          if (targetType === 'METHOD') {
            const meta = typeof target.metadata === 'string'
              ? JSON.parse(target.metadata || '{}') : target.metadata || {};
            if (meta.kind === 'constructor') {
              const className = extractClassName(target.semanticId || '');
              if (className && classIndex.has(className)) return { type: className };
            }
          }
        }
      }

      const result = inferCallType(callName, classIndex);
      if (result) return { type: result };
      continue;
    }

    if (sourceType === 'EXPRESSION') {
      const meta = typeof source.metadata === 'string'
        ? JSON.parse(source.metadata || '{}') : source.metadata || {};
      if (meta.expressionType === 'ArrayExpression') return { type: 'Array' };
      if (meta.expressionType === 'ObjectExpression') return { type: 'Object' };
      continue;
    }
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Infer type from a LITERAL node's name.
 * Handles LITERAL_TYPE_MAP entries plus string/number detection.
 */
function inferLiteralType(litName) {
  if (LITERAL_TYPE_MAP[litName]) return LITERAL_TYPE_MAP[litName];
  if (litName && (litName.startsWith("'") || litName.startsWith('"'))) return 'String';
  if (litName && /^\d/.test(litName)) return 'Number';
  return null;
}

/**
 * Infer type from a CALL node's name using static maps and factory heuristics.
 * Used as the JS fallback after Datalog Q2-Q4 (factory-suffix directive).
 */
function inferCallType(callName, classIndex) {
  const returnType = RETURN_TYPE_MAP[callName];
  if (returnType) return returnType;

  if (callName === 'new Map' || callName === 'Map') return 'Map';
  if (callName === 'new Set' || callName === 'Set') return 'Set';
  if (callName === 'new Date' || callName === 'Date') return 'Date';
  if (callName === 'new Error' || callName === 'Error') return 'Error';
  if (callName === 'new RegExp' || callName === 'RegExp') return 'RegExp';
  if (callName === 'new Promise' || callName === 'Promise') return 'Promise';
  if (callName === 'Buffer.from' || callName === 'Buffer.alloc') return 'Buffer';
  if (callName === 'Array.from' || callName === 'Array.of') return 'Array';

  // Factory suffix heuristic: createRFDBClient → RFDBClient, getOrCreateKnowledgeBase → KnowledgeBase
  if (!callName.includes('.')) {
    const callLower = callName.toLowerCase();
    for (const [className] of classIndex) {
      if (className.length >= 3) {
        const classLower = className.toLowerCase();
        if (callLower.endsWith(classLower) && callLower.length > classLower.length) {
          return className;
        }
      }
    }
  }

  return null;
}

function extractClassName(semanticId) {
  const decoded = decodeURIComponent(semanticId);
  const match = decoded.match(/\[in:([^\]]+)\]/);
  return match ? match[1] : null;
}
