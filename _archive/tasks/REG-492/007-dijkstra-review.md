## Dijkstra Correctness Review

**Verdict:** APPROVE (with one documented concern, non-blocking)

**Functions reviewed:**
- `execute()` — APPROVE
- `buildImportIndex()` — APPROVE (with one concern documented below)
- `collectUnresolvedCalls()` — APPROVE
- `resolveCall()` — APPROVE (with one concern documented below)
- `extractPackageName()` — APPROVE

---

## Detailed Analysis

### `buildImportIndex()` — lines 155–173

**Input enumeration:**
- `graph` — any `PluginContext['graph']`; `queryNodes` is async iterable over all IMPORT nodes.
- Each node cast to `ImportNode` may have: `file` (string | undefined), `local` (string | undefined), `source` (string | undefined), `importBinding` (string | undefined).

**Guard at line 162:** `if (!imp.file || !imp.local || !imp.source) continue;`
This correctly skips nodes missing any of the three fields required to form a usable key. All three fields participate downstream — `file` and `local` form the key; `source` determines externality. The guard is complete.

**Relative-import filter at lines 165–166:**
```ts
const isRelative = imp.source.startsWith('./') || imp.source.startsWith('../');
if (isRelative) continue;
```
At this point `imp.source` is guaranteed non-empty (checked above). The filter covers `./` and `../`. Node.js `file:` protocol imports are not filtered, but those are effectively dead code in this codebase. No issue.

**Duplicate key concern (non-blocking):**
The key is `${imp.file}:${imp.local}`. If two IMPORT nodes in the same file declare the same `local` binding (e.g. a re-declaration after a conditional import, or a tooling artifact producing duplicate nodes), the second one silently overwrites the first via `Map.set`. This is a data-quality question, not a code defect: the graph enrichers that produce IMPORT nodes should enforce uniqueness per `(file, local)`. If they do not, `buildImportIndex` will silently use whichever node was iterated last. This should be documented as an assumption.

No duplicate-key handling was requested by the spec and no test covers it, so I record it as an observation rather than a defect.

---

### `collectUnresolvedCalls()` — lines 178–197

**Input enumeration:**
- Iterates all nodes of type `CALL`.
- Each cast to `CallNode`; relevant fields: `object` (string | undefined), `id` (required by `BaseNodeRecord`).

**Method-call skip at line 187:** `if (call.object) continue;`
Blocks when `call.object` is any truthy string. Passes through when `object` is `undefined`, `null`, `''`, or `0`. An empty string `object: ''` would be incorrectly admitted. However, an empty string as an object name is not a valid AST concept; the analyzer should never produce it. This is an implicit assumption rather than a defect.

**Already-resolved skip at lines 190–191:**
```ts
const existingEdges = await graph.getOutgoingEdges(call.id, ['CALLS']);
if (existingEdges.length > 0) continue;
```
Correct. The check is on `CALLS` edge type only, which matches the contract (a node is "resolved" if it already has a CALLS edge). HANDLED_BY is not used as a skip signal — correct, because a call could have HANDLED_BY without CALLS in some degenerate state; the CALLS edge is the authoritative "resolved" marker.

**Loop termination:** The `for await` over `queryNodes` is an async generator. It terminates if and only if the graph's iterator terminates. This is a database-level guarantee; no infinite-loop risk in the plugin code itself.

---

### `resolveCall()` — lines 203–284 (THE CRITICAL METHOD)

**Return type discriminated union:**
```ts
| { type: 'external'; nodesCreated: number; handledByCreated: number }
| { type: 'builtin' }
| { type: 'unresolved'; reason: 'unknown' | 'dynamic' }
```

I enumerate all code paths and verify each returns one of these three variants:

1. Line 217: `!calledName || !file` → `{ type: 'unresolved', reason: 'unknown' }` — CORRECT
2. Line 222: `JS_GLOBAL_FUNCTIONS.has(calledName)` → `{ type: 'builtin' }` — CORRECT
3. Line 227: `callNode.isDynamic` → `{ type: 'unresolved', reason: 'dynamic' }` — CORRECT
4. Line 235: `!imp` (no matching import) → `{ type: 'unresolved', reason: 'unknown' }` — CORRECT
5. Line 241: `!packageName` (extractPackageName returned null) → `{ type: 'unresolved', reason: 'unknown' }` — CORRECT
6. Line 283: all conditions passed, edges created → `{ type: 'external', nodesCreated, handledByCreated }` — CORRECT

