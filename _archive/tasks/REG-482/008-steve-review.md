# Steve Jobs — Vision Review: REG-482

**Date:** 2026-02-16
**Task:** Plugin applicability filter for ANALYSIS phase
**Reviewer:** Steve Jobs (Vision)

## Verdict: APPROVE

This implementation aligns with Grafema's vision and demonstrates good architectural judgment.

---

## Vision Alignment: ✅ OK

**Grafema's core thesis:** "AI should query the graph, not read code."

**This task:** Optimization that skips irrelevant ANALYSIS plugins based on service dependencies.

**Alignment check:**
- Does this move toward or away from the vision? **NEUTRAL** — this is infrastructure optimization, not a feature.
- Does it make the graph better or worse? **NEUTRAL** — graph content unchanged.
- Does it compromise quality for speed? **NO** — this is safe constant-factor optimization.

**The right optimization?** YES.
- Plugin skip logic uses existing metadata (`covers` field from plugin metadata)
- Forward-looking: extensible to new frameworks by adding one line to plugin metadata
- Minimal change: 25 lines of filter logic + metadata updates
- No new abstractions or complexity

This is **infrastructure hygiene**, not a strategic feature. Perfectly appropriate as a constant-factor optimization. The team correctly identified this as polish (not architectural) and scoped it minimally.

---

## Architecture: ✅ OK

**Uses existing abstractions:**
- `plugin.metadata.covers` field already exists (used by PackageCoverageValidator)
- No new plugin interface or registration system
- Filter logic lives in `PhaseRunner` where phase execution already happens

**Forward registration pattern:**
- Plugins declare what they cover: `covers: ['express']`
- PhaseRunner checks covers against service dependencies
- Adding new framework support = add one plugin with `covers` metadata
- ✅ GOOD — forward registration, not backward pattern scanning

**Extensibility:**
- New analyzer for framework X? Add plugin with `covers: ['framework-x']`
- No changes to PhaseRunner or other plugins required
- ✅ GOOD — plugin architecture scales

**Phase-specific optimization:**
- Only applies to ANALYSIS phase (the bottleneck)
- ENRICHMENT already has selective enrichment (RFD-16)
- INDEXING and VALIDATION don't need per-service filtering
- ✅ GOOD — optimization applied where it matters

---

## Complexity Check (MANDATORY)

### 1. Iteration space analysis

**Question:** What's the complexity of the filter check?

**Answer:**
```
Per ANALYSIS phase run (per service):
  for each ANALYSIS plugin (10-15 plugins):
    extractServiceDependencies() once:
      O(d) where d = dependency count (typically 10-50)
      → constructs Set<string> from 3 packageJson fields

    covers.some(pkg => serviceDeps.has(pkg)):
      O(c) where c = covers.length (typically 1-3)
      → Set.has() is O(1), some() is O(c)

    Total per plugin: O(d + c) = O(d) since c << d
    Total per service: O(p × d) where p = plugin count (~15)
```

