# Joel Spolsky - Technical Implementation Plan: REG-187

## Summary

Replace file path heuristic with semantic ID parsing in `findVariables()` function. The fix is a 10-line change in `/Users/vadimr/grafema/packages/cli/src/commands/trace.ts` (lines 140-176).

## Verification: Dependencies Confirmed

### 1. `parseSemanticId` Export Status

Confirmed in `/Users/vadimr/grafema/packages/core/src/index.ts:59`:
```typescript
export { parseSemanticId } from './core/SemanticId.js';
```

Available for import in CLI commands.

### 2. Return Type

From `/Users/vadimr/grafema/packages/core/src/core/SemanticId.ts:52-59`:
```typescript
export interface ParsedSemanticId {
  file: string;
  scopePath: string[];  // <-- This is what we need
  type: string;
  name: string;
  discriminator?: number;
  context?: string;
}
```

Function signature (line 104):
```typescript
export function parseSemanticId(id: string): ParsedSemanticId | null
```

**Returns `null` if ID is invalid** - must handle this case.

### 3. `scopePath` Structure

Example from Don's plan:
```
AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response
                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                  scopePath = ['AdminSetlist', 'handleDragEnd', 'try#0']
```

Each scope name may include discriminators like `try#0`, `if#1` - this is expected and correct.

## Implementation Details

### File to Modify

**Path:** `/Users/vadimr/grafema/packages/cli/src/commands/trace.ts`

### Import Addition (Line 12)

**Current:**
```typescript
import { RFDBServerBackend } from '@grafema/core';
```

**After:**
```typescript
import { RFDBServerBackend, parseSemanticId } from '@grafema/core';
```

### Code Change (Lines 153-159)

**Current (broken):**
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

**After (correct):**
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

**Line count:** Was 6 lines, now 8 lines (+2 lines).

### Logic Explanation

1. **Parse the semantic ID**: Extract scope chain from `node.id`
2. **Handle parse failure**: If `parseSemanticId` returns `null`, skip this node
3. **Normalize scope names**: Convert all scope names to lowercase for case-insensitive matching
4. **Exact match in chain**: Check if user's `scopeName` appears as a complete element in the scope path

**Example:**
- Node ID: `AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response`
- Parsed scopePath: `['AdminSetlist', 'handleDragEnd', 'try#0']`
- Normalized: `['adminsetlist', 'handledragend', 'try#0']`
- User input: `trace "response from handleDragEnd"` → scopeName = `"handleDragEnd"`
- Match: `'handledragend'` is in the normalized array → PASS

## Test Plan (TDD)

### Test File Location

Create: `/Users/vadimr/grafema/test/unit/commands/trace.test.js`

Use existing pattern from `/Users/vadimr/grafema/test/unit/commands/get.test.js`.

### Test Structure

```javascript
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { TestBackend } from '../../helpers/TestRFDB.js';
```

### Test Cases

#### 1. Baseline: Scope filtering works for exact function name

**Setup:**
- Add variable `response` in function `handleDragEnd`
- Node ID: `AdminSetlist.tsx->AdminSetlist->handleDragEnd->VARIABLE->response`

**Test:**
```javascript
it('should find variable in exact scope match', async () => {
  // Setup
  await backend.addNode({
    id: 'AdminSetlist.tsx->AdminSetlist->handleDragEnd->VARIABLE->response',
    nodeType: 'VARIABLE',
    name: 'response',
    file: 'AdminSetlist.tsx',
    line: 42,
  });
  await backend.flush();

  // Test: simulate findVariables with scopeName = "handleDragEnd"
  // (Will need to extract findVariables logic or test via command)
});
```

**Expected:** Variable found.

#### 2. Regression: File name does NOT match scope

**Setup:**
- Variable in file `AdminSetlist.tsx`, function `handleDragEnd`
- User searches: `trace "response from setlist"` (hoping "setlist" in filename matches)

**Test:**
```javascript
it('should NOT match scope based on file path substring', async () => {
  await backend.addNode({
    id: 'AdminSetlist.tsx->AdminSetlist->handleDragEnd->VARIABLE->response',
    nodeType: 'VARIABLE',
    name: 'response',
    file: 'AdminSetlist.tsx',
    line: 42,
  });
  await backend.flush();

  // scopeName = "setlist" should NOT match (it's in file, not in scope chain)
});
```

**Expected:** Variable NOT found. This proves we're not doing file path matching anymore.

#### 3. Nested scope matching

**Setup:**
- Variable in nested scope: `try#0` inside `handleDragEnd`
- Node ID: `AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->error`

