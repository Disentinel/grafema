## Uncle Bob — Code Quality Review

**Verdict:** APPROVE (with notes)

---

**File sizes:** OK

All 10 files are well under the 500-line hard limit:

| File | Lines |
|------|-------|
| AwaitInLoopValidator.ts | 101 |
| UnconnectedRouteValidator.ts | 104 |
| PackageCoverageValidator.ts | 192 |
| CallResolverValidator.ts | 199 |
| EvalBanValidator.ts | 204 |
| TypeScriptDeadCodeValidator.ts | 215 |
| DataFlowValidator.ts | 230 |
| ShadowingDetector.ts | 245 |
| GraphConnectivityValidator.ts | 228 |
| BrokenImportValidator.ts | 324 |
| SQLInjectionValidator.ts | 428 |

No file violates the limit.

---

**Method quality:** OVER LIMIT (not a blocker for this task — see instructions)

The 50-line guideline for `execute()` is exceeded across most validators. This is pre-existing technical debt, not introduced by REG-497. The onProgress additions are minimal (3–6 lines per block), so they are not the cause.

Measured `execute()` sizes (approximate line counts):

| File | execute() lines |
|------|----------------|
| UnconnectedRouteValidator | ~62 |
| CallResolverValidator | ~71 |
| SQLInjectionValidator | ~131 |
| EvalBanValidator | ~133 |
| GraphConnectivityValidator | ~173 |
| BrokenImportValidator | ~235 |

These are candidates for future refactoring but are explicitly out of scope per the task instructions ("candidate for split, not blocker for this task").

---

**Patterns & naming:** ONE NAMING DEFECT

The onProgress pattern is applied consistently across all 10 files. Every `execute()` correctly:
1. Destructures `onProgress` from `context` on the first line
2. Guards each call with `if (onProgress && counter % N === 0)`
3. Reports `phase: 'validation'` and `currentPlugin: <ClassName>`

Counter variable names are clear in 9 of 10 files:
- `scannedCalls` (EvalBanValidator, SQLInjectionValidator) — precise
- `collected` (GraphConnectivityValidator) — acceptable
- `routesChecked` (UnconnectedRouteValidator) — precise
- `importsScanned`, `callsChecked` (BrokenImportValidator) — precise
- `totalCalls` reused as counter (CallResolverValidator) — doubles as summary field, acceptable

**One defect — EvalBanValidator.ts, `scannedCalls` counter:**

The variable `scannedCalls` is incremented inside three separate `for await` loops, each iterating over `graph.queryNodes({ nodeType: 'CALL' })`. By the time the third loop completes, `scannedCalls` holds approximately 3× the actual number of CALL nodes in the graph. The progress messages report this inflated number as "calls checked", which is misleading. The name implies unique calls scanned, but the implementation counts loop iterations across three passes.

This is a low-severity issue — the progress reporting still fires at correct intervals and does not affect correctness — but the reported number misleads the caller about progress through the node population.

**Risk:** LOW
**Scope:** EvalBanValidator.ts lines 88–172 (three loops, one shared counter)

Recommendation: either reset or use a separate counter per pass, or restructure the three passes into one (which would also fix the triple-scan inefficiency). Out of scope for REG-497, but worth a tech debt note.

---

**Duplication assessment:** CORRECT

The onProgress blocks are intentionally duplicated across independent plugin files. Each validator is a self-contained unit with no shared execution path. This is the correct pattern — extracting a shared helper would create false coupling between independent validators. The duplication is appropriate here.

---

**Summary:**

REG-497 added `onProgress` support cleanly and consistently. The pattern is uniform across all 10 files. The only quality note is a misleading counter in EvalBanValidator that predates this task's scope. No regressions introduced.
