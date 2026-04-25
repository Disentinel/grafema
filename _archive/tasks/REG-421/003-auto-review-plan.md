# Auto-Review: REG-421 Plan

**Verdict:** REJECT

---

## Part 1 — Vision & Architecture: CRITICAL ISSUES

### ❌ ISSUE 1: Incorrect Type Counts — Data Integrity Problem

**Claim:** Plan states "56 node types and 37 edge types"

**Reality:**
```bash
NODE_TYPE entries: 26
NAMESPACED_TYPE entries: 18
Total node types: 44
EDGE_TYPE entries: 60
```

**Impact:** Plan is based on inaccurate metadata. The coverage verification script in the plan lists hardcoded arrays with wrong counts. This is not a minor typo — it suggests Don didn't actually query the source of truth (`packages/types/src/nodes.ts` and `packages/types/src/edges.ts`).

**Required Fix:** Update all numbers to actual counts. Coverage script must derive node/edge lists from `packages/types/dist/*.js` dynamically, NOT hardcoded arrays.

---

### ❌ ISSUE 2: Determinism Assumption — UNVERIFIED

**Claim:** "Semantic IDs are stable across line number changes — perfect for golden files"

**Reality Check:**
- Semantic IDs use **counter-based discriminators** (`#0`, `#1`, `#2`)
- Counter increments happen in `ScopeTracker.getItemCounter()` during AST traversal
- Discriminator value depends on **traversal order**

**Critical Question:** Is AST traversal order guaranteed to be deterministic?
- If visitor order changes → counters change → semantic IDs change → false positive test failures
- If future refactoring reorders visitor invocations → snapshots break

**What's Missing:**
1. Don didn't verify AST traversal order is deterministic
2. Plan doesn't document this as a REQUIREMENT for snapshots to work
3. No test to validate determinism (e.g., analyze same file twice, compare IDs)

**Required Fix:**
- Add determinism test: analyze fixture 10 times, assert IDs are identical
- Document in test/snapshots/README.md: "Snapshots assume deterministic AST traversal order"
- If traversal is NOT deterministic → semantic IDs won't work, need content-based hashing instead

---

### ⚠️ ISSUE 3: Cross-Category Interactions — Coverage Gap Risk

**Plan's fixture mapping:**
- `functions.json` ← 01-simple-script, parameters fixtures
- `scopes.json` ← 04-control-flow, shadowing fixtures
- `calls.json` ← 02-api-service, passes-argument fixtures

**Problem:** Each category uses DIFFERENT fixtures. If a refactoring changes how functions interact with scopes, will BOTH `functions.json` AND `scopes.json` catch it?