**Test:**
```javascript
it('should find variable in nested scope (try block)', async () => {
  await backend.addNode({
    id: 'AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->error',
    nodeType: 'VARIABLE',
    name: 'error',
    file: 'AdminSetlist.tsx',
    line: 50,
  });
  await backend.flush();

  // scopeName = "try#0" should match
  // scopeName = "handleDragEnd" should also match (parent scope)
});
```

**Expected:** Both "try#0" and "handleDragEnd" should find the variable.

#### 4. Case insensitivity

**Setup:**
- Function name: `handleDragEnd`
- User searches: `trace "response from HANDLEDRAGEND"` (all caps)

**Expected:** Variable found (case-insensitive match).

#### 5. Non-existent scope

**Setup:**
- Variable exists in `handleDragEnd`
- User searches: `trace "response from nonExistent"`

**Expected:** No results (scope doesn't exist in chain).

#### 6. Multiple variables, same name, different scopes

**Setup:**
- Variable `x` in `funcA`
- Variable `x` in `funcB`
- User searches: `trace "x from funcA"`

**Expected:** Only variable from `funcA` returned.

#### 7. Special nodes (singletons, external modules)

**Setup:**
- External module: `EXTERNAL_MODULE->lodash`
- Singleton: `net:stdio->__stdio__`

**Test:**
```javascript
it('should handle singleton nodes gracefully', async () => {
  await backend.addNode({
    id: 'net:stdio->__stdio__',
    nodeType: 'SINGLETON',
    name: '__stdio__',
    file: '',
  });
  await backend.flush();

  // scopeName = "stdio" should NOT crash, but won't match (scopePath is ['net:stdio'])
});
```

**Expected:** No crash. May or may not match depending on scopePath structure for singletons.

#### 8. Invalid semantic IDs

**Setup:**
- Node with malformed ID: `broken-id-format`

**Expected:** parseSemanticId returns `null`, node is skipped, no crash.

### Test Fixtures

**None needed.** All test data created in-memory via `TestBackend`.

### Testing Strategy

1. **Write tests FIRST** (per TDD principle)
2. **Run tests** - they should FAIL (current implementation doesn't use semantic IDs)
3. **Implement fix** (change import + modify findVariables)
4. **Run tests again** - they should PASS

## Edge Cases & Considerations

### 1. Exact Match vs Partial Match

**Decision:** Exact match only.

**Why:** User expectation for `trace "x from handler"` is "function named exactly 'handler'", not "function containing 'handler' substring".

**Implementation:** Use `scopeChain.includes(scopeName.toLowerCase())` - this is exact element match, not substring.

### 2. Discriminators in Scope Names

**Example:** `try#0`, `if#1`, `catch#0`

**Handling:** Included in scope name as-is. User must type `trace "x from try#0"` to match.

**Alternative:** Could strip discriminators before matching. But this creates ambiguity:
- `if#0` and `if#1` would both match `trace "x from if"`

**Recommendation:** Keep discriminators. If users complain, we can add fuzzy matching later.

### 3. Multiple Scopes with Same Name

**Example:**
- `FileA.js->handler->VARIABLE->x`
- `FileB.js->handler->VARIABLE->x`

**Behavior:** Both returned (limited to 5 results by existing code on line 169).

**Correct?** Yes. User sees multiple matches and can choose. This is already current behavior.

### 4. Empty Scope Path (global variables)

**Example:** `app.js->global->VARIABLE->config`

**scopePath:** `['global']`

**Behavior:** `trace "config from global"` should match.

**Edge case:** What if user omits scopeName? `trace "config"` should return all variables named `config`, including globals.

**Implementation:** Already handled - if `scopeName` is `null`, the scope filter is skipped entirely (line 153).

### 5. Singleton and External Module Nodes

From `SemanticId.ts:106-126`, these have special parsing:

**Singleton:**
- ID: `net:stdio->__stdio__`
- Parsed: `{ file: '', scopePath: ['net:stdio'], type: 'SINGLETON', name: '__stdio__' }`

**External Module:**
- ID: `EXTERNAL_MODULE->lodash`
- Parsed: `{ file: '', scopePath: [], type: 'EXTERNAL_MODULE', name: 'lodash' }`

**Behavior:**
- Singleton: scopePath = `['net:stdio']` - won't match typical function names
- External: scopePath = `[]` - won't match any scope filter

**Correct?** Yes. These are not user variables, shouldn't appear in `trace "x from func"` results.

### 6. Performance

**Current:** O(N) loop over all VARIABLE/CONSTANT/PARAMETER nodes, with O(1) file string check per node.

**After:** O(N) loop with:
- `parseSemanticId()`: O(k) where k = ID length (typically < 200 chars)
- `.map()`: O(m) where m = scopePath length (typically 1-5 elements)
- `.includes()`: O(m)

**Total per node:** O(k + m), still linear. No performance regression expected.

**Optimization opportunity:** If this becomes slow, we could add a scope index to RFDB. But not needed now.

## Testing Integration

### Unit Test Only

This change affects only `findVariables()` function logic. All other functions unchanged:
- `parseTracePattern()` - unchanged
- `traceBackward()` - unchanged
- `traceForward()` - unchanged
- `getValueSources()` - unchanged
- `displayTrace()` - unchanged

**Test scope:** Unit test for `findVariables()` logic only.

**How to test:**
1. Create test backend
2. Add nodes with known semantic IDs
3. Call backend queries directly (simulate what findVariables does)
4. Assert correct filtering

**Alternative approach:** Extract `findVariables` to testable function (might require refactoring). For now, test via backend queries is cleaner.

## Rollout Plan

### Step 1: Write Tests (Kent Beck)

Create `/Users/vadimr/grafema/test/unit/commands/trace.test.js` with all 8 test cases above.

**Verify:** Tests FAIL with current implementation (proves they test the right thing).

### Step 2: Implement Fix (Rob Pike)

1. Add `parseSemanticId` to import (line 12)
2. Replace lines 153-159 with new logic
3. No other changes

**Verify:** Tests PASS.

### Step 3: Manual Testing

Run actual CLI command on real codebase:

```bash
grafema analyze
grafema trace "response from handleDragEnd"
```

**Expected:** Should find variables in `handleDragEnd` function, not in file path.

### Step 4: Review (Kevlin + Linus)

Check:
- Code clarity
- Test quality
- Edge cases covered
- No regressions

## Success Criteria

1. All 8 unit tests pass
2. Manual CLI test works correctly
3. No other tests broken
4. Code is clearer than before (uses semantic IDs properly)

## Files Modified

1. `/Users/vadimr/grafema/packages/cli/src/commands/trace.ts` - 1 line import, 8 lines in findVariables
2. `/Users/vadimr/grafema/test/unit/commands/trace.test.js` - NEW file, ~200 lines

**Total:** 2 files, ~210 lines added/modified.

## Risks & Mitigations

### Risk 1: `parseSemanticId` returns null for valid nodes

**Likelihood:** Low (all nodes should have valid semantic IDs post-REG-131).

**Mitigation:** Test includes case for malformed IDs. If this happens in production, node is skipped (fail-safe behavior).

**Monitoring:** If users report "can't find variable that exists", check if those nodes have invalid IDs.

### Risk 2: Performance regression on large graphs

**Likelihood:** Very low (parsing is cheap, O(k) where k ~ 100 chars).

**Mitigation:** If slow, profile and optimize. Likely culprit would be backend query, not parsing.

### Risk 3: Unexpected scopePath structure for some node types

**Likelihood:** Low (semantic IDs are standardized).

**Mitigation:** Unit tests cover special cases (singletons, external modules). If new node type appears, add test case.

## What NOT to Change

1. **Pattern parsing** - works correctly
2. **Edge traversal** - unaffected
3. **Output formatting** - unaffected
4. **Other commands** - only `trace` command affected
5. **Backend/core** - no changes, using existing API

## Future Improvements (Out of Scope)

1. **Partial matching:** `trace "x from *drag*"` matches `handleDragEnd`
2. **Scope index:** Faster lookup if scope filtering becomes bottleneck
3. **Better error messages:** "Scope 'nonExistent' not found in graph" vs generic "no variables found"
4. **Multiple scope filters:** `trace "x from handleDragEnd or handleDrop"`

These are feature requests, not bugs. Handle separately if users request.

## Alignment with Vision

**From Don's plan:**

> "Use the semantic ID that's already there. The scopeName appears in this chain. We don't need edges or graph traversal - the information is in the ID itself."

This implementation follows the vision exactly:
- No new graph traversal
- No new edges
- Uses existing semantic ID infrastructure
- Deterministic, not heuristic

**From CLAUDE.md:**

> "AI should query the graph, not read code."

Semantic IDs ARE part of the graph. By parsing IDs, we're querying graph structure (scope hierarchy), not reading source files.

## Final Notes

This is a **surgical fix**:
- Small scope (one function)
- Clear behavior change (file path → semantic ID)
- High confidence (semantic IDs are standardized, well-tested)
- Low risk (fail-safe: skip node if ID invalid)

**Estimated effort:** 2-3 hours total (including tests).

**Complexity:** Low (straightforward string parsing and array lookup).

Ready for Kent Beck to write tests.
