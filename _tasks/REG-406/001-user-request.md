# REG-406: CLI `grafema context <nodeId>` — deep context with source code and graph neighborhood

## Goal

New CLI command `grafema context <semanticId>` that shows deep context for a specific node: source code + graph neighborhood (callers, callees) with source code at each call site.

## Motivation

SWE-bench trajectory analysis on preact-3345 shows that **62% of agent steps are navigation** — reading code fragments with `cat | sed -n`. Grafema `query` finds the right node quickly (4 steps), but the agent then spends **26 steps** doing `cat file | sed -n 'X,Yp'` to read:
- The function body
- Code context around each call site
- Repeated reads of the same ranges (agent forgets context)

A single `grafema context` call would replace ~16 of those steps.

**Projected impact:** 48 steps → 32 steps (-33%), navigation overhead 62% → 44%.

## Two parts:

1. **`grafema query`** — add SemanticID to output
2. **`grafema context <semanticId>`** — deep dive for ONE node:
   - Source code of the node
   - Called by (callers with code context)
   - Calls (callees)

### Options:
- `--depth N` — DFS/BFS depth (default: 1, max: 3)
- `--json` — JSON output for MCP/programmatic use
- `--lines N` — context lines (default: 3)

## Acceptance criteria
- `grafema query` shows SemanticID in output
- `grafema context <semanticId>` shows source code of the node
- `grafema context` shows callers with code context at each call site
- `grafema context` shows callees
- Output stays under ~100 lines for a typical function
- `--json` flag for programmatic use
- Works via MCP
