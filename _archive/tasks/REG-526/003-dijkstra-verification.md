# REG-526: Dijkstra Plan Verification

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-20
**Verdict:** **REJECT**

---

## Executive Summary

Don's plan provides solid technical infrastructure (Playwright, MCP cross-validation, state management) but **fundamentally misunderstands the task scope and methodology**. The original issue requires **line-by-line exhaustive verification** ("протыкиваем каждое слово") while Don proposes **sampling 5-10 entities per file**. The state schema is also incomplete.

**Critical gaps:**
1. **Entity checking rate:** 5-10 samples vs. line-by-line exhaustive
2. **State schema:** Flat structure vs. rich hierarchical schema with separate bug/gap registries
3. **Bug vs Gap distinction:** No gap tracking, no blocking behavior
4. **Version tracking:** Missing version-based re-check logic
5. **File ordering:** Not specified (issue requires largest-to-smallest)
6. **Session limits:** No 10-bug limit per session
7. **Custom tasks:** State schema missing `customTasks` registry

---

## Completeness Tables

### Table 1: State Schema Requirements

| Requirement | In Don's Plan? | How? | Gap? |
|-------------|---------------|------|------|
| Per-file tracking: `files.{path}.{totalLines, lastCheckedLine, status, blockedBy, entities{total,checked,ok,bugs,gaps}, sessions[]}` | ❌ NO | Don's schema has flat `checked_entities` array, no per-file objects | **CRITICAL GAP** — No `lastCheckedLine` for auto-resume per file, no `entities` breakdown |
| Separate bug registry: `bugs.{BUG-001...}` with verdict, evidence, linearIssue, status | ❌ NO | Don has `bugs_found` counter, bug reports in MD files | **CRITICAL GAP** — No bug ID tracking, no verdict field, no per-bug status |
| Separate gap registry: `gaps.{GAP-001...}` with verdict, evidence, linearIssue, status | ❌ NO | No gap concept in Don's plan | **CRITICAL GAP** — No gap tracking at all |
| Custom tasks registry: `customTasks.{TASK-001...}` with prompt, date, status, bugsFound, gapsFound, summary | ❌ NO | Don has `--task` flag but no state tracking | **GAP** — Custom tasks run but results not persisted |
| Coverage summary: `coverage{totalFiles, checkedFiles, totalEntities, checkedEntities, passRate}` | ⚠️ PARTIAL | Don has `total_entities_checked`, no file-level stats | **GAP** — Missing file-level coverage, passRate |
| History per version: `history[]` | ❌ NO | No version tracking | **GAP** — No historical record |
| Version field (extension version) | ❌ NO | Don's `version` is schema version, not extension version | **GAP** — Can't detect version changes |

**Verdict:** Don's state schema is **fundamentally different** from spec. It's a flat log of checked entities, not a rich hierarchical registry.

---

### Table 2: Methodology Requirements

| Requirement | In Don's Plan? | How? | Gap? |
|-------------|---------------|------|------|
| **Line-by-line exhaustive checking** ("протыкиваем каждое слово") | ❌ NO | Don explicitly states: "Rate: ~5-10 entities per file (representative sample, not exhaustive)" (line 302) | **CRITICAL GAP** — Don proposes sampling, issue requires exhaustive |
| File ordering: largest to smallest, starting with Orchestrator.ts | ❌ NO | No file ordering logic in plan | **GAP** — No mention of file ordering |
| Session limits: 10 bugs per session, then stop and report | ❌ NO | No session limit logic | **GAP** — Agent could run indefinitely |
| Bug vs Gap distinction with verdict (ui-bug / core-bug) | ⚠️ PARTIAL | Bug reports exist, but no "gap" concept, no verdict field | **CRITICAL GAP** — No gap tracking, no verdict enum |
| Blocking gaps: infrastructure gap → STOP, report, wait for resolution | ❌ NO | No blocking behavior | **CRITICAL GAP** — Agent can't block on infrastructure issues |
| Version tracking: on version change, re-check previously found bugs | ❌ NO | No version tracking in state | **GAP** — Can't detect version changes |
| Custom tasks: free text passed as args, tracked in customTasks registry | ⚠️ PARTIAL | `--task` flag exists, but no state persistence | **GAP** — Custom tasks not tracked |

