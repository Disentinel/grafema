# Don Melton — REVISED Plan for REG-421: Graph Snapshot Tests

## Why v2

Auto-review REJECTED original plan for 4 critical issues:

1. **Wrong type counts**: Plan said 56 nodes / 37 edges. Reality: 44 node types (26 base + 18 namespaced), 60 edge types. Coverage script MUST import from `packages/types/dist/` not hardcoded arrays.

2. **toSnapshot() insufficient**: Current format captures only {type, name, file} for nodes and {from, type, to} for edges. Missing semantic metadata (async, generator, exported, params, etc.). Refactoring could change `async: true → false` and snapshot wouldn't catch it.

3. **Cross-category gaps**: Original plan used different fixtures per category. A refactoring changing function+scope interaction might slip through both separate snapshots.

4. **Determinism unverified**: Semantic IDs use counter discriminators (#0, #1). Need verification.

## Revised Approach: Simpler & Stronger

Instead of 12 granular-by-category snapshots, use **full graph snapshots** per fixture.

### Core Principle

**One golden file per fixture, capturing FULL graph (all nodes, all edges, with semantic metadata).**

No category filtering. If any node or edge changes, the test fails. Period.

### Benefits

- **Eliminates cross-category gaps** — full graph captured, no way for interactions to slip through
- **Simpler to implement** — no category filtering logic
- **Easier to maintain** — 1:1 mapping fixture → golden file
- **Better debugging** — see entire graph structure in one file
- **Catches semantic changes** — enriched metadata detects refactoring regressions

## Architecture

### 1. Fixture Selection

Pick **3 existing fixtures** that together maximize type coverage:

| Fixture | Primary Coverage | Why |
|---------|------------------|-----|
| **03-complex-async** | Functions (async, generators), classes, methods, callbacks, promises, error handling (try/catch), event listeners, scopes, complex call patterns | Richest single fixture, covers ~70% of types |
| **04-control-flow** | Loops (for/for-in/for-of/while), branches (switch/case), if/else, try/catch/finally, scopes | Control flow constructs, branches, cases |
| **nodejs-builtins** | Imports (default, named, namespace, node: prefix), external modules, aliased imports, unused imports | Module system edge cases |

**Rationale:**
- 03-complex-async: Covers async/await, generators, promises, callbacks, classes, methods, error handling, events
- 04-control-flow: Covers loops, branches, cases, try/catch/finally blocks
- nodejs-builtins: Covers import variations (default, named, namespace, aliased, node: prefix)
- Together: ~90%+ type coverage (verified by script)

**If gaps remain after verification**: Add ONE minimal fixture covering missing types.

### 2. Golden File Structure

```
test/
├── snapshots/
│   ├── 03-complex-async.json      # Full graph snapshot
│   ├── 04-control-flow.json       # Full graph snapshot
│   ├── nodejs-builtins.json       # Full graph snapshot
│   └── README.md
├── helpers/
│   └── SnapshotHelper.js          # Capture utility
└── unit/
    └── GraphSnapshot.test.js      # Test runner
```

### 3. Enriched Snapshot Format

**Current toSnapshot() format (insufficient):**
```json
{
  "nodes": [
    { "type": "FUNCTION", "name": "foo", "file": "test.js" }
  ],
  "edges": [
    { "from": "FUNCTION:foo", "type": "CALLS", "to": "FUNCTION:bar" }
  ]
}
```

**New enriched format (REG-421):**
```json
{
  "fixture": "test/fixtures/03-complex-async/app.js",
  "nodes": [
    {
      "type": "FUNCTION",
      "name": "processUserRequest",
      "file": "test/fixtures/03-complex-async/app.js",
      "async": true,
      "generator": false,
      "exported": true,
      "arrowFunction": false,
      "params": ["userId"]
    }
  ],
  "edges": [
    {
      "from": "FUNCTION:processUserRequest",
      "type": "CALLS",
      "to": "METHOD:DataProcessor.processUser",
      "metadata": {}
    }
  ]
}
```

**Semantic properties to capture (by node type):**

- **FUNCTION**: async, generator, exported, arrowFunction, params (param names array)
- **CLASS**: exported, superClass (if extends)
- **METHOD**: async, static, kind (method/get/set/constructor)
- **VARIABLE**: kind (var/let/const), exported
- **LOOP**: loopType (for/for-in/for-of/while/do-while), async (for-await-of)
- **BRANCH**: branchType (switch/if/ternary)
- **CASE**: isDefault, fallsThrough
- **SCOPE**: scopeType (function/block/class/module/global)
- **IMPORT**: specifiers (array of {local, imported, type})
- **EXPORT**: exportedName, isDefault
- **CALL**: callee, isMethodCall

**Skip positional data**: line, column (change with formatting)
**Keep semantic data**: async, generator, exported, params, etc. (change only with refactoring)

### 4. Implementation Strategy

**Enhance GraphAsserter, not replace it:**

```javascript
// test/helpers/GraphAsserter.js

toEnrichedSnapshot() {
  return {
    nodes: this._getNodes().map(n => this._enrichNode(n))
      .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`)),
    edges: this._getEdges().map(e => this._enrichEdge(e))
      .sort((a, b) => `${a.from}-${a.type}-${a.to}`.localeCompare(`${b.from}-${b.type}-${b.to}`))
  };
}

