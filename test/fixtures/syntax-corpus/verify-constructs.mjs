#!/usr/bin/env node

/**
 * Per-Construct Graph Verification Script
 *
 * Verifies each construct's expected nodes/edges from 06-test-suite.json
 * against the REAL RFDB graph (production path, not in-memory).
 *
 * This intentionally uses the RFDB socket — the same path users get.
 * If edges are missing here but present in-memory, that's an RFDB bug to fix.
 *
 * Line ranges are computed from @construct markers in source files.
 *
 * Usage:
 *   node verify-constructs.mjs [--verbose] [--quiet] [--limit=N] [--filter=category] [--json]
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RFDBClient } from '../../../packages/rfdb/dist/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOCKET_PATH = resolve(__dirname, '.grafema/rfdb.sock');
const PARSED_PATH = resolve(__dirname, '.pipeline/00-parsed.ndjson');
const TEST_SUITE_PATH = resolve(__dirname, '.pipeline/06-test-suite.json');

// Synthetic node types that won't match test expectations
const SKIP_NODE_TYPES = new Set(['GRAPH_META']);

// Test suite → Grafema node type mapping.
// The LLM-generated test suite uses type names that differ from Grafema's taxonomy.
const TYPE_ALIASES = {
  // Methods/accessors → FUNCTION (Grafema stores all as FUNCTION with CONTAINS from CLASS)
  'METHOD':           ['FUNCTION'],
  'GETTER':           ['FUNCTION'],
  'SETTER':           ['FUNCTION'],
  // TypeScript type nodes → TYPE (Grafema uses single TYPE for all type constructs)
  'TYPE_REFERENCE':   ['TYPE'],
  'TYPE_ALIAS':       ['TYPE'],
  'CONDITIONAL_TYPE': ['TYPE'],
  'INFER_TYPE':       ['TYPE'],
  'LITERAL_TYPE':     ['TYPE', 'LITERAL'],
  'TYPE_PARAMETER':   ['TYPE_PARAMETER'],
  // const declarations → CONSTANT (Grafema splits const from let/var)
  'VARIABLE':         ['VARIABLE', 'CONSTANT'],
  // Object properties → PROPERTY_ASSIGNMENT
  'PROPERTY':         ['PROPERTY_ASSIGNMENT', 'PROPERTY_ACCESS'],
  // Enum members are stored inside ENUM.metadata.members, not as separate nodes
  'ENUM_MEMBER':      ['CONSTANT', 'PROPERTY_ASSIGNMENT'],
  // Other mappings
  'NAMESPACE':        ['MODULE'],
  'SIDE_EFFECT':      ['EXPRESSION', 'CALL'],
  'STATIC_BLOCK':     ['SCOPE'],
  'META_PROPERTY':    ['EXPRESSION', 'PROPERTY_ACCESS'],
  'LABEL':            ['SCOPE'],
  'EXTERNAL':         ['EXTERNAL_MODULE', 'MODULE'],
  'EXTERNAL_MODULE':  ['EXTERNAL_MODULE', 'MODULE'],
  // Test suite uses LITERAL for object/array literals; Grafema stores them as separate types
  'LITERAL':          ['LITERAL', 'OBJECT_LITERAL', 'ARRAY_LITERAL'],
};

// --- CLI args ---

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const quiet = args.includes('--quiet');
const jsonOutput = args.includes('--json');
const filterArg = args.find(a => a.startsWith('--filter='));
const categoryFilter = filterArg ? filterArg.split('=')[1] : null;
const limitArg = args.find(a => a.startsWith('--limit='));
const displayLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

// --- Data loading ---

/**
 * Parse source files to find real @construct boundaries.
 * Returns Map<constructId, { file, lineStart, lineEnd }>.
 */
