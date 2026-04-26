# REG-516: BLAST RADIUS Panel — Dijkstra Verification

**Date:** 2026-02-19
**Verifier:** Edsger Dijkstra (Plan Verifier)
**Input:** Don Melton's plan at `_tasks/REG-516/002-don-plan.md`
**Method:** Enumeration of all input categories, completeness tables, precondition analysis, edge case construction.

---

## Verdict: CONDITIONAL APPROVE

The plan is architecturally sound and the BFS approach is correct. However, three issues require explicit resolution before implementation begins. None are architecture-level rejections; they are specification gaps that will cause incorrect behavior if left to the implementer's discretion.

**Required fixes:**
1. The BFS algorithm sketch has a depth-semantics error (Section 2).
2. The guarantee node type query is incorrect — there are TWO distinct guarantee systems (Section 4).
3. Variables are mentioned in the task spec but the plan silently restricts cursor tracking to FUNCTION/METHOD (Section 5).

These must be resolved in the plan before Rob begins implementation.

---

## 1. BFS Algorithm Verification

### 1.1 Input Universe for BFS

Every BFS node can be one of:

| Input category | Handled | Notes |
|---|---|---|
| Node with 0 incoming edges | YES | loop exits immediately, empty sections |
| Node with 1 incoming edge | YES | trivial case |
| Node with N incoming edges where N <= MAX_BRANCHING_FACTOR (5) | YES | all processed |
| Node with N incoming edges where N > MAX_BRANCHING_FACTOR | PARTIAL — see below |
| Self-referencing node (A depends on A) | YES — visited set prevents loop |
| Node A where A's dependent also depends on A (mutual dependency) | YES — visited set handles |
| Root node that already appeared as indirect dependent | YES — root is in visited from start |
| Node whose dependent is a ghost (getNode returns null) | YES — plan says `if peerNode == null: continue` |
| Edge src that doesn't exist as a node | YES — same null-check handles this |
| Node at exactly maxDepth | UNCLEAR — see Section 1.2 |

### 1.2 BFS Algorithm Depth Semantics: DEFECT FOUND

The plan's BFS sketch contains a depth-counting error. I prove this by tracing through the algorithm with a 2-hop graph.

**Plan's pseudocode (Section 3.1):**
```
queue = [(rootNodeId, depth=0, viaPath=[])]
...
while queue not empty:
  (nodeId, depth, viaPath) = queue.dequeue()
  if depth > maxDepth: continue
  edges = getIncomingEdges(nodeId, ...)
  for each edge:
    if src in visited: continue
    visited.add(src)
    if depth == 0:
      directDependents.push(...)           # <-- when depth=0, we're processing ROOT
      queue.enqueue((src, depth+1, ...))  # src is at hop-1, enqueued at depth=1
    else:
      indirectDependents.push(...)         # <-- when depth=1, src is at hop-2
```

**Trace for root → A → B (A directly depends on root, B indirectly):**

- Start: queue = [(root, 0, [])]
- Iteration 1: dequeue (root, 0). `getIncomingEdges(root)` returns edge from A. depth==0, so push A to `directDependents`. Enqueue (A, 1, ["A"]).
- Iteration 2: dequeue (A, 1). `getIncomingEdges(A)` returns edge from B. depth==1 (not 0), so push B to `indirectDependents`. Correct so far.
- But now: enqueue (B, 2, ["A","B"]). If maxDepth=3: dequeue (B,2). Its dependents (C) go into `indirectDependents`. This is correct.

**The actual defect is the guard `if depth > maxDepth: continue`.**

With maxDepth=3:
- depth=3 is allowed to dequeue and fetch edges → its children get pushed at depth=4
- depth=4 > maxDepth=3 → skipped on next dequeue

The children of depth-3 nodes are never pushed to `directDependents` or `indirectDependents` (correct), but the nodes at depth=3 ARE fetched unnecessarily only to be discarded. The guard should be `if depth >= maxDepth: continue`. Otherwise at maxDepth=3, we fetch incoming edges for level-3 nodes (an extra round of RFDB calls) and then discard them.

**This is a performance bug, not a correctness bug.** But with `MAX_BRANCHING_FACTOR=5` and `maxDepth=3`, at depth-3 we make up to 5^3=125 unnecessary `getIncomingEdges` calls. At per-call latency, this matters.

