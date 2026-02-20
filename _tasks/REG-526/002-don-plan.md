# REG-526: QA Agent + /qa Skill — Implementation Plan

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-20
**Task:** Create automated QA agent that validates VS Code extension UI against Grafema graph data

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

## 2. `.claude/agents/qa-agent.md` Structure

### Purpose
This is the **first custom agent** in `.claude/agents/`. It defines a specialized QA persona that:
- Runs Playwright via Bash to automate code-server
- Takes screenshots and reads them via Read tool
- Cross-validates extension UI with Grafema MCP/CLI
- Maintains persistent state in `_qa/qa-state.json`

### Sections

#### **Frontmatter** (YAML)
```yaml
---
name: QA Agent
description: Automated QA for Grafema VS Code extension
version: 1.0.0
tools:
  - Bash (Playwright commands)
  - Read (screenshot analysis)
  - mcp__linear__* (Linear integration for bug reports)
  - Grafema MCP tools (cross-validation)
  - Write (state updates)
state_file: _qa/qa-state.json
---
```

#### **Role & Responsibilities**
- You are a QA automation agent for the Grafema VS Code extension
- Your job: validate that extension panels (Status, Value Trace, Callers, Edges Explorer, Issues, Hover) display correct data from the graph
- You interact with code-server (running in Docker at `http://localhost:8080`) via Playwright
- You cross-validate UI with Grafema MCP tools and CLI
- You maintain session state in `_qa/qa-state.json`

#### **Tools You Use**

**Playwright (via Bash):**
- `npx playwright codegen http://localhost:8080` — generate selectors (one-time)
- `npx playwright screenshot <url> --full-page <path>` — capture full page
- Inline scripts via `node -e "..."` to:
  - Open file in code-server
  - Click on specific line/column
  - Hover over entity
  - Wait for panel updates
  - Take screenshot of specific panel

**Read Tool:**
- Read screenshots as images (Claude is multimodal)
- Extract text, identify UI elements, check data presence
- **Limitation:** Small text may be hard to read — focus on structural validation (panel exists, non-empty, has expected sections)

**Grafema MCP Tools:**
- `mcp__grafema__find_nodes` — find entity by name/type
- `mcp__grafema__get_node` — get full node data (metadata, properties)
- `mcp__grafema__trace_dataflow` — validate Value Trace panel
- `mcp__grafema__get_neighbors` — validate Callers panel (incoming edges of type `CALLS`)
- `mcp__grafema__query` — Datalog queries for complex checks
- `mcp__grafema__get_issues` — validate Issues panel

**Grafema CLI (via Bash):**
- `grafema query "..."` — Datalog queries
- `grafema get <node-id>` — node details
- `grafema trace <node-id>` — dataflow trace
- `grafema context <file>:<line>:<col>` — context at position

**State Management:**
- Read `_qa/qa-state.json` at start
- Update after each file/entity check
- Write bug reports to `_qa/reports/YYYY-MM-DD-HH-MM-SS.md`

#### **Playwright Interaction Patterns**

**Pre-flight checks:**
```bash
# Check Docker is running
docker ps | grep code-server || echo "ERROR: Docker not running"

# Check Playwright browsers installed
npx playwright --version || npx playwright install chromium
```

**Open file in code-server:**
```javascript
// Via Playwright script (node -e "...")
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:8080');
  // Wait for code-server to load
  await page.waitForSelector('.monaco-workbench');
  // Open file via Command Palette (Cmd+P)
  await page.keyboard.press('Meta+P');
  await page.keyboard.type('test/fixtures/01-basic-usage/index.js');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000); // Let file load
  await page.screenshot({ path: '_qa/screenshots/file-opened.png', fullPage: true });
  await browser.close();
})();
```

