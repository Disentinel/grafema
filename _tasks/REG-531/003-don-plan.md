# REG-531: Fix Plan — findNodeAtCursor Algorithm

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-20

## Problem Analysis

`findNodeAtCursor` uses column-distance specificity (`1000 - |nodeColumn - cursorColumn|`). For chained calls:
- CALL node: column at start of entire expression (e.g., column 5 for `this.discoveryManager...`)
- PROPERTY_ACCESS "discoveryManager": column at its identifier (e.g., column 10)
- Cursor on "buildIndexingUnits" (column 40) → PROPERTY_ACCESS wins (closer start position)

**Root cause:** The algorithm compares start positions only, not full node spans. CALL nodes span the entire expression but the algorithm doesn't know that.

## Data Available

From exploration:
1. **Metadata fields exist** (`packages/vscode/src/types.ts` lines 10-15):
   - `line`, `column` (start position)
   - `endLine`, `endColumn` (end position) — OPTIONAL

2. **AST has end location** (`packages/core/src/plugins/analysis/ast/utils/location.ts` lines 98-103):
   - `getEndLocation(node)` extracts `loc.end.line` and `loc.end.column`
   - Currently UNUSED in CallExpressionVisitor

3. **CALL nodes don't populate endLine/endColumn**:
   - `CallExpressionVisitor.ts` line 319-320: only calls `getLine(callNode)` and `getColumn(callNode)` (start only)
   - Node metadata has `line`/`column` but NOT `endLine`/`endColumn`

## Standard Approach Research