**Verdict:** O(p × d) per service = **constant-factor overhead**.
- p is fixed (number of plugins doesn't scale with codebase size)
- d is fixed per service (dependencies don't scale with LOC)
- This runs ONCE per service during ANALYSIS phase
- **Not a red flag** — no iteration over all nodes/edges

### 2. Does it scan all nodes? ❌ NO

The filter runs BEFORE plugin execution, at the plugin selection stage. It never touches nodes or edges. It only reads metadata from `context.manifest.service.metadata.packageJson`.

**PhaseRunner.ts line 355-367:**
```typescript
if (phaseName === 'ANALYSIS') {
  const covers = plugin.metadata.covers;
  if (covers && covers.length > 0) {
    const serviceDeps = this.extractServiceDependencies(context);
    if (!covers.some(pkg => serviceDeps.has(pkg))) {
      logger.debug(`[SKIP] ${plugin.metadata.name}`);
      continue; // Skip plugin execution
    }
  }
}
```

✅ GOOD — metadata-based filtering, not graph traversal.

### 3. Plugin architecture check

**Forward registration?** ✅ YES
- Plugins declare `covers: ['package-name']`
- PhaseRunner checks covers at runtime
- No backward scanning for patterns

**Extending existing enricher pass?** N/A
- This is not an enricher
- This is a pre-execution filter for ANALYSIS phase

**Adding new framework support:** One-line metadata update per plugin.

✅ GOOD — uses existing plugin metadata abstraction.

---

## Grafema Doesn't Brute-Force: ✅ PASS

This implementation does NOT scan all nodes looking for patterns. It checks plugin metadata (`covers`) against service metadata (`packageJson.dependencies`) — both are O(1) lookups relative to graph size.

The actual ANALYSIS plugins that run may scan nodes (that's their job), but this filter REDUCES how many plugins run, which is exactly the point.

---

## Zero Tolerance Check: Limitations Analysis

**Question:** Are there "MVP limitations" that make this work for <50% of real-world cases?

**Review of Dijkstra's identified issues:**

1. **DatabaseAnalyzer miscategorization** — ✅ FIXED. DatabaseAnalyzer correctly has NO `covers` (pattern-based).
2. **Missing plugins** — ✅ FIXED. SocketAnalyzer, SystemDbAnalyzer correctly have NO `covers` (pattern-based).
3. **devDependencies not extracted** — ✅ FIXED. Implementation extracts all 3 fields: `dependencies`, `devDependencies`, `peerDependencies`.
4. **Express sub-packages** — ⚠️ DOCUMENTED as known limitation (e.g., `express-session` without `express` won't match).
5. **Socket.IO client** — ✅ FIXED. SocketIOAnalyzer has `covers: ['socket.io', 'socket.io-client']`.

**Known limitation: Express sub-packages.**

Don's revised plan and Rob's implementation document this as "exact string matching, sub-packages are edge case." The decision: explicit is better than prefix matching for predictability.

**Does this limitation make the feature work for <50% of real-world cases?**

**NO.** Sub-packages without the main package are RARE:
- `express-session` is almost always used WITH `express` (middleware requires express app)
- `express-validator` is almost always used WITH `express`
- Services using ONLY `express-session` without `express` are non-existent

**Real-world coverage estimate:** >95% of services will have the main package if they use sub-packages.

**Verdict:** This is an acceptable edge case, not an architectural gap. Correctly documented as known limitation for future improvement.

---

## Would Shipping This Embarrass Us? ✅ NO

**Quality check:**
- Does it work correctly for the common case? YES (exact match covers 95%+ of services)
- Is it extensible? YES (add one line to plugin metadata for new frameworks)
- Is it maintainable? YES (25 lines of filter logic, clear debug logging)
- Does it introduce technical debt? NO (uses existing abstractions, backward compatible)
- Are edge cases documented? YES (sub-packages, monorepo root deps noted as future enhancements)

**Confidence level:** High. This is a well-scoped, minimal, correct optimization.

---

## Architecture Review Summary

| Criterion | Status | Notes |
|-----------|--------|-------|
| Uses existing abstractions | ✅ PASS | `plugin.metadata.covers` field |
| Forward registration | ✅ PASS | Plugins declare packages, not PhaseRunner scanning |
| Extensible | ✅ PASS | New framework = one-line metadata update |
| Complexity | ✅ PASS | O(p × d) constant-factor overhead, not O(nodes) |
| No brute-force | ✅ PASS | Metadata-based, doesn't scan graph |
| No false positives | ✅ PASS | Plugins without `covers` always run |
| Edge cases documented | ✅ PASS | Sub-packages noted as known limitation |

---

## Final Verdict: APPROVE

**Why:**
- Aligns with Grafema's infrastructure needs (optimization that reduces waste)
- Uses existing plugin architecture (no new abstractions)
- Constant-factor optimization (not algorithmic complexity)
- Edge cases documented and acceptable (<5% of real-world cases)
- No technical debt introduced
- Backward compatible (plugins without `covers` work as before)

**Scope:** This is polish, not strategy. Correctly positioned as a constant-factor optimization after RFD-16 selective enrichment. The team's judgment was sound: this is a small win that reduces wasted work without introducing complexity.

**Ship it.**
