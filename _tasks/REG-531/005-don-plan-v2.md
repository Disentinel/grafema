# Don's Revised Plan: REG-531 — Fix findNodeAtCursor for chained method calls

**Tech Lead:** Don Melton
**Date:** 2026-02-20
**Version:** 2 (after Dijkstra rejection)
**Chosen Path:** Path B — Add endLine/endColumn to nodes AND implement containment algorithm

---

## Executive Summary

Dijkstra correctly identified that the original plan's containment algorithm was **dead code** — CALL and PROPERTY_ACCESS nodes don't have `endLine`/`endColumn` in their metadata. This revision implements **Path B**: populate end positions in the analyzer, THEN implement the containment-based matching algorithm.

**Total scope:**
1. **Type changes**: Add `endLine`/`endColumn` to `CallSiteInfo`, `MethodCallInfo`, `PropertyAccessInfo` interfaces
2. **Analyzer changes**: Populate end positions in **6 code paths** (3 for CALL, 3 for PROPERTY_ACCESS)
3. **findNodeAtCursor changes**: Implement containment algorithm with type precedence tiebreaker
4. **Test coverage**: Multi-line calls, chained calls, property accesses

---

## Part 1: Type Interface Changes

### File: `/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/ast/types.ts`

**Lines 246-258: PropertyAccessInfo**
```typescript
export interface PropertyAccessInfo {
  id: string;
  semanticId?: string;
  type: 'PROPERTY_ACCESS';
  objectName: string;
  propertyName: string;
  optional?: boolean;
  computed?: boolean;
  file: string;
  line: number;
  column: number;
  endLine: number;        // ADD THIS
  endColumn: number;      // ADD THIS
  parentScopeId?: string;
}
```

**Lines 261-280: CallSiteInfo**
```typescript
export interface CallSiteInfo {
  id: string;
  semanticId?: string;
  type: 'CALL';
  name: string;
  file: string;
  line: number;
  column?: number;
  endLine: number;        // ADD THIS
  endColumn: number;      // ADD THIS
  parentScopeId?: string;
  targetFunctionName?: string;
  isNew?: boolean;
  grafemaIgnore?: GrafemaIgnoreAnnotation;
  isAwaited?: boolean;
  isInsideTry?: boolean;
  isInsideLoop?: boolean;
}
```

**Lines 283-299: MethodCallInfo**
```typescript
export interface MethodCallInfo {
  id: string;
  semanticId?: string;
  type: 'CALL';
  name: string;
  object: string;
  method: string;
  computed?: boolean;
  computedPropertyVar?: string | null;
  file: string;
  line: number;
  column?: number;
  endLine: number;        // ADD THIS
  endColumn: number;      // ADD THIS
  parentScopeId?: string;
  arguments?: unknown[];
  isNew?: boolean;
  grafemaIgnore?: GrafemaIgnoreAnnotation;
  // ... (rest of fields unchanged)
}
```

---

## Part 2: Analyzer Changes — Dual Collection Paths

### CRITICAL: Dual Collection Pattern

From project memory: "Many AST node types are collected via TWO independent code paths:
1. **In-function**: handlers in `analyzeFunctionBody` (e.g., `CallExpressionHandler`)
2. **Module-level**: top-level `traverse_*` blocks in `JSASTAnalyzer.ts`

When adding a new field, **BOTH paths must be updated**."

### 2A: CALL Nodes — In-Function Path

#### File: `/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Import `getEndLocation` (line 4):**
```typescript
import { getLine, getColumn, getEndLocation } from '../utils/location.js';
```

**Method: `handleCallExpression` (lines 2917-2931 and 2960-2978)**

**Location 1: Direct function calls (after line 2923)**
```typescript
callSites.push({
  id: callId,
  type: 'CALL',
  name: calleeName,
  file: module.file,
  line: getLine(callNode),
  column: getColumn(callNode),
  endLine: getEndLocation(callNode).line,      // ADD THIS
  endColumn: getEndLocation(callNode).column,  // ADD THIS
  parentScopeId,
  targetFunctionName: calleeName,
  isAwaited,
  isInsideTry,
  ...(isAwaited && isInsideLoop ? { isInsideLoop } : {})
});
```