**Verdict:** Don's methodology is **fundamentally incompatible** with the exhaustive line-by-line requirement.

---

### Table 3: UX Requirements

| Requirement | In Don's Plan? | How? | Gap? |
|-------------|---------------|------|------|
| `/qa Orchestrator.ts` — check specific file | ✅ YES | `/qa [file]` (line 340) | ✅ |
| `/qa` — auto-resume from lastCheckedLine | ⚠️ PARTIAL | `--resume` flag exists, but state lacks `lastCheckedLine` per file | **GAP** — Can't resume mid-file |
| `/qa --recheck` — re-check previously found bugs | ⚠️ PARTIAL | `--recheck` clears `checked_entities`, but no bug-specific re-check | **GAP** — Re-checks entities, not bugs |
| `/qa <custom task>` — custom task execution | ✅ YES | `--task "..."` flag (line 350) | ⚠️ (but no state tracking) |

**Verdict:** UX mostly matches, but auto-resume is broken (no per-file `lastCheckedLine`).

---

### Table 4: Acceptance Criteria

| Criterion | In Don's Plan? | How? | Gap? |
|-------------|---------------|------|------|
| Custom agent `.claude/agents/qa-agent.md` with full prompt | ✅ YES | Section 2 (lines 32-316) | ✅ |
| Skill `/qa` with args (file, --recheck, auto-resume, custom task) | ✅ YES | Section 3 (lines 319-398) | ✅ |
| Agent traverses Orchestrator.ts from **first to LAST line** without manual intervention | ❌ NO | Don: "5-10 entities per file (representative sample)" | **CRITICAL GAP** |
| For each entity — checks all 6 panels (or notes which are unavailable) | ✅ YES | Panel validation logic (lines 180-189) | ✅ |
| Bug verdict: UI-bug or core-bug with evidence via CLI/MCP | ⚠️ PARTIAL | Bug reports exist, but no verdict field | **GAP** |
| `_qa/qa-state.json` correctly updates after each session | ⚠️ PARTIAL | State updates exist, but schema doesn't match spec | **CRITICAL GAP** |
| On restart, agent continues from `lastCheckedLine` | ❌ NO | State lacks `lastCheckedLine` per file | **CRITICAL GAP** |
| On version change — re-check previously found bugs | ❌ NO | No version tracking | **GAP** |
| Custom tasks execute and write to `customTasks` | ⚠️ PARTIAL | Tasks execute, but no state tracking | **GAP** |

**Verdict:** 4/9 criteria met. Critical failures: exhaustive checking, per-file resume, version tracking.

---

## Detailed Gap Analysis

### GAP-001: Entity Checking Rate (CRITICAL)

**Issue requirement:**
> "протыкиваем каждое слово" — poke every word, line-by-line

**Don's plan (line 302):**
> "Rate: ~5-10 entities per file (representative sample, not exhaustive)"

**Analysis:**
Don explicitly contradicts the requirement. The issue demands **exhaustive** validation (every entity on every line), while Don proposes **sampling** (5-10 representative entities).

**Impact:**
- Agent will miss bugs outside the sampled entities
- Can't provide coverage metrics (issue requires `totalEntities` vs `checkedEntities`)
- Violates acceptance criterion: "traverses Orchestrator.ts from first to LAST line"

**Evidence from issue:**
> "Agent traverses Orchestrator.ts from first to LAST line without manual intervention"

This is unambiguous: **every line**, not a sample.

---

### GAP-002: State Schema (CRITICAL)

