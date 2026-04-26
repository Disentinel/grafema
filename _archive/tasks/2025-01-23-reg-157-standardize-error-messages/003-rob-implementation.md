# Rob Pike - Implementation Report: REG-157

## Summary

Implemented standardized error formatting across all CLI commands. Created helper function and updated 9 commands.

## Changes Made

### New File

**`packages/cli/src/utils/errorFormatter.ts`**
- Created `exitWithError(title, nextSteps?)` function
- Uses `console.error()` for all output (goes to stderr)
- Returns `never` type for TypeScript flow analysis
- Format: `✗ Error message` + blank line + `→ Next step`

### Updated Commands

| Command | Error Points Updated |
|---------|---------------------|
| overview.ts | 1 (no database) |
| query.ts | 1 (no database) |
| trace.ts | 1 (no database) |
| impact.ts | 1 (no database) |
| stats.ts | 1 (no database) |
| init.ts | 1 (no package.json) |
| explore.tsx | 1 (no database) |
| check.ts | 7 (no database x2, unknown guarantee x2, guarantee not found, stale graph x2) |
| analyze.ts | 1 (fatal error - format only, kept special behavior) |

### Before/After Examples

**Before (stats.ts):**
```
Error: No database found at .grafema/graph.rfdb
Run "grafema analyze" first to create the database.
```

**After (all commands):**
```
✗ No graph database found

→ Run: grafema analyze
```

**Before (check.ts --fail-on-stale):**
```
Error: Graph is stale (3 module(s) changed)
  - file1.ts (modified)
  - file2.ts (deleted)
```

**After:**
```
✗ Graph is stale: 3 module(s) changed
  file1.ts (modified)
  file2.ts (deleted)

→ Run: grafema analyze
```

**Before (check.ts unknown guarantee):**
```
Error: Unknown guarantee "xyz"

Available guarantees:
  - node-creation
```

**After:**
```
✗ Unknown guarantee: xyz

→ Available: node-creation
```

**Before (analyze.ts fatal):**
```
Analysis failed with fatal error:
  <error.message>
```

**After:**
```
✗ Analysis failed: <error.message>

→ Run with --debug for detailed diagnostics
```

**Before (init.ts):**
```
✗ No package.json found
  → Are you in a JavaScript/TypeScript project?
  → Run "npm init" to create one
```

**After:**
```
✗ No package.json found

→ Initialize a project: npm init
→ Or check you are in the right directory
```

## Design Decisions

1. **No arrow indentation** - Arrow symbol (→) provides sufficient visual hierarchy
2. **Blank line before next steps** - Improves readability
3. **analyze.ts special handling** - Kept separate error flow due to:
   - Multiple exit codes (0, 1, 2)
   - Diagnostic report output after error
   - Still updated visual format for consistency
4. **check.ts freshness errors** - Kept special format (not using helper) because:
   - Need to show file list for CI debugging
   - Need to close backend before exit
   - Updated to consistent `✗`/`→` visual format
5. **Simpler messages** - Removed paths from "no database" errors (users know where they are)
6. **Actionable suggestions** - All next steps start with a verb
7. **Error message in title** - For analyze.ts, error message is the problem (in title), not a suggestion

## Verification

- `npm run build` in cli package: ✅ Success
- `npm test`: ✅ 1173 tests, 1161 passed, 12 skipped, 0 failed

## Files Changed

```
packages/cli/src/utils/errorFormatter.ts  (new)
packages/cli/src/commands/overview.ts
packages/cli/src/commands/query.ts
packages/cli/src/commands/trace.ts
packages/cli/src/commands/impact.ts
packages/cli/src/commands/stats.ts
packages/cli/src/commands/init.ts
packages/cli/src/commands/explore.tsx
packages/cli/src/commands/check.ts
packages/cli/src/commands/analyze.ts
```

## Acceptance Criteria Checklist

- [x] Helper function in `errorFormatter.ts`
- [x] All 9 commands use consistent format (8 use helper, 2 special cases use manual format)
- [x] Consistent format: `✗ Error` + `→ Next steps`
- [x] Messages under 80 characters
- [x] Next steps are actionable
- [x] Errors go to stderr
- [x] All tests pass