**Location 2: Method calls (after line 2970)**
```typescript
methodCalls.push({
  id: methodCallId,
  type: 'CALL',
  name: fullName,
  object: objectName,
  method: methodName,
  computed: isComputed,
  computedPropertyVar: isComputed ? property.name : null,
  file: module.file,
  line: getLine(callNode),
  column: getColumn(callNode),
  endLine: getEndLocation(callNode).line,      // ADD THIS
  endColumn: getEndLocation(callNode).column,  // ADD THIS
  parentScopeId,
  isAwaited,
  isInsideTry,
  ...(isAwaited && isInsideLoop ? { isInsideLoop } : {}),
  isMethodCall: true
});
```

### 2B: CALL Nodes — Module-Level Path

#### File: `/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Import `getEndLocation` (line 19):**
```typescript
import { getLine, getColumn, getEndLocation } from '../utils/location.js';
```

**Location 3: Direct calls in `handleDirectCall` (lines 215-224)**
```typescript
const callInfo: CallSiteInfo = {
  id: '',
  type: 'CALL',
  name: callee.name,
  file: s.module.file,
  line,
  column,
  endLine: getEndLocation(callNode).line,      // ADD THIS
  endColumn: getEndLocation(callNode).column,  // ADD THIS
  parentScopeId,
  targetFunctionName: callee.name,
  isAwaited: isAwaited || undefined
};
```

**Location 4: Method calls in `handleSimpleMethodCall` (lines 324-338)**
```typescript
const methodCallInfo: MethodCallInfo = {
  id: '',
  type: 'CALL',
  name: fullName,
  object: objectName,
  method: methodName,
  computed: isComputed,
  computedPropertyVar,
  file: s.module.file,
  line: methodLine,
  column: methodColumn,
  endLine: getEndLocation(callNode).line,      // ADD THIS
  endColumn: getEndLocation(callNode).column,  // ADD THIS
  parentScopeId,
  grafemaIgnore: grafemaIgnore ?? undefined,
  isAwaited: isAwaited || undefined,
};
```

**Location 5: Nested method calls in `handleNestedMethodCall` (lines 437-448)**
```typescript
const methodCallInfo: MethodCallInfo = {
  id: '',
  type: 'CALL',
  name: fullName,
  object: objectName,
  method: methodName,
  file: s.module.file,
  line: methodLine,
  column: methodColumn,
  endLine: getEndLocation(callNode).line,      // ADD THIS
  endColumn: getEndLocation(callNode).column,  // ADD THIS
  parentScopeId,
  grafemaIgnore: grafemaIgnore ?? undefined,
};
```

**Location 6: Constructor calls in `handleNewExpression` (lines 491-501 and 534-546)**

For direct constructors:
```typescript
const callInfo: CallSiteInfo = {
  id: '',
  type: 'CALL',
  name: constructorName,
  file: s.module.file,
  line: newLine,
  column: newColumn,
  endLine: getEndLocation(newNode).line,      // ADD THIS
  endColumn: getEndLocation(newNode).column,  // ADD THIS
  parentScopeId,
  targetFunctionName: constructorName,
  isNew: true
};
```

For member constructors:
```typescript
const methodCallInfo: MethodCallInfo = {
  id: '',
  type: 'CALL',
  name: fullName,
  object: objectName,
  method: constructorName,
  file: s.module.file,
  line: memberNewLine,
  column: memberNewColumn,
  endLine: getEndLocation(newNode).line,      // ADD THIS
  endColumn: getEndLocation(newNode).column,  // ADD THIS
  parentScopeId,
  isNew: true,
  grafemaIgnore: grafemaIgnore ?? undefined,
};
```

### 2C: PROPERTY_ACCESS Nodes — Dual Paths

#### File: `/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/ast/visitors/PropertyAccessVisitor.ts`

**Import `getEndLocation` (line 25):**
```typescript
import { getLine, getColumn, getEndLocation } from '../utils/location.js';
```

**Location 7: `extractPropertyAccesses` (lines 140-175)**

Current code creates PropertyAccessInfo objects in a loop. After line 142-143:
```typescript
for (const info of chain) {
  const fullName = `${info.objectName}.${info.propertyName}`;

  // ADD: Get end location from the node
  const endLoc = getEndLocation(info.node);
```