function loadConstructRanges() {
  const parsedMap = loadParsedForFileMapping();
  const ranges = new Map();

  const byFile = new Map();
  for (const [id, entry] of parsedMap) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, []);
    byFile.get(entry.file).push(id);
  }

  for (const [file] of byFile) {
    const filePath = resolve(__dirname, file);
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const category = basename(file).replace(/\.(js|cjs|mjs|ts|tsx)$/, '');

    const markers = [];
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/\/\/\s*@construct\s+\w+\s+(\S+)/);
      if (match) {
        markers.push({ name: match[1], line: i + 1 });
      }
    }

    for (let m = 0; m < markers.length; m++) {
      const marker = markers[m];
      const nextMarkerLine = m + 1 < markers.length ? markers[m + 1].line : lines.length + 1;

      let codeStart = marker.line + 1;
      for (let i = marker.line; i < nextMarkerLine - 1 && i <= lines.length; i++) {
        if (lines[i - 1].includes('@end-annotation')) {
          codeStart = i + 1;
          break;
        }
        if (lines[i - 1].match(/\/\/\s*@annotation/)) continue;
        if (!lines[i - 1].match(/^\s*\/\//) && lines[i - 1].trim() !== '') {
          codeStart = i;
          break;
        }
      }

      let codeEnd = nextMarkerLine - 1;
      while (codeEnd > codeStart) {
        const l = lines[codeEnd - 1];
        if (l.trim() === '' || l.match(/^\s*\/\//)) codeEnd--;
        else break;
      }

      const constructId = `${category}::${marker.name}`;
      ranges.set(constructId, { file, lineStart: codeStart, lineEnd: codeEnd });
    }
  }

  return ranges;
}

function loadParsedForFileMapping() {
  const lines = readFileSync(PARSED_PATH, 'utf-8').trim().split('\n');
  const map = new Map();
  for (const line of lines) {
    const entry = JSON.parse(line);
    map.set(entry.id, entry);
  }
  return map;
}

function loadTestSuite() {
  return JSON.parse(readFileSync(TEST_SUITE_PATH, 'utf-8'));
}

// --- Node metadata parsing ---

/** RFDB returns metadata as JSON string — parse it once, cache on node. */
function parseMeta(node) {
  if (node._m) return node._m;
  let meta = node.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  node._m = meta ?? {};
  return node._m;
}

function getLine(node) {
  return node.line ?? parseMeta(node).line ?? null;
}

// --- Test ID parsing ---

function parseTestId(testId) {
  let inner = testId.slice(1, -1);

  if (inner.startsWith("'") || inner.startsWith('"') || inner.startsWith('`')) {
    return { name: inner, disambig: null };
  }

  let disambig = null;
  const disambigMatch = inner.match(/_(\d+)$/);
  if (disambigMatch) {
    const base = inner.slice(0, -disambigMatch[0].length);
    const isNumericLiteral = /^[\d][\d_]*$/.test(inner) ||
      /^0[bBxXoO]/.test(inner) ||
      /^[\d][\d_]*\.[\d_]*$/.test(inner);
    if (!isNumericLiteral && (base.includes('(') || base.includes(' ') || /[a-zA-Z]/.test(base))) {
      disambig = parseInt(disambigMatch[1], 10);
      inner = base;
    }
  }

  if (inner.startsWith('new ')) {
    inner = inner.replace(/^new\s+/, '').replace(/\(.*\)$/, '');
    return { name: inner, disambig };
  }

  inner = inner.replace(/\(.*\)$/, '');
  return { name: inner, disambig };
}

// --- Node matching ---

/**
 * Match expected nodes to actual RFDB graph nodes within line range.
 * RFDB nodes: { id (numeric), semanticId, nodeType, name, file, metadata (JSON string) }
 * Returns Map<testId, { id, semanticId } | null>.
 */
function matchNodes(expectedNodes, graphNodes, lineStart, lineEnd) {
  const results = new Map();

  const inRange = graphNodes.filter(n => {
    const line = getLine(n);
    if (line == null) return false;
    return line >= lineStart && line <= lineEnd;
  });

  const grouped = new Map();
  function addToGroup(key, node) {
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(node);
  }

  for (const node of inRange) {
    const nodeType = node.nodeType ?? node.type;
    if (SKIP_NODE_TYPES.has(nodeType)) continue;
    const name = node.name ?? '';
    addToGroup(`${nodeType}::${name}`, node);

    if (nodeType === 'PROPERTY_ACCESS') {
      const meta = parseMeta(node);
      const obj = meta.objectName ?? meta.object ?? '';
      if (obj) addToGroup(`PROPERTY_ACCESS::${obj}.${name}`, node);
    }

    if (nodeType === 'LITERAL') {
      const meta = parseMeta(node);
      const val = meta.value;
      if (val != null) {
        const strVal = String(val);
        for (const repr of new Set([strVal, `'${val}'`, `"${val}"`, `\`${val}\``])) {
          addToGroup(`LITERAL::${repr}`, node);
        }
      }
    }

    // OBJECT_LITERAL / ARRAY_LITERAL: test suite refers to them as LITERAL with literalType
    if (nodeType === 'OBJECT_LITERAL' || nodeType === 'ARRAY_LITERAL') {
      // Index by type so TYPE_ALIASES LITERAL → OBJECT_LITERAL/ARRAY_LITERAL can match
      addToGroup(`${nodeType}::`, node);
      addToGroup(`${nodeType}::${name}`, node);
    }

    if (nodeType === 'CALL') {
      const meta = parseMeta(node);
      const method = meta.method;
      if (method && method !== name) addToGroup(`CALL::${method}`, node);
    }

    // EXPRESSION nodes: index by line for positional matching
    if (nodeType === 'EXPRESSION') {
      addToGroup(`EXPRESSION::@line:${getLine(node)}`, node);
    }
  }

  for (const nodes of grouped.values()) {
    nodes.sort((a, b) => (getLine(a) ?? 0) - (getLine(b) ?? 0));
  }

  for (const expected of expectedNodes) {
    const { name, disambig } = parseTestId(expected.id);
    const match = findBestMatch(expected.type, name, disambig, grouped, inRange);
    results.set(expected.id, match ? ref(match) : null);
  }

  return results;
}

/** Try exact key, then type aliases, then fuzzy fallback. */
function findBestMatch(expectedType, name, disambig, grouped, inRange) {
  // Build list of graph types to try: original type + aliases
  const typesToTry = [expectedType, ...(TYPE_ALIASES[expectedType] ?? [])];

  for (const graphType of typesToTry) {
    const key = `${graphType}::${name}`;
    const candidates = grouped.get(key);
    if (candidates && candidates.length > 0) {
      return (disambig != null && disambig <= candidates.length)
        ? candidates[disambig - 1]
        : candidates[0];
    }
  }

  // Fuzzy fallback across all alias types
  for (const graphType of typesToTry) {
    const hit = findFuzzyMatch(graphType, name, inRange);
    if (hit) return hit;
  }

  return null;
}

function ref(node) {
  return { id: node.id, semanticId: node.semanticId };
}

function findFuzzyMatch(graphType, name, nodes) {
  for (const node of nodes) {
    const nodeType = node.nodeType ?? node.type;
    if (nodeType !== graphType) continue;
    const meta = parseMeta(node);
    const nodeName = node.name ?? '';

    if (graphType === 'CALL') {
      if (meta.method === name) return node;
      if (nodeName.endsWith('.' + name)) return node;
      // Match: test <fn(args)> → CALL node named 'fn'
      const callBase = name.replace(/\(.*$/, '');
      if (nodeName === callBase || meta.method === callBase) return node;
    }

    if (graphType === 'LITERAL') {
      const stripped = name.replace(/^['"`]|['"`]$/g, '');
      if (String(meta.value) === stripped || String(meta.value) === name) return node;
      if (nodeName === stripped || nodeName === name) return node;
    }

    // OBJECT_LITERAL / ARRAY_LITERAL: any node of this type in range is a match
    if (graphType === 'OBJECT_LITERAL' || graphType === 'ARRAY_LITERAL') {
      return node;
    }

    if (graphType === 'PROPERTY_ACCESS' && name.includes('.')) {
      const obj = meta.objectName ?? meta.object ?? '';
      if (`${obj}.${nodeName}` === name) return node;
    }

    if (graphType === 'PROPERTY_ASSIGNMENT') {
      // Test expects <obj.prop> as PROPERTY, graph has PROPERTY_ASSIGNMENT named 'prop'
      const propName = name.includes('.') ? name.split('.').pop() : name;
      if (nodeName === propName) return node;
    }

    if (graphType === 'EXPRESSION') {
      // EXPRESSION nodes are named by AST type (BinaryExpression), not source code (a * b)
      // Match if the expression's line is within the construct and name partially matches
      if (nodeName === name) return node;
    }

    if (graphType === 'FUNCTION') {
      // Test may expect <ClassName.methodName> for methods stored as FUNCTION named 'methodName'
      const methodName = name.includes('.') ? name.split('.').pop() : name;
      if (nodeName === methodName) return node;
    }

    if (graphType === 'CONSTANT') {
      // Test expects VARIABLE but graph has CONSTANT
      if (nodeName === name) return node;
    }

    if (graphType === 'MODULE') {
      // NAMESPACE/EXTERNAL → MODULE
      if (nodeName === name) return node;
    }

    if (graphType === 'TYPE') {
      // TYPE_REFERENCE/TYPE_ALIAS → TYPE
      if (nodeName === name) return node;
    }
  }
  return null;
}

// --- Edge matching ---

/**
 * Check expected edges in RFDB.
 * RFDB edges use semanticId for src/dst.
 */
async function matchEdges(expectedEdges, nodeMap, client, edgeCache) {
  const result = { walk: [], postFile: [], postProject: [] };

  for (const phase of ['walk', 'postFile', 'postProject']) {
    const edges = expectedEdges[phase] ?? [];
    for (const edge of edges) {
      const srcRef = nodeMap.get(edge.src);
      const dstRef = nodeMap.get(edge.dst);

      if (!srcRef || !dstRef) {
        result[phase].push({
          ...edge,
          status: 'unresolved',
          reason: !srcRef ? `src ${edge.src} not matched` : `dst ${edge.dst} not matched`,
        });
        continue;
      }

      try {
        if (!edgeCache.has(srcRef.id)) {
          edgeCache.set(srcRef.id, await client.getOutgoingEdges(srcRef.id));
        }
        const outgoing = edgeCache.get(srcRef.id);
        const found = outgoing.some(
          e => e.dst === dstRef.semanticId && e.edgeType === edge.type
        );
        result[phase].push({ ...edge, status: found ? 'found' : 'missing' });
      } catch {
        result[phase].push({ ...edge, status: 'error' });
      }
    }
  }

  return result;
}

// --- Main ---

async function main() {
  const constructRanges = loadConstructRanges();
  const suite = loadTestSuite();

  const client = new RFDBClient(SOCKET_PATH, 'verify-constructs');
  await client.connect();
  await client.hello(3);

  const totalNodes = await client.nodeCount();
  const edgeTypeCounts = await client.countEdgesByType();
  const totalEdgeTypes = Object.keys(edgeTypeCounts).length;

  if (!jsonOutput) {
    console.log(`RFDB graph: ${totalNodes} nodes, ${totalEdgeTypes} edge types`);
    console.log(`Construct ranges: ${constructRanges.size}`);
  }

  // Cache: file → nodes
  const fileNodeCache = new Map();
  async function getNodesForFile(file) {
    if (fileNodeCache.has(file)) return fileNodeCache.get(file);
    const nodes = await client.getAllNodes({ file });
    for (const n of nodes) parseMeta(n);
    fileNodeCache.set(file, nodes);
    return nodes;
  }

  const edgeCache = new Map();

  // Deduplicate test cases
  const seenIds = new Set();
  const allCases = categoryFilter
    ? suite.cases.filter(c => c.category === categoryFilter)
    : suite.cases;
  const cases = allCases.filter(c => {
    if (seenIds.has(c.constructId)) return false;
    seenIds.add(c.constructId);
    return true;
  });

  const stats = {
    total: cases.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    nodesMatched: 0,
    nodesTotal: 0,
    edgesFound: 0,
    edgesTotal: 0,
    edgesUnresolved: 0,
    missingByEdgeType: {},
    missingByNodeType: {},
    perConstruct: [],
  };

  let displayed = 0;

  if (!jsonOutput && !quiet) {
    console.log('\n=== PER-CONSTRUCT VERIFICATION ===\n');
  }

  for (const testCase of cases) {
    const range = constructRanges.get(testCase.constructId);
    if (!range) {
      stats.skipped++;
      if (verbose && !jsonOutput) {
        console.log(`? ${testCase.constructId}  (no @construct marker found)`);
      }
      continue;
    }

    const graphNodes = await getNodesForFile(range.file);
    const nodeMap = matchNodes(
      testCase.expectedNodes,
      graphNodes,
      range.lineStart,
      range.lineEnd
    );

    const edgeResults = await matchEdges(
      testCase.expectedEdges ?? {},
      nodeMap,
      client,
      edgeCache
    );

    const matchedNodes = [...nodeMap.values()].filter(v => v != null).length;
    const totalExpNodes = testCase.expectedNodes.length;
    stats.nodesMatched += matchedNodes;
    stats.nodesTotal += totalExpNodes;

    let edgesFound = 0;
    let edgesTotal = 0;
    let edgesUnresolved = 0;
    const missingEdges = [];
    const missingNodes = [];

    for (const phase of ['walk', 'postFile', 'postProject']) {
      for (const e of edgeResults[phase]) {
        edgesTotal++;
        if (e.status === 'found') {
          edgesFound++;
        } else if (e.status === 'unresolved') {
          edgesUnresolved++;
          missingEdges.push({ ...e, phase });
        } else {
          missingEdges.push({ ...e, phase });
          stats.missingByEdgeType[e.type] = (stats.missingByEdgeType[e.type] ?? 0) + 1;
        }
      }
    }

    stats.edgesFound += edgesFound;
    stats.edgesTotal += edgesTotal;
    stats.edgesUnresolved += edgesUnresolved;

    for (const [testId, graphId] of nodeMap) {
      if (graphId == null) {
        const expected = testCase.expectedNodes.find(n => n.id === testId);
        missingNodes.push({ testId, type: expected?.type });
        const key = expected?.type ?? 'UNKNOWN';
        stats.missingByNodeType[key] = (stats.missingByNodeType[key] ?? 0) + 1;
      }
    }

    const allNodesOk = matchedNodes === totalExpNodes;
    const allEdgesOk = edgesFound === edgesTotal;
    const passed = allNodesOk && allEdgesOk;

    if (passed) stats.passed++;
    else stats.failed++;

    stats.perConstruct.push({
      constructId: testCase.constructId,
      passed,
      nodes: { matched: matchedNodes, total: totalExpNodes },
      edges: { found: edgesFound, total: edgesTotal, unresolved: edgesUnresolved },
      missingNodes,
      missingEdges,
    });

    if (!jsonOutput && !quiet && displayed < displayLimit) {
      const mark = passed ? '\u2713' : '\u2717';
      const line = `${mark} ${testCase.constructId.padEnd(50)} nodes: ${matchedNodes}/${totalExpNodes}  edges: ${edgesFound}/${edgesTotal}`;
      if (passed) {
        if (verbose) { console.log(line); displayed++; }
      } else {
        console.log(line);
        displayed++;
        if (verbose) {
          for (const m of missingNodes) {
            console.log(`    MISSING node: ${m.type} ${m.testId}`);
          }
          for (const m of missingEdges) {
            const label = m.status === 'unresolved' ? 'UNRESOLVED' : 'MISSING';
            console.log(`    ${label} edge (${m.phase}): ${m.src} -[${m.type}]-> ${m.dst}`);
          }
        }
      }
    }
  }

  await client.close();

  if (jsonOutput) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log('\n=== SUMMARY ===\n');
  console.log(`Constructs: ${stats.passed}/${stats.total} fully verified (${pct(stats.passed, stats.total)})`);
  if (stats.skipped > 0) console.log(`Skipped: ${stats.skipped} (no @construct marker found)`);
  console.log(`Nodes: ${stats.nodesMatched}/${stats.nodesTotal} matched (${pct(stats.nodesMatched, stats.nodesTotal)})`);
  console.log(`Edges: ${stats.edgesFound}/${stats.edgesTotal} matched (${pct(stats.edgesFound, stats.edgesTotal)})`);
  if (stats.edgesUnresolved > 0) {
    console.log(`  (${stats.edgesUnresolved} edges unresolved — src/dst node not matched)`);
  }

  const sortedEdgeMissing = Object.entries(stats.missingByEdgeType).sort(([, a], [, b]) => b - a);
  if (sortedEdgeMissing.length > 0) {
    console.log(`\nMissing by edge type:`);
    for (const [type, count] of sortedEdgeMissing) {
      console.log(`  ${type}: ${count}`);
    }
  }

  const sortedNodeMissing = Object.entries(stats.missingByNodeType).sort(([, a], [, b]) => b - a);
  if (sortedNodeMissing.length > 0) {
    console.log(`\nMissing by node type:`);
    for (const [type, count] of sortedNodeMissing) {
      console.log(`  ${type}: ${count}`);
    }
  }
}

function pct(a, b) {
  if (b === 0) return '0%';
  return `${Math.round((a / b) * 100)}%`;
}

main().catch(err => {
  console.error('Fatal:', err.message ?? err);
  process.exit(1);
});