All six exit points return a member of the discriminated union. The union is exhaustive. No path falls through without returning.

**`importBinding !== 'type'` guard — lines 274–281:**

The stated purpose of this guard is: "Skip type-only imports — they have no runtime relationship."

The `importBinding` field is typed as `string | undefined` (from the `ImportNode` interface). The possible values documented in the comment are: `'value' | 'type' | 'typeof'`.

The guard `imp.importBinding !== 'type'` is true for:
- `'value'` — CORRECT, runtime import, HANDLED_BY should be created
- `'typeof'` — CORRECT, `typeof` imports are also value-space at runtime (they import a type alias checked with typeof); HANDLED_BY is appropriate
- `undefined` — CORRECT, absence of importBinding means a plain value import (pre-REG-492 nodes without this field set); HANDLED_BY is appropriate
- `'type'` — blocked, CORRECT per spec

The concern raised in the task description about `importBinding === 'typeof'` is: does `typeof` warrant a HANDLED_BY edge? Yes — `import { foo } from 'bar'` used as `typeof foo` still imports a runtime value (in TypeScript, `import type { foo }` is the type-only form; `typeof foo` in a type position is a different construct but the binding still exists at runtime). The guard correctly admits `'typeof'`.

No gap found.

**`extractPackageName` return value usage at line 239:**
```ts
const packageName = this.extractPackageName(imp.source!);
```
The `!` non-null assertion is safe here: at line 234 we confirm `imp` is non-null (it came from the Map), and `imp.source` was verified non-empty in `buildImportIndex` (line 162 guard), and it was confirmed non-relative (lines 165–166). So `imp.source` is always a non-empty, non-relative string at this point. The assertion is sound.

**EXTERNAL_MODULE deduplication — lines 248–256:**
The logic checks `createdExternalModules` (in-memory Set) first, then falls back to `graph.getNode`. This is correct for:
- New node this run: first call creates it and adds to Set; subsequent calls hit the Set, skip getNode entirely. No duplicate addNode call.
- Node pre-existing from a prior run: Set is pre-populated at execute() lines 79–81; Set hit on first call, no addNode. Correct.
- Race condition: this plugin runs single-threaded (sequential `for...of` on `callsToProcess`), so there is no race.

**CALLS edge creation at lines 264–269:**
Created unconditionally after successful resolution. The `exportedName` falls back to `calledName` when `imp.imported` is absent (line 262). This fallback is appropriate: if the IMPORT node has no `imported` field (e.g. a non-standard enricher produced it), using the local call name as a best-effort exportedName is reasonable.

**HANDLED_BY edge creation at lines 273–281:**
Created only when `imp.importBinding !== 'type'`. Counter `handledByCreated` correctly tracks whether an edge was created (0 or 1). This flows back to the caller and is accumulated in `handledByEdgesCreated` in `execute()`.

**Observation: CALLS always created even for type-only imports.**
When `importBinding === 'type'`, the code:
1. Creates the EXTERNAL_MODULE node (if needed) — line 252
2. Creates the CALLS edge to EXTERNAL_MODULE — line 264
3. Skips HANDLED_BY — line 274

This means a `import type { Router } from 'express'` followed by a call `Router()` (which is a TypeScript compile error but valid at the graph level) will produce a CALLS edge to EXTERNAL_MODULE but no HANDLED_BY. The CALLS edge creation is not guarded by `importBinding`. This is arguably correct behavior: the CALLS edge represents "this call references an external package" (semantic intent), while HANDLED_BY represents "this call is handled by this import declaration" (structural link). For a type import, there is no structural link, but the package reference is still semantically present. The test at line 1265–1310 verifies exactly this behavior (no HANDLED_BY, but does not assert absence of CALLS edge — it is silent on that point). The behavior is internally consistent.

---

### `extractPackageName()` — lines 298–318

**Input enumeration:**
- `source`: string (caller always passes a non-empty, non-relative string due to buildImportIndex guards)

**Scoped packages (`source.startsWith('@')`):**
- `@scope/pkg` → `parts = ['@scope', 'pkg']`, length=2, returns `@scope/pkg` — CORRECT
- `@scope/pkg/sub` → `parts = ['@scope', 'pkg', 'sub']`, length=3 ≥ 2, returns `@scope/pkg` — CORRECT
- `@scope` → `parts = ['@scope']`, length=1 < 2, returns `null` — CORRECT (invalid scoped package)
- `@` (bare @) → `parts = ['@']`, length=1, returns `null` — CORRECT

