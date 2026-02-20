---
name: qa
description: |
  Run automated QA checks on Grafema VS Code extension via Playwright + MCP cross-validation.
  Use when: (1) user says "/qa" to start or resume QA session, (2) user wants to validate
  extension panels against graph data, (3) user wants to re-check previously found bugs after
  a fix, (4) user wants to run a custom QA task. Requires Docker code-server running.
author: Claude Code
version: 1.0.0
date: 2026-02-20
---

# /qa -- Grafema VS Code Extension QA

## When to Use

- Validate VS Code extension UI against graph data
- Check specific files or resume from last session
- Re-check open bugs after fixes (version validation)
- Run custom QA tasks (e.g., "check hover tooltips only")

## Usage

```
/qa                                           # Auto-resume from last session
/qa packages/vscode/src/Orchestrator.ts       # Check specific file
/qa --recheck                                 # Re-validate all open bugs
/qa check only the Callers panel              # Custom task (free text)
```

## Prerequisites

- Docker container `code-server` running (`cd demo && docker-compose up -d`)
- Playwright chromium available (auto-installed if missing)
- Code-server accessible at `http://localhost:8080`
- Grafema graph database populated (extension must be analyzing a project)

## How It Works

### 1. Parse Arguments

Determine the mode from the user's input:

- **No args / empty**: auto-resume. Find file with `status: "in-progress"` in state, resume from `lastCheckedLine + 1`. If none, pick next unchecked file.
- **File path**: check that specific file from line 1 (or resume if already in-progress).
- **`--recheck`**: re-validate all bugs with `status: "open"` and gaps with `status: "blocking"`.
- **Anything else**: treat as free-text custom task. Record in `customTasks` registry.

### 2. Load State

Read `_qa/qa-state.json`. This tracks:
- Per-file progress (which line we left off at)
- Bug registry (all bugs found across sessions)
- Gap registry (infrastructure gaps that block files)
- Custom task history
- Coverage statistics
- Version history

### 3. Check Docker

Verify the code-server Docker container is running and accessible. If not, print the start command and stop.

### 4. Launch QA Agent

Read the agent instructions from `.claude/agents/qa-agent.md`. The agent:

- Drives code-server via Playwright (inline Node.js scripts in Bash)
- Takes screenshots and reads them (multimodal -- Claude sees images)
- Cross-validates every panel with Grafema MCP tools and CLI
- Records bugs and gaps with full evidence
- Updates state after every checked line
- Stops after 10 bugs per session

### 5. Return Summary

After the session completes, report:
- How many entities were checked
- How many bugs and gaps were found
- Which reports were written
- What to do next (fix bugs, resolve gaps, re-run /qa)

## Modes

### Auto-Resume (default)

Finds the first file with `status: "in-progress"` and resumes from `lastCheckedLine + 1`. If no file is in progress, picks the next unchecked file using priority order: Orchestrator.ts first, then largest files first.

### Specific File

Checks the given file from line 1. If the file was previously in-progress, resumes from where it left off.

### Recheck

Re-validates all open bugs and blocking gaps. Does NOT check new lines. Marks fixed bugs as `"fixed"` and resolved gaps as `"resolved"`. Useful after deploying a fix to verify it works.

### Custom Task

Any argument that is not a file path and not `--recheck` is treated as a free-text instruction. The agent executes the task, records it in `customTasks`, and still logs any bugs/gaps found to the normal registries.

## Output Locations

| Artifact | Path |
|----------|------|
| State file | `_qa/qa-state.json` |
| Bug reports | `_qa/reports/bug-NNN.md` |
| Gap reports | `_qa/reports/gap-NNN.md` |
| Session reports | `_qa/reports/session-YYYY-MM-DD-HH-MM-SS.md` |
| Screenshots | `_qa/screenshots/` (gitignored) |

## Session Limits

The agent stops after finding 10 bugs in a single session. This keeps reports manageable and encourages incremental fixing. Fix the bugs, then re-run `/qa` to continue.

## Extension Panels

The extension registers 7 panels: Status, Value Trace, Callers, Blast Radius, Issues, Explorer, Debug Log. Plus the built-in Monaco hover tooltip.

**Note:** The panel formerly called "Edges Explorer" in early docs is actually "Blast Radius".

## Bug vs Gap

- **Bug** (`ui-bug` or `core-bug`): single entity shows wrong/missing data in one panel. Recorded, agent continues.
- **Gap** (`infrastructure-gap`): entire panel broken across 5+ entities in multiple files. Blocks affected files, agent stops session.

## Troubleshooting

### Docker not running
```bash
cd demo && docker-compose up -d
```

### Playwright not installed
The agent auto-installs chromium. If it fails:
```bash
npx playwright install chromium
```

### Code-server not responding
Check Docker logs:
```bash
docker logs code-server
```

### Panels not updating after click
The agent waits 3 seconds for async panel updates. If panels are still empty, this may indicate an infrastructure gap rather than a timing issue.

### Screenshots unreadable
Small text in screenshots may be hard to read. The agent uses MCP/CLI for exact data validation and screenshots only for structural checks (panel visible, non-empty, has sections).
