## Task Metrics: REG-546

**Workflow:** v2.2
**Config:** Mini-MLA
**Date:** 2026-02-21
**Wall clock:** ~5.5 hours (including Dijkstra reject + replan)

### Subagents

| # | Agent | Model | Role | Status |
|---|-------|-------|------|--------|
| 1 | Save request | Haiku | Request capture | ✓ |
| 2 | Don (explore+plan) | Sonnet | Discovery + planning | ✓ |
| 3 | Dijkstra (plan verify) | Sonnet | Verification | ✗ REJECT (snapshot count) |
| 3b | Dijkstra (replan) | Sonnet | Plan correction | ✓ |
| 4 | Uncle Bob (PREPARE) | Sonnet | Architecture review | ✓ |
| 5 | Kent (tests) | Opus | Test design + validation | ✓ |
| 6 | Rob (implementation) | Opus | Code changes | ✓ |
| 7 | Steve (review) | Sonnet | Vision review | ✓ APPROVE |
| 8 | Вадим auto (review) | Sonnet | Completeness review | ✓ APPROVE |
| 9 | Uncle Bob (review) | Sonnet | Code quality review | ✓ APPROVE |

### Totals

| Metric | Value |
|--------|-------|
| Subagents total | 9 agents (Dijkstra reject + replan counted as 2 iterations) |
| By model | Haiku: 1, Sonnet: 6, Opus: 2 |
| Total estimated tokens (subagents) | ~416,000 |
| Est. subagent cost | ~$5.24 |
| Top-level overhead | ~10-15% |
| **Est. total cost** | **~$5.75** |
| 3-Review cycles | 1 (REJECT/APPROVE on first pass: Steve + Вадим + Uncle Bob all APPROVE after replan) |

### Key Metrics

| Metric | Value |
|--------|-------|
| Files modified | 2 (VariableVisitor.ts, JSASTAnalyzer.ts) |
| Lines of code changed | ~20 total (1 line deleted, ~19 relocated/unchanged structure) |
| Tests added | 5 (4 new, 1 modified) |
| Snapshots updated | 2 files, 9+ nodes flipped CONSTANT→VARIABLE |
| Final test suite | 2177/2177 pass (0 failures), 5 skipped, 22 todo |
| Build status | ✓ Green (all packages) |

### Grafema Dogfooding

| Metric | Value |
|--------|-------|
| Graph queries attempted | 0 |
| Graph queries successful | 0 |
| Fallbacks to file read | 9 |
| Product gaps found | 1 |

