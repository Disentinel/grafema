# REG-526: Rob Pike Implementation Report

**Author:** Rob Pike (Implementation Engineer)
**Date:** 2026-02-20
**Plan:** `_tasks/REG-526/004-don-plan-v2.md`

---

## Summary

Created the QA automation infrastructure for Grafema VS Code extension validation. This is the first custom agent in the project, along with its skill entry point, persistent state file, and supporting directory structure.

## Deliverables Created

### 1. `.claude/agents/qa-agent.md` (NEW)

First custom agent in the project. Self-contained prompt that guides the QA agent through Playwright-based testing of the VS Code extension against graph data.

**Sections included:**
- **Role**: Systematic validation of VS Code extension panels against graph data
- **State Management**: reads/writes `_qa/qa-state.json`, tracks per-file progress, bug/gap registries
- **Pre-flight Checks**: Docker container, Playwright chromium, code-server accessibility
- **Version Detection**: reads from `packages/vscode/package.json`, triggers recheck on version change
- **File Ordering**: Orchestrator.ts first, then largest-to-smallest
- **Auto-Resume Logic**: handles no-args, filename, `--recheck`, and free-text custom tasks
- **Checking Methodology**: line-by-line exhaustive, every entity on every line
- **Panel Validation**: all 6 panels (hover, value-trace, callers, edges, issues, status) with specific MCP cross-validation tools for each
- **Playwright Interaction Patterns**: inline Node.js scripts via Bash with Ctrl (not Meta) for Linux container
- **Bug vs Gap Verdict Logic**: 4-case decision tree plus infrastructure gap detection (5+ similar failures = gap)
- **Recording bugs/gaps**: full evidence capture (MCP response, CLI output, screenshot path)
- **Session Limits**: stop after 10 bugs per session
- **Report Formats**: bug report, gap report, session report templates
- **Custom Tasks**: free-text task execution with registry tracking
- **Error Handling**: Docker down, Playwright missing, file not found, panel timeout, crash recovery
- **Recheck Flow**: re-validates open bugs and blocking gaps

### 2. `.claude/skills/qa/SKILL.md` (NEW)

Skill entry point for the `/qa` command. Follows the project's existing skill format (YAML frontmatter with name, description, author, version, date).

**Features:**
- Usage documentation with examples for all 4 modes
- Prerequisites section (Docker, Playwright, code-server)
- Mode descriptions: auto-resume, specific file, recheck, custom task
- Output locations table (state, reports, screenshots)
- Troubleshooting guide

### 3. `_qa/qa-state.json` (NEW)

Initial empty state with schema version 1.0.0:
- `version: null` (populated on first run from package.json)
- Empty registries: `files`, `bugs`, `gaps`, `customTasks`
- Zero coverage: `totalFiles: 0`, `checkedFiles: 0`, etc.
- Empty `history` array

### 4. `_qa/screenshots/.gitkeep` (NEW)
### 5. `_qa/reports/.gitkeep` (NEW)

Directory placeholder files to ensure directories are tracked by git.

### 6. `.claude/agents/` directory (NEW)

First agents directory in the project. Added `!.claude/agents/` negation to `.gitignore` so agents are tracked (matching the existing `!.claude/skills/` pattern).

### 7. `.gitignore` updates

Two changes:
- Added `!.claude/agents/` to track the new agents directory (line 33)
- Added `_qa/screenshots/*` and `!_qa/screenshots/.gitkeep` to ignore screenshots but keep the directory tracked (lines 56-57)

Note: used `_qa/screenshots/*` (glob) instead of `_qa/screenshots/` (directory) so the `.gitkeep` negation works. Git ignores directory-level rules completely and won't look inside for negated files.

## Design Decisions

### Ctrl vs Meta
The plan's Playwright examples used `Meta+P` for Quick Open. Changed to `Control+p` in the agent prompt because code-server runs in a Linux Docker container where Meta/Cmd is not available. This is called out explicitly in the agent with a bold note.

### Inline scripts only
The agent prompt specifies running Playwright as inline Node.js scripts via Bash, not as separate script files. This keeps the system self-contained within the agent prompt and avoids file management overhead.

### Screenshot validation strategy
Screenshots are used for structural checks (panel present, non-empty, has sections). Exact data validation is done via MCP/CLI queries. This is because small text in screenshots may be unreadable by the vision model.

### .gitignore glob pattern
Used `_qa/screenshots/*` instead of `_qa/screenshots/` for the gitignore rule. The trailing-slash form ignores the directory entirely and git will not look inside it for negation patterns. The glob form ignores contents but allows the `.gitkeep` negation to work.

## Files Modified

| File | Action | Lines |
|------|--------|-------|
| `.claude/agents/qa-agent.md` | Created | ~350 |
| `.claude/skills/qa/SKILL.md` | Created | ~120 |
| `_qa/qa-state.json` | Created | 17 |
| `_qa/screenshots/.gitkeep` | Created | 0 |
| `_qa/reports/.gitkeep` | Created | 0 |
| `.gitignore` | Modified | +3 lines |

## Verification

All files confirmed trackable by git:
```
git add --dry-run .claude/agents/qa-agent.md      # OK
git add --dry-run .claude/skills/qa/SKILL.md      # OK
git add --dry-run _qa/qa-state.json               # OK
git add --dry-run _qa/reports/.gitkeep             # OK
git add --dry-run _qa/screenshots/.gitkeep         # OK
git add --dry-run .gitignore                       # OK
```

Screenshot files confirmed ignored:
```
git check-ignore _qa/screenshots/some-image.png   # Ignored
```