**Hover over entity (line X, column Y):**
```javascript
// Click on line number to position cursor, then hover
await page.click('.monaco-editor .line-numbers >> text="42"');
await page.mouse.move(350, 450); // Approximate pixel position
await page.waitForTimeout(1000); // Let hover tooltip appear
await page.screenshot({ path: '_qa/screenshots/hover-tooltip.png' });
```

**Capture specific panel:**
```javascript
// Screenshot just the Value Trace panel
const panel = await page.$('[aria-label="Value Trace"]');
await panel.screenshot({ path: '_qa/screenshots/value-trace-panel.png' });
```

**Key insight:** Agent writes small Playwright scripts to Bash, runs them, reads screenshots via Read tool.

#### **Cross-Validation Strategy**

For each entity checked in the UI:

1. **Identify entity** (from file path + line/column or hover tooltip)
2. **Query graph** via MCP:
   ```javascript
   // Example: validate hover tooltip shows correct node type
   const nodes = await mcp__grafema__find_nodes({
     file: '/workspace/test/fixtures/01-basic-usage/index.js',
     line: 42
   });
   const node = await mcp__grafema__get_node({ nodeId: nodes[0].id });
   // Check node.type matches what's shown in hover tooltip
   ```

3. **Cross-check with CLI**:
   ```bash
   grafema context test/fixtures/01-basic-usage/index.js:42:10
   # Compare output with extension's hover tooltip
   ```

4. **Compare results:**
   - Extension shows X → Graph confirms X ✅
   - Extension shows X → Graph shows Y ❌ → **BUG REPORT**
   - Extension shows nothing → Graph has data ❌ → **BUG REPORT**
   - Extension shows X → Graph has no data → ⚠️ **EXPECTED** (entity not analyzed)

**Validation checklist per entity:**

| Panel | What to Check | MCP Tool | CLI Command |
|-------|---------------|----------|-------------|
| **Hover Tooltip** | Node type, name, file path | `get_node` | `grafema context <pos>` |
| **Value Trace** | Dataflow chain (assignments, returns) | `trace_dataflow` | `grafema trace <node-id>` |
| **Callers** | Incoming `CALLS` edges | `get_neighbors` (direction=in, type=CALLS) | `grafema query "..."` |
| **Edges Explorer** | All edges (in/out) | `get_neighbors` (both directions) | `grafema get <node-id>` |
| **Issues** | Issue nodes linked to this entity | `get_issues` | `grafema query "..."` |
| **Status Bar** | File analysis status, node count | `find_nodes` (count) | `grafema ls` |

#### **State Management Contract**

**`_qa/qa-state.json` schema:**
```json
{
  "version": "1.0.0",
  "session_id": "2026-02-20T14:30:00Z",
  "current_file": "test/fixtures/01-basic-usage/index.js",
  "checked_entities": [
    {
      "file": "test/fixtures/01-basic-usage/index.js",
      "line": 5,
      "column": 10,
      "entity_type": "FUNCTION_DECLARATION",
      "entity_name": "add",
      "timestamp": "2026-02-20T14:35:00Z",
      "panels_checked": ["hover", "callers", "value-trace"],
      "status": "passed"
    }
  ],
  "bugs_found": 3,
  "total_entities_checked": 15,
  "last_report": "_qa/reports/2026-02-20-14-40-00.md"
}
```

**Update rules:**
- Append to `checked_entities` after each entity validation
- Increment `bugs_found` when mismatch detected
- Update `last_report` when writing bug report
- `--recheck` flag → clear `checked_entities`, keep `bugs_found` counter
- Auto-resume: read `current_file` and `checked_entities`, skip already-checked positions

#### **Bug Report Format**

**File:** `_qa/reports/YYYY-MM-DD-HH-MM-SS.md`