From [LSP implementations](https://github.com/tree-sitter/tree-sitter/discussions/3346) and [Nushell completer](https://medium.com/ballerina-techblog/language-server-for-ballerina-auto-completion-engine-in-depth-ee20e543ac26):

**Best practice**: "Find innermost node at cursor position"
1. Start at root, descend to node of greatest depth that **contains** cursor position
2. Check if cursor is **within** `[start, end]` range (not just close to start)
3. Prefer smaller spans when multiple nodes overlap

**Key insight**: Containment > proximity. A node "contains" the cursor if:
```
cursor.line >= node.line && cursor.line <= node.endLine
&& (cursor.line != node.line || cursor.column >= node.column)
&& (cursor.line != node.endLine || cursor.column <= node.endColumn)
```

## Solution: Hybrid Containment + Type Precedence

### Algorithm Changes (in `findNodeAtCursor` only)

**Phase 1: Containment-based matching**
```typescript
// For nodes WITH endLine/endColumn:
if (endLine !== undefined && endColumn !== undefined) {
  const cursorInRange =
    (line < cursor.line && cursor.line < endLine) ||  // cursor on middle line
    (line === cursor.line && endLine === cursor.line && column <= cursor.column && cursor.column <= endColumn) ||  // single-line span
    (line === cursor.line && cursor.line < endLine && column <= cursor.column) ||  // cursor on start line of multi-line
    (line < cursor.line && cursor.line === endLine && cursor.column <= endColumn);  // cursor on end line of multi-line

  if (cursorInRange) {
    // Specificity = smaller span (more specific)
    const span = (endLine - line) * 10000 + (endColumn - column);
    specificity = 1000000 - span;  // Higher for smaller spans
  }
}

// For nodes WITHOUT endLine/endColumn (legacy):
else if (line === cursor.line) {
  // Fallback to proximity-based (current behavior)
  specificity = 1000 - Math.abs(column - cursor.column);
}
```

**Phase 2: Type precedence tiebreaker**

When CALL and PROPERTY_ACCESS have same line + overlapping ranges:
```typescript
// After computing specificity, add type bonus
if (nodeType === 'CALL' && specificity > 0) {
  specificity += 100;  // CALL nodes preferred over PROPERTY_ACCESS on ties
}
```

**Rationale:**
- CALL nodes represent the user's intent (invoking a function)
- PROPERTY_ACCESS are intermediate steps in the chain
- When cursor is anywhere in `this.obj.method()`, user likely wants CALL node

### Edge Cases Handled

| Scenario | Behavior |
|----------|----------|
| Single-line call: `this.method()` | CALL wins (contains cursor, type bonus) |
| Chained call: `this.obj.method()` | CALL wins (spans entire expression) |
| Cursor on intermediate property: `this.OBJ.method()` | CALL still wins (user rarely wants PROPERTY_ACCESS) |
| Multiple calls same line: `foo(); bar();` | Smaller span wins |
| Multi-line call | Containment check handles all lines in span |
| No endColumn data | Falls back to proximity (current behavior) |

### Why Not Fix in Analyzer?

Constraint: "Fix in `findNodeAtCursor` only, don't change how nodes are created."

**If we fixed it properly** (populate endLine/endColumn in analyzer):
1. Add `getEndLocation` calls in `CallExpressionVisitor.ts` line 320-321
2. Store in methodCallInfo: `endLine`, `endColumn`
3. Include in metadata when node is created

**But:** This is out of scope for this fix. The containment algorithm works with OR without endColumn (has fallback).

## Test Strategy

**Test file location:** `packages/vscode/test/nodeLocator.test.ts` (create new)

**Test scenarios:**

### Basic Chained Calls
```javascript
// File: test-chained-calls.js
this.discoveryManager.buildIndexingUnits();
//   ^cursor           ^cursor
// Should resolve to CALL "this.discoveryManager.buildIndexingUnits"
```

### Direct Method Calls (regression)
```javascript
this.method();
//   ^cursor
// Should resolve to CALL "this.method" (not broken by change)
```

### Multiple Calls Same Line
```javascript
foo(); bar();
//^    ^
// Each cursor resolves to its respective CALL
```

### Multi-line Calls
```javascript
this.manager
  .buildIndexingUnits();
//  ^cursor
// Should resolve to CALL node spanning both lines
```

### Property Access Without Call
```javascript
const x = obj.property;
//            ^cursor
// Should resolve to PROPERTY_ACCESS (no CALL node exists)
```

**Test implementation approach:**
1. Create minimal graph with synthetic nodes (mock RFDB client)
2. Nodes have `line`, `column`, `endLine`, `endColumn` in metadata
3. Call `findNodeAtCursor(client, file, line, column)`
4. Assert returned node has expected `id` and `type`

## Implementation Steps (for Dijkstra)

1. **Read existing test pattern** (if any) from `packages/vscode/test/`
2. **Write tests first** covering all scenarios above
3. **Implement containment algorithm** in `findNodeAtCursor`
   - Add endLine/endColumn extraction from metadata
   - Replace proximity-only logic with containment check
   - Add type precedence bonus for CALL nodes
   - Preserve fallback for nodes without endColumn
4. **Run tests** — all must pass
5. **Manual verification** in real extension:
   - Hover over `this.discoveryManager.buildIndexingUnits()` in Orchestrator.ts
   - Should show CALL node, not PROPERTY_ACCESS

## Metrics

- **Files changed:** 1 (`packages/vscode/src/nodeLocator.ts`)
- **Tests added:** 1 file, ~8 test cases
- **Lines added:** ~40 (algorithm + tests)
- **Backwards compat:** YES (fallback preserves old behavior for nodes without endColumn)

## Sources

Standard approaches for cursor-based AST node selection:
- [Tree-sitter LSP discussion on cursor position detection](https://github.com/tree-sitter/tree-sitter/discussions/3346)
- [Ballerina Language Server auto-completion using innermost node](https://medium.com/ballerina-techblog/language-server-for-ballerina-auto-completion-engine-in-depth-ee20e543ac26)
- [Nushell completion system using find_pipeline_element_by_position](https://deepwiki.com/nushell/nushell/6.3-prompts-and-shell-integration)
