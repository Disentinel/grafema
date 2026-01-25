# Rob Pike - Implementation Report: REG-187

## Summary

Implemented the fix for scope filtering in `grafema trace` command. Replaced file path heuristic with semantic ID parsing as specified in Joel's tech plan. All tests pass.

## Changes Made

### File: `/Users/vadimr/grafema/packages/cli/src/commands/trace.ts`

#### 1. Added Import (Line 12)

**Before:**
```typescript
import { RFDBServerBackend } from '@grafema/core';
```

**After:**
```typescript
import { RFDBServerBackend, parseSemanticId } from '@grafema/core';
```

#### 2. Replaced Scope Filtering Logic (Lines 153-162)

**Before (broken - file path substring matching):**
```typescript
// If scope specified, check if variable is in that scope
if (scopeName) {
  const file = (node as any).file || '';
  // Simple heuristic: check if function name is in file path or nearby
  if (!file.toLowerCase().includes(scopeName.toLowerCase())) {
    continue;
  }
}
```

**After (correct - semantic ID parsing):**
```typescript
// If scope specified, check if variable is in that scope
if (scopeName) {
  const parsed = parseSemanticId(node.id);
  if (!parsed) continue; // Skip nodes with invalid IDs

  // Check if scopeName appears anywhere in the scope chain
  const scopeChain = parsed.scopePath.map(s => s.toLowerCase());
  if (!scopeChain.includes(scopeName.toLowerCase())) {
    continue;
  }
}
```

## Implementation Details

### What Changed

1. **Import addition**: Added `parseSemanticId` function from `@grafema/core`
2. **Logic replacement**: Replaced file path substring check with semantic ID scope chain parsing

### How It Works

1. **Parse semantic ID**: Extract scope chain from the node's semantic ID using `parseSemanticId()`
2. **Handle invalid IDs**: If parsing returns `null`, skip the node gracefully
3. **Normalize scope names**: Convert all scope names to lowercase for case-insensitive matching
4. **Exact match**: Check if the user's `scopeName` appears as a complete element in the scope path array

### Example

For a node with ID: `AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response`

- `parseSemanticId()` returns: `{ scopePath: ['AdminSetlist', 'handleDragEnd', 'try#0'], ... }`
- Normalized: `['adminsetlist', 'handledragend', 'try#0']`
- User searches: `trace "response from handleDragEnd"`
- Match: `'handledragend'` is in the array → variable is returned

For the same node with file path "AdminSetlist.tsx":

- User searches: `trace "response from setlist"` (trying to match filename)
- Check: `'setlist'` is NOT in `['adminsetlist', 'handledragend', 'try#0']`
- Result: variable is NOT returned (correct - "setlist" is in filename, not in scope chain)

## Test Results

All tests pass successfully:

```
ok 1 - grafema trace - scope filtering (REG-187)
  ok 1 - semantic ID scope filtering (correct behavior)
    ok 1 - should find variable with exact scope match
    ok 2 - should NOT match scope based on file path substring (regression test)
    ok 3 - should find variable in nested scope when searching parent scope
    ok 4 - should find variable by direct nested scope name (try#0)
    ok 5 - should match scope names case-insensitively
    ok 6 - should return empty when scope does not exist
    ok 7 - should filter correctly when multiple variables have same name in different scopes
  ok 2 - special nodes handling
    ok 1 - should handle singleton nodes gracefully
    ok 2 - should handle singleton nodes when searching by prefix
    ok 3 - should handle external module nodes gracefully
  ok 3 - invalid semantic ID handling
    ok 1 - should skip nodes with malformed IDs
    ok 2 - should skip nodes with too few parts in ID
  ok 4 - no scope filter (null scopeName)
    ok 1 - should return all matching variables when scopeName is null
  ok 5 - global scope handling
    ok 1 - should find global variables when searching by "global" scope
  ok 6 - class scope handling
    ok 1 - should find variable in class method when searching by class name
    ok 2 - should find variable in class method when searching by method name
  ok 7 - discriminator in scope names
    ok 1 - should match exact discriminator scope (if#0 vs if#1)
  ok 8 - multiple node types (VARIABLE, CONSTANT, PARAMETER)
    ok 1 - should find constants in specified scope
    ok 2 - should find parameters in specified scope

ok 2 - parseSemanticId
  (8 tests for parseSemanticId function)
```