_enrichNode(node) {
  const base = {
    type: node.type,
    name: node.name,
    file: node.file
  };

  // Add semantic properties based on type
  // SKIP: id, line, column, start (positional data)
  // INCLUDE: async, generator, exported, params, etc.

  switch (node.type) {
    case 'FUNCTION':
      return {
        ...base,
        async: node.async,
        generator: node.generator,
        exported: node.exported,
        arrowFunction: node.arrowFunction,
        params: node.params // param names array
      };
    case 'CLASS':
      return {
        ...base,
        exported: node.exported,
        superClass: node.superClass
      };
    case 'METHOD':
      return {
        ...base,
        async: node.async,
        static: node.static,
        kind: node.kind
      };
    case 'LOOP':
      return {
        ...base,
        loopType: node.loopType,
        async: node.async
      };
    case 'VARIABLE':
      return {
        ...base,
        kind: node.kind,
        exported: node.exported
      };
    // ... other types
    default:
      return base; // fallback: just type/name/file
  }
}

_enrichEdge(edge) {
  const srcId = edge.src || edge.fromId;
  const dstId = edge.dst || edge.toId;
  const from = this._findNodeByEdgeId(srcId);
  const to = this._findNodeByEdgeId(dstId);

  const base = {
    from: `${from.type}:${from.name}`,
    type: edge.type,
    to: `${to.type}:${to.name}`
  };

  // Include edge metadata if present
  if (edge.metadata && Object.keys(edge.metadata).length > 0) {
    base.metadata = edge.metadata;
  }

  return base;
}
```

**Keep existing toSnapshot()** for backward compatibility. Add `toEnrichedSnapshot()` for REG-421.

### 5. Coverage Verification Script

**File:** scripts/verify-snapshot-coverage.js

```javascript
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { NODE_TYPE, NAMESPACED_TYPE } from '../packages/types/dist/nodes.js';
import { EDGE_TYPE } from '../packages/types/dist/edges.js';

// Import from source of truth, NOT hardcoded arrays
const ALL_NODE_TYPES = [
  ...Object.values(NODE_TYPE),
  ...Object.values(NAMESPACED_TYPE)
];
const ALL_EDGE_TYPES = Object.values(EDGE_TYPE);

const snapshotDir = join(process.cwd(), 'test/snapshots');
const files = readdirSync(snapshotDir).filter(f => f.endsWith('.json'));

const coveredNodes = new Set();
const coveredEdges = new Set();

for (const file of files) {
  const snapshot = JSON.parse(readFileSync(join(snapshotDir, file), 'utf-8'));
  for (const node of snapshot.nodes) coveredNodes.add(node.type);
  for (const edge of snapshot.edges) coveredEdges.add(edge.type);
}

const missingNodes = ALL_NODE_TYPES.filter(t => !coveredNodes.has(t));
const missingEdges = ALL_EDGE_TYPES.filter(t => !coveredEdges.has(t));

