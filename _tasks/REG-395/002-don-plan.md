# Don Melton - Technical Plan for REG-395: grafema grep

## The Problem

`grafema query` finds **graph nodes** (functions, classes, variables), but fails for **text patterns** without semantic representation. Property accesses like `config.maxBodyLength`, string literals, and arbitrary code snippets don't exist as nodes.

For SWE-bench agents, keyword search is the entry point. When `query` returns nothing, they fall back to raw grep and lose all graph context.

## Architecture

Three-step pipeline:

1. **Text Search**: Use ripgrep to find pattern in analyzed files
2. **Graph Enrichment**: For each match location, find containing function + callers
3. **Format Output**: Show match with graph context

## Key Decisions

1. **Ripgrep over Node.js regex** — 10-100x faster, battle-tested
2. **Files on disk, not in RFDB** — MODULE nodes have `file` path, not contents
3. **Graph context: containing function + callers** — reuses existing patterns
4. **Graceful degradation** — works even without graph data

## Files to Create/Modify

- `packages/cli/src/commands/grep.ts` — new command
- `packages/cli/src/utils/ripgrep.ts` — ripgrep wrapper
- `packages/core/src/queries/findNodesAtLocation.ts` — location-based node lookup
- `packages/cli/src/cli.ts` — register command
- Tests for each component

## CLI Design

```bash
grafema grep <pattern> [options]
  -i, --ignore-case
  -C, --context <n>
  -l, --limit <n>
  --json
  --no-graph
```

## Performance Target

- Text search: <500ms (ripgrep)
- Graph enrichment: ~10ms per match
- Total: <1s for typical projects
