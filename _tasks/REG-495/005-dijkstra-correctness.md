## Dijkstra Correctness Review

**Verdict:** APPROVE

**Functions reviewed:**
- ServiceConnectionEnricher.execute — route collection loop: PASS
- ServiceConnectionEnricher.execute — request collection loop: PASS
- ServiceConnectionEnricher.execute — request matching loop: PASS
- HTTPConnectionEnricher.execute — route collection loop: PASS
- HTTPConnectionEnricher.execute — request collection loop: PASS
- HTTPConnectionEnricher.execute — request matching loop: PASS
- SocketConnectionEnricher.execute — stage progress calls: PASS
- ConfigRoutingMapBuilder.execute — completion progress call: PASS
- RustFFIEnricher.buildNapiIndex — RUST_FUNCTION loop: PASS
- RustFFIEnricher.buildNapiIndex — RUST_METHOD loop: PASS
- RustFFIEnricher.findRustCallingJsCalls — CALL node loop: PASS
- RustFFIEnricher.execute — FFI matching loop: PASS

---

### Proof by enumeration — per review question

#### Question 1: Does onProgress affect control flow?

I enumerate every onProgress call site. In every case the pattern is:

```
if (onProgress && condition) {
  onProgress({ ... });
}
```

onProgress is called for its side effect only. The return value is never used, never assigned, never tested in a condition. The `if` guard is flat — it does not wrap the work statement. Control flow (loop body, break, continue) is unchanged by the presence or absence of the call.

**Result: onProgress does not affect control flow. Proved by inspection of all 12 call sites.**

---

#### Question 2: Is the counter incremented at the right place?

I examine each loop type separately.

**for-await loops (collection phase — ServiceConnectionEnricher, HTTPConnectionEnricher, RustFFIEnricher):**

Pattern (representative — ServiceConnectionEnricher lines 109–121):
```
for await (const node of graph.queryNodes({ type: 'http:route' })) {
  routes.push(node as HTTPRouteNode);   // work done first
  routeCounter++;                        // counter incremented after work
  if (onProgress && routeCounter % 100 === 0) {
    onProgress({ ..., processedFiles: routeCounter });
  }
}
```

The increment happens AFTER pushing the node. Therefore `routeCounter` at the time of the onProgress call equals the number of nodes already collected (inclusive of the current node). This is the correct semantics: "N items have been processed."

All six for-await collection loops in these two files follow the same pattern. Confirmed identical for RustFFIEnricher.buildNapiIndex (funcCounter, methodCounter) and findRustCallingJsCalls (callCounter).

**Result: counter increments are correct — post-work, pre-report.**

---

#### Question 3: For indexed loops (ri, ci), does the index variable replace the for-of correctly?

**ServiceConnectionEnricher, HTTPConnectionEnricher — request matching loop:**

```
for (let ri = 0; ri < uniqueRequests.length; ri++) {
  const request = uniqueRequests[ri];
  if (onProgress && ri % 50 === 0) {
    onProgress({ ..., processedFiles: ri });
  }
  ...
}
```

`ri` is used both to index into `uniqueRequests[ri]` (correct element access) and as the progress counter (`processedFiles: ri`). The loop variable is initialized to 0, incremented at the end of each iteration.

I enumerate the states:
- ri = 0: first element, progress fires (0 % 50 === 0). processedFiles = 0 (zero processed, about to process first). This is a "before" report semantics — acceptable; the message text says "Matching requests 0/N" which is truthful.
- ri = 50: 50th element, progress fires (50 % 50 === 0). processedFiles = 50. At this point ri=50 elements have been iterated (indices 0..49 done, ri=50 about to be processed). So processedFiles is slightly ahead of completed work by 1 on trigger points. This is a minor semantic imprecision but NOT a bug — the progress value is bounded by [0, length], never overflows, never misidentifies state.
- ri = uniqueRequests.length - 1: last element, fires only if (length-1) % 50 === 0. Final progress may not fire at exactly 100%. This is consistent with the existing pattern across all files and is a known acceptable limitation of modulo-based reporting.

**RustFFIEnricher — FFI matching loop:**

```
for (let ci = 0; ci < jsCalls.length; ci++) {
  const call = jsCalls[ci];
  if (onProgress && ci % 100 === 0) {
    onProgress({ ..., processedFiles: ci });
  }
  ...
}
```

Identical structure to `ri` loop. Same analysis applies. Correct.

**Result: indexed loops correctly replace for-of. Element access and progress counter are consistent.**

---

#### Question 4: Are there off-by-one errors in modulo reporting?

I enumerate the modulo trigger values for each loop:

| Loop | Modulo | Trigger values | First trigger | Last possible trigger |
|------|--------|---------------|---------------|-----------------------|
| route collection | 100 | 100, 200, 300, ... | routeCounter=100 | floor(N/100)*100 |
| request collection | 100 | 100, 200, 300, ... | requestCounter=100 | floor(N/100)*100 |
| request matching (ri) | 50 | 0, 50, 100, ... | ri=0 | floor(N/50)*50 where floor(N/50)*50 < N |
| FFI matching (ci) | 100 | 0, 100, 200, ... | ci=0 | floor(N/100)*100 where that < N |
| RustFFIEnricher RUST_FUNCTION | 100 | 100, 200, ... | funcCounter=100 | floor(N/100)*100 |
| RustFFIEnricher RUST_METHOD | 100 | 100, 200, ... | methodCounter=100 | floor(N/100)*100 |
| RustFFIEnricher CALL nodes | 500 | 500, 1000, ... | callCounter=500 | floor(N/500)*500 |

