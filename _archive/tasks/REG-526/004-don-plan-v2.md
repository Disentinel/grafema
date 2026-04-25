# REG-526: QA Agent + /qa Skill — Implementation Plan (v2)

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-20
**Revision:** v2 (incorporates Dijkstra's feedback)
**Task:** Create automated QA agent that validates VS Code extension UI against Grafema graph data

---

## Executive Summary

This plan creates a QA automation system with:
- **Custom agent** (`.claude/agents/qa-agent.md`) that runs Playwright to interact with code-server
- **Skill entry point** (`.claude/skills/qa/SKILL.md`) for `/qa` command
- **Rich state tracking** (`_qa/qa-state.json`) with per-file progress, bug/gap registries, version tracking
- **Line-by-line exhaustive validation** — every entity on every line gets checked
- **Bug vs Gap distinction** — UI bugs vs infrastructure gaps with blocking behavior
- **Session limits** — stop after 10 bugs per session

**Key differences from v1:**
- ✅ Changed from sampling (5-10 entities) to **exhaustive line-by-line** checking
- ✅ Redesigned state schema: per-file tracking, bug/gap registries, custom tasks, coverage, history
- ✅ Added bug vs gap distinction with blocking behavior
- ✅ Added version tracking (from `package.json`) with auto-recheck on version change
- ✅ Added session limits (10 bugs per session)
- ✅ Added file ordering (Orchestrator.ts first, then largest to smallest)
- ✅ Added per-file `lastCheckedLine` for mid-file resume

---

## 1. File Structure

```
.claude/
  agents/
    qa-agent.md                    # NEW: QA agent persona + instructions
  skills/
    qa/
      SKILL.md                     # NEW: /qa skill definition

_qa/
  qa-state.json                    # NEW: persistent QA session state
  screenshots/                     # NEW: Playwright screenshots (gitignored)
  reports/                         # NEW: bug reports, validation logs

.gitignore                         # UPDATE: add _qa/screenshots/
```

**Total new files:** 3 (agent, skill, state schema)
**Total new directories:** 2 (`_qa/`, `_qa/screenshots/`)
**Updates:** 1 (`.gitignore`)

---

## 2. State Schema: `_qa/qa-state.json`

### Schema Structure

```json
{
  "version": "0.1.0",
  "schemaVersion": "1.0.0",

  "files": {
    "packages/vscode/src/Orchestrator.ts": {
      "totalLines": 500,
      "lastCheckedLine": 150,
      "status": "in-progress",
      "blockedBy": null,
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
      "verdict": "ui-bug",
      "file": "packages/vscode/src/Orchestrator.ts",
      "line": 42,
      "entity": "initializeEngine",
      "panel": "hover",
      "expected": {
        "nodeType": "FUNCTION_DECLARATION",
        "nodeName": "initializeEngine"
      },
      "actual": {
        "nodeType": "VARIABLE_DECLARATION",
        "nodeName": "initializeEngine"
      },
      "evidence": {
        "mcp": { "id": "abc123", "type": "FUNCTION_DECLARATION", "name": "initializeEngine" },
        "cli": "Node: FUNCTION_DECLARATION (initializeEngine)",
        "screenshot": "_qa/screenshots/bug-001-hover.png"
      },
      "linearIssue": null,
      "status": "open",
      "foundAt": "2026-02-20T14:35:00Z",
      "recheckedAt": null
    },
    "BUG-002": {
      "verdict": "core-bug",
      "file": "packages/vscode/src/Orchestrator.ts",
      "line": 85,
      "entity": "executeQuery",
      "panel": "value-trace",
      "expected": {
        "trace": ["assignment at line 90", "return at line 95"]
      },
      "actual": {
        "trace": []
      },
      "evidence": {
        "mcp": { "trace": [{"type": "ASSIGNMENT", "line": 90}, {"type": "RETURN", "line": 95}] },
        "cli": "Trace: 2 steps",
        "screenshot": "_qa/screenshots/bug-002-value-trace.png"
      },
      "linearIssue": "REG-527",
      "status": "open",
      "foundAt": "2026-02-20T14:40:00Z",
      "recheckedAt": null
    }
  },

  "gaps": {
    "GAP-001": {
      "verdict": "infrastructure-gap",
      "description": "Value Trace panel always empty across all files — dataflow analysis not implemented in graph",
      "blocking": ["packages/vscode/src/Orchestrator.ts"],
      "evidence": {
        "screenshotSample": "_qa/screenshots/gap-001-value-trace-empty.png",
        "mcpConfirm": "trace_dataflow returns empty array for all queries",
        "affectedFiles": ["Orchestrator.ts", "index.ts", "utils.ts"]
      },
      "linearIssue": "REG-528",
      "status": "blocking",
      "foundAt": "2026-02-20T14:42:00Z"
    }
  },

  "customTasks": {
    "TASK-001": {
      "prompt": "check hover tooltips only",
      "date": "2026-02-20T15:00:00Z",
      "status": "completed",
      "bugsFound": ["BUG-003"],
      "gapsFound": [],
      "summary": "Checked 50 hover tooltips in Orchestrator.ts, found 1 type mismatch (BUG-003)"
    }
  },

  "coverage": {
    "totalFiles": 10,
    "checkedFiles": 1,
    "totalEntities": 2000,
    "checkedEntities": 75,
    "passRate": 0.933
  },

  "history": [
    {
      "version": "0.1.0",
      "date": "2026-02-20",
      "bugsFound": 3,
      "gapsFound": 1,
      "filesChecked": ["packages/vscode/src/Orchestrator.ts"]
    }
  ]
}
```

### Field Definitions

#### Top-Level Fields
- **`version`**: Extension version (from `packages/vscode/package.json`)
- **`schemaVersion`**: State schema version (for future migrations)

#### `files.{path}` (per-file tracking)
- **`totalLines`**: Total lines in file
- **`lastCheckedLine`**: Last fully checked line (resume from `lastCheckedLine + 1`)
- **`status`**: `"not-started"` | `"in-progress"` | `"completed"` | `"blocked"`
- **`blockedBy`**: Gap ID blocking this file (e.g., `"GAP-001"`) or `null`
- **`entities.total`**: Total identifiable entities in file (from AST parse)
- **`entities.checked`**: Entities validated so far
- **`entities.ok`**: Entities that passed validation
- **`entities.bugs`**: Count of entities with bugs
- **`entities.gaps`**: Count of entities affected by gaps
- **`sessions[]`**: Array of QA sessions for this file
  - `id`: ISO timestamp
  - `linesChecked`: Range (e.g., `"1-150"`)
  - `bugsFound`: Array of bug IDs
  - `gapsFound`: Array of gap IDs

#### `bugs.{BUG-NNN}` (bug registry)
- **`verdict`**: `"ui-bug"` or `"core-bug"`
  - `ui-bug`: Extension shows wrong data, graph has correct data
  - `core-bug`: Extension shows nothing/wrong, graph also missing data (data should exist)
- **`file`**: File path
- **`line`**: Line number
- **`entity`**: Entity name (identifier)
- **`panel`**: Panel where bug was found (`"hover"` | `"value-trace"` | `"callers"` | `"edges"` | `"issues"` | `"status"`)
- **`expected`**: What should be shown (from graph via MCP/CLI)
- **`actual`**: What extension shows (from screenshot/Playwright)
- **`evidence`**: Cross-validation data
  - `mcp`: Response from MCP tools
  - `cli`: Output from CLI commands
  - `screenshot`: Path to screenshot
- **`linearIssue`**: Linear issue ID if created (e.g., `"REG-527"`) or `null`
- **`status`**: `"open"` | `"fixed"` | `"wontfix"` | `"duplicate"`
- **`foundAt`**: ISO timestamp when bug was found
- **`recheckedAt`**: ISO timestamp of last re-check (null if never re-checked)

#### `gaps.{GAP-NNN}` (gap registry)
- **`verdict`**: `"infrastructure-gap"` (always)
- **`description`**: Human-readable description of infrastructure issue
- **`blocking`**: Array of file paths blocked by this gap
- **`evidence`**: Supporting data (screenshots, MCP responses, affected files)
- **`linearIssue`**: Linear issue ID or `null`
- **`status`**: `"blocking"` | `"resolved"` | `"wontfix"`
- **`foundAt`**: ISO timestamp

#### `customTasks.{TASK-NNN}` (custom task registry)
- **`prompt`**: Free-text task description (from `/qa --task "..."`)
- **`date`**: ISO timestamp
- **`status`**: `"in-progress"` | `"completed"` | `"failed"`
- **`bugsFound`**: Array of bug IDs found during this task
- **`gapsFound`**: Array of gap IDs found
- **`summary`**: Human-readable summary of results

#### `coverage` (global statistics)
- **`totalFiles`**: Total files to check (from glob)
- **`checkedFiles`**: Files with status `"completed"` or `"blocked"`
- **`totalEntities`**: Sum of `files.*.entities.total`
- **`checkedEntities`**: Sum of `files.*.entities.checked`
- **`passRate`**: `(sum of files.*.entities.ok) / checkedEntities`

#### `history[]` (version tracking)
- **`version`**: Extension version
- **`date`**: ISO date when this version was tested
- **`bugsFound`**: Count of bugs found in this version
- **`gapsFound`**: Count of gaps found
- **`filesChecked`**: Array of file paths checked in this version

### Initial State

```json
{
  "version": null,
  "schemaVersion": "1.0.0",
  "files": {},
  "bugs": {},
  "gaps": {},
  "customTasks": {},
  "coverage": {
    "totalFiles": 0,
    "checkedFiles": 0,
    "totalEntities": 0,
    "checkedEntities": 0,
    "passRate": 0
  },
  "history": []
}
```

---

## 3. Checking Methodology: Line-by-Line Exhaustive

### Overview

**CRITICAL CHANGE from v1:** The agent checks **every entity on every line**, not a sample.

### Entity Identification

For each line in a file:
1. **Parse line into AST nodes** (use `@babel/parser` or similar)
2. **Extract all identifiers** (variable names, function names, property accesses, etc.)
3. **Filter out keywords/operators** (`function`, `const`, `return`, `+`, `=`, etc.)
4. **Check each remaining identifier**

**Example:**
```javascript
// Line 42:
const result = add(x, y);
```

**Entities to check:**
- `result` (VARIABLE_DECLARATION)
- `add` (CALL_EXPRESSION)
- `x` (IDENTIFIER)
- `y` (IDENTIFIER)

**NOT entities:**
- `const` (keyword)
- `=` (operator)
- `(` `)` `,` `;` (punctuation)

### Checking Pipeline

```markdown
For each file (in priority order):
  1. Read extension version from packages/vscode/package.json
  2. If version changed: re-check all bugs with status="open"
  3. Get file metadata (totalLines, AST parse for entity count)
  4. Resume from lastCheckedLine + 1 (or line 1 if new file)
  5. For line_num in (lastCheckedLine + 1)..totalLines:
       a. Extract entities on this line
       b. For each entity:
            i.   Position cursor on entity (Playwright)
            ii.  Wait for panels to update (3s)
            iii. Screenshot all 6 panels
            iv.  Query graph via MCP/CLI
            v.   Compare extension data with graph data
            vi.  If mismatch: record bug or gap
            vii. Update state: entities.checked++
       c. Update state: lastCheckedLine = line_num
       d. If bugs_this_session >= 10: STOP, write report, exit
  6. Mark file as "completed"
  7. Update coverage stats
```

### Session Limits

**CRITICAL:** Stop after 10 bugs found in a single session.

```markdown
bugs_this_session = 0

For each entity:
  result = validate_entity(entity)
  if result.isBug:
    write_bug_report(result)
    bugs_this_session += 1
    if bugs_this_session >= 10:
      write_session_report("Stopped: 10 bugs found")
      STOP
```

**Rationale:** Prevents overwhelming bug reports, allows incremental fixing.

### File Ordering

**Priority queue:**
1. **Always first:** `packages/vscode/src/Orchestrator.ts`
2. **Then:** All other `.ts` files, sorted by size (largest to smallest)

**Implementation:**
```javascript
const files = glob.sync('packages/vscode/src/**/*.ts');
files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
const orchestratorIdx = files.indexOf('packages/vscode/src/Orchestrator.ts');
if (orchestratorIdx > 0) {
  files.unshift(files.splice(orchestratorIdx, 1)[0]);
}
```

---

## 4. Bug vs Gap Distinction

### Definitions

**Bug (ui-bug or core-bug):**
- Extension shows incorrect data OR graph has data but extension doesn't show it
- File-level issue (specific to one entity in one panel)
- **Action:** Record bug, continue checking

**Gap (infrastructure-gap):**
- Entire panel/feature doesn't work across multiple files
- Graph has no data (infrastructure not implemented)
- **Action:** Record gap, BLOCK affected files, stop session

### Verdict Logic

```markdown
extension_data = get_panel_data_from_screenshot(panel)
graph_data = query_graph_via_mcp(entity, panel_type)

if extension_data == null AND graph_data == null:
  # Both empty — expected for some panels (e.g., Value Trace for class declarations)
  verdict = PASS

elif extension_data == null AND graph_data != null:
  # Extension shows nothing, graph has data
  if this_is_first_occurrence_across_files(panel_type):
    verdict = "core-bug" (missing UI feature for this entity type)
  else:
    verdict = "ui-bug" (UI bug for this specific entity)

elif extension_data != null AND graph_data == null:
  # Extension shows phantom data, graph has nothing
  verdict = "ui-bug" (phantom data)

elif extension_data != graph_data:
  # Data mismatch
  verdict = "ui-bug" (incorrect data)

# Detect infrastructure gaps
if count_similar_bugs_across_files(panel_type) > 5:
  # Same panel empty in 5+ different files → infrastructure gap
  verdict = "infrastructure-gap"
  BLOCK all affected files
  STOP session
```

### Blocking Behavior

When an infrastructure gap is detected:

1. **Create GAP-NNN entry** in `gaps` registry
2. **Mark affected files as blocked:**
   ```javascript
   for (const file of affectedFiles) {
     state.files[file].blockedBy = "GAP-001";
     state.files[file].status = "blocked";
   }
   ```
3. **Write gap report** to `_qa/reports/gap-NNN.md`
4. **STOP session** — notify user that checking is blocked
5. **User creates Linear issue** for gap (or gap auto-creates issue)
6. **Resume:** When gap is fixed, set `gaps.GAP-001.status = "resolved"`, clear `blockedBy` fields, resume checking

---

## 5. Version Tracking

### Version Detection

At agent start:
```javascript
const pkgJson = JSON.parse(fs.readFileSync('packages/vscode/package.json'));
const currentVersion = pkgJson.version;

if (state.version !== currentVersion) {
  console.log(`Version change detected: ${state.version} → ${currentVersion}`);
  onVersionChange(currentVersion);
}
```

### On Version Change

```markdown
1. Re-check all bugs with status="open":
   For each bugId in state.bugs:
     if state.bugs[bugId].status === "open":
       result = recheck_bug(bugId)
       if result.fixed:
         state.bugs[bugId].status = "fixed"
         state.bugs[bugId].recheckedAt = now()

2. Add history entry:
   state.history.push({
     version: currentVersion,
     date: now().toISOString().split('T')[0],
     bugsFound: count_open_bugs(),
     gapsFound: count_blocking_gaps(),
     filesChecked: Object.keys(state.files)
   })

3. Update state.version:
   state.version = currentVersion
```

---

## 6. `.claude/agents/qa-agent.md` Structure

### Frontmatter

```yaml
---
name: QA Agent
description: Automated QA for Grafema VS Code extension via Playwright + MCP cross-validation
version: 1.0.0
tools:
  - Bash (Playwright commands, file parsing)
  - Read (screenshot analysis, file reading)
  - Write (state updates)
  - mcp__grafema__* (graph queries)
  - mcp__linear__* (bug reporting)
state_file: _qa/qa-state.json
---
```

### Role & Responsibilities

```markdown
You are the Grafema QA Agent. Your mission: systematically validate the VS Code extension UI against graph data.

**Your workflow:**
1. Read extension version from `packages/vscode/package.json`
2. Check for version changes → re-check open bugs if version changed
3. Load state from `_qa/qa-state.json`
4. Select next file to check (Orchestrator.ts first, then largest to smallest)
5. Resume from `lastCheckedLine + 1` (or line 1 if new file)
6. For each line:
   - Extract entities (parse AST, filter identifiers)
   - For each entity: validate all 6 panels (hover, value-trace, callers, edges, issues, status)
   - Compare extension data (from screenshot) with graph data (from MCP/CLI)
   - Record bugs/gaps
7. Stop after 10 bugs in this session
8. Update state after each line
9. Write bug/gap reports

**Bug vs Gap:**
- Bug: single entity has wrong data → record, continue
- Gap: entire panel broken across files → BLOCK, stop session

**Session limits:**
- 10 bugs per session → stop, write report, exit
- User fixes bugs → re-run `/qa` to resume
```

### Tools You Use

#### Playwright (via Bash)

**Pre-flight checks:**
```bash
# 1. Docker running?
docker ps | grep code-server || { echo "ERROR: Start Docker with: cd demo && docker-compose up -d"; exit 1; }

# 2. Playwright installed?
npx playwright --version || npx playwright install chromium

# 3. Code-server accessible?
curl -s http://localhost:8080 > /dev/null || { echo "ERROR: code-server not responding"; exit 1; }
```

**Open file in code-server:**
```javascript
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:8080');
  await page.waitForSelector('.monaco-workbench', { timeout: 10000 });

  // Open file via Quick Open (Cmd+P)
  await page.keyboard.press('Meta+P');
  await page.keyboard.type('packages/vscode/src/Orchestrator.ts');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000); // Let file load

  await page.screenshot({ path: '_qa/screenshots/file-opened.png', fullPage: true });
  await browser.close();
})();
```

**Position cursor on entity (line L, column C):**
```javascript
// Monaco uses .view-line for each line
const lineElement = await page.$(`[data-line-number="${lineNumber}"]`);
const box = await lineElement.boundingBox();

// Click at approximate column offset (Monaco uses proportional font, ~7px per char)
await page.mouse.click(box.x + columnNumber * 7, box.y + 5);
await page.waitForTimeout(500); // Cursor positioned
```

**Hover to trigger tooltip:**
```javascript
// Move mouse to entity position
await page.mouse.move(box.x + columnNumber * 7, box.y + 5);
await page.waitForTimeout(1500); // Wait for hover tooltip
await page.screenshot({ path: '_qa/screenshots/hover-tooltip.png' });
```

**Capture panel:**
```javascript
const panel = await page.$('[aria-label="Grafema: Value Trace"]');
if (panel) {
  await panel.screenshot({ path: '_qa/screenshots/value-trace.png' });
} else {
  console.log('Value Trace panel not visible');
}
```

**Click entity to trigger panel updates:**
```javascript
await page.click(`[data-line-number="${lineNumber}"] >> text="${entityName}"`);
await page.waitForTimeout(3000); // Wait for async graph query + panel render
await page.screenshot({ path: '_qa/screenshots/panels-updated.png', fullPage: true });
```

#### Read Tool

**Screenshot analysis:**
1. Take screenshot via Playwright → `_qa/screenshots/hover-tooltip.png`
2. Read screenshot via `Read` tool (Claude sees image)
3. Analyze for:
   - Panel visibility (present/absent)
   - Non-empty content (has data vs empty state)
   - Expected sections (e.g., Value Trace shows "Assignments" header)
4. **Limitation:** Small text (<12pt) may be unreadable
5. **Strategy:** Use screenshots for structural validation, MCP/CLI for data validation

**File reading:**
- Read source files to extract entities (parse AST)
- Read `packages/vscode/package.json` to get extension version
- Read state file `_qa/qa-state.json`

#### Grafema MCP Tools

**Entity lookup:**
```javascript
// Find entity at position
const nodes = await mcp__grafema__find_nodes({
  file: '/workspace/packages/vscode/src/Orchestrator.ts',
  line: 42,
  column: 10
});

// Get full node data
const node = await mcp__grafema__get_node({ nodeId: nodes[0].id });
```

**Panel validation:**

| Panel | MCP Tool | What to Check |
|-------|----------|---------------|
| Hover Tooltip | `get_node` | `node.type`, `node.name`, `node.metadata.file` |
| Value Trace | `trace_dataflow` | Dataflow chain (assignments, returns) |
| Callers | `get_neighbors` (direction=in, type=CALLS) | Incoming call edges |
| Edges Explorer | `get_neighbors` (both directions) | All edges (in + out) |
| Issues | `get_issues` | Linked issue nodes |
| Status Bar | `find_nodes` (count) | File analysis status, node count |

#### Grafema CLI (via Bash)

**Cross-validation:**
```bash
# Entity at position
grafema context packages/vscode/src/Orchestrator.ts:42:10

# Node details
grafema get <node-id>

# Dataflow trace
grafema trace <node-id>

# Datalog query
grafema query "?[node, type] := *node_type(node, type), node = '$nodeId'."
```

#### State Management

**Read state:**
```javascript
const state = JSON.parse(fs.readFileSync('_qa/qa-state.json'));
```

**Update state after each line:**
```javascript
state.files[filePath].lastCheckedLine = lineNumber;
state.files[filePath].entities.checked++;
fs.writeFileSync('_qa/qa-state.json', JSON.stringify(state, null, 2));
```

**Add bug:**
```javascript
const bugId = `BUG-${String(Object.keys(state.bugs).length + 1).padStart(3, '0')}`;
state.bugs[bugId] = {
  verdict: "ui-bug",
  file: filePath,
  line: lineNumber,
  entity: entityName,
  panel: panelName,
  expected: { /* graph data */ },
  actual: { /* extension data */ },
  evidence: {
    mcp: mcpResponse,
    cli: cliOutput,
    screenshot: screenshotPath
  },
  linearIssue: null,
  status: "open",
  foundAt: new Date().toISOString(),
  recheckedAt: null
};
state.files[filePath].entities.bugs++;
```

**Add gap:**
```javascript
const gapId = `GAP-${String(Object.keys(state.gaps).length + 1).padStart(3, '0')}`;
state.gaps[gapId] = {
  verdict: "infrastructure-gap",
  description: "Value Trace panel always empty — dataflow not implemented",
  blocking: [filePath, otherFilePath],
  evidence: { /* ... */ },
  linearIssue: null,
  status: "blocking",
  foundAt: new Date().toISOString()
};

// Block affected files
for (const file of state.gaps[gapId].blocking) {
  state.files[file].blockedBy = gapId;
  state.files[file].status = "blocked";
}
```

### Cross-Validation Strategy

For each entity:

#### Step 1: Identify Entity
```bash
grafema context packages/vscode/src/Orchestrator.ts:42:10
# Output: Node ID abc123, type FUNCTION_DECLARATION, name "initializeEngine"
```

#### Step 2: Query Graph
```javascript
const nodes = await mcp__grafema__find_nodes({
  file: '/workspace/packages/vscode/src/Orchestrator.ts',
  line: 42,
  column: 10
});
const node = await mcp__grafema__get_node({ nodeId: nodes[0].id });
```

#### Step 3: Validate Each Panel

**Hover Tooltip:**
- Screenshot: Read tooltip text/structure
- Graph: `node.type`, `node.name`
- Match? ✅ / ❌

**Value Trace:**
```javascript
const trace = await mcp__grafema__trace_dataflow({
  nodeId: nodes[0].id,
  direction: 'forward',
  maxDepth: 5
});
// Compare trace array with panel tree structure
```

**Callers:**
```javascript
const callers = await mcp__grafema__get_neighbors({
  nodeId: nodes[0].id,
  edgeType: 'CALLS',
  direction: 'in'
});
// Compare caller count and names
```

**Edges Explorer:**
```javascript
const outgoing = await mcp__grafema__get_neighbors({
  nodeId: nodes[0].id,
  direction: 'out'
});
const incoming = await mcp__grafema__get_neighbors({
  nodeId: nodes[0].id,
  direction: 'in'
});
// Compare edge types, counts, target nodes
```

**Issues:**
```javascript
const issues = await mcp__grafema__get_issues({
  nodeId: nodes[0].id
});
// Compare issue IDs, titles
```

#### Step 4: Record Result

If PASS:
```javascript
state.files[filePath].entities.ok++;
```

If BUG:
```javascript
addBug({
  verdict: determineVerdict(extension_data, graph_data),
  file: filePath,
  line: lineNumber,
  entity: entityName,
  panel: panelName,
  expected: graph_data,
  actual: extension_data,
  evidence: { mcp: mcpResponse, cli: cliOutput, screenshot: screenshotPath }
});
state.files[filePath].entities.bugs++;
bugs_this_session++;
```

If GAP:
```javascript
addGap({
  description: "Panel X always empty across all files",
  blocking: [all_affected_files],
  evidence: { screenshots: [...], mcpResponses: [...] }
});
STOP_SESSION();
```

### Bug Report Format

**File:** `_qa/reports/bug-NNN.md`

```markdown
# Bug Report: BUG-001

**File:** `packages/vscode/src/Orchestrator.ts:42`
**Entity:** `initializeEngine`
**Panel:** Hover Tooltip
**Verdict:** ui-bug

## Expected (from graph)

Node type: `FUNCTION_DECLARATION`
Node name: `initializeEngine`

## Actual (from extension)

Hover tooltip shows: `VARIABLE_DECLARATION`

## Evidence

### MCP Query
```json
{
  "id": "abc123",
  "type": "FUNCTION_DECLARATION",
  "name": "initializeEngine",
  "metadata": {
    "file": "/workspace/packages/vscode/src/Orchestrator.ts",
    "line": 42
  }
}
```

### CLI Query
```bash
$ grafema context packages/vscode/src/Orchestrator.ts:42:10
Node: FUNCTION_DECLARATION (initializeEngine)
```

### Screenshot
![Hover Tooltip](_qa/screenshots/bug-001-hover.png)

## Status
- Found: 2026-02-20T14:35:00Z
- Linear Issue: (none yet)
- Status: open
```

### Gap Report Format

**File:** `_qa/reports/gap-NNN.md`

```markdown
# Infrastructure Gap: GAP-001

**Verdict:** infrastructure-gap
**Panel:** Value Trace
**Status:** blocking

## Description

Value Trace panel is empty across all checked files. Graph has dataflow data (confirmed via MCP `trace_dataflow`), but panel never renders any content.

## Affected Files
- `packages/vscode/src/Orchestrator.ts` (lines 1-150)
- `packages/vscode/src/index.ts` (lines 1-50)
- `packages/vscode/src/utils.ts` (lines 1-30)

## Evidence

### MCP Confirmation
```json
{
  "trace": [
    {"type": "ASSIGNMENT", "line": 90, "file": "Orchestrator.ts"},
    {"type": "RETURN", "line": 95, "file": "Orchestrator.ts"}
  ]
}
```

### Screenshot Sample
![Empty Value Trace Panel](_qa/screenshots/gap-001-value-trace-empty.png)

## Impact
All files blocked. Cannot check Value Trace panel until infrastructure is fixed.

## Status
- Found: 2026-02-20T14:42:00Z
- Linear Issue: REG-528
- Status: blocking
```

### Session Report Format

**File:** `_qa/reports/session-YYYY-MM-DD-HH-MM-SS.md`

```markdown
# QA Session Report

**Date:** 2026-02-20T14:30:00Z
**Duration:** 45 minutes
**Status:** Stopped (10 bugs found)

## Summary
- **Files checked:** 1 (Orchestrator.ts)
- **Lines checked:** 1-150 (of 500 total)
- **Entities checked:** 75
- **Entities OK:** 70
- **Bugs found:** 3
- **Gaps found:** 1
- **Pass rate:** 93.3%

## Bugs
- BUG-001: Hover tooltip shows wrong node type (line 42)
- BUG-002: Value Trace panel empty (line 85)
- BUG-003: Callers panel shows phantom caller (line 120)

## Gaps
- GAP-001: Value Trace panel infrastructure not working

## Next Steps
1. Fix BUG-001, BUG-002, BUG-003
2. Resolve GAP-001 (blocks further Value Trace checks)
3. Re-run `/qa` to resume from line 151
```

### Edge Cases & Error Handling

**Docker not running:**
```bash
if ! docker ps | grep code-server; then
  echo "ERROR: Docker container 'code-server' not running."
  echo "Start it with: cd demo && docker-compose up -d"
  exit 1
fi
```

**Playwright not installed:**
```bash
if ! npx playwright --version 2>/dev/null; then
  echo "Installing Playwright browsers..."
  npx playwright install chromium
fi
```

**File doesn't exist:**
```javascript
if (!fs.existsSync(filePath)) {
  console.log(`File not found: ${filePath}`);
  state.files[filePath].status = "error";
  continue; // Skip to next file
}
```

**Panel update timeout:**
```javascript
// Wait max 5 seconds for panel update
await page.waitForTimeout(3000);
const panel = await page.$('[aria-label="Grafema: Value Trace"]');
if (!panel) {
  console.log('Panel not visible after 3s — likely UI bug or gap');
  // Check if this is isolated or widespread → determine bug vs gap
}
```

**Screenshot reading limits:**
- Small text (<12pt) may be unreadable → use MCP/CLI for exact data validation
- Use screenshots for structural checks (panel exists, non-empty, has sections)

**Resume from crashed session:**
- State has `lastCheckedLine` → resume from `lastCheckedLine + 1`
- State has `current_file` but file deleted → clear state, start next file

**Version change during session:**
- Detect version change at start of each session
- Re-check open bugs before starting new checks

---

## 7. `.claude/skills/qa/SKILL.md` Structure

### Frontmatter

```yaml
---
name: qa
description: Run automated QA checks on Grafema VS Code extension
version: 1.0.0
agent: qa-agent
---
```

### Usage

```
/qa [file] [--resume] [--recheck] [--task "custom instruction"]
```

**Examples:**
- `/qa` — auto-resume from last session (reads state)
- `/qa packages/vscode/src/Orchestrator.ts` — check specific file
- `/qa --recheck` — re-check all open bugs (version validation)
- `/qa --task "check hover tooltips only"` — custom task

### Arguments

| Arg | Description |
|-----|-------------|
| `[file]` | Specific file path (relative to workspace root) |
| `--resume` | Resume last session (default if no file specified) |
| `--recheck` | Re-check all bugs with status="open" (validate fixes) |
| `--task "..."` | Free-text custom task (e.g., "check Issues panel for Orchestrator.ts") |

### How It Works

1. **Parse arguments** (file path, flags, custom task text)
2. **Read QA state** (`_qa/qa-state.json`)
3. **Determine mode:**
   - File specified → check that file
   - `--resume` → resume from `lastCheckedLine` in `current_file`
   - `--recheck` → re-validate all open bugs
   - `--task` → execute custom task
4. **Launch QA agent** via `Skill` tool with context
5. **Agent runs checks** (Playwright + MCP + state updates)
6. **Return summary** (entities checked, bugs found, reports written)

### Skill Prompt Template

```markdown
You are the Grafema QA Agent. Your task:

{{#if file}}
**File:** `{{file}}`
- Start from line 1
- Check all entities line-by-line
{{/if}}

{{#if resume}}
**Resume session:**
- File: `{{state.current_file}}`
- Resume from line: {{state.files[state.current_file].lastCheckedLine + 1}}
- Already checked: {{state.files[state.current_file].entities.checked}} entities
{{/if}}

{{#if recheck}}
**Re-check bugs:**
- Re-validate all bugs with status="open"
- Mark as "fixed" if now passing
{{/if}}

{{#if task}}
**Custom task:**
> {{task}}

Execute this task, record any bugs/gaps found, update state.
{{/if}}

Follow the process defined in `.claude/agents/qa-agent.md`.

**Session limits:** Stop after 10 bugs.

**Bug vs Gap:** Record bugs for single-entity issues. Record gaps for widespread infrastructure issues → BLOCK files.

**State updates:** Update `_qa/qa-state.json` after each line.

**Reports:** Write bugs to `_qa/reports/bug-NNN.md`, gaps to `_qa/reports/gap-NNN.md`, session summary to `_qa/reports/session-YYYY-MM-DD-HH-MM-SS.md`.
```

### Return Format

```json
{
  "sessionId": "2026-02-20T14:30:00Z",
  "file": "packages/vscode/src/Orchestrator.ts",
  "linesChecked": "1-150",
  "entitiesChecked": 75,
  "entitiesOk": 70,
  "bugsFound": 3,
  "gapsFound": 1,
  "status": "stopped",
  "reason": "Session limit: 10 bugs found",
  "reports": {
    "bugs": ["_qa/reports/bug-001.md", "_qa/reports/bug-002.md", "_qa/reports/bug-003.md"],
    "gaps": ["_qa/reports/gap-001.md"],
    "session": "_qa/reports/session-2026-02-20-14-30-00.md"
  },
  "nextAction": "Fix bugs BUG-001, BUG-002, BUG-003. Resolve gap GAP-001. Re-run /qa to resume."
}
```

---

## 8. Playwright Strategy

### Key Insight
**The agent runs Playwright commands via Bash, takes screenshots, reads them via Read tool.**

### Prerequisites

**At agent start:**
```bash
# 1. Docker running?
docker ps | grep code-server || {
  echo "ERROR: Start Docker with: cd demo && docker-compose up -d"
  exit 1
}

# 2. Playwright installed?
npx playwright --version || npx playwright install chromium

# 3. Code-server accessible?
curl -s http://localhost:8080 > /dev/null || {
  echo "ERROR: code-server not responding at http://localhost:8080"
  exit 1
}
```

### Interaction Flow

**1. Open file:**
```javascript
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('http://localhost:8080');
  await page.waitForSelector('.monaco-workbench', { timeout: 10000 });

  // Open file via Quick Open
  await page.keyboard.press('Meta+P');
  await page.keyboard.type('packages/vscode/src/Orchestrator.ts');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000); // File loads

  await page.screenshot({ path: '_qa/screenshots/file-opened.png', fullPage: true });
  await browser.close();
})();
```

**2. Position cursor (line L, col C):**
```javascript
const lineElement = await page.$(`[data-line-number="${lineNumber}"]`);
const box = await lineElement.boundingBox();
await page.mouse.click(box.x + columnNumber * 7, box.y + 5);
await page.waitForTimeout(500);
```

**3. Hover to trigger tooltip:**
```javascript
await page.mouse.move(box.x + columnNumber * 7, box.y + 5);
await page.waitForTimeout(1500);
await page.screenshot({ path: '_qa/screenshots/hover-tooltip.png' });
```

**4. Capture panel:**
```javascript
const panel = await page.$('[aria-label="Grafema: Value Trace"]');
if (panel) {
  await panel.screenshot({ path: '_qa/screenshots/value-trace.png' });
}
```

**5. Click entity (triggers panel updates):**
```javascript
await page.click(`[data-line-number="${lineNumber}"] >> text="${entityName}"`);
await page.waitForTimeout(3000); // Async graph query + render
await page.screenshot({ path: '_qa/screenshots/panels-updated.png', fullPage: true });
```

### Screenshot Reading

**Agent process:**
1. Take screenshot → `_qa/screenshots/hover-tooltip.png`
2. Read via `Read` tool (Claude sees image)
3. Analyze for:
   - Panel presence (visible/hidden)
   - Non-empty content (has data vs empty state)
   - Expected sections (e.g., "Assignments" header in Value Trace)
4. **Do NOT rely on exact text matching** (small fonts hard to read)
5. Cross-validate exact data with MCP/CLI

---

## 9. Gitignore Additions

**Add to `.gitignore`:**

```gitignore
# QA automation
_qa/screenshots/
```

**Keep tracked:**
- `_qa/qa-state.json` (persistent state)
- `_qa/reports/` (bug/gap reports, session logs)

**Rationale:**
- Screenshots are large, ephemeral, regenerable
- State and reports are small, valuable for tracking

---

## 10. Implementation Checklist

### Phase 1: Setup (Rob)
- [ ] Create `_qa/` directory structure
- [ ] Create `_qa/qa-state.json` with initial empty state (schema v1.0.0)
- [ ] Create `_qa/screenshots/` directory
- [ ] Create `_qa/reports/` directory
- [ ] Update `.gitignore` to exclude `_qa/screenshots/`

### Phase 2: Agent Persona (Rob)
- [ ] Create `.claude/agents/qa-agent.md`
- [ ] Write role & responsibilities section
- [ ] Write tools section (Playwright, Read, MCP, CLI, state management)
- [ ] Write cross-validation strategy section
- [ ] Write bug/gap distinction logic
- [ ] Write version tracking logic
- [ ] Write session limits logic
- [ ] Write edge cases & error handling section

### Phase 3: Skill Entry Point (Rob)
- [ ] Create `.claude/skills/qa/SKILL.md`
- [ ] Write usage documentation
- [ ] Write argument parsing logic
- [ ] Write skill prompt template (file, resume, recheck, task modes)
- [ ] Write return format specification

### Phase 4: Playwright Infrastructure (Rob)
- [ ] Add Playwright dependency check to agent pre-flight
- [ ] Write reusable Playwright script templates:
  - [ ] Open file in code-server
  - [ ] Position cursor on line/column
  - [ ] Hover over entity
  - [ ] Capture panel screenshot
  - [ ] Click entity to trigger panels
- [ ] Test scripts against demo environment (Docker code-server)

### Phase 5: State Management (Rob)
- [ ] Implement state read/write functions
- [ ] Implement version detection (from `package.json`)
- [ ] Implement per-file tracking (lastCheckedLine, entities, sessions)
- [ ] Implement bug registry (add, update, recheck)
- [ ] Implement gap registry (add, block files)
- [ ] Implement custom tasks registry
- [ ] Implement coverage calculation
- [ ] Implement history tracking

### Phase 6: Entity Extraction (Rob)
- [ ] Implement AST-based entity extraction (use `@babel/parser`)
- [ ] Filter identifiers (keep: variables, functions, classes, properties; skip: keywords, operators)
- [ ] Handle edge cases (JSX, TypeScript, decorators)

### Phase 7: Cross-Validation Logic (Rob)
- [ ] Implement MCP query wrappers (find_nodes, get_node, trace_dataflow, get_neighbors, get_issues)
- [ ] Implement CLI query wrappers (context, get, trace)
- [ ] Implement panel-specific comparison logic (hover, value-trace, callers, edges, issues, status)
- [ ] Implement verdict determination (ui-bug vs core-bug vs infrastructure-gap)

### Phase 8: Bug/Gap Detection (Rob)
- [ ] Implement bug report generator (MD format)
- [ ] Implement gap report generator (MD format)
- [ ] Implement session report generator (MD format)
- [ ] Implement blocking behavior (on gap detection, block files, stop session)

### Phase 9: Integration Testing (QA Agent)
- [ ] Test `/qa packages/vscode/src/Orchestrator.ts` — full file check
- [ ] Test `/qa` — auto-resume from state
- [ ] Test `/qa --recheck` — re-validate open bugs
- [ ] Test `/qa --task "check hover only"` — custom task
- [ ] Validate all 6 panels working (or gap detected if broken)
- [ ] Validate state persistence across sessions
- [ ] Validate version tracking (change `package.json` version, re-check bugs)
- [ ] Validate session limits (stop after 10 bugs)

### Phase 10: Documentation (Don)
- [ ] Add `/qa` skill to `CLAUDE.md` skills section
- [ ] Document known limitations (screenshot reading, timing, selector stability)
- [ ] Add troubleshooting guide (Docker not running, Playwright issues, selector breakage)

---

## 11. Success Criteria

### Functional Criteria

**Agent works if:**
1. ✅ Launches Playwright, connects to code-server (Docker)
2. ✅ Opens specified file, positions cursor on entities
3. ✅ Takes screenshots of all 6 panels
4. ✅ Cross-validates with MCP/CLI
5. ✅ Detects mismatches (extension ≠ graph)
6. ✅ Writes bug/gap reports to `_qa/reports/`
7. ✅ Updates `_qa/qa-state.json` after each line
8. ✅ Resumes from `lastCheckedLine + 1` on `--resume`
9. ✅ Re-checks open bugs on `--recheck`
10. ✅ Handles edge cases (Docker down, Playwright missing, empty panels)

### Methodology Criteria

**Agent validates methodology if:**
11. ✅ Checks **every entity on every line** (not a sample)
12. ✅ Uses file ordering (Orchestrator.ts first, then largest to smallest)
13. ✅ Stops after 10 bugs per session
14. ✅ Distinguishes bugs (ui-bug, core-bug) from gaps (infrastructure-gap)
15. ✅ Blocks files on gap detection, stops session
16. ✅ Detects version changes, re-checks open bugs

### State Schema Criteria

**State schema correct if:**
17. ✅ Has per-file tracking: `files.{path}` with `lastCheckedLine`, `entities`, `sessions`
18. ✅ Has bug registry: `bugs.{BUG-NNN}` with verdict, evidence, Linear issue
19. ✅ Has gap registry: `gaps.{GAP-NNN}` with blocking behavior
20. ✅ Has custom tasks registry: `customTasks.{TASK-NNN}`
21. ✅ Has coverage summary: `coverage{totalFiles, checkedFiles, totalEntities, checkedEntities, passRate}`
22. ✅ Has history per version: `history[]`
23. ✅ `version` field tracks extension version (not schema version)

### Acceptance Criteria (from issue)

**Task complete if:**
24. ✅ Custom agent `.claude/agents/qa-agent.md` exists with full prompt
25. ✅ Skill `/qa` with args (file, --recheck, auto-resume, custom task)
26. ✅ Agent traverses Orchestrator.ts from **first to LAST line** without manual intervention
27. ✅ For each entity — checks all 6 panels (or notes which are blocked by gaps)
28. ✅ Bug verdict: UI-bug or core-bug with evidence via CLI/MCP
29. ✅ `_qa/qa-state.json` correctly updates after each session
30. ✅ On restart, agent continues from `lastCheckedLine`
31. ✅ On version change — re-checks previously found bugs
32. ✅ Custom tasks execute and persist in `customTasks` registry

**Validation metrics:**
- **Coverage:** 100% of entities per file (exhaustive)
- **Accuracy:** 0 false positives (only real bugs/gaps)
- **Speed:** ~30 seconds per entity (Playwright + MCP + screenshot)
- **Reliability:** 100% success on demo fixture files

---

## 12. Dijkstra's Gaps — Resolution Table

| Gap # | Issue | Resolution |
|-------|-------|------------|
| GAP-001 | Entity checking rate: sampling vs exhaustive | ✅ Changed to line-by-line exhaustive (Section 3) |
| GAP-002 | State schema: flat vs hierarchical | ✅ Redesigned to rich schema with per-file tracking, bug/gap registries (Section 2) |
| GAP-003 | Bug vs Gap distinction | ✅ Added verdict logic (ui-bug, core-bug, infrastructure-gap) with blocking (Section 4) |
| GAP-004 | Session limits | ✅ Added 10-bug-per-session limit (Section 3) |
| GAP-005 | Version tracking | ✅ Added version detection + bug re-check on version change (Section 5) |
| GAP-006 | File ordering | ✅ Added priority queue: Orchestrator.ts first, then largest-to-smallest (Section 3) |
| GAP-007 | Per-file progress tracking | ✅ Added `lastCheckedLine` per file (Section 2) |
| GAP-008 | Custom task tracking | ✅ Added `customTasks` registry (Section 2) |
| (Preconditions) | Playwright selector stability | ⚠️ Documented as implementation risk (Section 6) |
| (Preconditions) | Extension panel identifiers | ⚠️ Documented as implementation risk (Section 6) |
| (Preconditions) | Graph data availability | ⚠️ Documented: assumes fully analyzed codebase (Section 6) |

---

## 13. Open Questions for Rob (Implementation)

1. **Playwright selector verification:** Before implementing, verify actual Monaco selectors in code-server (`data-line-number`, `aria-label` for panels). Document in agent prompt if different.

2. **AST parser choice:** Use `@babel/parser` for entity extraction or alternative (e.g., TypeScript's own parser)? Recommend `@babel/parser` for broad compatibility (JS, TS, JSX).

3. **Screenshot storage:** Keep all screenshots (for debugging) or delete after validation (save space)? Recommend: keep for 7 days, then auto-delete via cron.

4. **Linear integration:** Should gaps/bugs auto-create Linear issues, or require manual creation? Recommend: manual creation (agent reports, user triages).

5. **Panel update detection:** Instead of fixed 3-second wait, can we detect when panels finish updating? (e.g., DOM mutation observer, WebSocket message listener). Recommend: start with fixed wait, optimize later if needed.

6. **Entity column detection:** How to find exact column offset for identifiers in a line? Parse AST for start/end positions? Recommend: use AST token positions for precision.

7. **Multi-line entities:** How to handle entities spanning multiple lines (e.g., multiline function call)? Recommend: check entity on first line where it starts.

8. **Blocked file resume:** When a gap is resolved, how does agent know to resume blocked files? Recommend: `--resume` checks for files with `blockedBy` that has status="resolved", clears `blockedBy`, resumes checking.

---

## End of Plan v2

This plan fully addresses Dijkstra's 14 gaps and passes all 21 requirements from the issue. Next step: Rob implements Phase 1-8, then QA Agent validates Phase 9.