**Verdict:** Not applicable to primary task. This was a fix to the graph builder itself (bootstrap problem: can't use the graph to fix the thing that builds the graph). However, a product gap was noted: INSTANCE_OF edges are not created for MemberExpression callees (`new ns.Foo()`, `new this.factory()`). This gap was flagged by Steve in his review but correctly identified as out-of-scope for REG-546.

---

## Narrative Summary

### What Happened

REG-546 fixed a bug in variable node classification: `const x = new Foo()` was being classified as CONSTANT when it should be VARIABLE. The bug existed in two parallel code paths (VariableVisitor for module-level declarations, JSASTAnalyzer.handleVariableDeclaration for in-function declarations), a classic dual-path footgun documented in the project's MEMORY.md.

### Plan → Reject → Replan → Implement → Approve

**Don's Plan:** Identified the root cause correctly (remove `|| isNewExpression` from `shouldBeConstant` in both files) but significantly underestimated snapshot impact (claimed "2 nodes" when the actual count was 9+).

**Dijkstra's Reject:** Caught the snapshot count error. The plan would have resulted in a PR with failing snapshot tests. Dijkstra enumerated all 9 affected nodes across the two snapshots and required the plan to be corrected before implementation.

**Corrected Plan:** Don revised the snapshot section to list all 9 affected nodes. The core fix logic remained unchanged and correct.

**Implementation:** Rob executed the fix exactly as planned: removed `|| isNewExpression` from line 253 (VariableVisitor.ts) and line 2084 (JSASTAnalyzer.ts), then moved the `classInstantiations.push()` block outside the if/else in both files to ensure INSTANCE_OF edges are still created for NewExpression initializers. All 5 tests passed. Build green. Snapshots updated.

**3-Review (Steve + Вадим + Uncle Bob):** All three approved on first pass. Steve validated the vision alignment ("AI should query the graph, not read code" — VARIABLE nodes make the graph truthful). Вадим verified acceptance criteria and regression coverage. Uncle Bob confirmed code quality and symmetry across both implementations.

### Key Decisions

1. **SKIP refactoring JSASTAnalyzer.ts** — The file is 4284 lines, a pre-existing condition. Uncle Bob PREPARE review explicitly rejected refactoring scope, filing JSASTAnalyzer decomposition as separate tech debt. The fix is surgical: ~20 LOC total.

2. **Dual-path test coverage** — Kent's tests explicitly exercise both VariableVisitor (module-level) and JSASTAnalyzer (in-function) paths. This directly addresses the dual-path footgun documented in memory.

3. **Preserve INSTANCE_OF edges** — Moving `classInstantiations.push()` outside the guard preserved edge creation while fixing node classification. Verified by test 5 (INSTANCE_OF + ASSIGNED_FROM assertion).

4. **No scope creep to enrichers** — The plan correctly identified that `ValueDomainAnalyzer`, `AliasTracker`, and VS Code's `traceEngine` only query VARIABLE nodes. After this fix, they automatically work for formerly-CONSTANT NewExpression nodes without code changes. Out-of-scope: fixing CONSTANT nodes from literals (a separate issue).

### Snapshot Impact

**Before fix:** 9 nodes were incorrectly classified as CONSTANT:
- Module-level (VariableVisitor path): `app`, `config`, `userSchema` in snapshot 03
- In-function (JSASTAnalyzer path): `processor` (4 instances), `newUser`, `user` (3 nodes in snapshot 03); `headers` (snapshot 07)

**After fix:** All 9 now correctly classified as VARIABLE. INSTANCE_OF edges present where callee is Identifier (e.g., `new Foo()` but not `new Foo.Bar()`).

### Product Gap Noted

Steve flagged: MemberExpression callees (`new this.factory()`, `new ns.Foo()`) do not get INSTANCE_OF edges. This is pre-existing behavior (not a regression). The plan correctly documented this as intentional and out-of-scope. Should be filed as separate feature request when it surfaces as a real need (REG-547 candidate).

### Tech Debt Recorded

Uncle Bob PREPARE review identified JSASTAnalyzer.ts as CRITICAL (4284 lines, 14-parameter method). Decomposition is not in scope for this fix. A tech debt task should be created to split it into focused modules. Recorded in 004-uncle-bob-prepare.md.

---

## Timeline

- **001 (Save request)** — User request captured
- **002 (Don plan)** — 27 minutes: comprehensive exploration + initial plan (with snapshot count error)
- **003a (Dijkstra verify)** — 4 minutes: REJECT on snapshot completeness
- **002b (Don replan)** — ~10 minutes: Plan revision with corrected snapshot enumeration
- **004 (Uncle Bob PREPARE)** — 1 minute: Green light, no refactoring needed
- **005 (Kent tests)** — 8 minutes: 5 tests designed, verified pre-fix failure, post-fix pass
- **006 (Rob implementation)** — 6 minutes: Changes applied, snapshots updated, tests pass
- **007 (Steve review)** — 1 minute: APPROVE (vision alignment + architecture)
- **008 (Вадим review)** — 2 minutes: APPROVE (acceptance criteria + regressions)
- **009 (Uncle Bob review)** — 1 minute: APPROVE (code quality)

**Total wall clock:** ~5.5 hours (including rejection + replan cycle)

---

## Notes

- **Dijkstra REJECT was valuable:** Prevented a PR with failing snapshot tests. The snapshot count error would have been discovered only during CI. The replan corrected the critical gap.
- **Dual collection path trap confirmed accurate:** MEMORY.md's note about VariableVisitor + JSASTAnalyzer dual paths was exactly the pitfall here. Both code paths needed fixing, and both were fixed identically.
- **Mini-MLA config worked well:** Don → Dijkstra → Uncle Bob → Kent ∥ Rob → 3-Review scaled efficiently for a medium-complexity fix with two implementations. Dijkstra's verification step caught a critical gap early.
- **3-Review cycles:** 1 cycle total. First-pass approval from all three reviewers after the replan corrected the snapshot issue.
- **Pre-existing conditions noted but not fixed:** JSASTAnalyzer.ts line count (4284), method parameter count (14), and VariableVisitor closure complexity (~305 lines). All flagged as tech debt, not blockers for this task.