**Total: 27 tests, all passing**

## Edge Cases Handled

### 1. Invalid Semantic IDs
- If `parseSemanticId()` returns `null`, the node is skipped
- No crashes, just silently filters out invalid nodes

### 2. Special Node Types
- **Singletons**: `net:stdio->__stdio__` has `scopePath = ['net:stdio']` - won't match typical function names
- **External modules**: `EXTERNAL_MODULE->lodash` has `scopePath = []` - won't match any scope filter
- Both handled gracefully without crashes

### 3. Case Insensitivity
- All scope names normalized to lowercase before comparison
- `trace "x from HANDLEDRAGEND"` matches `handleDragEnd` scope

### 4. Nested Scopes
- Variable in `handleDragEnd->try#0` matches both:
  - `trace "x from handleDragEnd"` (parent scope)
  - `trace "x from try#0"` (direct scope)

### 5. Discriminators
- Scope names include discriminators: `if#0`, `try#0`, etc.
- Exact match required: `if#0` won't match `if#1`

### 6. Multiple Variables with Same Name
- When multiple variables named `x` exist in different scopes
- `trace "x from funcA"` returns only the one from `funcA`
- Limited to 5 results by existing code

### 7. No Scope Filter
- When `scopeName` is `null`, scope filter is skipped entirely
- Returns all variables with matching name (existing behavior preserved)

## Code Quality

### Readability
- Clear, self-documenting code
- Inline comment explains the logic
- Error handling is explicit (null check)

### Simplicity
- Straightforward array lookup using `.includes()`
- No complex logic or clever tricks
- Matches existing code style in the file

### Performance
- `parseSemanticId()`: O(k) where k = ID length (typically < 200 chars)
- `.map()` and `.includes()`: O(m) where m = scopePath length (typically 1-5 elements)
- No performance regression expected

### Error Handling
- Gracefully handles invalid semantic IDs (returns null, node skipped)
- No crashes on malformed data
- Fail-safe behavior: if parsing fails, node is excluded from results

## Alignment with Vision

From Don's plan:
> "Use the semantic ID that's already there. The scopeName appears in this chain. We don't need edges or graph traversal - the information is in the ID itself."

This implementation:
- Uses existing semantic ID infrastructure
- No new graph traversal
- No new edges
- Deterministic, not heuristic
- Queries graph structure (scope hierarchy) instead of reading files

## What Was NOT Changed

1. **Pattern parsing** - `parseTracePattern()` unchanged
2. **Edge traversal** - `traceBackward()`, `traceForward()` unchanged
3. **Output formatting** - `displayTrace()` unchanged
4. **Value source lookup** - `getValueSources()` unchanged
5. **Other commands** - only `trace` command affected
6. **Backend/core** - no changes, using existing API

## Files Modified

1. `/Users/vadimr/grafema/packages/cli/src/commands/trace.ts`
   - Line 12: Added import
   - Lines 153-162: Replaced scope filtering logic
   - Total: 1 line import, 10 lines in function (was 7, now 10)

## Verification

### Unit Tests
- Command: `node --test test/unit/commands/trace.test.js`
- Result: All 27 tests pass
- Duration: ~5.4 seconds

### Test Coverage
- Exact scope match
- Regression test (file path substring should NOT match)
- Nested scope matching
- Case insensitivity
- Non-existent scope
- Multiple variables with same name
- Singleton nodes
- External module nodes
- Invalid semantic IDs
- No scope filter (null)
- Global scope
- Class scope
- Discriminators
- Multiple node types (VARIABLE, CONSTANT, PARAMETER)

## Next Steps

Ready for review by:
1. **Kevlin Henney** - code quality, readability, test quality
2. **Linus Torvalds** - high-level: did we do the right thing?

## Implementation Time

- Reading Joel's plan: 2 minutes
- Making changes: 3 minutes
- Running tests: 1 minute
- Writing this report: 5 minutes

**Total: ~11 minutes**

## Confidence Level

**High**

Reasons:
1. Straightforward change (2 edits, 10 lines total)
2. All tests pass (27/27)
3. Tests cover all edge cases
4. Uses existing, well-tested infrastructure (`parseSemanticId`)
5. No complex logic introduced
6. Matches project patterns and style
7. Clear improvement over previous heuristic approach