```markdown
# QA Bug Report — [Date/Time]

## Summary
Found 3 mismatches between VS Code extension and graph data.

---

## Bug #1: Hover Tooltip Shows Wrong Node Type

**File:** `test/fixtures/01-basic-usage/index.js:5:10`
**Entity:** `add` (function declaration)

**Expected (from graph):**
- Node type: `FUNCTION_DECLARATION`
- Node name: `add`

**Actual (from extension):**
- Hover tooltip shows: `VARIABLE_DECLARATION`

**Screenshots:**
- Hover: `_qa/screenshots/hover-line5-col10.png`

**MCP Validation:**
```json
{
  "id": "abc123",
  "type": "FUNCTION_DECLARATION",
  "name": "add"
}
```

**CLI Validation:**
```bash
$ grafema context test/fixtures/01-basic-usage/index.js:5:10
Node: FUNCTION_DECLARATION (add)
```

**Verdict:** ❌ Extension shows incorrect node type

---

## Bug #2: Value Trace Panel Empty

[Same format...]
```

#### **Edge Cases & Error Handling**

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
if ! npx playwright --version; then
  echo "Installing Playwright browsers..."
  npx playwright install chromium
fi
```

**Screenshot reading limits:**
- Claude can see images but may miss small text (<12pt)
- Focus on **structural checks**: panel visible, non-empty, has expected sections
- For exact text matching: use MCP/CLI cross-validation, not screenshot OCR

**Entity selection strategy:**
- **Check:** imports, declarations (function/class/variable), function calls, assignments
- **Skip:** keywords (`function`, `return`, `const`), operators (`+`, `=`), punctuation (`;`, `,`)
- **Rate:** ~5-10 entities per file (representative sample, not exhaustive)

**What counts as an entity:**
- Import specifiers: `import { foo } from 'bar'` → check `foo`
- Function declarations: `function add() {}` → check `add`
- Class declarations: `class User {}` → check `User`
- Variable declarations: `const x = 5` → check `x`
- Function calls: `add(1, 2)` → check `add`
- Property access: `obj.prop` → check `prop` (if graph tracks it)

**Timeout strategy:**
- Each Playwright action: 1-2 second wait for UI updates
- Panel updates (Value Trace, Callers): 3-5 seconds (extension queries graph asynchronously)
- File opening: 2 seconds for syntax highlighting + initial analysis

---

## 3. `.claude/skills/qa/SKILL.md` Structure

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
- `/qa` — resume last session (from `_qa/qa-state.json`)
- `/qa test/fixtures/01-basic-usage/index.js` — check specific file
- `/qa --recheck` — re-check all entities in current file
- `/qa --task "check hover tooltips only"` — custom task

### Arguments

| Arg | Description |
|-----|-------------|
| `[file]` | Specific file to check (relative to workspace root) |
| `--resume` | Resume last session (default if no file specified) |
| `--recheck` | Re-check entities already validated (ignore state) |
| `--task "..."` | Free-text custom task (e.g., "check Issues panel only") |

### How It Works

1. **Parse arguments** (extract file path, flags, custom task)
2. **Read QA state** (`_qa/qa-state.json`)
3. **Launch QA agent** via `Skill` tool with parsed context
4. **Pass state to agent** (current file, checked entities, resume point)
5. **Agent runs checks** (Playwright + MCP cross-validation)
6. **Agent updates state** after each entity
7. **Agent writes bug report** if issues found
8. **Skill returns summary** (entities checked, bugs found, report path)

### Skill Prompt Template

```markdown
You are the Grafema QA Agent. Your task:
{{#if file}}
- Check file: `{{file}}`
{{/if}}
{{#if resume}}
- Resume session from: `{{state.current_file}}` (skip {{state.checked_entities.length}} already checked)
{{/if}}
{{#if recheck}}
- Re-check all entities (ignore previous state)
{{/if}}
{{#if task}}
- Custom task: "{{task}}"
{{/if}}

Follow the process defined in `.claude/agents/qa-agent.md`.

Report bugs to `_qa/reports/YYYY-MM-DD-HH-MM-SS.md`.
Update state in `_qa/qa-state.json` after each entity.
```

### Return Format

```json
{
  "session_id": "2026-02-20T14:30:00Z",
  "file": "test/fixtures/01-basic-usage/index.js",
  "entities_checked": 12,
  "bugs_found": 2,
  "report": "_qa/reports/2026-02-20-14-40-00.md",
  "summary": "Checked 12 entities, found 2 mismatches (hover tooltip, Value Trace panel)"
}
```

---

## 4. `_qa/qa-state.json` — Initial Schema

```json
{
  "version": "1.0.0",
  "session_id": null,
  "current_file": null,
  "checked_entities": [],
  "bugs_found": 0,
  "total_entities_checked": 0,
  "last_report": null
}
```

**Fields:**
- `version`: Schema version (for future migrations)
- `session_id`: ISO timestamp of current session start
- `current_file`: File being checked (null if no active session)
- `checked_entities`: Array of validated entities (see schema above)
- `bugs_found`: Counter of mismatches detected
- `total_entities_checked`: Running total (persists across `--recheck`)
- `last_report`: Path to most recent bug report

---

## 5. Playwright Strategy

### Key Insight
**The agent runs Playwright commands via Bash, takes screenshots, reads them via Read tool.**

### Prerequisites

**Check at agent start:**
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

  // Open file via Quick Open (Cmd+P on macOS, Ctrl+P on Linux)
  await page.keyboard.press('Meta+P'); // Docker runs Linux, but code-server maps Meta
  await page.keyboard.type('test/fixtures/01-basic-usage/index.js');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000); // Let file load

  await page.screenshot({ path: '_qa/screenshots/file-opened.png', fullPage: true });
  await browser.close();
})();
```

**2. Position cursor on entity (line X, col Y):**
```javascript
// Click on specific line in editor
// Monaco uses .view-line[data-line-number="X"]
await page.click('.view-line[data-line-number="5"]');
// Then click at approximate column offset (Monaco uses proportional font)
// For column 10, estimate pixel position based on font size (~7px per char)
const lineElement = await page.$('.view-line[data-line-number="5"]');
const box = await lineElement.boundingBox();
await page.mouse.click(box.x + 10 * 7, box.y + 5); // Click at column 10
await page.waitForTimeout(500); // Let cursor position
```

**3. Hover to trigger tooltip:**
```javascript
// Move mouse to entity position (triggers hover provider)
await page.mouse.move(box.x + 10 * 7, box.y + 5);
await page.waitForTimeout(1500); // Wait for hover tooltip to appear
await page.screenshot({ path: '_qa/screenshots/hover-tooltip.png' });
```

**4. Capture specific panel:**
```javascript
// Grafema extension panels have aria-labels
const valuTracePanel = await page.$('[aria-label="Grafema: Value Trace"]');
if (valueTracePanel) {
  await valueTracePanel.screenshot({ path: '_qa/screenshots/value-trace.png' });
} else {
  console.log('Value Trace panel not visible');
}
```

**5. Click on entity (triggers panel updates):**
```javascript
// Click on identifier triggers extension to query graph
await page.click('.view-line[data-line-number="5"] >> text="add"');
await page.waitForTimeout(3000); // Wait for async graph query + panel render
await page.screenshot({ path: '_qa/screenshots/panels-updated.png', fullPage: true });
```

### Screenshot Reading

**Agent process:**
1. Take screenshot via Playwright (`_qa/screenshots/hover-tooltip.png`)
2. Read screenshot via `Read` tool (Claude sees image)
3. Analyze image for:
   - Panel visibility (present/absent)
   - Non-empty content (has text/data vs. empty state)
   - Expected sections (e.g., Value Trace shows "Assignments" section)
4. **Do NOT rely on exact text matching** (small fonts hard to read)
5. Cross-validate data with MCP/CLI (source of truth)

**Example analysis:**
```
Screenshot: _qa/screenshots/value-trace.png
Observed:
- Panel visible: ✅
- Shows tree structure: ✅
- Has "Assignments" header: ✅
- Shows 3 items (small text, can't read details): ✅

Next step: Validate via MCP (trace_dataflow) that those 3 items are correct.
```

---

## 6. Cross-Validation Flow

### Entity Validation Pipeline

**For each entity (e.g., function `add` at line 5, col 10):**

#### Step 1: Identify Entity
```bash
# Get entity at cursor position (via CLI)
grafema context test/fixtures/01-basic-usage/index.js:5:10
# Output: Node ID abc123, type FUNCTION_DECLARATION, name "add"
```

#### Step 2: Query Graph (MCP)
```javascript
// Find node at position
const nodes = await mcp__grafema__find_nodes({
  file: '/workspace/test/fixtures/01-basic-usage/index.js',
  line: 5,
  column: 10
});
// Get full node data
const node = await mcp__grafema__get_node({ nodeId: nodes[0].id });
```

#### Step 3: Validate Each Panel

**Hover Tooltip:**
- **Extension shows:** Node type, name, file path
- **Graph confirms:** `node.type`, `node.name`, `node.metadata.file`
- **Match?** ✅ / ❌

**Value Trace Panel:**
```javascript
// Query dataflow
const trace = await mcp__grafema__trace_dataflow({
  nodeId: nodes[0].id,
  direction: 'forward',
  maxDepth: 5
});
// Extension should show same chain
```
- **Extension shows:** Tree of assignments/returns
- **Graph confirms:** `trace` array
- **Match?** Count, node types, relationships

**Callers Panel:**
```javascript
// Get incoming CALLS edges
const callers = await mcp__grafema__get_neighbors({
  nodeId: nodes[0].id,
  edgeType: 'CALLS',
  direction: 'in'
});
```
- **Extension shows:** List of callers
- **Graph confirms:** `callers` array
- **Match?** Count, caller names

**Edges Explorer:**
```javascript
// Get all edges (both directions)
const outgoing = await mcp__grafema__get_neighbors({
  nodeId: nodes[0].id,
  direction: 'out'
});
const incoming = await mcp__grafema__get_neighbors({
  nodeId: nodes[0].id,
  direction: 'in'
});
```
- **Extension shows:** Tree of all edges
- **Graph confirms:** Combined `outgoing` + `incoming`
- **Match?** Edge types, counts, target nodes

**Issues Panel:**
```javascript
// Get issues linked to this node
const issues = await mcp__grafema__get_issues({
  nodeId: nodes[0].id
});
```
- **Extension shows:** List of issues
- **Graph confirms:** `issues` array
- **Match?** Issue IDs, titles

#### Step 4: Record Result

```javascript
// Update state
const entity = {
  file: 'test/fixtures/01-basic-usage/index.js',
  line: 5,
  column: 10,
  entity_type: 'FUNCTION_DECLARATION',
  entity_name: 'add',
  timestamp: new Date().toISOString(),
  panels_checked: ['hover', 'value-trace', 'callers', 'edges', 'issues'],
  status: 'passed' // or 'failed'
};
state.checked_entities.push(entity);
```

#### Step 5: Write Bug Report (If Mismatch)

See "Bug Report Format" section above.

---

## 7. Gitignore Additions

**Add to `.gitignore`:**

```gitignore
# QA automation
_qa/screenshots/
```

**Keep tracked:**
- `_qa/qa-state.json` (persistent session state)
- `_qa/reports/` (bug reports for historical record)

**Rationale:**
- Screenshots are large, ephemeral, regenerable
- State and reports are small, valuable for debugging

---

## 8. Important Edge Cases

### Docker Must Be Running

**Check before Playwright launch:**
```bash
if ! docker ps | grep code-server; then
  echo "ERROR: Docker container 'code-server' not running."
  echo "Start it with: cd demo && docker-compose up -d"
  exit 1
fi
```

**If container exists but stopped:**
```bash
docker start code-server
sleep 5 # Wait for code-server to initialize
```

### Playwright Browser Installation

**First-time setup:**
```bash
# Check if Playwright browsers installed
if ! npx playwright --version 2>/dev/null; then
  echo "Installing Playwright..."
  npm install -D playwright
fi

# Install Chromium browser
npx playwright install chromium
```

**In Docker environment:**
- Agent runs on host, Playwright connects to code-server in Docker
- No need for Playwright inside container
- Use `headless: true` mode (no GUI)

### Screenshot Reading Limitations

**Claude can see images but:**
- Small text (<12pt) may be unreadable
- UI elements may be visually ambiguous
- Colors/icons easier to identify than text

**Strategy:**
- Use screenshots for **structural validation** (panel exists, non-empty)
- Use MCP/CLI for **data validation** (exact values, counts, relationships)
- Example: Screenshot shows "Value Trace panel has 3 items" → MCP confirms those 3 items are correct

### Entity Selection Rate

**DO NOT check every token:**
- ❌ `function` keyword, `return` keyword, `;` punctuation
- ✅ `add` function name, `x` variable name, `User` class name

**Target rate:** 5-10 entities per file
- Representative sample, not exhaustive
- Prioritize:
  1. High-value entities (exports, classes, complex functions)
  2. Diverse node types (declaration, call, assignment)
  3. Entities with many edges (likely to have issues)

**What counts as an entity:**

| Code | Entity to Check | Node Type |
|------|-----------------|-----------|
| `import { foo } from 'bar'` | `foo` | IMPORT_SPECIFIER |
| `function add(a, b) {}` | `add` | FUNCTION_DECLARATION |
| `const x = 5` | `x` | VARIABLE_DECLARATION |
| `add(1, 2)` | `add` | CALL_EXPRESSION |
| `class User {}` | `User` | CLASS_DECLARATION |
| `obj.prop` | `prop` | MEMBER_EXPRESSION |

**Skip:**
- Keywords: `function`, `const`, `return`, `class`, `import`
- Operators: `+`, `-`, `=`, `===`
- Punctuation: `;`, `,`, `{`, `}`

### Panel Update Timing

**Extension panels query graph asynchronously:**
- Click on entity → extension sends request to rfdb-server → panel updates
- **Typical latency:** 100-500ms (local WebSocket)
- **Safe wait time:** 2-3 seconds after click

**Playwright wait strategy:**
```javascript
await page.click('.view-line >> text="add"');
await page.waitForTimeout(3000); // Wait for panel updates
// Then screenshot panels
```

**Network latency in Docker:**
- rfdb-server runs on port 7432 (WebSocket)
- code-server runs on port 8080
- Both in same Docker network → minimal latency
- If panels don't update: check rfdb-server logs for errors

### Expected "No Data" Cases

**Not every entity will have data in all panels:**

| Panel | Expected Empty When... |
|-------|------------------------|
| Value Trace | Entity is not a variable/parameter (e.g., class declaration) |
| Callers | Entity is not a function (e.g., variable declaration) |
| Issues | No static analysis rules triggered |
| Edges | Entity has no relationships (rare, but possible for isolated code) |

**Validation rule:**
- Extension shows empty panel → MCP confirms no data → ✅ **PASS**
- Extension shows empty panel → MCP has data → ❌ **BUG**
- Extension shows data → MCP has no data → ❌ **BUG** (phantom data)

### Resumption Edge Cases

**`--resume` from crashed session:**
- `qa-state.json` may have `current_file` but incomplete `checked_entities`
- Agent should resume from last checked entity in that file
- If file doesn't exist or was deleted: clear state, start fresh

**`--recheck` behavior:**
- Keep `bugs_found` counter (historical record)
- Clear `checked_entities` for current file
- Re-validate all entities (ignore previous results)

**State corruption recovery:**
- If `qa-state.json` is malformed: reset to initial schema
- Log warning, start new session

---

## 9. Implementation Checklist

### Phase 1: Setup (Rob)
- [ ] Create `.claude/agents/qa-agent.md` with full persona prompt
- [ ] Create `.claude/skills/qa/SKILL.md` with argument parsing logic
- [ ] Create `_qa/qa-state.json` with initial empty schema
- [ ] Create `_qa/screenshots/` directory
- [ ] Create `_qa/reports/` directory
- [ ] Update `.gitignore` to exclude `_qa/screenshots/`

### Phase 2: Playwright Infrastructure (Rob)
- [ ] Add Playwright dependency check to agent pre-flight
- [ ] Write reusable Playwright script templates:
  - [ ] `open-file.js` — open file in code-server
  - [ ] `click-entity.js` — click on line/column
  - [ ] `hover-entity.js` — trigger hover tooltip
  - [ ] `screenshot-panel.js` — capture specific panel
- [ ] Test Playwright scripts against demo environment

### Phase 3: Cross-Validation Logic (Rob)
- [ ] Implement MCP query wrappers (find entity, get node, trace, neighbors, issues)
- [ ] Implement CLI query wrappers (context, get, trace)
- [ ] Write comparison logic (extension data vs. graph data)
- [ ] Write bug report generator

### Phase 4: State Management (Rob)
- [ ] Implement state read/write functions
- [ ] Implement `--resume` logic (skip checked entities)
- [ ] Implement `--recheck` logic (clear checked entities)
- [ ] Implement session ID generation (ISO timestamp)

### Phase 5: Integration Testing (QA Agent)
- [ ] Run `/qa test/fixtures/01-basic-usage/index.js` against demo
- [ ] Validate all 6 panels (hover, Value Trace, Callers, Edges, Issues, Status)
- [ ] Check 5-10 entities in file
- [ ] Generate bug report if mismatches found
- [ ] Verify state persistence across sessions

### Phase 6: Documentation (Don)
- [ ] Add `/qa` skill to `CLAUDE.md` skills section
- [ ] Document known limitations (screenshot reading, timing)
- [ ] Add troubleshooting guide (Docker not running, Playwright issues)

---

## 10. Success Criteria

**Agent works if:**
1. ✅ Launches Playwright, connects to code-server (Docker)
2. ✅ Opens specified file, positions cursor on entities
3. ✅ Takes screenshots of all 6 panels
4. ✅ Cross-validates with MCP/CLI (compares data)
5. ✅ Detects mismatches (extension ≠ graph)
6. ✅ Writes bug reports to `_qa/reports/`
7. ✅ Updates `_qa/qa-state.json` after each entity
8. ✅ Resumes from last position on `--resume`
9. ✅ Re-checks entities on `--recheck`
10. ✅ Handles edge cases (Docker down, Playwright missing, empty panels)

**Validation metrics:**
- **Coverage:** 5-10 entities per file (representative sample)
- **Accuracy:** 0 false positives (report only real bugs)
- **Speed:** ~30 seconds per entity (Playwright + MCP + screenshot analysis)
- **Reliability:** 100% success rate on demo fixture files

---

## 11. Open Questions for Dijkstra

1. **Playwright script reusability:** Should we extract script templates to `_qa/playwright/*.js` or keep them inline in agent Bash commands?
2. **Screenshot storage:** Keep all screenshots (for debugging) or delete after validation (save space)?
3. **MCP vs CLI priority:** Which should be source of truth for cross-validation? (Prefer MCP for programmatic access, CLI for human-readable output?)
4. **Entity selection heuristic:** Should agent use AST-based entity detection (parse file, find all declarations/calls) or cursor-based sampling (click on random lines)?
5. **Panel update detection:** Instead of fixed 3-second wait, can we detect when panels finish updating? (Listen for WebSocket messages, DOM mutation observers?)

---

## End of Plan

This plan provides complete structure for REG-526. Next step: Rob implements Phase 1-4, then QA Agent validates Phase 5.
