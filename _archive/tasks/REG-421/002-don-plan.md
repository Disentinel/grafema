# Don Melton — Plan for REG-421: Graph Snapshot Tests

## Context

We're adding behavior-locking tests to protect the graph output from regressions during upcoming JSASTAnalyzer refactoring (REG-331). The goal: capture EXACT nodes and edges produced by the analyzer, so ANY unintentional change fails the test.

## Key Findings

**Existing Infrastructure:**
- `GraphAsserter.toSnapshot()` already normalizes/sorts nodes and edges (test/helpers/GraphAsserter.js:366-387)
- TestRFDB provides fast test databases (~10ms per test)
- Semantic IDs are stable across line number changes — perfect for golden files
- 30 test fixtures covering various patterns (test/fixtures/)
- 55,953 lines of existing tests — mature test patterns to follow

**Coverage Requirements:**
- **Node types** (56 total): MODULE, FUNCTION, CLASS, METHOD, VARIABLE, CONSTANT, PARAMETER, CALL, CONSTRUCTOR_CALL, IMPORT, EXPORT, SCOPE, BRANCH, CASE, LOOP, TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK, LITERAL, PROPERTY_ACCESS, UPDATE_EXPRESSION, etc.
- **Edge types** (37 total): CONTAINS, CALLS, HAS_CALLBACK, IMPORTS, EXTENDS, IMPLEMENTS, HAS_PARAMETER, HAS_SCOPE, HAS_CONDITION, RETURNS, YIELDS, FLOWS_INTO, MODIFIES, USES, WRITES_TO, READS_FROM, PASSES_ARGUMENT, ITERATES_OVER, RESOLVES_TO, REJECTS, CATCHES_FROM, etc.

## Architecture

### 1. Snapshot File Structure

```
test/
├── snapshots/
│   ├── functions.json           # FUNCTION, METHOD, PARAMETER, HAS_PARAMETER
│   ├── classes.json              # CLASS, CONSTRUCTOR_CALL, EXTENDS, IMPLEMENTS
│   ├── scopes.json               # SCOPE, HAS_SCOPE, CONTAINS, CAPTURES
│   ├── calls.json                # CALL, CALLS, HAS_CALLBACK, PASSES_ARGUMENT
│   ├── control-flow.json         # BRANCH, CASE, LOOP, TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK
│   ├── imports-exports.json      # IMPORT, EXPORT, IMPORTS
│   ├── mutations.json            # MODIFIES, WRITES_TO, FLOWS_INTO, UPDATE_EXPRESSION
│   ├── variables.json            # VARIABLE, CONSTANT, DECLARES, USES, READS_FROM
│   ├── literals.json             # LITERAL, OBJECT_LITERAL, ARRAY_LITERAL, HAS_PROPERTY
│   ├── async.json                # RETURNS, YIELDS, RESOLVES_TO, REJECTS, CATCHES_FROM
│   ├── typescript.json           # INTERFACE, TYPE_ALIAS, ENUM, DECORATOR, TYPE_PARAMETER
│   └── property-access.json      # PROPERTY_ACCESS, EXPRESSION
└── unit/
    └── GraphSnapshot.test.js     # Runner for all snapshot tests
```

**Rationale:**
- Granular files = easy diff review during refactoring
- Each file tests ~4-6 related node/edge types
- If scopes.json fails → scope-related changes detected
- Categories align with JSASTAnalyzer visitor modules

### 2. Golden File Format

```json
{
  "fixture": "test/fixtures/02-api-service/index.js",
  "nodes": [
    { "type": "FUNCTION", "name": "processRequest", "file": "test/fixtures/02-api-service/index.js" },
    { "type": "PARAMETER", "name": "req", "file": "test/fixtures/02-api-service/index.js" }
  ],
  "edges": [
    { "from": "FUNCTION:processRequest", "type": "HAS_PARAMETER", "to": "PARAMETER:req" }
  ]
}
```

**Why this format:**
- Human-readable for git diffs
- Sorted alphabetically (deterministic)
- Uses semantic IDs (stable across line changes)
- Matches existing `GraphAsserter.toSnapshot()` output

### 3. Fixture Strategy

**Reuse existing fixtures** — they already cover most patterns. No need to create new ones.

**Fixture-to-snapshot mapping:**