**Required fix:** Change `if depth > maxDepth` to `if depth >= maxDepth` in the BFS guard.

### 1.3 Branching Factor Cap: Is 5 Per Node Sufficient?

The plan applies MAX_BRANCHING_FACTOR=5 at the section level in CALLERS (see `callersProvider.ts` line 338: `if (children.length >= MAX_BRANCHING_FACTOR: break`). However, the plan's BFS sketch does NOT show the cap being applied. I enumerate the possibilities:

| Cap placement | Consequence |
|---|---|
| Cap applied per-node during BFS | Some dependents silently dropped from result |
| Cap applied globally (total nodes) | Better — allows more unique nodes before truncation |
| No cap — rely on visited set only | Risk of O(N) calls for fan-in nodes |
| Cap with "N+ more" marker in UI | Correct UX — tells user the list is truncated |

The comment in Section 3.1 says: `# Cap both lists at MAX_BRANCHING_FACTOR * maxDepth or a global limit` — this is vague. The plan needs to decide: per-level cap or global cap? The existing `callersProvider.ts` uses per-node cap (breaks at 5 children per node, shows `more` item). The blast radius BFS should apply the same policy for consistency.

**Required clarification, not a rejection.** The implementation should explicitly document the cap strategy.

### 1.4 Completeness Table: BFS Node States

| State | Classified As | Correct? |
|---|---|---|
| Reachable in 1 hop | `directDependents` | YES |
| Reachable in 2-N hops | `indirectDependents` | YES |
| Root node itself | Neither (in `visited` from start) | YES |
| Node appearing in both direct and indirect paths | Whichever comes first (visited set) | ACCEPTABLE — first-come-first-served |
| Node with no file attribute | Still added to results, gotoLocation skipped | YES — plan covers this |
| EXTERNAL / EXTERNAL_MODULE nodes | Added to results (no special handling) | ACCEPTABLE but noisy |

---

## 2. Impact Score Formula Verification

### 2.1 Completeness Table: Score → Level Classification

Formula: `score = direct × 3 + indirect × 1 + guarantees × 10`
Levels: LOW = 0–10, MEDIUM = 11–30, HIGH = 31+

| Input | Score | Level | Correct? |
|---|---|---|---|
| 0 direct, 0 indirect, 0 guarantees | 0 | LOW | YES |
| 3 direct, 0 indirect, 0 guarantees | 9 | LOW | YES |
| 4 direct, 0 indirect, 0 guarantees | 12 | MEDIUM | YES |
| 10 direct, 0 indirect, 0 guarantees | 30 | MEDIUM | YES |
| 11 direct, 0 indirect, 0 guarantees | 33 | HIGH | YES |
| 0 direct, 10 indirect, 0 guarantees | 10 | LOW | YES |
| 0 direct, 11 indirect, 0 guarantees | 11 | MEDIUM | YES |
| 0 direct, 30 indirect, 0 guarantees | 30 | MEDIUM | YES |
| 0 direct, 31 indirect, 0 guarantees | 31 | HIGH | YES |
| 0 direct, 0 indirect, 1 guarantee | 10 | LOW | YES — boundary |
| 0 direct, 0 indirect, 2 guarantees | 20 | MEDIUM | YES |
| 0 direct, 0 indirect, 3 guarantees | 30 | MEDIUM | YES |
| 0 direct, 0 indirect, 4 guarantees | 40 | HIGH | YES |
| **Boundary: exactly 10** | **10** | **LOW** | YES — 0–10 is LOW |
| **Boundary: exactly 11** | **11** | **MEDIUM** | YES |
| **Boundary: exactly 30** | **30** | **MEDIUM** | YES |
| **Boundary: exactly 31** | **31** | **HIGH** | YES |

All boundary cases are consistent with the spec. The formula is correct.

### 2.2 Overflow Analysis

With MAX_BRANCHING_FACTOR=5 and maxDepth=3, the maximum direct count is 5 (one level), maximum indirect is 5^2 + 5^3 = 150. Maximum realistic guarantees: a few dozen.

Maximum score: `5×3 + 150×1 + 50×10 = 15 + 150 + 500 = 665`. Well within JavaScript's safe integer range (2^53). No overflow risk.