if (missingNodes.length > 0 || missingEdges.length > 0) {
  console.error('COVERAGE GAPS DETECTED:');
  if (missingNodes.length > 0) {
    console.error(`Missing node types (${missingNodes.length}/${ALL_NODE_TYPES.length}):`, missingNodes);
  }
  if (missingEdges.length > 0) {
    console.error(`Missing edge types (${missingEdges.length}/${ALL_EDGE_TYPES.length}):`, missingEdges);
  }
  process.exit(1);
}

console.log(`All ${ALL_NODE_TYPES.length} node types and ${ALL_EDGE_TYPES.length} edge types covered!`);
```

**CRITICAL:** Import from `packages/types/dist/`, never hardcode type lists.

### 6. Determinism Verification

**New test:** test/unit/SemanticIdDeterminism.test.js

```javascript
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestDatabase, createTestOrchestrator, assertGraph, setupSemanticTest } from '../helpers/testHelpers.js';

describe('Semantic ID Determinism', () => {
  it('should produce same IDs for same code analyzed twice', async () => {
    const code = `
      function foo() { const x = 1; }
      function bar() { const x = 2; }
    `;

    const db1 = await createTestDatabase();
    const db2 = await createTestDatabase();

    await setupSemanticTest(db1.backend, { 'test.js': code });
    await setupSemanticTest(db2.backend, { 'test.js': code });

    const orchestrator1 = createTestOrchestrator({ backend: db1.backend });
    const orchestrator2 = createTestOrchestrator({ backend: db2.backend });

    await orchestrator1.analyzeModule('test.js');
    await orchestrator2.analyzeModule('test.js');

    const graph1 = await assertGraph(db1.backend);
    const graph2 = await assertGraph(db2.backend);
    await graph1.init();
    await graph2.init();

    const snap1 = graph1.toEnrichedSnapshot();
    const snap2 = graph2.toEnrichedSnapshot();

    // IDs must be identical
    assert.deepStrictEqual(snap1, snap2);

    await db1.cleanup();
    await db2.cleanup();
  });
});
```

**Purpose:** Verify counter discriminators (#0, #1) are deterministic.

## Implementation Steps

### Step 1: Enhance GraphAsserter (test/helpers/GraphAsserter.js)

- Add `toEnrichedSnapshot()` method
- Add `_enrichNode(node)` — semantic properties by type
- Add `_enrichEdge(edge)` — include metadata if present
- Keep existing `toSnapshot()` for backward compat

**Estimate:** 2-3 hours

### Step 2: Snapshot Test Runner (test/unit/GraphSnapshot.test.js)

```javascript
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTestDatabase, createTestOrchestrator, assertGraph } from '../helpers/testHelpers.js';

const SNAPSHOT_DIR = join(process.cwd(), 'test/snapshots');
const UPDATE_SNAPSHOTS = process.env.UPDATE_SNAPSHOTS === 'true';

const FIXTURES = [
  'test/fixtures/03-complex-async/app.js',
  'test/fixtures/04-control-flow/index.js',
  'test/fixtures/nodejs-builtins/index.js'
];

describe('Graph Snapshots', () => {
  for (const fixturePath of FIXTURES) {
    const fixtureName = fixturePath.split('/').slice(-2, -1)[0]; // '03-complex-async'

    it(`should match snapshot: ${fixtureName}`, async () => {
      const goldenPath = join(SNAPSHOT_DIR, `${fixtureName}.json`);

      // Analyze fixture
      const db = await createTestDatabase();
      const orchestrator = createTestOrchestrator({ backend: db.backend });
      await orchestrator.analyzeModule(fixturePath);

      // Capture current output
      const asserter = await assertGraph(db.backend);
      await asserter.init();
      const current = asserter.toEnrichedSnapshot();

      const snapshot = {
        fixture: fixturePath,
        ...current
      };

      if (UPDATE_SNAPSHOTS) {
        writeFileSync(goldenPath, JSON.stringify(snapshot, null, 2), 'utf-8');
        console.log(`Updated: ${goldenPath}`);
      } else {
        const golden = JSON.parse(readFileSync(goldenPath, 'utf-8'));
        assert.deepStrictEqual(snapshot, golden);
      }

      await db.cleanup();
    });
  }
});
```

**Estimate:** 1-2 hours

### Step 3: Coverage Verification Script (scripts/verify-snapshot-coverage.js)

As described in section 5 above.

**Estimate:** 1 hour

### Step 4: Determinism Test (test/unit/SemanticIdDeterminism.test.js)

As described in section 6 above.

**Estimate:** 1 hour

### Step 5: Generate Initial Snapshots

```bash
#!/bin/bash
# scripts/generate-snapshots.sh
set -e