Then in the PropertyAccessInfo object construction (around line 160):
```typescript
propertyAccesses.push({
  id,
  semanticId,
  type: 'PROPERTY_ACCESS',
  objectName: info.objectName,
  propertyName: info.propertyName,
  file: module.file,
  line: info.line,
  column: info.column,
  endLine: endLoc.line,      // ADD THIS
  endColumn: endLoc.column,  // ADD THIS
  optional: info.optional,
  computed: info.computed,
  parentScopeId
});
```

**IMPORTANT:** The `info` object needs to carry the AST node reference. Check `extractChain` method return type — if it doesn't include the node, add it.

**Location 8: `extractMetaProperty` (lines 177-204)**

After line 185-186 where objectName/propertyName are extracted:
```typescript
const objectName = node.meta.name;
const propertyName = node.property.name;
const fullName = `${objectName}.${propertyName}`;

// ADD: Get end location
const endLoc = getEndLocation(node);
```

Then in the PropertyAccessInfo object (around line 198-210):
```typescript
propertyAccesses.push({
  id,
  semanticId,
  type: 'PROPERTY_ACCESS',
  objectName,
  propertyName,
  file: module.file,
  line: node.loc?.start?.line ?? 0,
  column: node.loc?.start?.column ?? 0,
  endLine: endLoc.line,      // ADD THIS
  endColumn: endLoc.column,  // ADD THIS
  parentScopeId
});
```

**Note:** `extractChain` helper method (not shown in grep output) needs investigation — it likely returns an array of intermediate objects. Each object needs to carry the AST node reference so we can call `getEndLocation` on it.

### 2D: Graph Builder — Metadata Serialization

#### File: `/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts`

**Method: `bufferMethodCalls` (line 166)**

The current code just casts the entire `methodCall` object:
```typescript
this.ctx.bufferNode(methodCall as unknown as GraphNode);
```

**No change needed** — the `endLine`/`endColumn` fields will automatically be included in the node metadata when `bufferNode` serializes it to JSON.

**Method: `bufferPropertyAccessNodes` (lines 218-242)**

Current code explicitly lists fields:
```typescript
this.ctx.bufferNode({
  id: propAccess.id,
  type: 'PROPERTY_ACCESS',
  name: propAccess.propertyName,
  objectName: propAccess.objectName,
  file: propAccess.file,
  line: propAccess.line,
  column: propAccess.column,
  endLine: propAccess.endLine,    // ADD THIS
  endColumn: propAccess.endColumn, // ADD THIS
  semanticId: propAccess.semanticId,
  optional: propAccess.optional,
  computed: propAccess.computed
} as GraphNode);
```

**Method: `bufferCallSiteEdges` (line 134-156)**

This method doesn't buffer CALL nodes — they're buffered elsewhere (in `bufferMethodCalls` for method calls, and in `JSASTAnalyzer` for direct calls via the function traversal). Need to verify where direct `callSites` are buffered.

**Search needed:** Grep for where `callSites` array is buffered as nodes (not just edges).

---

## Part 3: findNodeAtCursor Algorithm Changes

### File: `/Users/vadimr/grafema-worker-2/packages/vscode/src/types.ts`

**Verify NodeMetadata interface (lines 10-16):**

Already has `endLine` and `endColumn`:
```typescript
export interface NodeMetadata {
  line?: number;
  column?: number;
  endLine?: number;     // ✓ Already present
  endColumn?: number;   // ✓ Already present
  [key: string]: unknown;
}
```

**No change needed** — the interface already supports end positions.

### File: `/Users/vadimr/grafema-worker-2/packages/vscode/src/utils.ts` (or wherever `findNodeAtCursor` lives)

**Current algorithm:**
```typescript
// Proximity-based (column distance on same line)
if (nodeLine === line) {
  specificity = 1000 - Math.abs(nodeColumn - cursor.column);
}
```