If the BFS cap is global (e.g., 50 direct + 100 indirect as the plan suggests in Section 5.1): `50×3 + 100×1 + 50×10 = 150 + 100 + 500 = 750`. Still no overflow.

---

## 3. Guarantee Discovery Verification

### 3.1 Critical Issue: Two Distinct Guarantee Systems

**This is the most serious gap in the plan.** Don's plan treats guarantees as a single concept. The codebase has TWO completely different guarantee systems:

**System A — GuaranteeManager (Datalog-based):**
- Node type stored as: `'GUARANTEE'` (plain string, uppercase, no namespace)
- ID format: `GUARANTEE:{id}` (e.g., `GUARANTEE:no-direct-db`)
- Listed via: `queryNodes({ type: 'GUARANTEE' })`
- GOVERNS direction: `GUARANTEE:foo --GOVERNS--> MODULE:src/auth.js`

**System B — GuaranteeAPI / GuaranteeNode (Schema-based):**
- Node types: `'guarantee:queue'`, `'guarantee:api'`, `'guarantee:permission'` (namespaced, lowercase)
- ID format: `guarantee:queue#orders`, `guarantee:api#rate-limit`
- Listed via: `queryNodes({ type: 'guarantee:queue' })` etc.
- GOVERNS direction: **also uses GOVERNS edge** (see `GuaranteeAPI.ts` line 59: `governs?: string[]` field, and `GuaranteeAPI` creates GOVERNS edges)

Don's plan (Section 4.3) acknowledges the inconsistency but draws the wrong conclusion:

> "Query for `nodeType: 'GUARANTEE'` (the string used by GuaranteeManager when creating guarantee nodes), which is what `GuaranteeManager.list()` already uses."

This would miss ALL guarantee:queue, guarantee:api, and guarantee:permission nodes from System B.

Don's mitigation (Section 4.3) — "Primary path is GOVERNS edge discovery, not nodeType query" — is the correct fallback. The GOVERNS-edge-first approach works for both systems because both create GOVERNS edges to MODULE nodes.

**However**, the BFS engine sketch in Section 3.1 uses `queryNodes({nodeType: 'MODULE'})` filtered by file, then `getIncomingEdges(moduleId, ['GOVERNS'])`. This is the GOVERNS-first approach. The query approach (`queryNodes({ nodeType: 'GUARANTEE' })`) from Section 2.4 contradicts this.

**Required clarification:** Confirm that the implementation will use the GOVERNS-edge-first path (module → GOVERNS incoming → guarantee nodes) exclusively, without any `queryNodes({ nodeType: 'GUARANTEE' })` call. This is already the correct path described in the guarantee discovery sketch in Section 3.1.

### 3.2 Completeness Table: Guarantee Discovery

| Scenario | Handled | Notes |
|---|---|---|
| Root node has `file` attribute | YES | main path |
| Root node has no `file` attribute | YES — returns empty (Section 2.4 and 3.1 both say `if not file: return []`) |
| File has a MODULE node in graph | YES — query finds it |
| File has no MODULE node (e.g., not yet analyzed) | YES — query returns empty, no crash |
| MODULE node has 0 incoming GOVERNS edges | YES — returns empty list |
| MODULE node has N GOVERNS edges (N guarantees govern it) | YES — all returned |
| Same guarantee governs multiple modules in same file | Handled — the GOVERNS-first approach finds all GOVERNS edges to that module; duplicates only matter if the same guarantee governs the SAME module twice (impossible by construction: `_createGovernsEdges` uses `break` after first match per module) |
| GUARANTEE node pointed to by GOVERNS has been deleted (dangling edge) | PARTIAL — `getNode(edge.src)` returns null; plan says "Catch all errors in guarantee discovery, return empty array on any failure" but this is a silent drop, not an error. **A null check on `getNode` result is needed in the implementation.** |
| GuaranteeAPI nodes (guarantee:queue etc.) | YES — if GOVERNS-first path used. NO if `queryNodes({ nodeType: 'GUARANTEE' })` used. |

### 3.3 Precondition: MODULE Node Existence

The guarantee discovery path requires: `queryNodes({ nodeType: 'MODULE', file: rootFile })` finds at least one MODULE node for the file.

This precondition is NOT guaranteed in general — a node can exist for a file that hasn't been analyzed as a module (e.g., inline scripts, dynamically evaluated code). The plan correctly handles this by returning an empty list when no MODULE is found.

