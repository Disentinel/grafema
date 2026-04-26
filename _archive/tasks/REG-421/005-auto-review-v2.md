# Auto-Review: REG-421 Plan v2

**Verdict:** REJECT

## Summary

Plan v2 fixes the 4 critical issues from v1 (type counts, enriched format, cross-category gaps, determinism). However, it introduces a NEW critical problem: **fixture coverage gap for domain-specific types**.

The plan proposes 3 fixtures (03-complex-async, 04-control-flow, nodejs-builtins) to cover all 44 node types + 60 edge types. But **18 out of 44 node types are namespaced domain types** requiring domain-specific analyzers (Express, SocketIO, DB, FS, etc.). None of the 3 proposed fixtures will create these nodes.

This violates the project vision: "If reading code gives better results than querying Grafema — that's a product gap." Snapshot tests MUST cover ALL types, not just JSASTAnalyzer types.

---

## Part 1 — Vision & Architecture

### What v2 Fixed (Good)

✅ **Type counts corrected**: Plan now imports from `packages/types/dist/` dynamically (44 nodes, 60 edges)
✅ **Enriched format**: New `toEnrichedSnapshot()` captures semantic metadata (async, generator, params, etc.)
✅ **Cross-category gaps eliminated**: Full graph per fixture (no category filtering)
✅ **Determinism verified**: New dedicated test for semantic ID stability

### NEW Critical Issue: Domain Type Coverage Gap

**Problem:** 18 namespaced types require domain-specific analyzers:

```
express:router, express:middleware, express:mount
socketio:emit, socketio:on, socketio:namespace
db:query, db:connection
fs:read, fs:write, fs:operation
net:request, net:stdio
http:route, http:request
event:listener, event:emit
grafema:plugin
```

**None of the 3 proposed fixtures will trigger these analyzers:**

| Fixture | Creates Namespaced Types? |
|---------|---------------------------|
| 03-complex-async | NO — uses callbacks/promises, but not Express/SocketIO/DB APIs |
| 04-control-flow | NO — pure control flow (loops, branches) |
| nodejs-builtins | NO — Node.js imports (fs, http modules) but not actual API calls |

**Why this matters:**

The coverage script will run and report:
```
Missing node types (18/44):
  express:router, express:middleware, socketio:emit, ...
COVERAGE GAPS DETECTED
```

**Root Cause:** Plan conflates "fixture using domain APIs" with "fixture importing domain modules". Importing `express` doesn't create `express:router` nodes — only calling `express.Router()` does.

---

## Part 2 — Practical Quality

### Implementation Concerns

1. **orchestrator.run() vs analyzeModule()**
   - Plan shows: `await orchestrator.analyzeModule(fixturePath)`
   - Reality: Orchestrator has `async run(projectPath)` that analyzes entire project
   - `analyzeModule()` doesn't exist in Orchestrator API
   - **Impact:** Test code won't work as written

2. **toEnrichedSnapshot() switch statement**
   - Plan proposes big switch by node type in `_enrichNode()`
   - Nodes already have metadata stored in their properties
   - **Question:** Could we just include all non-positional properties generically instead of hardcoding every type?
   - Current approach creates maintenance burden (new node type = update switch)

3. **Fixture coverage verification — false assumption**
   - Plan assumes 3 fixtures "~90%+ type coverage"
   - Reality: 3 fixtures cover ~26 base types (JSASTAnalyzer output)
   - 18 namespaced types require specific domain code (Express routes, SocketIO emit, DB queries, etc.)
   - Coverage script will fail immediately

### Missing Domain Fixtures

To actually cover all 44 types, need fixtures that:

| Domain | Required Fixture Code | Current Status |
|--------|----------------------|----------------|
| Express | `const router = express.Router(); router.get('/foo', ...)` | MISSING |
| SocketIO | `io.emit('event', ...); socket.on('event', ...)` | MISSING (06-socketio fixture exists but not in plan) |
| Database | `db.query('SELECT * FROM users')` | MISSING |
| Filesystem | `fs.readFileSync(...), fs.writeFileSync(...)` | MISSING |
| Network | `http.request(...), process.stdout.write(...)` | MISSING |
| Events | `emitter.on('event', ...); emitter.emit('event')` | MISSING |
| Grafema | `grafema:plugin` nodes (created during self-analysis?) | UNCLEAR |

**Reality Check:** Existing fixtures in `/test/fixtures/`:
- `06-socketio/` — SocketIO types
- `03-advanced-routing/` — Express routes (maybe?)
- But neither is in the plan

---

## Part 3 — Code Quality

### Positive Aspects

✅ Simpler approach (3 full graphs vs 12 category snapshots)
✅ Coverage verification script imports from source of truth
✅ Determinism test is good addition
✅ Documentation plan is clear

### Issues

❌ **Incomplete fixture analysis** — Plan claims "~90% coverage" without verifying which analyzers run on which fixtures
❌ **API mismatch** — `orchestrator.analyzeModule()` doesn't exist
❌ **Switch statement maintenance burden** — Every new node type requires switch case update
❌ **No validation of fixture→analyzer→types mapping** — Plan doesn't trace which fixtures create which namespaced types

---

## Specific Recommendations

### Fix 1: Add Domain Fixtures

**Minimum viable set** (use existing fixtures where possible):