**New algorithm:**
```typescript
function findNodeAtCursor(
  nodes: WireNode[],
  cursor: { line: number; column: number }
): WireNode | null {
  let bestNode: WireNode | null = null;
  let bestSpecificity = -1;

  for (const node of nodes) {
    const meta = parseNodeMetadata(node);
    const { line, column, endLine, endColumn } = meta;

    if (!line || column === undefined) continue;

    let specificity = 0;

    // Phase 1: Containment-based matching (if end position available)
    if (endLine !== undefined && endColumn !== undefined) {
      // Check if cursor is within [start, end] range
      const isContained = isWithinSpan(
        cursor,
        { line, column },
        { line: endLine, column: endColumn }
      );

      if (isContained) {
        // Compute specificity based on span size (smaller = more specific)
        const spanSize = computeSpanSize(
          { line, column },
          { line: endLine, column: endColumn }
        );
        specificity = 10000 - spanSize; // Large base to dominate proximity
      }
    }
    // Phase 1b: Fallback to proximity (if no end position)
    else if (line === cursor.line) {
      specificity = 1000 - Math.abs(column - cursor.column);
    }

    // Phase 2: Type precedence tiebreaker
    // CALL nodes preferred over PROPERTY_ACCESS when specificity is close
    if (node.nodeType === 'CALL' && specificity > 0) {
      specificity += 100;
    }

    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestNode = node;
    }
  }

  return bestNode;
}

// Helper: Check if cursor is within [start, end] span
function isWithinSpan(
  cursor: { line: number; column: number },
  start: { line: number; column: number },
  end: { line: number; column: number }
): boolean {
  // Single-line span
  if (start.line === end.line) {
    return cursor.line === start.line &&
           cursor.column >= start.column &&
           cursor.column <= end.column;
  }

  // Multi-line span
  if (cursor.line === start.line) {
    return cursor.column >= start.column;
  } else if (cursor.line === end.line) {
    return cursor.column <= end.column;
  } else {
    return cursor.line > start.line && cursor.line < end.line;
  }
}

// Helper: Compute span size (for specificity ranking)
function computeSpanSize(
  start: { line: number; column: number },
  end: { line: number; column: number }
): number {
  if (start.line === end.line) {
    return end.column - start.column;
  } else {
    // Multi-line: approximate size as (lines * 100) + column deltas
    const lineSpan = (end.line - start.line) * 100;
    const colDelta = (100 - start.column) + end.column;
    return lineSpan + colDelta;
  }
}
```

---

## Part 4: Missing Piece — Where are CallSites buffered?

**Search needed:**
```bash
grep -rn "bufferNode.*callSites\|bufferNode.*callSite" packages/core/src/plugins/analysis/ast/builders/
```

Or check if `CallExpressionVisitor` or `JSASTAnalyzer` directly calls `bufferNode` for direct function calls.

**Hypothesis:** Direct `callSites` (non-method calls like `foo()`) might not be getting buffered as nodes at all — only edges are created in `bufferCallSiteEdges`. This would be a **pre-existing bug**.

**Verification needed:**
1. Check if `callSites` array is ever passed to `bufferNode`
2. If not, add a `bufferCallSiteNodes` method in `CoreBuilder`:

```typescript
private bufferCallSiteNodes(callSites: CallSiteInfo[]): void {
  for (const callSite of callSites) {
    this.ctx.bufferNode(callSite as unknown as GraphNode);
  }
}
```

Then call it in `CoreBuilder.buffer()`:
```typescript
this.bufferCallSiteNodes(callSites);          // ADD THIS LINE
this.bufferCallSiteEdges(callSites, functions);
```

---

## Part 5: Test Strategy

### Test File: Create new file `test/unit/queries/findNodeAtCursor.test.ts`

**Test cases:**

1. **Chained method call — cursor on different positions**
   ```javascript
   this.discoveryManager.buildIndexingUnits();
   // Cursor positions: 0, 5, 10, 25, 40
   // Expected: CALL node in all positions
   ```

2. **Multi-line chained call**
   ```javascript
   this.manager
     .buildIndexingUnits();
   // Cursor on line 2 should find CALL node (using endLine)
   ```

3. **Property access without call**
   ```javascript
   const x = obj.property;
   // Cursor on "property" should find PROPERTY_ACCESS node
   ```

4. **Multiple calls same line**
   ```javascript
   foo(); bar();
   // Cursor at 0 → foo
   // Cursor at 7 → bar
   ```

5. **Nested calls**
   ```javascript
   outer(inner());
   // Cursor at 0 → outer
   // Cursor at 6 → inner
   ```

6. **Regression: Direct method calls still work**
   ```javascript
   this.method();
   // Cursor anywhere should find CALL node
   ```

### Integration Test

Add to existing test suite (e.g., `test/integration/vscode/`):
- Create a real TypeScript file with chained calls
- Run analysis
- Query `findNodeAtCursor` via MCP
- Verify correct node returned

