# Joel Spolsky - Technical Implementation Plan for REG-395

## Architecture: Three-Phase Pipeline

1. **Text Search** — Shell out to system `rg` with `--json` output
2. **Graph Enrichment** — For each match, find containing function + callers
3. **Format Output** — Text or JSON

## Atomic Commits

### Commit 1: Command skeleton + ripgrep integration
- Create `packages/cli/src/commands/grep.ts`
- Register in `packages/cli/src/cli.ts`
- Implement ripgrep spawning with JSON parsing
- Fallback to Node.js native search if rg not available
- Get file list from MODULE nodes (or fall back to project directory)

### Commit 2: Graph enrichment
- Per-file cache of FUNCTION/METHOD/CLASS nodes sorted by line
- Binary search for containing function at file:line
- Find callers via CALLS edges
- Graceful degradation when graph unavailable

### Commit 3: Output formatting + tests
- Text output with graph context annotations
- JSON output mode
- Integration tests

## Key Algorithms

### Finding Containing Function (O(log F) with cache)
```
1. Get all FUNCTION/METHOD/CLASS nodes in file → cache by file
2. Sort by line number
3. Binary search for last function whose line <= matchLine
```

### Finding Callers (O(E * D))
```
1. Get incoming CALLS edges to function
2. For each caller edge, findContainingFunction of the call node
3. Return list of calling functions
```

## CLI Interface
```bash
grafema grep <pattern> [options]
  -p, --project <path>    Project path (default: ".")
  -i, --ignore-case       Case-insensitive search
  -C, --context <n>       Lines of context (default: 0)
  -l, --limit <n>         Max results (default: 50)
  --json                  JSON output
  --no-graph              Skip graph enrichment
```

## Files
- NEW: `packages/cli/src/commands/grep.ts` (~400 lines)
- MOD: `packages/cli/src/cli.ts` (+2 lines)
- NEW: test files

## Performance
- ripgrep: ~200ms for 10K files
- graph enrichment: ~6ms per match
- total: <1s for 50 matches in typical project