**Issue requirement:**
Rich hierarchical schema with:
- `files.{path}` objects (per-file tracking)
- `bugs.{BUG-001}` registry (separate from logs)
- `gaps.{GAP-001}` registry (infrastructure issues)
- `customTasks.{TASK-001}` registry
- `coverage` summary
- `history[]` per version

**Don's schema (lines 195-215):**
```json
{
  "version": "1.0.0",
  "session_id": "...",
  "current_file": "...",
  "checked_entities": [...],  // Flat array
  "bugs_found": 0,            // Counter only
  "total_entities_checked": 0,
  "last_report": "..."
}
```

**Analysis:**
Don's schema is a **flat log** of checked entities. It lacks:
1. Per-file objects (`files.{path}`) → Can't track `lastCheckedLine` per file
2. Bug registry (`bugs.{BUG-001}`) → Can't re-check specific bugs
3. Gap registry (`gaps.{GAP-001}`) → No gap tracking
4. Custom tasks (`customTasks.{TASK-001}`) → Custom tasks not persisted
5. Coverage summary → Can't compute `totalFiles`, `passRate`
6. History → Can't track version changes

**Impact:**
- Auto-resume breaks: can't resume mid-file (no `lastCheckedLine`)
- Re-check breaks: can't re-check specific bugs (no bug IDs)
- Version tracking breaks: can't detect extension version changes
- Custom tasks lost: no persistence

---

### GAP-003: Bug vs Gap Distinction (CRITICAL)

**Issue requirement:**
> "Bug verdict: UI-bug or core-bug with evidence via CLI/MCP"
> "Blocking gaps: infrastructure gap → STOP, report, wait for resolution"

**Don's plan:**
- Bug reports exist (MD files)
- No "gap" concept
- No verdict field (ui-bug / core-bug)
- No blocking behavior

**Analysis:**
The issue distinguishes between:
1. **Bugs:** UI doesn't match graph → report, continue
2. **Gaps:** Infrastructure missing (e.g., graph has no data for entire panel) → BLOCK, wait for fix

Don's plan treats everything as a bug. No gap tracking, no blocking.

**Impact:**
- Agent can't distinguish UI bugs from infrastructure gaps
- Agent can't block on gaps (will report false bugs when data is missing)
- No `gaps.{GAP-001}` registry in state

---

### GAP-004: Session Limits

**Issue requirement:**
> "Session limits: 10 bugs per session, then stop and report"

**Don's plan:**
No mention of session limits.

**Analysis:**
Don's agent will continue checking until it completes the file. Issue requires stopping after 10 bugs.

**Impact:**
- Agent could generate massive bug reports
- Hard to manage incremental fixes

---

### GAP-005: Version Tracking

**Issue requirement:**
> "Version tracking: on version change, re-check previously found bugs"

**Don's plan:**
- Don has `version: "1.0.0"` in state, but this is **schema version**, not extension version
- No logic to detect extension version changes
- No logic to re-check bugs on version change

**Analysis:**
The issue requires tracking the **extension version** (from `package.json` or similar), and when it changes, re-running checks on previously found bugs to see if they're fixed.

Don's `version` field is for state schema migrations, not extension versions.

**Impact:**
- Can't detect when extension is updated
- Can't auto-validate fixes

---

### GAP-006: File Ordering

**Issue requirement:**
> "File ordering: largest to smallest, starting with Orchestrator.ts"

**Don's plan:**
No mention of file ordering logic.

**Analysis:**
The issue specifies a priority: check Orchestrator.ts first, then other files by size (largest to smallest).

Don's plan doesn't specify how the agent selects files.

**Impact:**
- Agent might check files in arbitrary order
- User expects Orchestrator.ts first

---

### GAP-007: Per-File Progress Tracking

**Issue requirement:**
State schema has `files.{path}.lastCheckedLine` for mid-file resume.

**Don's state:**
- `current_file` (string)
- `checked_entities` (flat array with line numbers)

