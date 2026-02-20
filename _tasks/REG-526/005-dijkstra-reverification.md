# REG-526: Dijkstra Re-Verification (Plan v2)

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-20
**Verdict:** **APPROVE**

---

## Executive Summary

Don's revised plan v2 **fully addresses all 21 requirements**. All critical gaps from v1 have been resolved:

✅ **Methodology changed from sampling to exhaustive** (line-by-line checking)
✅ **State schema redesigned** (per-file tracking, bug/gap registries, version tracking)
✅ **Bug vs Gap distinction** implemented with blocking behavior
✅ **Session limits** added (10 bugs per session)
✅ **Version tracking** added with auto-recheck on version change
✅ **File ordering** specified (Orchestrator.ts first, largest-to-smallest)
✅ **Per-file resume** via `lastCheckedLine`
✅ **Custom tasks** tracked in `customTasks` registry

**Score: 21/21 PASS**

No new issues introduced by v2. Plan is ready for implementation.

---

## Quick Verification Table

| # | Requirement | PASS/FAIL | Note |
|---|-------------|-----------|------|
| 1 | Per-file state schema (`files.{path}` with `lastCheckedLine`, `entities`, `sessions`) | ✅ PASS | Lines 64-85, full per-file objects |
| 2 | Separate bug registry (`bugs.{BUG-NNN}` with verdict, evidence, Linear issue) | ✅ PASS | Lines 88-134, complete bug schema |
| 3 | Separate gap registry (`gaps.{GAP-NNN}` with blocking behavior) | ✅ PASS | Lines 137-151, includes blocking array |
| 4 | Custom tasks registry (`customTasks.{TASK-NNN}`) | ✅ PASS | Lines 153-161, with prompt/status/results |
| 5 | Coverage summary (`totalFiles`, `checkedFiles`, `totalEntities`, `checkedEntities`, `passRate`) | ✅ PASS | Lines 164-170, all fields present |
| 6 | History per version (`history[]`) | ✅ PASS | Lines 172-179, tracks version + date + results |
| 7 | Version field (extension version from `package.json`) | ✅ PASS | Line 61, + version detection logic lines 443-450 |
| 8 | **Line-by-line exhaustive checking** (NOT sampling) | ✅ PASS | Lines 279-283, 312-332: "every entity on every line" |
| 9 | File ordering (Orchestrator.ts first, then largest to smallest) | ✅ PASS | Lines 353-367, priority queue implementation |
| 10 | Session limits (10 bugs per session) | ✅ PASS | Lines 335-351, explicit stop logic |
| 11 | Bug vs Gap distinction (ui-bug, core-bug, infrastructure-gap) | ✅ PASS | Lines 372-416, full verdict logic |
| 12 | Blocking gaps (infrastructure gap → STOP, block files) | ✅ PASS | Lines 418-434, blocking behavior specified |
| 13 | Version tracking (on version change, re-check open bugs) | ✅ PASS | Lines 437-474, full version change workflow |
| 14 | `/qa` — auto-resume from `lastCheckedLine` | ✅ PASS | Line 192 schema + lines 1019, 1037-1062 skill logic |
| 15 | `/qa --recheck` — re-check previously found bugs | ✅ PASS | Lines 1030, 1064-1068, re-validate open bugs |
| 16 | Custom agent `.claude/agents/qa-agent.md` with full prompt | ✅ PASS | Section 6 (lines 478-996), complete agent spec |
| 17 | Skill `/qa` with args (file, --recheck, auto-resume, custom task) | ✅ PASS | Section 7 (lines 999-1109), all modes covered |
| 18 | Traverses file from **first to LAST line** without manual intervention | ✅ PASS | Lines 312-332, pipeline covers lines 1..totalLines |
| 19 | For each entity — checks all 6 panels (or notes blocked by gaps) | ✅ PASS | Lines 630-640, 716-783, all 6 panels validated |
| 20 | Bug verdict: ui-bug or core-bug with evidence via CLI/MCP | ✅ PASS | Lines 207-223, verdict field + evidence structure |
| 21 | `_qa/qa-state.json` correctly updates after each session | ✅ PASS | Lines 659-714, state update logic per line/bug/gap |

---

## Changes from v1 → v2

