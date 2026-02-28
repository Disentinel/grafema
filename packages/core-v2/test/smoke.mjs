/**
 * Smoke test: full 3-stage pipeline on syntax-corpus.
 * Compares v2 output against lang-spec baseline (64 edge types, 40 node types).
 */
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { createRequire } from 'module';
import { walkFile } from '../dist/walk.js';
import { jsRegistry } from '../dist/registry.js';
import { resolveFileRefs, resolveProject } from '../dist/resolve.js';
import { loadBuiltinRegistry } from '@grafema/lang-defs';

const require = createRequire(import.meta.url);
const esDefs = require('@grafema/lang-defs/defs/ecmascript/es2022.json');
const builtins = loadBuiltinRegistry([esDefs]);

const corpusDir = resolve(import.meta.dirname, '../../../test/fixtures/syntax-corpus/src');
const files = readdirSync(corpusDir).filter(f => f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.cjs'));

// ─── Lang-spec baseline: all 64 edge types with assertion counts ────

const LANG_SPEC_EDGES = {
  // Structural (walk engine / edge-map)
  CONTAINS: 0, HAS_BODY: 0, HAS_CONDITION: 0, HAS_CONSEQUENT: 0, HAS_ALTERNATE: 0,
  HAS_INIT: 0, HAS_UPDATE: 0, HAS_CASE: 0, HAS_CATCH: 0, HAS_FINALLY: 0,
  HAS_PROPERTY: 0, HAS_ELEMENT: 0, HAS_DEFAULT: 0,
  // Scope / data flow
  ASSIGNED_FROM: 0, WRITES_TO: 0, READS_FROM: 0, MODIFIES: 0, FLOWS_INTO: 0,
  CAPTURES: 0, SHADOWS: 0, DELETES: 0,
  // Module system
  IMPORTS: 0, IMPORTS_FROM: 0, EXPORTS: 0, DEPENDS_ON: 0,
  // Call flow
  CALLS: 0, CALLS_ON: 0, PASSES_ARGUMENT: 0, RECEIVES_ARGUMENT: 0,
  RETURNS: 0, THROWS: 0, YIELDS: 0, AWAITS: 0,
  CHAINS_FROM: 0, BINDS_THIS_TO: 0, INVOKES: 0, DELEGATES_TO: 0,
  // Iteration / Collection
  ITERATES_OVER: 0, SPREADS_FROM: 0, ELEMENT_OF: 0, KEY_OF: 0,
  // Control flow
  USES: 0, DECLARES: 0, HAS_SCOPE: 0, RESOLVES_TO: 0, CATCHES_FROM: 0,
  // Class / OOP
  EXTENDS: 0, IMPLEMENTS: 0, DECORATED_BY: 0, OVERRIDES: 0,
  ACCESSES_PRIVATE: 0, LISTENS_TO: 0, MERGES_WITH: 0,
  // TypeScript
  HAS_TYPE: 0, HAS_TYPE_PARAMETER: 0, RETURNS_TYPE: 0, DEFAULTS_TO: 0,
  CONSTRAINED_BY: 0, UNION_MEMBER: 0, INTERSECTS_WITH: 0,
  INFERS: 0, ALIASES: 0,
  // Misc
  IMPLEMENTS_OVERLOAD: 0, HAS_OVERLOAD: 0, EXTENDS_SCOPE_WITH: 0,
};

// Assertion counts from baseline (how important each edge type is)
const ASSERTION_COUNTS = {
  WRITES_TO: 125, HAS_TYPE: 113, HAS_ELEMENT: 92, CALLS_ON: 73,
  AWAITS: 34, EXTENDS: 32, CHAINS_FROM: 27, DEFAULTS_TO: 27, RETURNS_TYPE: 27,
  HAS_TYPE_PARAMETER: 26, ALIASES: 25, SPREADS_FROM: 18, UNION_MEMBER: 17,
  CONSTRAINED_BY: 13, HAS_CASE: 13, HAS_FINALLY: 12, INFERS: 11,
  INTERSECTS_WITH: 10, DECORATED_BY: 7, SHADOWS: 7, BINDS_THIS_TO: 6,
  DELETES: 6, INVOKES: 6, ACCESSES_PRIVATE: 5, IMPLEMENTS: 5,
  IMPLEMENTS_OVERLOAD: 5, EXTENDS_SCOPE_WITH: 4, HAS_DEFAULT: 4,
  LISTENS_TO: 4, MERGES_WITH: 4, HAS_OVERLOAD: 2, OVERRIDES: 1,
};

// 40 expected node types
const LANG_SPEC_NODES = new Set([
  'MODULE', 'FUNCTION', 'VARIABLE', 'CONSTANT', 'PARAMETER', 'CLASS',
  'METHOD', 'PROPERTY', 'CALL', 'EXPRESSION', 'LITERAL', 'BRANCH',
  'LOOP', 'TRY_BLOCK', 'CATCH_BLOCK', 'CASE', 'SCOPE', 'IMPORT', 'EXPORT',
  'PROPERTY_ACCESS', 'GETTER', 'SETTER', 'DECORATOR', 'LABEL',
  'STATIC_BLOCK', 'FINALLY_BLOCK', 'SIDE_EFFECT', 'META_PROPERTY', 'FILE',
  'EXTERNAL', 'ENUM', 'ENUM_MEMBER', 'INTERFACE', 'NAMESPACE',
  'TYPE_ALIAS', 'TYPE_REFERENCE', 'TYPE_PARAMETER', 'LITERAL_TYPE',
  'CONDITIONAL_TYPE', 'INFER_TYPE',
]);

// ─── Stage 1+2: per-file walk ────────────────────────────────────────

const fileResults = [];
let passed = 0;
let failed = 0;
const failures = [];
let stage25Resolved = 0;
let stage25Remaining = 0;

for (const filename of files) {
  const filePath = resolve(corpusDir, filename);
  const code = readFileSync(filePath, 'utf8');
  const relPath = `src/${filename}`;

  try {
    const walkResult = await walkFile(code, relPath, jsRegistry);
    const unresolvedBefore = walkResult.unresolvedRefs.length;
    const result = resolveFileRefs(walkResult);
    stage25Resolved += unresolvedBefore - result.unresolvedRefs.length;
    stage25Remaining += result.unresolvedRefs.length;
    fileResults.push(result);
    passed++;
  } catch (e) {
    failed++;
    failures.push({ file: relPath, error: e.message });
  }
}

// ─── Stage 3: project-level resolution ───────────────────────────────

const { edges: stage3Edges, unresolved, stats } = resolveProject(fileResults, builtins);

// ─── Aggregate ───────────────────────────────────────────────────────

let totalNodes = 0;
let totalEdgesStage12 = 0;
const nodeTypes = {};
const edgeTypes = {};

for (const r of fileResults) {
  totalNodes += r.nodes.length;
  totalEdgesStage12 += r.edges.length;
  for (const n of r.nodes) nodeTypes[n.type] = (nodeTypes[n.type] || 0) + 1;
  for (const e of r.edges) edgeTypes[e.type] = (edgeTypes[e.type] || 0) + 1;
}
for (const e of stage3Edges) {
  edgeTypes[e.type] = (edgeTypes[e.type] || 0) + 1;
}
const totalEdges = totalEdgesStage12 + stage3Edges.length;

// ─── Report ──────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  CORE V2 PIPELINE — COVERAGE REPORT`);
console.log(`${'═'.repeat(60)}`);
console.log(`  Files: ${files.length} (${passed} ok, ${failed} fail)`);
console.log(`  Nodes: ${totalNodes}  |  Edges: ${totalEdges} (S1+2: ${totalEdgesStage12}, S2.5: ${stage25Resolved}, S3: ${stage3Edges.length})`);
console.log(`  Unresolved: ${unresolved.length} (S2.5 passed: ${stage25Remaining}, S3 unresolved: ${stats.unresolved})`);

// ─── Edge coverage ───────────────────────────────────────────────────

const allSpecEdges = Object.keys(LANG_SPEC_EDGES);
const coveredEdges = allSpecEdges.filter(t => (edgeTypes[t] || 0) > 0);
const missingEdges = allSpecEdges.filter(t => (edgeTypes[t] || 0) === 0);
const extraEdges = Object.keys(edgeTypes).filter(t => !(t in LANG_SPEC_EDGES));

console.log(`\n${'─'.repeat(60)}`);
console.log(`  EDGE TYPES: ${coveredEdges.length}/${allSpecEdges.length} (${Math.round(coveredEdges.length/allSpecEdges.length*100)}%)`);
console.log(`${'─'.repeat(60)}`);

console.log(`\n  Covered (${coveredEdges.length}):`);
for (const t of coveredEdges.sort((a,b) => (edgeTypes[b]||0) - (edgeTypes[a]||0))) {
  console.log(`    ${String(edgeTypes[t]).padStart(5)}  ${t}`);
}

if (missingEdges.length > 0) {
  console.log(`\n  Missing (${missingEdges.length}):`);
  // Sort by assertion count (most important first)
  const sorted = missingEdges.sort((a,b) => (ASSERTION_COUNTS[b]||0) - (ASSERTION_COUNTS[a]||0));
  for (const t of sorted) {
    const assertions = ASSERTION_COUNTS[t] || 0;
    const category = categorizeEdge(t);
    console.log(`    ${String(assertions).padStart(4)} assertions  ${t.padEnd(24)} ${category}`);
  }
}

if (extraEdges.length > 0) {
  console.log(`\n  Extra (not in lang-spec): ${extraEdges.join(', ')}`);
}

// ─── Node coverage ───────────────────────────────────────────────────

const coveredNodes = [...LANG_SPEC_NODES].filter(t => (nodeTypes[t] || 0) > 0);
const missingNodes = [...LANG_SPEC_NODES].filter(t => (nodeTypes[t] || 0) === 0);
const extraNodes = Object.keys(nodeTypes).filter(t => !LANG_SPEC_NODES.has(t));

console.log(`\n${'─'.repeat(60)}`);
console.log(`  NODE TYPES: ${coveredNodes.length}/${LANG_SPEC_NODES.size} (${Math.round(coveredNodes.length/LANG_SPEC_NODES.size*100)}%)`);
console.log(`${'─'.repeat(60)}`);

console.log(`\n  Covered (${coveredNodes.length}):`);
for (const t of coveredNodes.sort((a,b) => (nodeTypes[b]||0) - (nodeTypes[a]||0))) {
  console.log(`    ${String(nodeTypes[t]).padStart(5)}  ${t}`);
}

if (missingNodes.length > 0) {
  console.log(`\n  Missing (${missingNodes.length}):`);
  for (const t of missingNodes.sort()) {
    const category = categorizeNode(t);
    console.log(`    ${t.padEnd(24)} ${category}`);
  }
}

if (extraNodes.length > 0) {
  console.log(`\n  Extra (not in lang-spec): ${extraNodes.join(', ')}`);
}

// ─── Stage 2.5 detail ────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`  STAGE 2.5 FILE-LEVEL RESOLUTION`);
console.log(`${'─'.repeat(60)}`);
console.log(`  Resolved: ${stage25Resolved}  |  Passed to Stage 3: ${stage25Remaining}`);

// ─── Stage 3 detail ──────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`  STAGE 3 RESOLUTION`);
console.log(`${'─'.repeat(60)}`);
console.log(`  import_resolve:    ${stats.importResolved}`);
console.log(`  call_resolve:      ${stats.callResolved}`);
console.log(`  type_resolve:      ${stats.typeResolved}`);
console.log(`  alias_resolve:     ${stats.aliasResolved}`);
console.log(`  re-export chain:   ${stats.reExportResolved}`);
console.log(`  ambiguousBuiltin:  ${stats.ambiguousBuiltin}`);
console.log(`  builtinInferred:   ${stats.builtinInferred}`);
console.log(`  IMPORTS→MODULE:    ${stats.importsToModule}`);
console.log(`  DERIVES_FROM:      ${stats.derivesFrom}`);
console.log(`  INSTANCE_OF:       ${stats.instanceOf}`);

if (unresolved.length > 0) {
  const byKind = {};
  for (const u of unresolved) byKind[u.kind] = (byKind[u.kind] || 0) + 1;
  console.log(`\n  Unresolved by kind:`);
  for (const [k, c] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(c).padStart(5)}  ${k}`);
  }

  // Top unresolved names
  const byName = {};
  for (const u of unresolved) byName[u.name] = (byName[u.name] || 0) + 1;
  console.log(`\n  Top unresolved names:`);
  const topNames = Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [name, count] of topNames) {
    console.log(`    ${String(count).padStart(5)}  ${name}`);
  }
}

// ─── Failures ────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.log(`\n  FAILURES:`);
  for (const f of failures) {
    console.log(`    ${f.file}: ${f.error.substring(0, 120)}`);
  }
}

console.log(`\n${'═'.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);

// ─── Helpers ─────────────────────────────────────────────────────────

function categorizeEdge(t) {
  const ts = ['HAS_TYPE','HAS_TYPE_PARAMETER','RETURNS_TYPE','DEFAULTS_TO','CONSTRAINED_BY','UNION_MEMBER','INTERSECTS_WITH','INFERS','ALIASES'];
  if (ts.includes(t)) return '[TypeScript]';
  const oop = ['IMPLEMENTS','DECORATED_BY','OVERRIDES','ACCESSES_PRIVATE','LISTENS_TO','MERGES_WITH'];
  if (oop.includes(t)) return '[OOP/Class]';
  const cf = ['CALLS_ON','CHAINS_FROM','BINDS_THIS_TO','INVOKES','DELEGATES_TO'];
  if (cf.includes(t)) return '[CallFlow]';
  const ctrl = ['HAS_DEFAULT','EXTENDS_SCOPE_WITH','CATCHES_FROM','DECLARES','HAS_SCOPE','RESOLVES_TO'];
  if (ctrl.includes(t)) return '[ControlFlow]';
  const df = ['WRITES_TO','READS_FROM','FLOWS_INTO','CAPTURES','SHADOWS','DELETES'];
  if (df.includes(t)) return '[DataFlow]';
  return '';
}

function categorizeNode(t) {
  const ts = ['ENUM','ENUM_MEMBER','INTERFACE','NAMESPACE','TYPE_ALIAS','TYPE_REFERENCE','TYPE_PARAMETER','LITERAL_TYPE','CONDITIONAL_TYPE','INFER_TYPE'];
  if (ts.includes(t)) return '[TypeScript]';
  const cls = ['PROPERTY','GETTER','SETTER','DECORATOR','STATIC_BLOCK'];
  if (cls.includes(t)) return '[Class]';
  const ctrl = ['FINALLY_BLOCK','LABEL','SIDE_EFFECT'];
  if (ctrl.includes(t)) return '[ControlFlow]';
  const mod = ['EXTERNAL','META_PROPERTY','FILE'];
  if (mod.includes(t)) return '[Module]';
  return '';
}