---

## 4. Edge Types Verification

### 4.1 Completeness Table: All Edge Types vs. Selected Set

The plan selects: `['CALLS', 'IMPORTS_FROM', 'DEPENDS_ON', 'USES']`

From `packages/types/src/edges.ts`, I enumerate every edge type and assess whether it should be in the dependency traversal:

| Edge Type | Meaning (incoming to root) | Should Include? | Plan's Decision |
|---|---|---|---|
| `CALLS` | "who calls this function" | YES — core dependency | INCLUDED |
| `IMPORTS_FROM` | "who imports from this module" | YES — module dependency | INCLUDED |
| `DEPENDS_ON` | generic dependency | YES — catch-all | INCLUDED |
| `USES` | "who uses this variable/value" | YES — data dependency | INCLUDED |
| `EXTENDS` | "who extends this class" | YES for CLASS, NO for FUNCTION | NOT INCLUDED — risk of missing class-level blast radius |
| `IMPLEMENTS` | "who implements this interface" | YES for CLASS/interface | NOT INCLUDED — same risk |
| `HANDLED_BY` | route → handler; incoming means "route handled by me" | NO — wrong direction for blast | NOT INCLUDED — correct |
| `HAS_CALLBACK` | "who passes me as a callback" | MAYBE — strong dependency | NOT INCLUDED |
| `PASSES_ARGUMENT` | "who passes me as an argument" | MAYBE | NOT INCLUDED |
| `DELEGATES_TO` | "who delegates to me" | MAYBE | NOT INCLUDED |
| `REGISTERS_VIEW` | framework view registration | NO — too structural | NOT INCLUDED |
| All structural edges (CONTAINS, HAS_SCOPE, etc.) | structural, not dependency | NO | NOT INCLUDED — correct |
| `ASSIGNED_FROM`, `DERIVES_FROM` | data flow | These point TO origins, not from consumers | NOT INCLUDED — correct direction |

**Finding on EXTENDS/IMPLEMENTS:** Don acknowledges these in Section 1.7 and explicitly says "EXTENDS/IMPLEMENTS are narrower and can be added later if needed." This is a conscious deferral, not an omission. For the Phase 4 scope, this is acceptable as long as the DEPENDENCY_EDGE_TYPES constant is documented as "initial set, extendable."

**Finding on HANDLED_BY:** Don says "Should `HANDLED_BY` be included?" in the exploration. The answer is NO. HANDLED_BY goes FROM a route TO a handler (route → handler). Incoming to a handler means "what routes use me as a handler" — that IS a valid blast radius dependency. However, the handler is already reachable via `CALLS` (a route handler is a function that gets called). Don's exclusion is defensible but the rationale should be documented.

### 4.2 Edge Field Access in BFS

The RFDB client's `getIncomingEdges()` returns `WireEdge & Record<string, unknown>`. From the source (`client.ts` lines 609-626), the returned objects have `edgeType` as the primary field (not `type`), plus a `type` alias also added (line 601: `return { ...e, type: e.edgeType, ...meta }`).

The BFS accesses `edge.src` to get the dependent node ID. Verified: `WireEdge` interface in `packages/types/src/edges.ts` has `src: string` and `dst: string`. This is correct.

---

## 5. Cursor Tracking — Node Type Filter Verification

### 5.1 Task Spec vs. Plan

Don's plan (Section 1.4) states: "if the node is a `FUNCTION` or `METHOD` (same filter as CALLERS)."

The CALLERS panel uses this exact filter in `extension.ts` (line 638):
```typescript
if (node && (node.nodeType === 'FUNCTION' || node.nodeType === 'METHOD')) {
```