### Critical Changes (Gap Resolutions)

| Gap from v1 | Resolution in v2 | Evidence |
|-------------|------------------|----------|
| **GAP-001: Sampling vs Exhaustive** | Changed to line-by-line exhaustive | Lines 279-283: "checks **every entity on every line**, not a sample"; Lines 312-332: pipeline traverses all lines |
| **GAP-002: Flat state schema** | Redesigned to rich hierarchical schema | Lines 59-181: per-file objects, bug/gap/customTasks registries, coverage, history |
| **GAP-003: No bug vs gap distinction** | Added verdict logic + blocking | Lines 207-209 (verdict field), lines 372-416 (verdict logic), lines 418-434 (blocking) |
| **GAP-004: No session limits** | Added 10-bug limit | Lines 335-351: explicit stop after 10 bugs |
| **GAP-005: No version tracking** | Added version detection + re-check | Lines 437-474: version change detection + bug re-check workflow |
| **GAP-006: No file ordering** | Added priority queue | Lines 353-367: Orchestrator.ts first, size-sorted |
| **GAP-007: No per-file resume** | Added `lastCheckedLine` per file | Line 192 (schema), lines 318-320 (resume logic) |
| **GAP-008: Custom tasks not tracked** | Added `customTasks` registry | Lines 153-161 (schema), lines 234-240 (field definitions) |

### Methodology Validation

**v1 statement (REJECTED):**
> "Rate: ~5-10 entities per file (representative sample, not exhaustive)" — Line 302 of v1

**v2 statement (APPROVED):**
> "**CRITICAL CHANGE from v1:** The agent checks **every entity on every line**, not a sample." — Lines 279-283 of v2

**Pipeline confirmation:**
```markdown
For line_num in (lastCheckedLine + 1)..totalLines:
  a. Extract entities on this line
  b. For each entity:
       [full validation]
  c. Update state: lastCheckedLine = line_num
```
— Lines 318-328 of v2

✅ **Methodology matches issue requirement: exhaustive line-by-line checking**

---

## State Schema Validation

### v1 Schema (REJECTED)
```json
{
  "version": "1.0.0",           // Schema version (not extension version)
  "checked_entities": [...],    // Flat array
  "bugs_found": 0,              // Counter only
}
```

### v2 Schema (APPROVED)
```json
{
  "version": "0.1.0",                          // Extension version ✅
  "schemaVersion": "1.0.0",                    // Schema version (separate) ✅

  "files": {
    "path": {
      "lastCheckedLine": 150,                  // Per-file resume ✅
      "entities": { total, checked, ok, bugs, gaps }, // Coverage ✅
      "sessions": [...]                        // Session tracking ✅
    }
  },

  "bugs": { "BUG-001": { verdict, evidence, ... } },     // Bug registry ✅
  "gaps": { "GAP-001": { verdict, blocking, ... } },     // Gap registry ✅
  "customTasks": { "TASK-001": { prompt, ... } },        // Custom tasks ✅
  "coverage": { totalFiles, passRate, ... },             // Coverage ✅
  "history": [{ version, date, bugsFound, ... }]         // History ✅
}
```

✅ **All required fields present, correctly structured**

---

## New Issues Check

**Question:** Does v2 introduce any NEW problems that v1 didn't have?

### Review of Changes

1. **Exhaustive checking** — Could be slow (30s per entity × 200 entities = 100 min per file), but this is **required by issue**. Not a plan gap. ✅

2. **Blocking behavior** — Could halt all work if infrastructure gap found, but this is **intended design** (issue requires blocking). ✅

3. **10-bug session limit** — Could require many iterations, but **prevents overwhelming reports** (issue requirement). ✅

4. **Version tracking** — Depends on `package.json` version field existing. **Assumption documented**, Rob will validate. ✅

5. **AST parsing for entity extraction** — Plan specifies `@babel/parser`, no implementation details. **Left for Rob**, appropriate for plan phase. ✅

6. **Playwright selectors** — Plan notes as "implementation risk" (lines 1380-1381), **documented in Open Questions**. ✅

7. **Screenshot reading limitations** — Explicitly noted (lines 985-987), **strategy uses MCP/CLI for exact data**. ✅