**Analysis:**
Don's state can track **which entities** were checked, but can't compute **which line to resume from**. To resume mid-file, you need:
1. Open file
2. Jump to `lastCheckedLine + 1`
3. Continue from there

Don's state would require parsing `checked_entities`, filtering by `current_file`, sorting by line number, finding the max line. The spec requires a single `lastCheckedLine` field per file.

**Impact:**
- Auto-resume is fragile (depends on array parsing)
- Can't easily display "File: 150/500 lines checked"

---

### GAP-008: Custom Task Tracking

**Issue requirement:**
State schema has `customTasks.{TASK-001}` with prompt, date, status, bugsFound, gapsFound, summary.

**Don's plan:**
- `--task "..."` flag passes custom task to agent
- No state tracking for custom tasks

**Analysis:**
Don's agent will execute custom tasks (e.g., "check hover tooltips only"), but the results aren't persisted in state. The issue requires a registry of all custom tasks run.

**Impact:**
- Custom task results lost after session ends
- Can't see history of custom tasks

---

## Precondition Issues

### Precondition 1: Playwright Selector Stability

**Don's assumption (lines 136-148):**
Playwright scripts use Monaco editor selectors like `.view-line[data-line-number="5"]`.

**Unverified:**
1. Does Monaco use `data-line-number` in code-server? (May differ from VS Code Desktop)
2. Are these selectors stable across code-server versions?
3. What if Monaco is virtualized (lazy-renders lines)?

**Recommendation:**
Rob should verify selectors against live code-server instance before implementing.

---

### Precondition 2: Extension Panel Identifiers

**Don's assumption (lines 497-504):**
Panels have `aria-label="Grafema: Value Trace"`.

**Unverified:**
1. Do Grafema extension panels actually have `aria-label`?
2. Are labels stable across extension versions?

**Recommendation:**
Inspect extension DOM in code-server, document actual selectors.

---

### Precondition 3: Graph Data Availability

**Don's assumption (lines 176-178):**
> "Extension shows X → Graph has no data → ⚠️ EXPECTED (entity not analyzed)"

**Unverified:**
The issue requires checking against a **fully analyzed codebase** (demo fixture). Don assumes partial analysis is acceptable.

**Conflict:**
If the agent is validating extension correctness, the graph should be **complete** (all entities analyzed). Otherwise, "no data" cases are ambiguous (is it a bug, or just not analyzed?).

**Recommendation:**
Issue should clarify: are we validating against a **partial graph** (some files analyzed) or **complete graph** (all demo fixtures analyzed)?

---

## Recommendations

### Recommendation 1: State Schema Redesign (CRITICAL)

Rewrite `_qa/qa-state.json` to match issue spec:

```json
{
  "version": "0.1.0",  // Extension version from package.json
  "schemaVersion": "1.0.0",  // State schema version

  "files": {
    "packages/vscode-ext/src/Orchestrator.ts": {
      "totalLines": 500,
      "lastCheckedLine": 150,  // Resume from line 151
      "status": "in-progress",
      "blockedBy": null,  // or GAP-001
      "entities": {
        "total": 200,
        "checked": 75,
        "ok": 70,
        "bugs": 3,
        "gaps": 2
      },
      "sessions": [
        {
          "id": "2026-02-20T14:30:00Z",
          "linesChecked": "1-150",
          "bugsFound": ["BUG-001", "BUG-002"],
          "gapsFound": ["GAP-001"]
        }
      ]
    }
  },

  "bugs": {
    "BUG-001": {
      "verdict": "ui-bug",  // or "core-bug"
      "file": "packages/vscode-ext/src/Orchestrator.ts",
      "line": 42,
      "entity": "initializeEngine",
      "panel": "hover",
      "evidence": {
        "expected": "FUNCTION_DECLARATION",
        "actual": "VARIABLE_DECLARATION",
        "mcp": {...},
        "screenshot": "_qa/screenshots/bug-001.png"
      },
      "linearIssue": "REG-527",
      "status": "open",  // or "fixed", "wontfix"
      "foundAt": "2026-02-20T14:35:00Z",
      "recheckedAt": null
    }
  },

  "gaps": {
    "GAP-001": {
      "verdict": "infrastructure-gap",
      "description": "Value Trace panel always empty — dataflow analysis not implemented",
      "evidence": {...},
      "linearIssue": "REG-528",
      "status": "blocking",
      "foundAt": "2026-02-20T14:40:00Z"
    }
  },

  "customTasks": {
    "TASK-001": {
      "prompt": "check hover tooltips only",
      "date": "2026-02-20T15:00:00Z",
      "status": "completed",
      "bugsFound": ["BUG-003"],
      "gapsFound": [],
      "summary": "Checked 50 hover tooltips, found 1 type mismatch"
    }
  },

  "coverage": {
    "totalFiles": 10,
    "checkedFiles": 1,
    "totalEntities": 2000,
    "checkedEntities": 75,
    "passRate": 0.933  // (70 ok) / (75 checked)
  },

  "history": [
    {
      "version": "0.1.0",
      "date": "2026-02-20",
      "bugsFound": 3,
      "gapsFound": 1,
      "filesChecked": ["Orchestrator.ts"]
    }
  ]
}
```