**The user request (REG-516)** — I have not verified the original task spec (only Don's plan). Don's Section 1.4 says "same filter as CALLERS" but the task description mentions "function/variable." Let me enumerate whether other node types should trigger blast radius:

| Node Type | Has meaningful blast radius? | Should trigger? | Plan's decision |
|---|---|---|---|
| `FUNCTION` | YES — functions have callers | YES | INCLUDED |
| `METHOD` | YES — methods have callers | YES | INCLUDED |
| `CLASS` | YES — via EXTENDS/IMPLEMENTS | MAYBE — excluded edge types | NOT INCLUDED |
| `VARIABLE` | YES (exported variables can be USES'd) | MAYBE — task spec mentions "variable" | NOT INCLUDED |
| `CONSTANT` | YES (same as VARIABLE) | MAYBE | NOT INCLUDED |
| `MODULE` | YES — whole module blast radius | MAYBE | NOT INCLUDED |
| `PARAMETER` | Rarely meaningful — parameters aren't re-used across callers | NO | NOT INCLUDED |
| `IMPORT` | Already covered by module | NO | NOT INCLUDED |

**The plan is silent on VARIABLE nodes despite the task description mentioning them.** This is a specification gap that Rob should not resolve alone. Don must decide: does the plan intentionally exclude variables from cursor tracking, and if so, why?

**Required action:** Don must explicitly state in the plan whether VARIABLE nodes trigger blast radius analysis, with justification.

---

## 6. TreeView Items Verification

### 6.1 Completeness Table: getChildren(undefined) states

| State | Returns | Correct? |
|---|---|---|
| Not connected | `[{kind:'status', message:'Not connected...'}]` | YES |
| Connected, no root | `[{kind:'status', message:'Move cursor...'}]` | YES |
| Loading (BFS in progress) | `[{kind:'loading'}]` | YES |
| Loaded, all counts > 0 | `[root, section:direct, section:indirect, section:guarantee, summary]` | YES |
| Loaded, 0 direct, 0 indirect, 0 guarantees | Plan shows same structure with 0 counts | UNCLEAR — see below |

### 6.2 Empty Sections: AMBIGUITY FOUND

The plan does not specify whether sections with 0 items are shown or hidden. For example: 0 direct dependents, 5 indirect dependents.

| Display option | User experience |
|---|---|
| Show empty sections ("Direct dependents (0)") | Cluttered but consistent |
| Hide sections with 0 items | Cleaner but implementation needs explicit check |

The ISSUES panel (`issuesProvider.ts`) hides sections with 0 items. The CALLERS panel always shows both sections. For blast radius, hiding empty sections seems correct (the "no dependents found" case should show a status message, not three empty sections).

**Required clarification:** What do we show when all counts are 0? Options: (a) a single `{kind: 'status', message: 'No dependents found'}` replacing all sections, or (b) all sections shown with "(0)" counts.

### 6.3 Summary Line: Missing from getChildren Return

The plan's `getChildren(undefined)` returns `[root, section:direct, section:indirect, section:guarantee, summary]`. But the `summary` item kind is defined in `BlastRadiusItem` and shown in the `getTreeItem` table. This is consistent. However, the summary line appears as a top-level item — it is a peer of sections, not a child. This is consistent with the spec ("8 total · 5 files · 1 guarantee").

**One issue:** Should summary appear even when all counts are 0? "0 total · 0 files · 0 guarantees" is technically correct but uninformative. This ties back to the ambiguity above.

### 6.4 Loading State Transition

The plan uses `{kind: 'loading'}` while BFS is in progress. The `setRootNode()` flow:
1. Set `this.loading = true`
2. Fire `_onDidChangeTreeData`
3. Trigger async BFS
4. On completion: set `this.loading = false`, fire `_onDidChangeTreeData`

**Gap:** If a second `setRootNode()` call arrives while BFS is still in progress (user moves cursor fast), the previous BFS must be cancelled or its results ignored. The plan does not address this race condition explicitly.

The `CallersProvider` handles this via same-node deduplication: `if (node.id === this.rootNode.id) return`. But blast radius BFS is async and takes longer than CALLERS (which does lazy loading). If the root changes during BFS, the results from the old BFS must be discarded.

**Required:** The implementation must include a "current request ID" or AbortController pattern to cancel stale BFS results. Without this, a fast-moving cursor could cause the panel to display results for the wrong node.

---

## 7. Pattern B (createTreeView) Registration Verification

The plan says to use Pattern B because "spec requires a summary line (implemented as `treeView.message` or as a dedicated tree item)."

Looking at `extension.ts`, the actual `issuesProvider` uses Pattern B with `createTreeView`. The `issuesProvider.setTreeView(view)` call enables badge setting. The blast radius plan's `setTreeView()` is for future badge use.

**However:** The plan implements summary as a `{kind: 'summary'}` tree item, NOT as `treeView.message`. This means Pattern B is only needed for future badge functionality. For the current implementation, Pattern A would also work. This is a minor architectural note, not an error — Pattern B is the correct choice given the badge future.

---

## 8. Preconditions Audit

### 8.1 What Must Be True for the Algorithm to Work

| Precondition | Guaranteed? | If violated |
|---|---|---|
| RFDB client is connected | Checked by `isConnected()` | Shows "Not connected" status |
| Root node has a valid `id` field | YES — WireNode always has id | N/A |
| `getIncomingEdges()` returns WireEdge with `src` field | YES — verified in client source | N/A |
| `getNode()` returns WireNode or null (not undefined) | YES — client returns `|| null` | null check in BFS |
| MODULE nodes have a `file` attribute | CONDITIONAL — `ModuleNodeRecord` has `file?: string` (optional) | MODULE with no file → guarantee query misses it |
| GOVERNS edges point from GUARANTEE to MODULE | YES — both GuaranteeManager and GuaranteeAPI create this pattern | N/A |
| BFS terminates | YES — visited set + maxDepth bound | N/A |

**The MODULE file optionality (line 152 in nodes.ts: `file?: string` for `ModuleNodeRecord`)** means a MODULE node can theoretically have no file. The guarantee discovery code must handle `!moduleNode.file` as well as `!rootNode.file`.

### 8.2 What Happens When RFDB Throws

The plan says "Catch all errors in guarantee discovery, return empty array on any failure." But the BFS engine's error handling is not specified for `getIncomingEdges()` or `getNode()` failures mid-BFS.

If `getIncomingEdges()` throws on node X during BFS iteration, the partial results accumulated so far would be lost. The BFS should wrap each RFDB call in try/catch and treat errors as "no edges" for that node.

---

## 9. Test Coverage Completeness

The plan's test list (Section 3.6-3.7) is mostly complete. Missing test cases:

| Missing Test | Why It Matters |
|---|---|
| T_NEW: BFS with getNode returning null mid-traversal | Null nodes should be silently skipped, not cause crash |
| T_NEW: Two simultaneous setRootNode() calls (race condition) | Stale results from first BFS must not overwrite second BFS results |
| T_NEW: Guarantee with `guarantee:queue` type (not `GUARANTEE`) | Verifies GOVERNS-edge discovery finds namespaced guarantee types |
| T_NEW: CLASS node at cursor — confirm no blast radius triggered | The filter must explicitly not trigger on CLASS nodes |
| T_NEW: VARIABLE node at cursor — confirm behavior matches spec decision | Once Don resolves the VARIABLE question, a test should verify it |

---

## 10. Summary of Issues

### Blocking (must be resolved before implementation)

**B1: BFS guard condition error** — `depth > maxDepth` should be `depth >= maxDepth`. This causes unnecessary RFDB calls at the boundary level. (Section 1.2)

**B2: Guarantee node type query is wrong** — `queryNodes({ nodeType: 'GUARANTEE' })` misses namespaced guarantee types (`guarantee:queue`, `guarantee:api`, `guarantee:permission`). The GOVERNS-first discovery path in Section 3.1 is correct and must be the ONLY path used. The contradictory `queryNodes({ nodeType: 'GUARANTEE' })` mention in Section 2.4 must be removed. (Section 3.1)

**B3: VARIABLE cursor trigger is unspecified** — The task description mentions "function/variable" but the plan silently restricts to FUNCTION/METHOD. Don must decide and document. (Section 5.1)

### Non-blocking (implementation choices, document in code)

**N1: Empty sections display** — Specify behavior when all counts are 0. Recommendation: single status message "No dependents found." (Section 6.2)

**N2: BFS race condition** — Concurrent `setRootNode()` calls during long BFS need stale-result cancellation. (Section 6.4)

**N3: EXTENDS/IMPLEMENTS exclusion** — Document in `DEPENDENCY_EDGE_TYPES` comment that these are deferred, not forgotten. (Section 4.1)

**N4: Null GUARANTEE node from dangling GOVERNS edge** — Add null check after `getNode(edge.src)` in guarantee discovery. (Section 3.2)

**N5: MODULE node without file attribute** — Add `!moduleNode.file` check alongside `!rootNode.file`. (Section 8.1)
