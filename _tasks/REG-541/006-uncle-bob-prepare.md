## Uncle Bob PREPARE Review: REG-541

### NodeFactory.ts

**File:** `packages/core/src/core/NodeFactory.ts`
**File size:** 275 lines — OK

**Methods to modify:**
- 4 new static bindings to add (lines 79–113 block) — trivial, one line each, pure delegation pattern
- `validate()` (lines 191–274) — 83 lines, moderate complexity

**validate() assessment:** The method is a flat lookup table (Record<string, NodeValidator>) plus a linear chain of `if (DomainNode.isDomainType(node.type))` guards. Adding 4 new types is straightforward: 2 go into the lookup table (GRAPH_META, GUARANTEE are core types that follow the existing static-validator pattern), 2 go into the guard chain (SYSTEM_DB_VIEW_REGISTRATION, SYSTEM_DB_SUBSCRIPTION will need a `SystemFactory.isSystemDbType()` check, following the `DatabaseNode.isDatabaseType()` pattern already present). No structural change to the method needed.

**Cleanup opportunities:** None. The file is clean by design — it is already a pure static facade. The binding block and validate() are both in correct state. The existing pattern (bindings by domain section + section comments) is exactly right.

**Recommendation:** SKIP refactoring. Add new lines in the correct sections; no prep work required.

---

### CoreFactory.ts

**File:** `packages/core/src/core/factories/CoreFactory.ts`
**File size:** 489 lines — approaching limit, but OK

**Methods to modify:** add `createGraphMeta()` and `createGuarantee()` — new static methods, not modifying existing ones.

**Assessment:** The file is well-structured. The 489-line count is inflated primarily by the interface block at the top (lines 55–236, ~180 lines of typed option interfaces, one per factory method). This is an intentional pattern used consistently across all domain factories — each method has a named options interface local to the file. The interface block and factory method block are cleanly separated.

Adding `createGraphMeta` and `createGuarantee` requires:
1. New option interfaces (expected: 5–15 lines each)
2. New static methods (expected: 3–8 lines each)

The file will grow to approximately 510–520 lines. This remains below the 500-line soft limit only if the new methods are compact. Monitor but not a blocking concern.

**One genuine concern:** The double comment block at lines 183–188 (`/** Extract... */` immediately followed by `/** Extract... */` for the same function) is a cosmetic inconsistency — a stale JSDoc from a previous version of `extractServiceDependencies`. However, this is in PhaseRunner, not CoreFactory. CoreFactory itself is clean.

**Recommendation:** SKIP refactoring. Append new interfaces and methods at the end of the existing pattern. No prep work required.

---

### PhaseRunner.ts

**File:** `packages/core/src/PhaseRunner.ts`
**File size:** 500 lines — at the soft limit boundary

**Methods to modify:**
- `buildPluginContext()` (lines 111–176, 65 lines) — we will inject GraphFactory as `context.graph`
- Constructor (lines 57–60) — may need to accept GraphFactory construction options
- No other methods are directly touched

**buildPluginContext() assessment:** The method is 65 lines — above the 50-line "skip" threshold. However, the complexity is not intrinsic to the method itself: ~30 lines are a config-merging block that handles three cases (no config, merge routing, merge services). The remaining 35 lines are straightforward field assignment and the `reportIssue` closure for VALIDATION phase.

The GraphFactory injection point is clear: the method receives `baseContext: Partial<PluginContext> & { graph }` and spreads it into `pluginContext`. GraphFactory will be constructed in PhaseRunner and injected as `baseContext.graph` before `buildPluginContext` is called — or alternatively, constructed once in PhaseRunner's constructor and substituted at the `context.graph` assignment inside this method.

**The double comment on lines 183–188 is the only actual noise:** Two consecutive JSDoc blocks for the same method `extractServiceDependencies`. This is a leftover from when the method comment was revised. It does not affect behavior but is confusing.

**Recommendation:** REFACTOR — one specific action before implementation:

Remove the duplicate JSDoc block. Lines 183–186 (`/** Extract service dependency package names from the ANALYSIS phase manifest. Merges dependencies... */`) are the stale first version. Lines 187–192 are the current correct version. Delete lines 183–186 only.

This is a 4-line deletion, 5 minutes max, zero risk. It removes noise directly in the method we're modifying and prevents confusion during implementation of the GraphFactory injection.

No other refactoring needed. The method itself does not require structural changes before implementation.

---

### Orchestrator.ts

**File:** `packages/core/src/Orchestrator.ts`
**File size:** 613 lines — MUST SPLIT threshold (>500), below CRITICAL (>700)

**Methods to modify:**
- `constructor` (lines 82–156, 74 lines) — update DiscoveryManager instantiation at line 132

**Constructor assessment:** The constructor is 74 lines. It is an initialization sequence for 11 fields + 5 subsystems. The overall structure is acceptable for a coordinator class, but there are two issues:

1. **Comment style inconsistency:** Lines 87–113 mix Russian inline comments (`# ГОРИЗОНТАЛЬНОЕ МАСШТАБИРОВАНИЕ`, `# Callback для прогресса`, `# Флаг для игнорирования кэша`, `# Фильтр для одного сервиса`) with English JSDoc on the class itself and English comments elsewhere. Not a blocking issue, but inconsistent.

2. **The actual modification is minimal and low-risk:** Line 132 changes from:
   ```ts
   this.discoveryManager = new DiscoveryManager(
     this.plugins, this.graph, this.config, this.logger, this.onProgress, this.configServices,
   );
   ```
   to passing a GraphFactory instance instead of `this.graph`. The GraphFactory is constructed in PhaseRunner (per the plan), so Orchestrator needs either a reference to it or constructs its own. The plan's Option B means Orchestrator passes the same `GraphFactory` instance (which wraps `this.graph`) to DiscoveryManager.

**The 613-line concern:** The file exceeds 500 lines and MUST SPLIT — but this is pre-existing technical debt, not introduced by REG-541. The REG-541 change to Orchestrator is a single line substitution at line 132. Splitting Orchestrator is not part of REG-541 scope, and doing it now (in STEP 2.5) would be high-risk scope creep.

**Recommendation:** SKIP refactoring on Orchestrator. The modification is a 1-line substitution at line 132 — isolated, low-risk, does not touch any large method. Log the 613-line size as a note for a follow-up cleanup task, but do not split now.

Note the file size in the PR description so the reviewer knows it is pre-existing debt, not new.

---

## Overall Risk Assessment

**Overall risk:** LOW

The 4 files are clean and well-structured. The changes we're making to each are small and mechanically clear:

| File | Change Size | Risk |
|------|-------------|------|
| NodeFactory.ts | +4 bindings, +4 type entries in validate() | Trivial |
| CoreFactory.ts | +2 interfaces, +2 methods | Trivial |
| PhaseRunner.ts | +GraphFactory construction + 1 injection point | Low |
| Orchestrator.ts | +1 line substitution at constructor line 132 | Trivial |

**Estimated prep scope:** 4-line deletion in PhaseRunner.ts (duplicate JSDoc). 15 minutes including verification. No other prep work is warranted.

**Pre-implementation checklist:**
1. Delete duplicate JSDoc on `extractServiceDependencies` in PhaseRunner.ts (lines 183–186)
2. Verify SystemFactory node type check pattern matches DatabaseNode.isDatabaseType() before touching validate()
3. Confirm CoreFactory.ts stays under 520 lines after additions (monitor — not a blocker)
4. Do NOT split Orchestrator.ts — it is pre-existing debt outside REG-541 scope