| Snapshot File | Fixtures Used | Node/Edge Types Covered |
|---------------|---------------|-------------------------|
| functions.json | 01-simple-script, parameters | FUNCTION, METHOD, PARAMETER, HAS_PARAMETER |
| classes.json | class-parameters, 03-frontend-app | CLASS, CONSTRUCTOR_CALL, EXTENDS, IMPLEMENTS |
| scopes.json | 04-control-flow, shadowing | SCOPE, HAS_SCOPE, CONTAINS, CAPTURES |
| calls.json | 02-api-service, passes-argument | CALL, CALLS, HAS_CALLBACK, PASSES_ARGUMENT |
| control-flow.json | 04-control-flow, eval-ban | BRANCH, CASE, LOOP, TRY_BLOCK, CATCH_BLOCK |
| imports-exports.json | 08-reexports, broken-imports | IMPORT, EXPORT, IMPORTS |
| mutations.json | value-domain, 03-complex-async | MODIFIES, WRITES_TO, FLOWS_INTO, UPDATE_EXPRESSION |
| variables.json | shadowing, reg327-local-vars | VARIABLE, CONSTANT, DECLARES, USES, READS_FROM |
| literals.json | value-domain | LITERAL, OBJECT_LITERAL, ARRAY_LITERAL |
| async.json | 03-complex-async | RETURNS, YIELDS, RESOLVES_TO, REJECTS |
| typescript.json | react-analyzer (has TS) | INTERFACE, TYPE_ALIAS, ENUM, DECORATOR |
| property-access.json | computed-property | PROPERTY_ACCESS, EXPRESSION |

**Coverage verification:** Script to detect missing node/edge types before finalizing.

## Implementation Steps

### Step 1: Snapshot Capture Utility (test/helpers/SnapshotHelper.js)

**Purpose:** Generate golden files from current analyzer output.

```javascript
export class SnapshotHelper {
  static async captureSnapshot(fixturePath, backend) {
    // Analyze fixture → get nodes/edges
    // Filter by category (only keep relevant node types)
    // Sort and normalize
    // Return { fixture, nodes, edges }
  }

  static filterByCategory(snapshot, category) {
    // Keep only nodes/edges relevant to category
    // e.g., category='functions' → keep FUNCTION, METHOD, PARAMETER
  }

  static async writeSnapshot(category, data, snapshotPath) {
    // Write JSON file with pretty formatting
  }
}
```

**Dependencies:** GraphAsserter.toSnapshot(), existing test infrastructure.

### Step 2: Snapshot Test Runner (test/unit/GraphSnapshot.test.js)

**Purpose:** Load golden files, re-analyze fixtures, compare.

```javascript
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';

const SNAPSHOT_DIR = join(process.cwd(), 'test/snapshots');
const UPDATE_SNAPSHOTS = process.env.UPDATE_SNAPSHOTS === 'true';

describe('Graph Snapshots', () => {
  for (const category of CATEGORIES) {
    it(`should match snapshot: ${category}`, async () => {
      const goldenPath = join(SNAPSHOT_DIR, `${category}.json`);
      const golden = JSON.parse(readFileSync(goldenPath, 'utf-8'));

      // Re-analyze fixture
      const db = await createTestDatabase();
      const orchestrator = createTestOrchestrator({ backend: db.backend });
      await orchestrator.analyzeModule(golden.fixture);

      // Capture current output
      const asserter = await assertGraph(db.backend);
      await asserter.init();
      const current = asserter.toSnapshot();

      // Filter by category
      const currentFiltered = SnapshotHelper.filterByCategory(current, category);

      // Compare
      if (UPDATE_SNAPSHOTS) {
        // Regenerate golden file
        await SnapshotHelper.writeSnapshot(category, currentFiltered, goldenPath);
      } else {
        // Strict equality check
        assert.deepStrictEqual(currentFiltered, golden);
      }

      await db.cleanup();
    });
  }
});
```

**Key features:**
- `UPDATE_SNAPSHOTS=true` regenerates golden files
- Otherwise, strict equality comparison
- Uses existing test helpers (createTestDatabase, createTestOrchestrator, assertGraph)

### Step 3: Initial Snapshot Generation Script

**Purpose:** Generate all golden files in one command.