**Non-scoped packages:**
- `lodash` → `slashIndex = -1`, returns `'lodash'` — CORRECT
- `lodash/map` → `slashIndex = 6`, returns `'lodash'` — CORRECT
- `/absolute` → `slashIndex = 0`, returns `''` (empty string before slash). This is a problem: an absolute path like `/usr/local/lib` would return `''` (empty string), which is falsy, so the caller's `if (!packageName)` guard at line 241 would catch it and return `unresolved`. No crash, but the behavior is technically silently misclassified as "unknown unresolved" rather than "invalid source". Not a defect, but worth noting.

However: `buildImportIndex` filters out relative imports (starting with `./` or `../`) but does NOT filter out absolute paths starting with `/`. In practice, an absolute path in an import statement is not valid ECMAScript, so this case should never arise. The guard in `resolveCall` adequately handles the degenerate case.

**Termination:** All branches return. No loops. Termination is unconditional.

---

### `execute()` — lines 63–149

**Counter accumulation — lines 114–123:**
```ts
if (result.type === 'external') {
  nodesCreated += result.nodesCreated;
  edgesCreated++;
  handledByEdgesCreated += result.handledByCreated;
  externalResolved++;
} else if (result.type === 'builtin') {
  builtinResolved++;
} else {
  unresolvedByReason[result.reason]++;
}
```

The discriminated union has exactly three variants: `external`, `builtin`, `unresolved`. The if/else-if/else covers all three. The `else` branch handles `unresolved` and accesses `result.reason`. TypeScript will narrow `result` to `{ type: 'unresolved'; reason: 'unknown' | 'dynamic' }` in the else branch, so `result.reason` is safe.

`unresolvedByReason` is initialized with keys `unknown` and `dynamic`. Those are exactly the two values of `reason`. No key can be missing. No out-of-bounds access.

**`edgesCreated` vs `handledByEdgesCreated`:**
`edgesCreated` increments by 1 (not by `result.nodesCreated` — that's correct, it's counting CALLS edges). `handledByEdgesCreated` increments by `result.handledByCreated` (0 or 1). Both are reflected in `createSuccessResult` at line 139:
```ts
{ nodes: nodesCreated, edges: edgesCreated + handledByEdgesCreated }
```
This matches the test expectation at line 930 (`result.created.edges === 2` for one external call with value binding).

**Loop termination:** `callsToProcess` is a pre-collected array (finite). The `for...of` loop terminates unconditionally.

---

## Issues Found

**[buildImportIndex:169] — Undocumented assumption: `(file, local)` must be unique per file.**
If the graph contains two IMPORT nodes with identical `file` and `local` fields (same binding name in same file), the second silently overwrites the first in the Map. There is no contract violation in the plugin code itself, but the plugin implicitly assumes this uniqueness. This assumption should be documented in the method JSDoc.

**[resolveCall:239] — Non-null assertion `imp.source!` is safe but opaque.**
The safety is established by invariant from `buildImportIndex` (only nodes with non-empty source enter the index). This is a cross-method invariant with no local evidence. A comment noting "source is guaranteed non-null here (buildImportIndex guard)" would make the proof local. Not a defect.

---

## Test Suite Assessment

The 8 new HANDLED_BY tests cover:
- Named import with `importBinding: 'value'` — covered (lines 1112–1165)
- Default import with `importBinding: 'value'` — covered (lines 1167–1214)
- Aliased import, HANDLED_BY points to correct import node — covered (lines 1216–1263)
- Type-only import, no HANDLED_BY — covered (lines 1265–1310)
- Method call, no HANDLED_BY — covered (lines 1312–1364)
- Already-resolved call, no HANDLED_BY — covered (lines 1366–1431)
- Multi-file isolation — covered (lines 1433–1506)
- Regression: both CALLS and HANDLED_BY created together — covered (lines 1508–1564)

**Gap:** No test covers `importBinding: 'typeof'`. The `typeof` case is admitted by the guard (creates HANDLED_BY), but there is no test asserting this. Given that `typeof` imports are a valid TypeScript construct, a test confirming HANDLED_BY is created for `importBinding: 'typeof'` would complete the coverage of the three documented binding values.

This gap does not affect correctness of the implementation — the logic is correct for `typeof`. It is a test completeness gap.