```javascript
const FIXTURES = [
  // Base types (JSASTAnalyzer)
  'test/fixtures/03-complex-async/app.js',      // async, classes, methods, callbacks
  'test/fixtures/04-control-flow/index.js',     // loops, branches, try/catch

  // Domain types (require specific analyzers)
  'test/fixtures/06-socketio/index.js',         // socketio:emit, socketio:on
  'test/fixtures/03-advanced-routing/app.js',   // express:router, express:middleware (verify this exists!)
  // TODO: Add or create fixtures for db:query, fs:read/write, net:request
];
```

**OR** create ONE minimal fixture that exercises ALL domain analyzers:

```javascript
// test/fixtures/all-domains/index.js
const express = require('express');
const { Server } = require('socket.io');
const fs = require('fs');
const http = require('http');
const db = require('./mock-db'); // Minimal DB interface

const app = express();
const router = express.Router();
router.get('/users', (req, res) => { /* ... */ }); // express:route
app.use('/api', router); // express:mount

const io = new Server();
io.emit('update', data); // socketio:emit
io.on('connection', (socket) => { /* ... */ }); // socketio:on

db.query('SELECT * FROM users'); // db:query
fs.readFileSync('file.txt'); // fs:read
http.request('http://example.com'); // net:request

// etc.
```

### Fix 2: Correct Orchestrator API Usage

```javascript
// WRONG (plan v2):
await orchestrator.analyzeModule(fixturePath);

// CORRECT:
await orchestrator.run(fixturePath); // Analyzes entire directory as project
```

**OR** use test helpers pattern (check existing tests):

```javascript
import { createTestDatabase, createTestOrchestrator, setupSemanticTest } from '../helpers/testHelpers.js';

const db = await createTestDatabase();
await setupSemanticTest(db.backend, { 'app.js': code });
const orchestrator = createTestOrchestrator({ backend: db.backend });
await orchestrator.run(db.projectPath); // Use temp project path
```

### Fix 3: Generic Property Extraction (Optional Improvement)

Instead of switch statement per type:

```javascript
_enrichNode(node) {
  const SKIP_PROPS = ['id', 'line', 'column', 'start', 'end', 'loc', 'range'];

  const enriched = { type: node.type };

  // Include semantic properties, skip positional
  for (const [key, value] of Object.entries(node)) {
    if (!SKIP_PROPS.includes(key) && value !== undefined) {
      enriched[key] = value;
    }
  }

  return enriched;
}
```

**Tradeoff:** More maintainable (no switch updates) but might capture unwanted metadata. Switch statement is safer for now.

---

## Root Cause Analysis

**Why this happened:**

Plan v2 focused on fixing v1's structural issues (wrong type counts, insufficient format) but didn't validate the **fixture→analyzer→node types** dependency chain.

**Assumption:** "3 diverse fixtures will cover 90% of types"
**Reality:** Base types (26) ≠ All types (44). Domain types require domain code.

**Project Vision Violation:**

> "If reading code gives better results than querying Grafema — that's a product gap."

Snapshot tests that only cover 26/44 types leave a 41% gap. When refactoring breaks Express/SocketIO/DB analyzers, tests won't catch it. We'd only discover breakage by manually reading code — exactly what Grafema exists to prevent.

---

## Blocking Issues

1. **CRITICAL:** Fixture coverage gap — 18 namespaced types not covered
2. **BLOCKER:** `orchestrator.analyzeModule()` API doesn't exist
3. **CONCERN:** No validation that proposed fixtures actually create the claimed types

---

## Next Steps

**Don must:**

1. **Audit existing fixtures** — Which ones already exercise domain analyzers?
   - Check `test/fixtures/06-socketio/`, `03-advanced-routing/`, etc.
   - Read fixture code, trace which analyzers run

2. **Add missing fixtures** — Either use existing or create minimal all-domains fixture

3. **Fix Orchestrator API usage** — Use correct `run()` method or test helpers

4. **Validate coverage claim** — Run proposed fixtures through coverage script BEFORE implementation
   - Build packages
   - Run orchestrator on each fixture
   - Check which node types actually get created
   - Prove coverage before coding

**Estimated additional work:** +2-4 hours for fixture audit and additions.

---

## Verdict Details

| Aspect | Status | Reason |
|--------|--------|--------|
| **Vision alignment** | ❌ FAIL | 41% type coverage gap violates "graph must be superior" vision |
| **Architecture** | ⚠️ PARTIAL | Good structure, but missing domain coverage |
| **Correctness** | ❌ FAIL | Orchestrator API mismatch, fixtures won't create claimed types |
| **Completeness** | ❌ FAIL | 18 namespaced types not covered by proposed fixtures |

**Default stance: REJECT**

Plan v2 makes good progress on v1's structural issues but introduces a new critical gap. Don't patch this with "we'll add domain fixtures later in a follow-up" — that's deferring a core requirement. Fix now.

---

## What Would APPROVE Look Like

✅ Fixture list includes domain-specific code (Express routes, SocketIO emit, DB queries, FS ops)
✅ Coverage verification script passes (all 44 nodes + 60 edges present in snapshots)
✅ Orchestrator API usage matches actual implementation (`run()` not `analyzeModule()`)
✅ Plan includes traceability: "Fixture X creates types Y via analyzer Z"
✅ Performance still <5 seconds (adding 2-3 domain fixtures should be fine)

Then we'd escalate to Вадим for manual confirmation.
