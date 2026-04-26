## Вадим auto — Completeness Review

**Verdict:** APPROVE

**Feature completeness:** OK
**Test coverage:** OK
**Commit quality:** OK

---

### Feature Completeness

All four acceptance criteria are met:

1. **CALL nodes for external imports have HANDLED_BY → IMPORT edges** — yes. `resolveCall()` (lines 271–281 in `ExternalCallResolver.ts`) creates `HANDLED_BY` from the CALL to the matching IMPORT node after creating the `CALLS` edge. The guard `if (imp.importBinding !== 'type')` correctly excludes type-only imports.

2. **Enrichment plugins can query "find all calls to functions from library X"** — yes. The new `HANDLED_BY` edge provides direct CALL → IMPORT connectivity. From an IMPORT node the existing `MODULE → IMPORTS → EXTERNAL_MODULE` path is available, so a Datalog query can traverse: `CALL -HANDLED_BY-> IMPORT {source: 'express'}` and get all call sites for any library.

3. **No performance regression (enrichment phase within 20% of current)** — the approach is O(1) per call (HashMap lookup on `importIndex`) with one extra `addEdge` call per resolved external call. No additional graph traversal was introduced. No benchmarks are in the test file, but the algorithmic complexity is unchanged from the pre-existing `CALLS` edge path.

4. **Existing CALL → FUNCTION edges for internal calls not affected** — yes. The `collectUnresolvedCalls` method (lines 178–197) skips any call that already has a `CALLS` edge. Relative imports are excluded from `importIndex` at build time. Both guards were already present for the original `CALLS` logic and are not touched.

Import type coverage:
- Named import: covered (lodash `map` tests + express `Router` tests).
- Default import: covered (lodash `_` test + express default test).
- Aliased import (`map as lodashMap`): covered — `local` is used as lookup key, `imported` is stored as `exportedName`.
- Type-only import: covered — `importBinding === 'type'` guard skips `HANDLED_BY`, test explicitly verifies zero edges.
- Namespace method calls (`_.map()`): covered — `object` attribute guard fires before any index lookup.

No edge case was missed in the implementation.

---

### Test Coverage

The test file contains a dedicated `HANDLED_BY Edges (REG-492)` section with 8 new tests:

| Test | What it verifies |
|------|-----------------|
| named import call | HANDLED_BY created, CALLS still created |
| default import call | HANDLED_BY for `importType: 'default'` |
| aliased import | HANDLED_BY points to IMPORT with local name |
| type-only import | HANDLED_BY NOT created (`importBinding: 'type'`) |
| method call (namespace) | HANDLED_BY NOT created (object field present) |
| already resolved call | HANDLED_BY NOT created (CALLS pre-existing) |
| multi-file isolation | Each file's CALL points to its own IMPORT |
| regression (both edges together) | CALLS + HANDLED_BY coexist, count = 2 |

All 8 tests are behavioural (assert actual edge presence/absence in the graph), not structural. The updated `Mixed Resolution Types` test (line 930) asserts `result.created.edges === 2` — correctly reflecting that one external resolution now produces two edges.

The idempotency test (lines 1059–1066) verifies that a second run creates 0 edges, covering the case where HANDLED_BY might be accidentally duplicated. `collectUnresolvedCalls` already skips calls with an existing CALLS edge, so idempotency holds.

Minor observation: there is no explicit test verifying `handledByEdgesCreated` counter in `result.metadata`. The counter is logged and returned (`result.metadata.handledByEdgesCreated`) but not asserted anywhere. This is a documentation gap, not a correctness gap — the graph state assertions cover the actual requirement.

---

### Commit Quality

The change is clean and scoped to the task:

- `ExternalCallResolver.ts`: refactoring (3 extracted private methods) plus ~15 lines of new logic for `HANDLED_BY`. Metadata declaration updated (`creates.edges`, `produces`). The extraction was a STEP 2.5 prepare action.
- `ExternalCallResolver.test.js`: 8 new tests + 3 updated assertions (the `result.created.edges` counts that now include both edge types).

No changes outside the stated scope. No TODOs, no commented-out code, no workarounds. The extracted methods (`buildImportIndex`, `collectUnresolvedCalls`, `resolveCall`) are clearly named and have JSDoc comments.