**Verdict:** No new gaps. All potential issues are either:
- Required by original issue (exhaustive checking, blocking)
- Documented as implementation risks (selectors, AST parsing)
- Mitigated by design (screenshot limits → use MCP/CLI)

---

## Proof of Completeness

### All 8 Critical Gaps Resolved

| Gap # | Requirement | v1 Status | v2 Status | Evidence |
|-------|-------------|-----------|-----------|----------|
| GAP-001 | Line-by-line exhaustive | ❌ Sampling | ✅ Exhaustive | Lines 279-283, 312-332 |
| GAP-002 | Rich hierarchical state | ❌ Flat log | ✅ Rich schema | Lines 59-181 |
| GAP-003 | Bug vs Gap distinction | ❌ No gaps | ✅ Full verdict logic | Lines 207-209, 372-434 |
| GAP-004 | Session limits | ❌ Missing | ✅ 10-bug limit | Lines 335-351 |
| GAP-005 | Version tracking | ❌ Missing | ✅ Full workflow | Lines 437-474 |
| GAP-006 | File ordering | ❌ Missing | ✅ Priority queue | Lines 353-367 |
| GAP-007 | Per-file resume | ❌ Missing | ✅ lastCheckedLine | Line 192, 318-320 |
| GAP-008 | Custom tasks tracking | ❌ Missing | ✅ Registry + persistence | Lines 153-161, 234-240 |

### All 9 Acceptance Criteria Met

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Custom agent `.claude/agents/qa-agent.md` | ✅ | Section 6 (lines 478-996) |
| 2 | Skill `/qa` with args | ✅ | Section 7 (lines 999-1109) |
| 3 | Traverses first to LAST line | ✅ | Lines 312-332 pipeline |
| 4 | Checks all 6 panels per entity | ✅ | Lines 630-640, 716-783 |
| 5 | Bug verdict with evidence | ✅ | Lines 207-223 |
| 6 | State updates after each session | ✅ | Lines 659-714 |
| 7 | Auto-resume from `lastCheckedLine` | ✅ | Line 192, 318-320, 1037-1062 |
| 8 | Version change → re-check bugs | ✅ | Lines 437-474 |
| 9 | Custom tasks → persist in state | ✅ | Lines 153-161, 234-240 |

---

## Section-by-Section Validation

| Section | Purpose | Complete? | Notes |
|---------|---------|-----------|-------|
| 1. File Structure | Define new files/dirs | ✅ | Clear structure, gitignore updated |
| 2. State Schema | Define `_qa/qa-state.json` | ✅ | All 21 requirements covered |
| 3. Methodology | Line-by-line checking | ✅ | Exhaustive, session limits, file ordering |
| 4. Bug vs Gap | Verdict logic + blocking | ✅ | Full distinction, blocking behavior |
| 5. Version Tracking | Detect version changes | ✅ | Detection + re-check workflow |
| 6. Agent Persona | `.claude/agents/qa-agent.md` | ✅ | Complete role, tools, strategies |
| 7. Skill Definition | `.claude/skills/qa/SKILL.md` | ✅ | All modes (file, resume, recheck, task) |
| 8. Playwright Strategy | Browser automation | ✅ | Full interaction flow, screenshot reading |
| 9. Gitignore | Exclude screenshots | ✅ | Correct exclusions |
| 10. Implementation Checklist | Phases for Rob | ✅ | Clear phases, testable milestones |
| 11. Success Criteria | Acceptance tests | ✅ | 32 criteria, all testable |
| 12. Gap Resolution Table | Track fixes from v1 | ✅ | All 8 gaps resolved |
| 13. Open Questions | Implementation risks | ✅ | 8 questions for Rob, appropriate for plan phase |

---

## Final Score

**Requirements Met: 21/21 (100%)**

**Critical Gaps Resolved: 8/8**

**Acceptance Criteria: 9/9**

**New Issues Introduced: 0**

---

## Recommendation

**APPROVE plan v2 for implementation.**

Don has fully addressed all feedback from v1 verification. Plan is complete, correct, and ready for Rob to implement.

**Next step:** Rob proceeds with Phase 1-8 (implementation), then QA Agent validates Phase 9 (integration testing).

---

**End of Re-Verification Report**