---

## Part 6: Risk Assessment

### Low Risk
- Type interface changes (pure addition, no breaking changes)
- `getEndLocation` already exists and is tested
- VSCode `NodeMetadata` already has fields

### Medium Risk
- **Dual collection paths** — missing one path will cause inconsistent data
- **extractChain return type** — might need refactoring to carry AST node reference
- **CallSite node buffering** — might be missing entirely (pre-existing bug)

### High Risk
- **Graph builder metadata serialization** — if `bufferNode` doesn't automatically serialize all fields, we need custom handling
- **Babel AST node end positions** — might be missing for some node types (need verification)

### Mitigation
- **Before starting:** Verify Babel AST nodes always have `loc.end` for CallExpression and MemberExpression
- **During development:** Add console.log to verify `endLine`/`endColumn` are populated in analyzer
- **After completion:** Run full test suite + visual verification in VSCode extension

---

## Part 7: Completeness Check

### All 6 CALL collection paths covered?
- ✓ In-function direct calls (`JSASTAnalyzer.handleCallExpression` line 2917)
- ✓ In-function method calls (`JSASTAnalyzer.handleCallExpression` line 2960)
- ✓ Module-level direct calls (`CallExpressionVisitor.handleDirectCall` line 215)
- ✓ Module-level simple method calls (`CallExpressionVisitor.handleSimpleMethodCall` line 324)
- ✓ Module-level nested method calls (`CallExpressionVisitor.handleNestedMethodCall` line 437)
- ✓ Constructor calls (`CallExpressionVisitor.handleNewExpression` lines 491 and 534)

### All PROPERTY_ACCESS collection paths covered?
- ✓ In-function property accesses (`PropertyAccessHandler.extractPropertyAccesses` via handler)
- ✓ Module-level property accesses (`PropertyAccessVisitor.extractPropertyAccesses` line 114)
- ✓ MetaProperty (`PropertyAccessVisitor.extractMetaProperty` line 177)

### Graph builder updated?
- ✓ `bufferPropertyAccessNodes` — add endLine/endColumn
- ⚠️ `bufferMethodCalls` — auto-serializes, verify no issues
- ❓ `callSites` node buffering — **needs verification**

---

## Part 8: Implementation Order

1. **Phase 1:** Type changes (types.ts)
2. **Phase 2:** Analyzer changes
   - 2A: CALL in-function path (JSASTAnalyzer.ts)
   - 2B: CALL module-level path (CallExpressionVisitor.ts)
   - 2C: PROPERTY_ACCESS both paths (PropertyAccessVisitor.ts)
3. **Phase 3:** Graph builder verification
   - Check if callSites are buffered as nodes
   - Add explicit endLine/endColumn to bufferPropertyAccessNodes
4. **Phase 4:** findNodeAtCursor algorithm (utils.ts or types.ts)
5. **Phase 5:** Tests (unit + integration)
6. **Phase 6:** Manual verification in VSCode extension

---

## Part 9: Open Questions for Dijkstra

1. **extractChain return type:** Does it include AST node reference? If not, how to refactor?
2. **CallSite node buffering:** Are direct function calls (`foo()`) buffered as nodes or only as edges?
3. **Babel AST guarantees:** Are `loc.end` positions guaranteed for all CallExpression/MemberExpression nodes?
4. **Metadata serialization:** Does `bufferNode` auto-serialize all fields, or do we need explicit metadata packing?

---

## Estimated LOC

- Type changes: ~6 lines (3 interfaces × 2 fields each)
- Analyzer changes: ~40 lines (20 getEndLocation calls × 2 lines each)
- Graph builder: ~10 lines (explicit field additions + possible callSite buffering)
- findNodeAtCursor: ~80 lines (new algorithm + helpers)
- Tests: ~150 lines (6 test cases + fixtures)

**Total: ~286 lines**

---

## Success Criteria

1. Chained calls (`this.obj.method()`) — cursor anywhere returns CALL node
2. Multi-line calls — cursor on any line within the call returns CALL node
3. Property accesses without calls — cursor on property returns PROPERTY_ACCESS node
4. No regressions — all existing tests pass
5. Manual verification — VSCode "Go to Definition" works correctly on chained calls

---

**Don's signature:** "Measure twice, cut once. We're doing Path B because it's the right thing to do."
