## Uncle Bob PREPARE Review

---

**File: packages/core-v2/src/walk.ts**
**File size:** 607 lines — MUST SPLIT (>500)
**Methods to modify:** `walkFile()` (lines 216–553, **338 lines**)

**File-level:**
- 607 lines crosses the MUST SPLIT threshold. However, the file has a clear internal structure: `parseFile` (utility), `createWalkContext` (factory), `walkFile` (engine), `deriveLoopElementEdges` (post-walk helper). A natural split would be extracting `deriveLoopElementEdges` and the overload/override post-walk blocks into a `post-walk.ts` module. That said, this is a pre-implementation review — splitting now would be a STEP 2.5 refactor, not part of REG-591. The file is 607 lines, which is at the boundary. Do not let the implementation grow it further.

**Method-level: walk.ts:walkFile**
- **Length:** 338 lines — well above the 50-line candidate threshold
- **Structure:** The function has five visually separated phases: (1) setup, (2) JS globals seed, (3) recursive `visit()` inner function (~125 lines), (4) post-walk overload/override detection (~65 lines), (5) Stage 2 deferred ref resolution (~65 lines), plus the loop-element derivation call.
- **Parameter count:** 4 — acceptable, but adding a 5th (`domainPlugins`) pushes it past the comfort zone
- **Recommendation:** REFACTOR the `domainPlugins` addition using a Parameter Object. Instead of `walkFile(code, file, registry, strict, domainPlugins)`, introduce an options bag for the optional parameters:
  ```ts
  interface WalkOptions {
    strict?: boolean;
    domainPlugins?: DomainPlugin[];
  }
  walkFile(code: string, file: string, registry: VisitorRegistry, options?: WalkOptions)
  ```
  This keeps the signature stable for all existing callers (they pass nothing for options) and avoids a 5-parameter signature. The current 4-parameter form already has `strict = true` as a defaulted trailing arg — the options object replaces it cleanly.
- **Nested `visit()` function:** Already 125 lines. Adding a domain-plugin execution block inside it will push it higher. Extract the plugin dispatch into a helper `runDomainPlugins(nodeId, callNode, plugins, ctx)` and call it from inside `visit()`. This keeps the inner function from bloating further.
- **Risk:** MEDIUM — `walkFile` is the hot path; any change to its signature or inner loop must be tested carefully
- **Estimated scope:** 15–25 lines added (options object + plugin dispatch call + helper function)

---

**File: packages/core-v2/src/visitors/expressions.ts**
**File size:** 1387 lines — CRITICAL (>700)
**Methods to modify:** `visitCallExpression()` (lines 44–467, **424 lines**)

**File-level:**
- 1387 lines is critical. The file contains ~25 exported visitor functions. The natural split is by concern: call/member/assignment expressions, function expressions (arrow, function expr), class/object expressions, identifier/literal visitors. This is a STEP 2.5 candidate, but splitting a 1387-line visitor file is a significant refactor with high risk of import chain breakage. Since REG-591 only touches `visitCallExpression`, splitting the file is out of scope here — but it must be tracked as tech debt.
- **For REG-591:** Do not add new top-level functions to this file. Any helper for argValues extraction must be a local helper at the top of the file or inlined.

**Method-level: expressions.ts:visitCallExpression**
- **Length:** 424 lines — critically long. This is the largest visitor in the codebase.
- **Structure:** The function handles: (1) callee name extraction (~60 lines), (2) node construction (~20 lines), (3) CHAINS_FROM edges (~30 lines), (4) PASSES_ARGUMENT deferred refs (~15 lines), (5) CALLS/CALLS_ON deferred refs (~80 lines), (6) mutation/iteration method patterns (~130 lines), (7) require/import handling (~15 lines), (8) Object.assign/keys/values/entries (~40 lines).
- **The argValues addition:** The task adds extraction of string/number literal argument values into `argValues` metadata on the CALL node. This is a localized change: read `call.arguments`, extract literals, attach to the node's `metadata` object. It belongs in section (2) alongside the existing `arguments: call.arguments.length` metadata field.
- **Recommendation:** SKIP a full refactor. The argValues addition is surgical — it slots into the existing metadata construction block (lines ~106–124). No restructuring needed for that change. The function is already stable and well-tested. A split of `visitCallExpression` into sub-functions would be correct long-term but is not safe to do in the same PR as a feature addition.
- **One specific concern:** The `_classStack` internal access pattern appears three times (lines 213, 242, 270): `(ctx as unknown as { _classStack?: string[] })._classStack`. This is a smell — internal state accessed via casting. If the new argValues work requires any similar internal access, push to expose it properly via `WalkContext` instead of adding a fourth cast.
- **Risk:** LOW for the argValues addition specifically. HIGH if the scope of change in this function widens.
- **Estimated scope:** 5–10 lines added (literal extraction loop + metadata field)

---

**File: packages/core/src/plugins/analysis/CoreV2Analyzer.ts**
**File size:** 204 lines — OK
**Methods to modify:** `execute()` (lines 65–149, **85 lines**), `buildPackageMap()` (lines 156–185, **30 lines**)

**File-level:**
- 204 lines is well within limits. The file has a single clear responsibility: bridge the core-v2 pipeline to the plugin host. No structural issues.

**Method-level: CoreV2Analyzer.ts:execute**
- **Length:** 85 lines — borderline but acceptable. It has three phases: (a) setup/builtins, (b) per-file walk loop, (c) Stage 3 cross-file resolution. Each phase is visually separated and clear.
- **Parameter count:** 1 (`context`) — fine
- **Nesting:** The per-file loop has a try/catch with 3 levels of nesting. Acceptable.
- **Plugin registry wiring:** Adding domain plugin config reads from `context.config` and passing to `walkFile` adds ~5–10 lines to the setup phase. This is safe.
- **Recommendation:** SKIP refactoring `execute`. Add the plugin registry extraction before the module loop, pass it into `walkFile` via the new options object. Keep it simple.
- **One caution:** Do not overload `execute` with plugin discovery logic. The pattern `buildPackageMap` uses (extract private method, call from execute) is the right model for any non-trivial wiring logic.
- **Risk:** LOW
- **Estimated scope:** 10–15 lines added (config extraction + options construction + pass-through)

---

## Summary

| File | Lines | Status | Action Required |
|------|-------|--------|-----------------|
| walk.ts | 607 | MUST SPLIT | Use Parameter Object for new option; extract plugin dispatch helper |
| expressions.ts | 1387 | CRITICAL | SKIP split (out of scope); argValues addition is surgical, fits in metadata block |
| CoreV2Analyzer.ts | 204 | OK | No structural changes needed; wiring is straightforward |

**Overall risk:** MEDIUM — driven entirely by the size of `visitCallExpression` and the complexity of `walkFile`'s inner `visit()` function. The actual changes are small and localized; the risk is collateral damage from editing large, heavily-tested functions.

**Blocking issue for implementation:** The `walkFile` signature change must use a Parameter Object (`WalkOptions`) to avoid breaking all callers. Verify all call sites of `walkFile` before touching the signature.
