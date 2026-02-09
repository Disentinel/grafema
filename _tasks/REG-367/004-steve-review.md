# Steve Jobs Review: REG-367 Replace priority with declarative depends_on

**Reviewed:** 2026-02-09

## Executive Summary

This is exactly the kind of architectural improvement Grafema needs. Replacing implicit numeric priorities with explicit dependency declarations is a fundamental shift from "magic numbers" to declarative, self-documenting architecture.

**Decision: APPROVE**

## Detailed Review

### 1. Complexity & Architecture Checklist

**✅ Complexity Check:**
- Toposort runs once per phase during plugin registration
- O(V+E) where V<15 plugins per phase
- NOT scanning all nodes/edges in the graph
- **PASS** — appropriate algorithmic complexity

**✅ Plugin Architecture:**
- Uses existing `dependencies` field (already in PluginMetadata)
- No new abstractions needed
- Extends existing registration mechanism
- **PASS** — leverages existing infrastructure

**✅ Extensibility:**
- Adding new plugin: declare dependencies explicitly
- No coordinator changes needed for new plugins
- Self-documenting through dependency declarations
- **PASS** — scalable pattern

**✅ No Brute-Force:**
- This is about plugin registration order, not graph traversal
- N/A — but principle holds: declarative beats imperative
- **PASS**

### 2. Vision Alignment

**Does this align with "AI should query the graph, not read code"?**

YES — Indirectly but importantly. Clean plugin architecture means:
- Easier to add new enrichers (more queryable data)
- Clearer mental model for contributors
- Less time debugging priority bugs, more time building features

This is infrastructure that enables the vision.

### 3. Corner-Cutting Check

**Did we cut corners?**

NO. The plan does it RIGHT:

1. **No half-measures**: Removes `priority` completely, not keeping it as fallback
2. **Proper algorithm**: Kahn's algorithm with cycle detection, not hacky sort
3. **Cross-phase deps handled correctly**: Informational only (phases are sequential)
4. **Registration order as tiebreaker**: Preserves determinism without magic numbers

**Critical decision well-made:**
- Keeping `dependencies` name instead of renaming to `depends_on`
- Pragmatic: 25+ plugins already use it, renaming adds risk for zero benefit
- This is NOT corner-cutting, it's being practical about existing reality

### 4. Architectural Gaps

**Are there fundamental gaps that make this useless?**

NO — but let's verify edge cases:

**✅ Cross-phase dependencies:**
- Plan correctly identifies these as informational only
- Phases run sequentially by design (DISCOVERY→INDEXING→ANALYSIS→ENRICHMENT→VALIDATION)
- No architectural issue here

**✅ Cycle detection:**
- Kahn's algorithm detects cycles naturally
- Error thrown with plugin names → developer fix immediately
- **CORRECT** — fail fast on invalid configuration

**✅ Missing dependencies:**
- Plan adds dependencies to 12 plugins that lack them
- Derived from priority comments and code analysis
- **CONCERN**: How do we verify these are correct?

### 5. "MVP Limitations" Check

**Does this work for <50% of real-world cases?**

NO limitations that defeat the purpose:

- Handles intra-phase dependencies (the common case)
- Handles cross-phase deps (marks as informational)
- Handles cycles (detects and fails)
- Handles registration order tiebreaker (deterministic)

**Coverage: ~100%** of plugin dependency scenarios

### 6. Would Shipping This Embarrass Us?

**NO.**

This is clean, correct architecture:
- Industry-standard algorithm (Kahn's toposort)
- Declarative over imperative
- Self-documenting code
- Removes technical debt (magic priority numbers)

Shipping this is **GOOD FOR GRAFEMA'S REPUTATION**.

## Concerns & Questions

### Medium Priority: Dependency Verification

**Issue:** Adding dependencies to 12 plugins based on "priority comments and code analysis."

**Question:** How confident are we these are correct?

**Mitigation in plan:**
- Integration tests will catch wrong deps (plugins fail to access expected data)
- Existing behavior preserved (toposort should match old priority order)

**Verdict:** Acceptable risk. Integration tests will validate.

### Low Priority: Documentation

**Missing:** No mention of updating developer docs about plugin dependency declarations.

**Impact:** New plugin authors might not know to declare dependencies.

**Recommendation:** Add brief section to plugin authoring guide.

**Verdict:** Nice-to-have, not blocking.

## What I Like

1. **No compromises**: Priority field GONE, not deprecated
2. **Proper algorithm**: Kahn's, not bubble sort hacks
3. **Tests planned**: 10 unit cases + integration
4. **Preserves determinism**: Registration order tiebreaker
5. **Pragmatic naming**: Keeps `dependencies`, doesn't bikeshed to `depends_on`

## What Would Make Me Reject

If this plan had:
- Kept `priority` as fallback "just in case"
- Used naive sorting without cycle detection
- Skipped tests
- Added breaking changes without necessity

**None of these are present.**

## Final Verdict

**APPROVE**

This is architectural improvement done RIGHT:
- Removes technical debt
- Uses correct algorithm
- Declarative over imperative
- Tests included
- No corner-cutting

Ship it.

---

**Escalate to Вадим for final confirmation.**