```bash
# scripts/generate-snapshots.sh
#!/bin/bash
set -e

echo "Building packages..."
pnpm build

echo "Generating snapshots..."
UPDATE_SNAPSHOTS=true node --test test/unit/GraphSnapshot.test.js

echo "Snapshots generated in test/snapshots/"
```

**Usage:**
- Run once to create initial golden files
- Commit golden files to git
- CI runs without UPDATE_SNAPSHOTS → fails on any change

### Step 4: Coverage Verification Script

**Purpose:** Ensure all node/edge types are covered by at least one snapshot.

```javascript
// scripts/verify-snapshot-coverage.js
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ALL_NODE_TYPES = [
  'MODULE', 'FUNCTION', 'CLASS', 'METHOD', 'VARIABLE', 'CONSTANT',
  'PARAMETER', 'CALL', 'CONSTRUCTOR_CALL', 'IMPORT', 'EXPORT',
  'SCOPE', 'BRANCH', 'CASE', 'LOOP', 'TRY_BLOCK', 'CATCH_BLOCK',
  'FINALLY_BLOCK', 'LITERAL', 'PROPERTY_ACCESS', 'UPDATE_EXPRESSION',
  // ... (all 56 types)
];

const ALL_EDGE_TYPES = [
  'CONTAINS', 'CALLS', 'HAS_CALLBACK', 'IMPORTS', 'EXTENDS',
  'IMPLEMENTS', 'HAS_PARAMETER', 'HAS_SCOPE', 'HAS_CONDITION',
  // ... (all 37 types)
];

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
    console.error(`Missing node types (${missingNodes.length}):`, missingNodes);
  }
  if (missingEdges.length > 0) {
    console.error(`Missing edge types (${missingEdges.length}):`, missingEdges);
  }
  process.exit(1);
}

console.log('All node and edge types covered!');
```

**Run this before finalizing snapshots** to detect gaps.

### Step 5: Documentation

**File:** test/snapshots/README.md

```markdown
# Graph Snapshots

Behavior-locking tests for JSASTAnalyzer and GraphBuilder.

## Purpose

Capture the EXACT nodes and edges produced by the analyzer. Any change in output
fails the test — protects against regressions during refactoring.

## Running Tests

```bash
# Run snapshot tests (fails if output changed)
node --test test/unit/GraphSnapshot.test.js

# Update snapshots after intentional changes
UPDATE_SNAPSHOTS=true node --test test/unit/GraphSnapshot.test.js
```

## Coverage

- 12 snapshot files covering 56 node types and 37 edge types
- See test/snapshots/README.md for fixture-to-category mapping
```

## Execution Order

1. **SnapshotHelper.js** — utility for capture/filter/write
2. **GraphSnapshot.test.js** — test runner with UPDATE_SNAPSHOTS support
3. **generate-snapshots.sh** — script to create initial golden files
4. **verify-snapshot-coverage.js** — detect missing node/edge types
5. **Run coverage script** → fix gaps if any
6. **Generate snapshots** → commit to git
7. **README.md** → document usage

## Performance Estimate

- 12 snapshot categories × ~200ms per test = **~2.4 seconds total**
- Well within <30s constraint
- Parallelization possible if needed (node:test supports --test-concurrency)

## Success Criteria

- All 56 node types covered in at least one snapshot
- All 37 edge types covered in at least one snapshot
- Coverage verification script passes
- Snapshot tests run in <5 seconds
- Golden files are deterministic (semantic IDs, sorted)
- UPDATE_SNAPSHOTS=true regenerates all snapshots correctly

## Risk Mitigation

**Risk:** Existing fixtures might not cover all node/edge types.
**Mitigation:** Coverage verification script detects gaps early. If gaps found, add minimal fixtures (not full apps — just code snippets that trigger missing types).

**Risk:** Snapshots might be too large (verbose diffs).
**Mitigation:** Granular categorization keeps each file focused. GraphAsserter.toSnapshot() already filters to minimal fields (type, name, file).

**Risk:** False positives (intentional changes fail test).
**Mitigation:** UPDATE_SNAPSHOTS=true workflow. Document in README.

## Open Questions

None — plan is complete and ready for Joel's expansion.

---

**Files to create:**
- test/helpers/SnapshotHelper.js
- test/unit/GraphSnapshot.test.js
- scripts/generate-snapshots.sh
- scripts/verify-snapshot-coverage.js
- test/snapshots/README.md
- test/snapshots/*.json (12 files, generated by script)
