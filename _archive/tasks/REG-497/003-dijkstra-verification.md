## Dijkstra Plan Verification

**Verdict:** APPROVE with corrections

---

### onProgress type shape — VERIFIED

`PluginContext.onProgress` is `(info: Record<string, unknown>) => void` (plugins.ts:102).
BrokenImportValidator passes `{ phase, currentPlugin, message, totalFiles, processedFiles }`.
The plan inherits this shape. No structural issues — all fields are valid `Record<string, unknown>` entries.

Guard pattern `if (onProgress && counter % INTERVAL === 0)` is correct.
`onProgress` is optional (`?:`), so the guard is required. Fire-and-forget: no try/catch needed.

---

### Completeness table — actual loops vs plan

| # | Validator | Actual loops (verified from source) | Plan says | Match? |
|---|-----------|-------------------------------------|-----------|--------|
| 1 | CallResolverValidator | 1 stream loop: `queryNodes({ nodeType: 'CALL' })` | 1 loop, every 500 | YES |
| 2 | EvalBanValidator | 3 separate stream loops over `{ nodeType: 'CALL' }` | 3 loops, single counter, every 500 | YES |
| 3 | SQLInjectionValidator | 1 collection loop (CALL → sqlCalls[]) + 1 analysis loop (for...of sqlCalls) + 1 `checkViaGraphPattern` call (no exposed loop) | 2 loops + pattern check | PARTIAL — see gap #1 |
| 4 | AwaitInLoopValidator | 1 stream loop: `queryNodes({ nodeType: 'CALL' })` | 1 loop, every 500 | YES |
| 5 | ShadowingDetector | 4 collection loops (CLASS, VARIABLE, CONSTANT, IMPORT) + 1 cross-file check loop (allVariables) + 1 scope check loop (allLocalVars) | 4 collection + 2 analysis | YES — structure correct |
| 6 | GraphConnectivityValidator | 1 collection loop `queryNodes({})` (ALL nodes) + 1 BFS while-loop | 2 loops | YES — but see note #1 |
| 7 | DataFlowValidator | 2 collection loops (VARIABLE, CONSTANT → combined array) + 1 analysis loop (for...of variables) | 2 collection + 1 validation | YES — structure correct |
| 8 | TypeScriptDeadCodeValidator | 1 INTERFACE collection loop + 1 interface analysis loop (for...of interfaces Map) + 2 counting-only loops (ENUM, TYPE) | "interface collection + analysis" | PARTIAL — see gap #2 |
| 9 | UnconnectedRouteValidator | 1 stream loop: `queryNodes({ type: 'http:route' })` | 1 loop, every 200 | YES — but see gap #3 |
| 10 | PackageCoverageValidator | 1 IMPORT collection loop + 1 issue reporting loop (for...of uncoveredPackages) | collection loop only | PARTIAL — see gap #4 |

---

### Gaps found

**Gap #1 — SQLInjectionValidator: `checkViaGraphPattern` is not a loop**

The plan says "2 loops — collection and analysis". The actual code has a third path: `checkViaGraphPattern` (line 174). This is NOT a loop — it is a single Datalog query call that internally iterates `violations`. The plan proposes adding progress to the collection loop (every 500) and the analysis loop (every 100). This is correct. The Datalog-based path does not need progress reporting since it is a single awaited call, not a visible iteration. No action required — gap is informational only.

**Gap #2 — TypeScriptDeadCodeValidator: 2 silent counting loops (ENUM, TYPE)**

The plan identifies "interface collection + analysis loop" but overlooks the ENUM and TYPE loops (lines 140-147). These loops iterate the full graph and contribute to total execution time. They contain no counter variable — they only increment local `enumCount`/`typeCount`. The plan's proposed placement (progress only in analysis loop) will not report progress during ENUM/TYPE iteration.

Assessment: these are counting-only loops with no per-node work. Adding progress here is low-value. However, if `ENUM` or `TYPE` node counts are large, the validator will appear to stall silently. The plan is acceptable but Rob should be aware these loops exist. No correction required, noting for awareness.

**Gap #3 — UnconnectedRouteValidator: query key mismatch**

The plan states: `queryNodes({ type: 'http:route' })`.
The actual code uses `{ type: 'http:route' }` (line 49) — not `{ nodeType: 'http:route' }`.
The plan correctly mirrors the actual code. No issue.

However: the plan proposes a counter variable and reporting every 200. The actual loop has NO counter (`issueCount` only increments conditionally on `customerFacing && incoming.length === 0`). The plan must introduce a new `counter` variable that increments unconditionally on every node, separate from `issueCount`. The plan implies this but does not state it explicitly. This is a minor implementation detail; Rob must not reuse `issueCount` as the progress counter.

**Gap #4 — PackageCoverageValidator: issue reporting loop omitted**

The plan says "report in collection loop every 500". The collection loop (line 113) iterates ALL IMPORT nodes — this is the correct place and 500 is a reasonable interval.

The plan omits the second loop (lines 141-156): `for (const [packageName, location] of uncoveredPackages)`. This loop is bounded by unique uncovered package count — typically small (10s to 100s). No progress reporting needed here. Plan is correct to omit it.

---

### Precondition issues

**Precondition #1 — EvalBanValidator: shared counter must span loop restarts**

The plan says "single counter across all 3 loops". Each loop declares its own counter (`evalCount`, `funcCount`, `methodCount`). The plan proposes a new `counter` variable. Rob must introduce this additional variable; he must NOT reuse the existing per-loop counts, as those have semantic meaning in the summary. Two sets of variables will exist: the plan's `counter` (for progress) and the existing `evalCount/funcCount/methodCount` (for summary). This is safe but must be explicit.

**Precondition #2 — ShadowingDetector: analysis loops operate on derived arrays, not raw queryNodes streams**

The plan says "report during cross-file check (every 500)". The cross-file check (line 114) iterates `allVariables[]`, which was already fully collected. `allVariables.length` is known. The plan is correct to propose `counter/total` format here. The same applies to the `allLocalVars` loop (line 140). Both loops have known totals — the plan should specify `counter/total` for both analysis loops, not just the first. This is a minor omission.

**Precondition #3 — DataFlowValidator: collection is two separate loops merged into one array**

Both VARIABLE and CONSTANT streams append to `variables[]`. After both loops complete, `variables.length` is the total. The analysis loop (line 61) has a known total. The plan correctly states `${i}/${variables.length}`. Verified correct — but `i` is not an index variable in the current code (it uses `for...of`, not `for`). Rob must introduce an explicit counter. The plan implies this. Correct approach.

**Precondition #4 — GraphConnectivityValidator: BFS while-loop has no stable total**

The plan proposes "BFS (every 1000)". The BFS loop (line 84) processes `queue.shift()` — queue length grows dynamically as edges are followed. `reachable.size` is available at each step as a proxy for progress. The plan suggests `${reachable.size} nodes reached` which is correct and matches what is available. No total is knowable upfront. Verified: plan's approach is sound.

---

### Verdict summary

The plan is structurally correct. All 10 validators have their primary iteration loops correctly identified. The `onProgress` field shape is consistent with BrokenImportValidator's usage and the PluginContext type definition.

Two corrections Rob must apply explicitly:
1. EvalBanValidator: introduce a fresh `counter` variable separate from `evalCount/funcCount/methodCount`.
2. UnconnectedRouteValidator: introduce a fresh `counter` variable separate from `issueCount`.

These are implementation details not stated explicitly in the plan but implied. They will not cause bugs if Rob reads the code before writing — which is required per project rules.

**APPROVE.**