---

### Recommendation 2: Methodology Redesign (CRITICAL)

Rewrite checking strategy from **sampling** to **exhaustive**:

**Current (Don's plan, line 302):**
> "Rate: ~5-10 entities per file (representative sample, not exhaustive)"

**Required:**
> "Traverse file from line 1 to last line, check every entity on every line"

**Implementation:**
```markdown
For each file:
  1. Parse file into lines
  2. For line_num in 1..totalLines:
     a. Extract all entities on this line (use AST or regex)
     b. For each entity on this line:
        - Hover over entity
        - Validate all 6 panels
        - Record result
     c. Update state: lastCheckedLine = line_num
     d. If bugs_this_session >= 10: STOP, write report
  3. Mark file as "completed"
```

**Entity extraction:**
Use AST parser (e.g., `@babel/parser`) to find all identifiers on a line, filter out keywords/operators.

---

### Recommendation 3: Session Limit Enforcement

Add logic to stop after 10 bugs:

```markdown
bugs_this_session = 0

For each entity:
  result = validate_entity(entity)
  if result.status == "failed":
    write_bug_report(result)
    bugs_this_session += 1
    if bugs_this_session >= 10:
      write_summary("Session stopped: 10 bugs found")
      STOP
```

---

### Recommendation 4: Bug vs Gap Distinction

Implement verdict logic:

```markdown
result = validate_entity(entity)

if extension_shows_data AND graph_has_no_data:
  verdict = "ui-bug" (phantom data)
elif extension_shows_nothing AND graph_has_data:
  if entire_panel_broken:
    verdict = "infrastructure-gap" → BLOCK
  else:
    verdict = "ui-bug" (missing data)
elif extension_shows_X AND graph_shows_Y:
  verdict = "ui-bug" (mismatch)
```

**Blocking behavior:**
If gap with `verdict="infrastructure-gap"` and `status="blocking"`:
- Write gap report
- Update state: `files.{path}.blockedBy = GAP-001`
- STOP session
- Notify user: "Cannot continue — blocked by GAP-001"

---

### Recommendation 5: Version Tracking

Add extension version detection:

```javascript
// At agent start, read extension version
const pkgJson = JSON.parse(fs.readFileSync('packages/vscode-ext/package.json'));
const currentVersion = pkgJson.version;

// Compare with state
if (state.version !== currentVersion) {
  console.log(`Version changed: ${state.version} → ${currentVersion}`);
  // Re-check all bugs with status="open"
  for (const bugId in state.bugs) {
    if (state.bugs[bugId].status === "open") {
      recheck_bug(bugId);
    }
  }
  // Update version
  state.version = currentVersion;
  state.history.push({
    version: currentVersion,
    date: new Date().toISOString(),
    bugsFound: 0,
    gapsFound: 0,
    filesChecked: []
  });
}
```

---

### Recommendation 6: File Ordering

Implement priority queue:

```javascript
// Get all files to check
const files = glob.sync('packages/vscode-ext/src/**/*.ts');

// Sort by size (largest first)
files.sort((a, b) => {
  const sizeA = fs.statSync(a).size;
  const sizeB = fs.statSync(b).size;
  return sizeB - sizeA;
});

// Move Orchestrator.ts to front
const orchestratorIndex = files.indexOf('packages/vscode-ext/src/Orchestrator.ts');
if (orchestratorIndex > 0) {
  files.unshift(files.splice(orchestratorIndex, 1)[0]);
}

// Process files in order
for (const file of files) {
  check_file(file);
}
```

---

## Proof by Enumeration: All Issue Requirements

| # | Requirement | Met? | Evidence |
|---|-------------|------|----------|
| 1 | Per-file state schema | ❌ | Don has flat `checked_entities`, no `files.{path}` |
| 2 | Separate bug registry | ❌ | Don has `bugs_found` counter, no `bugs.{BUG-001}` |
| 3 | Separate gap registry | ❌ | No gap concept |
| 4 | Custom tasks registry | ❌ | `--task` flag exists, no state persistence |
| 5 | Coverage summary | ⚠️ | Partial (`total_entities_checked`), missing file-level stats |
| 6 | History per version | ❌ | No history array |
| 7 | Version field (extension version) | ❌ | Don's `version` is schema version |
| 8 | Line-by-line exhaustive checking | ❌ | Don: "5-10 entities per file (sample)" |
| 9 | File ordering (largest to smallest) | ❌ | Not specified |
| 10 | Session limits (10 bugs) | ❌ | No limit logic |
| 11 | Bug vs Gap distinction | ❌ | No gap tracking |
| 12 | Blocking gaps | ❌ | No blocking behavior |
| 13 | Version-based re-check | ❌ | No version tracking |
| 14 | `/qa` — auto-resume from lastCheckedLine | ❌ | State lacks `lastCheckedLine` per file |
| 15 | `/qa --recheck` — re-check bugs | ⚠️ | Re-checks entities, not bugs |
| 16 | Custom agent `.claude/agents/qa-agent.md` | ✅ | Section 2 |
| 17 | Skill `/qa` with args | ✅ | Section 3 |
| 18 | Traverses file from first to LAST line | ❌ | Sampling, not exhaustive |
| 19 | Checks all 6 panels per entity | ✅ | Panel validation logic |
| 20 | Bug verdict: ui-bug / core-bug | ❌ | No verdict field |
| 21 | State updates after each session | ⚠️ | Updates exist, schema wrong |

**Score: 3/21 PASS, 4/21 PARTIAL, 14/21 FAIL**

---

## Conclusion

Don's plan provides **solid technical infrastructure** (Playwright, MCP cross-validation, state persistence), but **fundamentally misunderstands the task scope**:

1. **Sampling vs Exhaustive:** Don proposes sampling 5-10 entities per file. Issue requires line-by-line exhaustive checking.
2. **State Schema:** Don's flat log doesn't match the rich hierarchical schema (per-file tracking, bug/gap registries, custom tasks, coverage, history).
3. **Bug vs Gap:** Don treats everything as a bug. Issue requires distinguishing bugs (UI errors) from gaps (infrastructure missing) with blocking behavior.
4. **Version Tracking:** Don has no logic to detect extension version changes and re-check bugs.

**Verdict: REJECT**

Don should revise the plan to:
- Change checking strategy from sampling to exhaustive (line-by-line)
- Redesign state schema to match issue spec
- Add bug vs gap distinction with blocking
- Add version tracking and auto-recheck on version change
- Add session limits (10 bugs per session)
- Add file ordering logic (largest to smallest)

---

**End of Verification Report**