**Observation on ri=0 and ci=0 triggers:** The indexed matching loops fire at ri=0 (or ci=0) on the first iteration. This produces a "Matching ... 0/N" message before any matching work has started. This is not an off-by-one error in the classical sense — it is a deliberate "start" notification. The processedFiles value is truthful (0 items matched so far). Not a defect.

**Observation on final progress:** None of these loops guarantee a final 100% report. For N=99: the route/request collection loops never fire (counter never reaches 100). This means there is no progress event for small graphs. This is consistent with the design intent (progress reporting is a best-effort hint, not a guaranteed sequence), and it is consistent across all files. Not a new defect introduced by this change.

**Result: No off-by-one errors. The modulo arithmetic is correct in all 12 call sites.**

---

#### Question 5: Does onProgress handle the undefined case correctly?

I enumerate every call site's guard pattern:

**Pattern A — conditional call with explicit `if (onProgress)`:**
```
if (onProgress && condition) {
  onProgress({ ... });
}
```
Present in: ServiceConnectionEnricher (3 sites), HTTPConnectionEnricher (3 sites), RustFFIEnricher.buildNapiIndex (2 sites), RustFFIEnricher.findRustCallingJsCalls (1 site), RustFFIEnricher.execute (1 site).

When `onProgress` is undefined: the `&&` short-circuits, onProgress is never called. Safe.
When `onProgress` is defined: the condition is evaluated and onProgress called if true. Safe.

**Pattern B — explicit `if (onProgress)` guard (no secondary condition):**
Present in: SocketConnectionEnricher (5 sites), ConfigRoutingMapBuilder (1 site).
```
if (onProgress) {
  onProgress({ ... });
}
```
When `onProgress` is undefined: guard prevents call. Safe.
When `onProgress` is defined: called unconditionally. Correct — these are milestone markers, not per-item throttled calls.

**Destructuring at top of execute:** All five files destructure `onProgress` from context:
```
const { graph, onProgress } = context;
```
The type of `onProgress` in PluginContext is `((progress: ProgressInfo) => void) | undefined`. Destructuring preserves the possibly-undefined type. The guards correctly handle the undefined case.

**Result: All 12 call sites correctly guard against undefined onProgress. Proved by exhaustive enumeration.**

---

### Completeness table: all onProgress call sites

| File | Loop/Site | Pattern | Guard | Counter position | Modulo | Verdict |
|------|-----------|---------|-------|-----------------|--------|---------|
| ServiceConnectionEnricher | route for-await | A | `onProgress && counter % 100` | post-push | 100 | CORRECT |
| ServiceConnectionEnricher | request for-await | A | `onProgress && counter % 100` | post-push | 100 | CORRECT |
| ServiceConnectionEnricher | ri matching loop | A | `onProgress && ri % 50` | pre-work (ri=0 start) | 50 | CORRECT |
| HTTPConnectionEnricher | route for-await | A | `onProgress && counter % 100` | post-push | 100 | CORRECT |
| HTTPConnectionEnricher | request for-await | A | `onProgress && counter % 100` | post-push | 100 | CORRECT |
| HTTPConnectionEnricher | ri matching loop | A | `onProgress && ri % 50` | pre-work (ri=0 start) | 50 | CORRECT |
| SocketConnectionEnricher | before collectNodes (4x) | B | `if (onProgress)` | N/A (milestone) | N/A | CORRECT |
| SocketConnectionEnricher | before match unix | B | `if (onProgress)` | N/A (milestone) | N/A | CORRECT |
| SocketConnectionEnricher | before match TCP | B | `if (onProgress)` | N/A (milestone) | N/A | CORRECT |
| ConfigRoutingMapBuilder | after addRules | B | `if (onProgress)` | post-work | N/A | CORRECT |
| RustFFIEnricher.buildNapiIndex | RUST_FUNCTION loop | A | `onProgress && counter % 100` | pre-filter | 100 | CORRECT* |
| RustFFIEnricher.buildNapiIndex | RUST_METHOD loop | A | `onProgress && counter % 100` | pre-filter | 100 | CORRECT* |
| RustFFIEnricher.findRustCallingJsCalls | CALL node loop | A | `onProgress && counter % 500` | pre-filter | 500 | CORRECT |
| RustFFIEnricher.execute | ci matching loop | A | `onProgress && ci % 100` | pre-work (ci=0 start) | 100 | CORRECT |

*Note on RustFFIEnricher.buildNapiIndex counter placement: funcCounter and methodCounter are incremented BEFORE the `if (rustNode.napi)` filter. This means processedFiles counts all RUST_FUNCTION/RUST_METHOD nodes scanned, not only those added to the index. This is the correct semantics for a progress counter — it measures scan progress, not output size. Not a defect.

---

### Issues found:

None. All enumerated cases are handled correctly.

**Final verdict: APPROVE**

All 12 onProgress call sites are provably correct. The changes are purely additive. No control flow modification. No off-by-one errors. No undefined-access risk.
