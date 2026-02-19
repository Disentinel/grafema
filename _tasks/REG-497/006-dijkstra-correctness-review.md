## Dijkstra Correctness Review

**Verdict:** APPROVE (with one noted semantic imprecision that does not affect correctness)

---

**Files reviewed:**
- `BrokenImportValidator.ts`
- `CallResolverValidator.ts`
- `GraphConnectivityValidator.ts`
- `SQLInjectionValidator.ts`
- `AwaitInLoopValidator.ts`
- `ShadowingDetector.ts`
- `DataFlowValidator.ts`
- `TypeScriptDeadCodeValidator.ts`
- `EvalBanValidator.ts`
- `UnconnectedRouteValidator.ts`
- `PackageCoverageValidator.ts`

---

## Functions reviewed (verdict per validator)

| Validator | Guard correct? | Counter order correct? | Counter scope clean? | Loop termination safe? | Zero-fire risk? | Verdict |
|---|---|---|---|---|---|---|
| BrokenImportValidator | YES | YES (`stats.importsChecked++` before `% 100 === 0`) | YES — fresh stats field | YES | NO — starts at 0, increments before check | PASS |
| CallResolverValidator | YES | YES (`summary.totalCalls++` before `% 500 === 0`) | YES — fresh summary field | YES | NO | PASS |
| GraphConnectivityValidator | YES | YES (`collected++` before check; `reachable.size` checked after `reachable.add()`) | YES — separate `collected` variable | YES | NO — `reachable.size` is checked after `.add()`, so minimum value at check point is 1 | PASS |
| SQLInjectionValidator | YES | YES (both `scannedCalls` and `analyzed` incremented before check) | YES — two separate counters, neither aliases existing semantics | YES | NO | PASS |
| AwaitInLoopValidator | YES | YES (`scannedCalls++` before `% 500 === 0`) | YES — dedicated variable, `issueCount` is separate and not used as counter | YES | NO | PASS |
| ShadowingDetector | YES | YES (all four collection loops and both check loops increment before modulo check) | MINOR NOTE — `collected` is shared across four sequential collection loops, and `checked` is reset to 0 between the two check phases. This is correct. | YES | NO | PASS |
| DataFlowValidator | YES | YES (`collected++` before check in both collection loops; `checked++` before check in validation loop) | YES — `collected` and `checked` are distinct and `checked` is reset between independent phases | YES | NO | PASS |
| TypeScriptDeadCodeValidator | YES | YES (`collected++` before `% 500 === 0`; `checked++` before `% 200 === 0`) | YES — two separate counters for collection vs checking phases | YES | NO | PASS |
| EvalBanValidator | YES | YES (`scannedCalls++` before `% 500 === 0` in all three loops) | SEE NOTE BELOW | YES | NO | PASS (with note) |
| UnconnectedRouteValidator | YES | YES (`routesChecked++` before `% 200 === 0`) | YES — dedicated variable, `issueCount` is separate | YES | NO | PASS |
| PackageCoverageValidator | YES | YES (`importsScanned++` before `% 500 === 0`) | YES — dedicated variable | YES | NO | PASS |

---

## Issues found

**No correctness bugs.** One semantic imprecision noted:

### EvalBanValidator — `scannedCalls` shared across three independent passes

`EvalBanValidator.execute` makes three separate `for await` loops over `graph.queryNodes({ nodeType: 'CALL' })`, and all three loops increment and test the **same** `scannedCalls` variable:

- Loop 1 (eval detection): `scannedCalls` runs 0 → N
- Loop 2 (Function detection): `scannedCalls` runs N → 2N
- Loop 3 (method eval detection): `scannedCalls` runs 2N → 3N

The `onProgress` callback is correctly guarded and the counter increments before the modulo test in all three loops, so **the callback fires at the right points without premature fire**. This is not a correctness defect.

The imprecision: the `message` field reports `"Scanning for eval patterns: X calls checked"` where X grows past the total CALL count (the same dataset is scanned three times). The value of `processedFiles` will reach 3N by end of execution, which misrepresents progress as "more than 100%" to any consumer normalizing against the total. This is a **display/UX imprecision**, not a callback safety issue. The guard, the increment order, and loop termination are all correct.

**Assessment:** Not a bug that requires remediation under this task's scope, but worth noting in a follow-up for the EvalBanValidator's future refactor into a single-pass implementation.

---

## Checklist verification

1. **Guard correctness** — All 10 validators check `if (onProgress && ...)` before invoking the callback. No unguarded call exists.

2. **Counter increment order** — In every case, the counter is incremented (`counter++`) on the line immediately before or as part of the same expression that precedes the modulo check. The pattern is consistently: increment, then `if (onProgress && counter % N === 0)`. The modulo-zero premature fire cannot occur because no counter starts at 0 and is tested before its first increment.

3. **Counter scope isolation** — All counters are fresh local variables (`let scannedCalls = 0`, `let collected = 0`, etc.) or fields on fresh local summary objects. None of them alias or shadow existing semantic variables (e.g., `issueCount` tracks a different quantity than the iteration counter in every file that uses both).

4. **Loop termination** — The `onProgress` call is unconditional except for the guard and the modulo test. It performs no mutation of graph state, no `break`/`continue` (the call is isolated to the `if` block), and does not throw unless the caller-provided callback throws. Fire-and-forget semantics are preserved in all 10 validators.

5. **Modulo edge case (0 % N === 0)** — No premature fire. Every counter starts at 0 and is incremented to at least 1 before the modulo test is evaluated for the first time.

---

**Signed:** Edsger W. Dijkstra
