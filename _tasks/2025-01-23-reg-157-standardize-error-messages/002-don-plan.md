# Don Melton - Tech Lead Analysis: REG-157

## Executive Summary

This task is **the RIGHT approach**. Error message standardization is a user-facing quality improvement that aligns with Grafema's AI-first vision. Consistent error messages help both humans and AI agents understand what went wrong and how to fix it.

**Complexity Assessment:** Mini-MLA sufficient (Don -> Rob -> Linus)

## Current State Analysis

### Error Patterns Found

I identified **4 distinct error patterns** across CLI commands:

#### Pattern A: Checkmark + Suggestion (init.ts, overview.ts, query.ts, trace.ts, impact.ts)
```
✗ No graph database found
  → Run "grafema analyze" first
```
- Uses `✗` symbol
- Uses `→` for next steps
- Indentation with 2 spaces

#### Pattern B: Error Prefix (check.ts, stats.ts)
```
Error: No database found at .grafema/graph.rfdb
Run "grafema analyze" first to create the database.
```
- Uses `Error:` prefix
- No special symbols
- Includes path in error message
- Second line is plain text, not indented

#### Pattern C: Error Prefix + List (check.ts for unknown guarantee)
```
Error: Unknown guarantee "xyz"

Available guarantees:
  - option1
  - option2
```
- Blank line after error
- List uses `  - ` prefix

#### Pattern D: Special Case (analyze.ts fatal error)
```
Analysis failed with fatal error:
  {error.message}
```
- Different structure entirely
- Shows diagnostics report afterward

### Commands Requiring Updates

| Command | File | Error Points | Current Pattern |
|---------|------|--------------|-----------------|
| init | init.ts:43-46 | No package.json | A |
| analyze | analyze.ts:275-281 | Fatal error | D (special) |
| overview | overview.ts:25-27 | No database | A |
| query | query.ts:47-49 | No database | A |
| trace | trace.ts:48-50 | No database | A |
| impact | impact.ts:50-52 | No database | A |
| check | check.ts:81-87, 103-105, 176-181, 260-262, 316 | Multiple | B, C |
| stats | stats.ts:21-23 | No database | B |

### Existing Utils Structure

```
packages/cli/src/utils/
├── codePreview.ts    # Code snippet extraction
└── formatNode.ts     # Node display formatting (REG-125)
```

The `formatNode.ts` is a good reference - it was created for a similar standardization task (REG-125).

## Proposed Solution

### Helper Function Design

Create `packages/cli/src/utils/errorFormatter.ts`:

```typescript
/**
 * Standardized error formatting for CLI commands - REG-157
 * 
 * Provides consistent error messages across all CLI commands.
 * Format:
 *   ✗ Main error message (1 line, concise)
 *   
 *   → Next action 1
 *   → Next action 2
 */

/**
 * Print a standardized error message and exit.
 * 
 * @param title - Main error message (should be under 80 chars)
 * @param nextSteps - Optional array of actionable suggestions
 * @returns never - always calls process.exit(1)
 * 
 * @example
 * exitWithError('No graph database found', [
 *   'Run: grafema analyze'
 * ]);
 */
export function exitWithError(title: string, nextSteps?: string[]): never {
  console.error(`✗ ${title}`);
  
  if (nextSteps && nextSteps.length > 0) {
    console.error('');
    for (const step of nextSteps) {
      console.error(`→ ${step}`);
    }
  }
  
  process.exit(1);
}
```

### Key Design Decisions

1. **No external dependencies** - Uses built-in `console.error()` and `process.exit()`
2. **Returns `never`** - TypeScript knows this function terminates execution
3. **Empty line before next steps** - Improves readability
4. **No indentation on next steps** - Arrow provides visual hierarchy
5. **Simple API** - Just title + optional next steps array

### Standard Error Messages

| Error Category | Title | Next Steps |
|---------------|-------|------------|
| Missing database | `No graph database found` | `Run: grafema analyze` |
| Missing package.json | `No package.json found` | `Initialize a project: npm init` |
| Unknown argument | `Invalid <arg>: <value>` | `Valid options: ...` |
| Config error | `Config error: <details>` | `Run: grafema init` |
| File not found | `File not found: <path>` | `Check path and try again` |
| Unknown guarantee | `Unknown guarantee: <name>` | `Available: ...` |

### Special Case: analyze.ts

The `analyze.ts` command has a different error structure because:
1. It needs to show diagnostic reports
2. It has multiple exit codes (0, 1, 2)
3. Errors are reported AFTER partial completion

**Recommendation:** Keep analyze.ts error handling separate but update the format:

```typescript
// Before
console.error('Analysis failed with fatal error:');
console.error(`  ${error.message}`);

// After
console.error('✗ Analysis failed');
console.error('');
console.error(`→ ${error.message}`);
```

This maintains the special behavior while adopting the visual format.

## Implementation Plan

### Phase 1: Create Helper (5 min)
1. Create `packages/cli/src/utils/errorFormatter.ts`
2. Export `exitWithError()` function
3. Add JSDoc with examples

### Phase 2: Update Commands (20 min)

Order by simplest to most complex:

1. **overview.ts** (1 error point) - Simple database check
2. **query.ts** (1 error point) - Simple database check  
3. **trace.ts** (1 error point) - Simple database check
4. **impact.ts** (1 error point) - Simple database check
5. **stats.ts** (1 error point) - Update format
6. **init.ts** (1 error point) - Update format
7. **analyze.ts** (1 error point) - Update format only
8. **check.ts** (5 error points) - Most complex, handle carefully

### Phase 3: Verify (5 min)
1. Run `npm run build` in cli package
2. Test each error path manually:
   - `grafema overview` (no database)
   - `grafema init` (no package.json)
   - `grafema check --guarantee=invalid`

## Architectural Considerations

### Why This Is Right

1. **Consistency improves UX** - Users learn one pattern
2. **AI agents benefit** - Standardized format is easier to parse
3. **Low risk** - Error handling is isolated, no logic changes
4. **Clear precedent** - `formatNode.ts` shows this pattern works

### Why NOT to Over-Engineer

1. **Don't create error classes** - Simple function is sufficient
2. **Don't add error codes** - Messages are already actionable
3. **Don't add colors** - Symbols (✗, →) work in all terminals
4. **Don't localize** - English is fine for CLI tool

### Edge Cases

1. **check.ts freshness errors** - These should use `console.warn()` not `exitWithError()` because they don't always exit
2. **analyze.ts diagnostics** - Keep separate from `exitWithError()` due to complex exit codes
3. **explore.tsx** - Also has the pattern, should be updated too

## Risk Assessment

**Risk Level: LOW**

- No logic changes
- Only console output changes
- Easy to test visually
- Easy to revert if needed

## Test Strategy

No new tests needed. This is a formatting change with no behavioral impact. Manual verification is sufficient:

```bash
# Test each error path
cd packages/cli
npm run build

# No database
rm -rf /tmp/test-project/.grafema
grafema overview -p /tmp/test-project

# No package.json
mkdir -p /tmp/empty && cd /tmp/empty && grafema init

# Invalid guarantee
grafema check --guarantee=invalid
```

## Recommendation

**Proceed with implementation.** This is a clean, well-scoped improvement that aligns with project quality standards.

**Assignee:** Rob Pike (straightforward implementation, matches existing patterns)
**Reviewer:** Linus (verify consistency and no scope creep)
