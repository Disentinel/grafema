# REG-495: Uncle Bob — Code Quality Review

## Uncle Bob — Code Quality Review

**Verdict:** REJECT

---

## File Sizes

| File | Lines | Status |
|------|-------|--------|
| ServiceConnectionEnricher.ts | 506 | **MUST SPLIT** (exceeds 500-line hard limit) |
| HTTPConnectionEnricher.ts | 336 | OK |
| SocketConnectionEnricher.ts | 285 | OK |
| ConfigRoutingMapBuilder.ts | 78 | OK |
| RustFFIEnricher.ts | 271 | OK |

**File sizes:** FAIL — ServiceConnectionEnricher.ts is at 506 lines, breaching the 500-line hard limit.

---

## Method Quality

### ServiceConnectionEnricher.execute() — lines 87–309 (223 lines)

This method has grown well beyond acceptable size. The 50-line limit for methods exists precisely to prevent this. At 223 lines, execute() currently does six distinct things in sequence:

1. Builds service map
2. Fetches routing map from resource registry
3. Collects route nodes with inline progress reporting
4. Collects request nodes with inline progress reporting
5. Marks customer-facing routes
6. Runs the full request-to-route matching loop (itself ~120 lines, containing nested error handling, route iteration, edge creation, and HTTP_RECEIVES logic)

The onProgress addition did not cause this problem — execute() was already large before REG-495. But REG-495 pushed the file over the 500-line hard limit, and the review must surface this.

**Recommendation:** MUST SPLIT. The file needs to be split before or immediately after this task lands.

### HTTPConnectionEnricher.execute() — lines 64–254 (191 lines)

Same structural problem as ServiceConnectionEnricher.execute(), at smaller scale. The method does: collect routes, collect requests, deduplicate, match, accumulate errors, log. The onProgress additions are fine, but the method was already overlong.

**Recommendation:** Candidate for split — not a blocker for this task, but technical debt.

### SocketConnectionEnricher.execute() — lines 51–157 (107 lines)

Over the 50-line limit (107 lines), but the structure is clean: collect 4 node sets, match unix, match TCP, log, return. The match logic is delegated to private methods. Acceptable given the delegation pattern.

**Recommendation:** SKIP refactor for this task.

### RustFFIEnricher.execute() — lines 42–100 (59 lines)

Marginally over 50 lines, but only because of the onProgress addition. Structure is clear: build index, find candidates, match, return. Delegation to private methods is correct.

**Recommendation:** SKIP.

### ConfigRoutingMapBuilder.execute() — lines 30–77 (48 lines)

Under 50 lines. No issues.

**Recommendation:** SKIP.

---

## Patterns & Naming

**onProgress pattern consistency:** The pattern used across all 5 files is consistent with the established convention from REG-497 (ArgumentParameterLinker, ImportExportLinker, etc.):

```typescript
const { graph, onProgress } = context;
// ...
if (onProgress && counter % 100 === 0) {
  onProgress({
    phase: 'enrichment',
    currentPlugin: 'PluginName',
    message: `Collecting X ${counter}`,
    totalFiles: 0,
    processedFiles: counter,
  });
}
```

This is correct. Pattern matches existing codebase usage.

**Counter variable names:**
- `routeCounter`, `requestCounter` — clear, unambiguous.
- `ri` — acceptable as loop index where full name would be `requestIndex`. Convention used elsewhere in the codebase.
- `funcCounter`, `methodCounter`, `callCounter` in RustFFIEnricher — clear.
- `ci` in RustFFIEnricher matching loop — acceptable.

**SocketConnectionEnricher progress calls:**
Six separate `if (onProgress)` blocks guard single unconditional calls (no modulo). This is different from the collection-phase pattern in other files. The intent is phase transitions (before-collect, before-match), not iteration progress. This is legitimate given socket node counts are typically tiny (1–5 nodes). No objection.

**Duplication assessment:**
The onProgress block shape repeats ~20+ times across the 5 files. The `CLAUDE.md` rule is "same pattern 3+ times = extract helper." However:

1. The pattern is already the codebase standard — it was established in REG-497 across 10 plugins. Extracting it now would be a refactor outside this task's scope.
2. The `currentPlugin` string differs per file, so extraction would require a parameter.
3. This is acknowledged technical debt, not a bug.

**Verdict on duplication:** Not a blocker for this task. Should be tracked as a separate tech debt item if the team decides to extract a `reportProgress()` helper on the base `Plugin` class.

---

## Blocking Issue

**ServiceConnectionEnricher.ts at 506 lines breaches the 500-line hard limit.** Per the Code Quality Review rules, this is a MUST SPLIT condition:

> File > 500 lines = MUST split. Create tech debt issue if can't split safely.

The file crossed the limit during this task (was ~472 before, ~506 after). The split cannot be deferred silently.

**Resolution options:**

1. **Split the file now** — Extract the path matching utilities (`normalizeUrl`, `hasParams`, `pathsMatch`, `buildParamRegex`, `escapeRegExp`) into a shared `HttpPathMatcher.ts` helper. These 5 methods (~40 lines) are already duplicated verbatim between `ServiceConnectionEnricher.ts` and `HTTPConnectionEnricher.ts` (a DRY violation). Extracting them brings ServiceConnectionEnricher below 470 lines and eliminates the duplication.

2. **Create a tech debt issue** — If a safe split cannot be done within this task's scope, create a Linear issue and document it explicitly.

Option 1 is preferable because it also fixes the DRY violation (the path matching code is copy-pasted between the two HTTP enrichers).

---

## Summary

**File sizes:** FAIL — ServiceConnectionEnricher.ts at 506 lines breaches the hard limit.
**Method quality:** FAIL — execute() methods in ServiceConnectionEnricher (223 lines) and HTTPConnectionEnricher (191 lines) are severely over the 50-line limit. Pre-existing issue, not introduced by REG-495, but the file now also breaches the file-size limit.
**Patterns & naming:** OK — onProgress pattern matches codebase convention, counter names are clear.

**If REJECT:**
- ServiceConnectionEnricher.ts must be brought under 500 lines. Extract `HttpPathMatcher` utilities shared with HTTPConnectionEnricher — this also fixes the DRY violation where these 5 methods are duplicated verbatim between the two files.
- The execute() method sizes in ServiceConnectionEnricher and HTTPConnectionEnricher should be tracked as a tech debt Linear issue, but do not need to be fixed in this task.
