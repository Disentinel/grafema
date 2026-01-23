# Linus Torvalds' Review of REG-97 Plan

## The Big Picture Issue

**The original request says:** "Изменённые файлы переанализируются перед проверкой" (Changed files ARE re-analyzed before check)

**The plan says:** "Warn but don't auto-reanalyze (user must run `grafema analyze`)"

**This is a fundamental mismatch.** The acceptance criteria explicitly states:
- "Изменённые файлы переанализируются перед проверкой" (Changed files are reanalyzed before check)

Don's plan includes an API for `reanalyzeStale()` in the interface but Joel's detailed spec completely IGNORES it. Joel's implementation only shows a warning and tells the user to run `grafema analyze` themselves.

This is not what was asked for. This is doing the EASY thing and calling it the RIGHT thing.

## What Was Actually Requested

1. `grafema check` automatically checks graph freshness - **Planned: YES**
2. Changed files are reanalyzed before check - **Planned: NO, just a warning**
3. `--skip-reanalysis` flag to skip (CI optimization) - **Planned: YES (but backwards)**
4. Warning output when files were reanalyzed - **Planned: NO (warning about staleness instead)**
5. Performance < 1s for 1000 files - **Planned: YES**

The `--skip-reanalysis` flag implies there IS automatic reanalysis by default. If there's no reanalysis, what is this flag skipping?

## The Architectural Cop-Out

Don correctly identified that Phase 2 needs `IncrementalReanalyzer` but then wrote this:

> **Key insight**: The existing `Orchestrator.run()` with `forceAnalysis=true` is too heavy-handed. We need selective re-analysis.

Then Joel completely punted on this. Phase 2 doesn't exist in Joel's tech spec. The `reanalyzeStale()` method that Don designed? Nowhere in Joel's implementation.

This is a classic case of "Phase 2 - Draw the rest of the owl."

## Is This a Hack?

Yes. This is doing 50% of the feature and calling it done. The detection half is well-designed. The reanalysis half is missing entirely.

However, I'll acknowledge there's nuance here:

1. **Detection-only IS useful for CI** - With `--fail-on-stale`, CI can catch when developers forget to run `grafema analyze`. That's valuable.

2. **Reanalysis is genuinely harder** - It requires orchestrating the analysis pipeline for just a subset of files. The Orchestrator isn't designed for this.

## What Would Be RIGHT

**Option A: Full Implementation (what was requested)**
- Implement Phase 2 properly
- Create `IncrementalReanalyzer` that can run analysis pipeline on specific modules
- Default behavior: detect and reanalyze
- `--skip-reanalysis`: only detect, warn, proceed
- `--fail-on-stale`: detect, fail if stale

**Option B: Scoped-Down Implementation (honest about limitations)**
- Detection only, but be CLEAR about it in the ticket
- Change acceptance criteria to match reality
- Create a follow-up ticket for actual reanalysis
- Name the feature honestly: "Graph Staleness Detection" not "Auto-reanalyze"

The plan takes neither option. It pretends to do Option A while delivering Option B without acknowledging the gap.

## Specific Technical Issues

1. **CLI code duplication** - The freshness check logic appears in TWO places in check.ts (once in the main action, theoretically again in `runBuiltInValidator`). Joel's spec only shows integration with the main flow, not with built-in validators. Both paths need freshness checking.

2. **The `--skip-reanalysis` flag is confusing** - If there's no reanalysis, what does this skip? The name implies the feature does something it doesn't do. Should be `--skip-freshness-check` if that's what it does.

3. **Hash function duplication** - There are already THREE implementations of `calculateFileHash()`. Joel's plan creates a FOURTH in `GraphFreshnessChecker._calculateFileHash()`. The plan says "Same algorithm as JSModuleIndexer and JSASTAnalyzer" but doesn't actually unify them. This is the EASY approach, not the RIGHT one.

## The Verdict

**This plan is 60% of the right thing.**

The detection part is well-designed. The architecture (separate `GraphFreshnessChecker` service) is correct. The interface is sensible. The test plan is reasonable.

But it completely skips the hard part - actual reanalysis - while naming flags as if it exists.

## My Recommendation

**Do not approve as-is.**

Either:

1. **Implement Phase 2 properly** - Add `IncrementalReanalyzer` that uses the existing analysis plugins to update specific modules. This is the actual feature request.

2. **Or rescope the ticket honestly:**
   - Rename to "Graph Staleness Detection"
   - Remove "auto-reanalyze" from the name and acceptance criteria
   - Rename `--skip-reanalysis` to `--skip-freshness-check`
   - Create REG-XX for actual incremental reanalysis
   - Document this as a limitation

I can accept Option 2 if the team acknowledges this is a stepping stone, not the complete feature. Ship detection now, ship reanalysis later. But don't ship detection and pretend you shipped reanalysis.

Also: unify the hash functions. Having four copies of the same SHA-256 call is embarrassing.

## Summary

| Aspect | Status |
|--------|--------|
| Detection architecture | ✅ Good |
| Reanalysis architecture | ❌ Missing |
| Flag naming | ⚠️ Confusing |
| Hash function DRY | ❌ Fourth copy |
| Overall | ⚠️ Needs revision |