echo "Building packages..."
pnpm build

echo "Generating snapshots..."
UPDATE_SNAPSHOTS=true node --test test/unit/GraphSnapshot.test.js

echo "Verifying coverage..."
node scripts/verify-snapshot-coverage.js

echo "Done! Snapshots in test/snapshots/"
```

**Estimate:** 30 min

### Step 6: Documentation (test/snapshots/README.md)

```markdown
# Graph Snapshots

Behavior-locking tests for JSASTAnalyzer + GraphBuilder.

## Purpose

Capture the EXACT nodes and edges (with semantic metadata) produced by the analyzer.
ANY change in output fails the test — protects against regressions during refactoring.

## Fixtures

- `03-complex-async.json` — async/await, generators, promises, callbacks, classes, error handling
- `04-control-flow.json` — loops, branches, switch/case, try/catch/finally
- `nodejs-builtins.json` — import variations (default, named, namespace, aliased)

## Running Tests

```bash
# Run snapshot tests (fails if output changed)
node --test test/unit/GraphSnapshot.test.js

# Update snapshots after intentional changes
UPDATE_SNAPSHOTS=true node --test test/unit/GraphSnapshot.test.js

# Verify coverage (all node/edge types present)
node scripts/verify-snapshot-coverage.js
```

## Coverage

- 44 node types (26 base + 18 namespaced)
- 60 edge types
- Coverage auto-verified by importing from packages/types/dist/

## Snapshot Format

Full graph per fixture (all nodes, all edges, semantic metadata).
No category filtering — simpler, stronger coverage.
```

**Estimate:** 30 min

## Performance

- 3 fixtures × ~300ms per analysis = **~1 second total**
- Determinism test: ~100ms
- Coverage verification: <50ms
- **Total: <2 seconds** — well within constraints

## Success Criteria

- ✅ All 44 node types covered (verified by script importing from types/dist/)
- ✅ All 60 edge types covered (verified by script importing from types/dist/)
- ✅ toEnrichedSnapshot() includes semantic properties (async, generator, params, etc.)
- ✅ Determinism test passes (same code → same IDs)
- ✅ Snapshot tests run in <5 seconds
- ✅ UPDATE_SNAPSHOTS=true regenerates correctly
- ✅ No cross-category gaps (full graph captured)

## Risk Mitigation

**Risk:** 3 fixtures might not cover all 44 node types + 60 edge types.
**Mitigation:** Coverage script auto-detects gaps. If gaps found, add ONE minimal fixture with missing types.

**Risk:** Enriched snapshots too verbose (large diffs).
**Mitigation:** Skip positional data (line/col), keep only semantic. 3 full snapshots manageable.

**Risk:** False positives from metadata changes.
**Mitigation:** Only capture semantic properties that SHOULD break tests if changed (async, params, etc.).

## Differences from v1

| Aspect | v1 (REJECTED) | v2 (This Plan) |
|--------|---------------|----------------|
| Snapshots | 12 category-based files | 3 full-graph files (one per fixture) |
| Coverage | Different fixture per category | Same 3 fixtures cover all types |
| Type lists | Hardcoded (wrong counts) | Imported from packages/types/dist/ |
| Node format | {type, name, file} only | Enriched with semantic metadata |
| Cross-category gaps | Possible | Eliminated (full graph) |
| Complexity | High (filtering logic) | Low (1:1 fixture→snapshot) |
| Determinism | Unverified | Dedicated test |

---

**Total Estimate:** 6-8 hours (vs 12-day original plan)

**Files to Create:**
- test/helpers/GraphAsserter.js (enhance existing)
- test/unit/GraphSnapshot.test.js
- test/unit/SemanticIdDeterminism.test.js
- scripts/verify-snapshot-coverage.js
- scripts/generate-snapshots.sh
- test/snapshots/README.md
- test/snapshots/*.json (3 files, generated by script)
