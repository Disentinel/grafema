# Rob Pike Implementation Report - REG-314 Phase 5 Parser

## Summary

Implemented `@grafema-ignore cardinality` comment detection in JSASTAnalyzer. When a loop statement has a leading line comment with exactly `// @grafema-ignore cardinality`, the LOOP node will have `ignoreCardinality: true` set.

## Changes Made

### 1. JSASTAnalyzer.ts

Added `hasIgnoreCardinalityComment()` helper method:

```typescript
private hasIgnoreCardinalityComment(node: t.Node): boolean {
  const comments = node.leadingComments;
  if (!comments || comments.length === 0) return false;

  for (const comment of comments) {
    // Only line comments are supported (not block comments)
    if (comment.type !== 'CommentLine') continue;

    // Check for exact @grafema-ignore cardinality directive
    const trimmed = comment.value.trim();
    if (trimmed === '@grafema-ignore cardinality') {
      return true;
    }
  }

  return false;
}
```

Called in `createLoopScopeHandler()` before pushing the LoopInfo:

```typescript
// 3.7. Check for @grafema-ignore cardinality comment (REG-314 Phase 5)
const ignoreCardinality = this.hasIgnoreCardinalityComment(node) ? true : undefined;
```

### 2. Type Updates

**LoopInfo (types.ts):**
```typescript
// Escape hatch (REG-314 Phase 5)
ignoreCardinality?: boolean;    // true when @grafema-ignore cardinality comment present
```

**LoopNodeRecord (nodes.ts):**
```typescript
ignoreCardinality?: boolean;  // REG-314: true when @grafema-ignore cardinality comment present
```

### 3. Integration Tests

Added Group 12 to `loop-nodes.test.ts` with 7 tests:

| Test | Description |
|------|-------------|
| should set ignoreCardinality: true for loop with ignore comment | for-of with comment |
| should NOT set ignoreCardinality for loop without ignore comment | for-of without comment |
| should NOT set ignoreCardinality for block comment | `/* */` not supported |
| should NOT set ignoreCardinality for wrong rule name | `@grafema-ignore other-rule` |
| should set ignoreCardinality for while loop | while with comment |
| should set ignoreCardinality for for loop | classic for with comment |
| should only set ignoreCardinality on the loop with the comment | Mixed loops |

## Design Decisions

1. **Line comments only**: Block comments (`/* */`) are intentionally not supported, matching the `eslint-disable-next-line` pattern. This is explicit in Don's plan.

2. **Exact match**: The comment must be exactly `@grafema-ignore cardinality` after trimming whitespace. No partial matches or variations.

3. **Babel's leadingComments**: Used Babel's built-in comment attachment. Babel attaches leading comments to the next node, so `// @grafema-ignore cardinality` on the line before a loop will be in `node.leadingComments`.

4. **Undefined vs false**: When no comment is present, `ignoreCardinality` is `undefined` (not `false`) to avoid adding unnecessary properties to every LOOP node.

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Added `hasIgnoreCardinalityComment()` and integration |
| `packages/core/src/plugins/analysis/ast/types.ts` | Added `ignoreCardinality` to LoopInfo |
| `packages/types/src/nodes.ts` | Added `ignoreCardinality` to LoopNodeRecord |
| `test/unit/plugins/analysis/ast/loop-nodes.test.ts` | Added Group 12 with 7 integration tests |

## Testing

All tests pass:
- Unit tests: `node --test test/unit/cardinality/*.test.js` - 9/9 pass
- Integration tests: `node --import tsx --test --test-name-pattern="grafema-ignore" test/unit/plugins/analysis/ast/loop-nodes.test.ts` - 7/7 pass

## Commit

```
feat(core): Parse @grafema-ignore cardinality comments in JSASTAnalyzer

Detects // @grafema-ignore cardinality comment before loops and sets
ignoreCardinality flag on LOOP nodes.

REG-314
```

## Data Flow

The complete escape hatch now works end-to-end:

```
1. User writes: // @grafema-ignore cardinality
2. JSASTAnalyzer detects comment via hasIgnoreCardinalityComment()
3. LoopInfo gets ignoreCardinality: true
4. GraphBuilder passes flag to LOOP node
5. CardinalityEnricher skips loops with ignoreCardinality: true
```

All components are now connected and working.
