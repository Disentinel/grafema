# Don Melton - Technical Analysis and Plan

## REG-204: Explore Command Raw Mode Error

---

## 1. Problem Analysis

### Root Cause
The `grafema explore` command at `packages/cli/src/commands/explore.tsx` uses the `ink` library (version 6.6.0) for interactive terminal UI. The command calls `render()` from ink at line 1044:

```typescript
const { waitUntilExit } = render(
  <Explorer
    backend={backend}
    startNode={startNode}
    projectPath={projectPath}
  />
);
```

Ink internally calls `process.stdin.setRawMode(true)` to handle keyboard input (`useInput` hook). In non-TTY environments (CI, piped input, non-interactive shells), `process.stdin.setRawMode` is undefined because stdin is not a TTY.

### Why This Matters for Grafema's Vision
Grafema's core thesis is **"AI should query the graph, not read code."** The `explore` command is designed for interactive graph navigation, but:

1. **AI agents run non-interactively** - When Claude Code or other AI agents try to use `grafema explore`, they hit this error
2. **CI/CD pipelines need graph exploration** - Automated workflows cannot use this command
3. **Scriptability is blocked** - Cannot pipe queries or integrate with other tools

This directly contradicts Grafema being an **AI-first tool**.

---

## 2. Existing Patterns Analysis

### CLI Commands That Work Non-Interactively
All other CLI commands (`query`, `get`, `trace`, `impact`, `overview`, `stats`) work in non-interactive mode because they:
- Accept all input via command-line arguments
- Output to stdout (text or JSON with `--json` flag)
- Do not use `ink` or any interactive TUI library

Example from `query.ts`:
```typescript
export const queryCommand = new Command('query')
  .argument('<pattern>', 'Search pattern')
  .option('-j, --json', 'Output as JSON')
  .action(async (pattern, options) => {
    // Direct stdout output, no TUI
  });
```

### MCP Module Pattern
The MCP module at `packages/mcp/` provides programmatic access to graph operations. All operations are:
- Fully argument-based (no interactive input)
- JSON output
- Designed for AI agents

This is the correct pattern for AI-first design.

---

## 3. Solution Options

### Option A: Add Batch Mode (Recommended)
Add command-line arguments for non-interactive use:

```bash
grafema explore --query "authenticate"     # One-shot search
grafema explore --callers "authenticate"   # Show callers of function
grafema explore --callees "authenticate"   # Show callees of function
grafema explore --json                     # JSON output for programmatic use
```

**Pros:**
- Aligns with AI-first vision
- Consistent with other CLI commands
- Works in all environments
- Scriptable and pipeable

**Cons:**
- Requires implementation effort
- Duplicates some functionality from `query` command

### Option B: Graceful Fallback with TTY Detection
Detect non-TTY environment and fall back to batch mode:

```typescript
if (!process.stdin.isTTY) {
  exitWithError('Interactive mode requires a terminal', [
    'Use: grafema explore --query "name"  (batch mode)',
    'Use: grafema query "name"  (search)',
    'Use: grafema impact "name"  (impact analysis)',
  ]);
}
```

**Pros:**
- Simple to implement
- Clear guidance to users
- No breaking changes

**Cons:**
- Doesn't add new functionality
- Still requires users to use different commands

### Option C: Full Dual-Mode Support (Best Long-term)
Combine both: TUI mode when TTY available, batch mode via arguments:

```typescript
const hasQueryArg = options.query || options.callers || options.callees;

if (!process.stdin.isTTY && !hasQueryArg) {
  exitWithError('Interactive mode requires a terminal', [...]);
}

if (hasQueryArg) {
  // Batch mode - direct output
  await runBatchExplore(backend, options);
} else {
  // Interactive TUI
  render(<Explorer .../>);
}
```

---

## 4. Recommended Approach: Option C

Given Grafema's vision as an AI-first tool, the RIGHT solution is **Option C: Full Dual-Mode Support**.

### Rationale

1. **AI-first design**: AI agents get programmatic access via `--query`, `--callers`, `--callees` flags
2. **Human UX preserved**: Interactive TUI still available when TTY is present
3. **Consistent with existing commands**: Follows patterns from `query`, `trace`, `impact`
4. **Future-proof**: Can add more batch operations as needed

### Key Design Decisions

1. **Batch mode outputs should be JSON-first**
   - Default to JSON for programmatic use
   - Add `--format text` option for human-readable output

2. **Reuse existing helper functions**
   - `getCallers()`, `getCallees()`, `searchNodes()` already exist in explore.tsx
   - Can be extracted and reused for batch mode

3. **TTY detection should use standard Node.js API**
   ```typescript
   const isTTY = process.stdin.isTTY && process.stdout.isTTY;
   ```

4. **Error messages should guide users to alternatives**
   - When interactive mode fails, suggest batch mode flags
   - Reference related commands (`query`, `impact`)

---

## 5. Implementation Plan

### Phase 1: Add TTY Detection and Error Handling (Quick Win)
1. Add TTY check before `render()`
2. Show helpful error with alternatives
3. Tests for non-TTY behavior

### Phase 2: Add Batch Mode Options
1. Add `--query <name>` flag for node search
2. Add `--callers <name>` flag for caller analysis
3. Add `--callees <name>` flag for callee analysis
4. Add `--depth <n>` flag for traversal depth
5. Add `--json` flag (default in batch mode)

### Phase 3: Refactor for Code Reuse
1. Extract helper functions to separate module
2. Share between batch mode and TUI components
3. Add comprehensive tests

---

## 6. Acceptance Criteria

1. **Non-interactive detection**
   - [ ] `grafema explore` in non-TTY shows clear error with suggestions
   - [ ] Error message includes available alternatives

2. **Batch mode**
   - [ ] `grafema explore --query "name"` returns search results
   - [ ] `grafema explore --callers "name"` returns callers
   - [ ] `grafema explore --callees "name"` returns callees
   - [ ] `echo "q" | grafema explore --query "x"` works in pipes

3. **Output formats**
   - [ ] JSON output by default in batch mode
   - [ ] `--format text` produces human-readable output

4. **Backward compatibility**
   - [ ] Interactive TUI still works when TTY available
   - [ ] Existing behavior preserved for human users

---

## 7. Files to Modify

| File | Changes |
|------|---------|
| `packages/cli/src/commands/explore.tsx` | Add TTY detection, batch mode options, batch handlers |
| `packages/cli/src/utils/exploreHelpers.ts` | Extract reusable functions (new file) |
| `test/unit/cli/explore.test.ts` | Add tests for batch mode (new file) |

---

## 8. Questions for Review

1. **Scope**: Should batch mode support all TUI features (modules view, data flow, class members)?
2. **Priority**: Should Phase 1 (quick fix) be released separately?
3. **Consistency**: Should we align output format with MCP tool responses?

---

## Summary

The "Raw mode is not supported" error is a fundamental UX issue that blocks Grafema's AI-first vision. The root cause is the `ink` library requiring TTY for interactive features. The RIGHT solution is dual-mode support: preserve TUI for humans with TTY, add programmatic batch mode for AI agents and scripts. This aligns with how all other CLI commands work and follows the MCP module's AI-first design principles.

---

## Critical Files for Implementation

- `packages/cli/src/commands/explore.tsx` - Main file to modify
- `packages/cli/src/commands/query.ts` - Pattern to follow for batch mode
- `packages/cli/src/utils/errorFormatter.ts` - Use `exitWithError()` for graceful error handling
- `packages/mcp/src/definitions.ts` - Reference for AI-first API design patterns
- `packages/cli/src/commands/impact.ts` - Pattern for traversal-based analysis with depth control