**Example Scenario:**
1. Refactor scope tracking in FunctionVisitor
2. `functions.json` test passes (01-simple-script doesn't exercise complex scope interactions)
3. `scopes.json` test passes (04-control-flow fixture doesn't have the specific function pattern that broke)
4. Bug ships to production

**Why This Happens:** No fixture exercises ALL node types together. Snapshots are partitioned by category, but categories INTERACT.

**Mitigation Options:**
1. **Add overlap fixtures:** Some fixtures should intentionally exercise multiple categories (e.g., functions + scopes + calls in one file)
2. **Add integration snapshot:** One "kitchen sink" snapshot with ALL types from a single rich fixture
3. **Document the risk:** README must state: "Category snapshots may miss cross-category regressions. Integration tests are required."

**Required Fix:** At minimum, add one `integration.json` snapshot from a fixture like `03-complex-async` that exercises most types together.

---

## Part 2 — Practical Quality: MAJOR GAPS

### ❌ ISSUE 4: GraphAsserter.toSnapshot() — Insufficient Data

**Current Implementation (test/helpers/GraphAsserter.js:366-387):**

Nodes capture:
```javascript
{ type: n.type, name: n.name, file: n.file }
```

Edges capture:
```javascript
{ from: `${from.type}:${from.name}`, type: e.type, to: `${to.type}:${to.name}` }
```

**What's Missing:**
- **Node metadata:** async, generator, exported, isMethodCall, etc.
- **Edge metadata:** argumentCount, isDefault, specifier, etc.
- **Edge index:** Some edges are ordered (HAS_PARAMETER, HAS_ELEMENT) — index matters!

**Real-World Failure Scenario:**
1. Refactor changes `async: true` → `async: false` on a function
2. Snapshot test: "type: FUNCTION, name: processData, file: app.js" — PASSES (no change)
3. Bug ships — function no longer marked async

**Impact:** Snapshots only catch STRUCTURAL changes (nodes added/removed, edges added/removed). They DON'T catch SEMANTIC changes (property mutations).

**Required Fix:**
1. Update `toSnapshot()` to include ALL properties:
   ```javascript
   nodes: this._getNodes().map(n => ({
     type: n.type,
     name: n.name,
     file: n.file,
     ...n.metadata,  // Include ALL properties
   }))
   ```
2. For edges:
   ```javascript
   edges: this._getEdges().map(e => ({
     from: `${from.type}:${from.name}`,
     type: e.type,
     to: `${to.type}:${to.name}`,
     index: e.index,
     metadata: e.metadata,
   }))
   ```
3. Update golden file format in plan to reflect full property capture

---

### ⚠️ ISSUE 5: Fixture-to-Snapshot Mapping — Verification Missing

**Plan lists mapping table but doesn't explain HOW to verify it's complete.**

**Missing Workflow:**
1. Generate snapshots from fixtures
2. Run coverage verification script
3. **If gaps found** → what do we do?
   - Add minimal code to existing fixtures?
   - Create new fixtures?
   - Accept gaps and document them?

**Current plan says:** "If gaps found, add minimal fixtures"

**Problem:** How do we know WHICH fixture to add the missing pattern to? Each category snapshot is tied to specific fixtures. Adding a new fixture means regenerating that category's golden file.

**Required Fix:**
1. Coverage script should output: "Missing type X — consider adding to fixture Y"
2. Document strategy: "Prefer extending existing fixtures over creating new ones. Only create new fixture if pattern doesn't fit existing categories."
3. Plan should include: "After initial snapshot generation, iterate on fixtures until coverage script passes."

---

## Part 3 — Code Quality: MODERATE CONCERNS

### ⚠️ ISSUE 6: Snapshot Update Workflow — User Error Risk

**Proposed mechanism:** `UPDATE_SNAPSHOTS=true node --test test/unit/GraphSnapshot.test.js`

**Risk:** Developer accidentally runs with UPDATE_SNAPSHOTS=true and commits regressions as "valid" snapshots.

**Better Practice (from Jest/Vitest):**
- `--update-snapshots` CLI flag (intentional action)
- Interactive mode: "Snapshot mismatch detected. Update? (y/N)"
- Require `git status` to be clean before updating

**Required Fix:**
1. Add safety check in test:
   ```javascript
   if (UPDATE_SNAPSHOTS && process.env.CI === 'true') {
     throw new Error('Cannot update snapshots in CI');
   }
   ```
2. Document in README: "Never commit snapshot updates without reviewing diff"
3. Consider interactive prompt instead of env var

---

### ⚠️ ISSUE 7: Granularity vs Maintainability Tradeoff

**Plan proposes:** 12 separate snapshot files

**Pros:** Fine-grained diff review

**Cons:**
- 12 files to maintain
- 12 fixtures to keep in sync
- Harder to spot cross-category regressions

**Alternative:** 3-tier structure:
1. **Unit snapshots** (12 files) — focused, per-category
2. **Integration snapshot** (1 file) — kitchen sink, all types together
3. **Regression snapshots** (add as bugs are found)

**Current plan has:** Only tier 1

**Required:** Add tier 2 (integration.json from 03-complex-async or similar)

---

## Summary of Required Changes

### Critical (MUST FIX):
1. **Fix type counts** — query actual source of truth, not hardcoded lists
2. **Verify determinism** — add test that analyzes same file 10x, assert IDs identical
3. **Fix toSnapshot()** — capture ALL node/edge properties, not just type/name/file
4. **Add integration snapshot** — one fixture exercising all categories together

### Important (SHOULD FIX):
5. **Document determinism requirement** — README must state snapshots assume deterministic traversal
6. **Add fixture iteration workflow** — plan should include "generate → verify coverage → fix gaps → regenerate" loop
7. **Add UPDATE_SNAPSHOTS safety checks** — prevent accidental overwrites in CI

### Nice-to-Have:
8. **Interactive snapshot updates** — safer than env var
9. **Coverage script hints** — suggest which fixture to extend when gaps found

---

## Escalation

**Steve Jobs would say:** "This plan looks complete at first glance, but the details reveal fundamental gaps. Semantic IDs might not be deterministic. Snapshots only capture structure, not semantics. Type counts are wrong. This would ship and LOOK like it works, then fail silently during refactoring when a property changes but the snapshot doesn't notice."

**Вадим would say:** "Did anyone actually RUN this? The type counts are wrong — that's a 5-second check. The toSnapshot() method doesn't capture metadata — that's obvious from reading the code. And nobody verified if semantic IDs are deterministic across runs. This plan needs another pass with ACTUAL code inspection, not assumptions."

---

## Recommendation

**REJECT** — Send back to Don for revision.

**Next Steps:**
1. Fix critical issues 1-4 (type counts, determinism test, toSnapshot() enrichment, integration snapshot)
2. Document determinism requirement and fixture iteration workflow
3. Re-submit plan with verified data and complete architecture

**Timeline Impact:** +0.5 days for fixes, worth it to avoid shipping a false safety net.
