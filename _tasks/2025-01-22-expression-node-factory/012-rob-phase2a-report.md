# Phase 2a: JSASTAnalyzer EXPRESSION ID Generation Migration - Implementation Report

**Date:** 2025-01-22
**Author:** Rob Pike (Implementation Engineer)
**Task:** Migrate JSASTAnalyzer EXPRESSION ID generation to use ExpressionNode factory

---

## Summary

Successfully migrated all 5 EXPRESSION ID generation sites in JSASTAnalyzer from legacy hash-based format (`EXPRESSION#...`) to the new colon-based format (`{file}:EXPRESSION:{type}:{line}:{column}`).

---

## Changes Made

### 1. ExpressionNode.ts

Added two new static methods:

**`generateId(expressionType, file, line, column)`**
- Generates EXPRESSION node ID without creating the full node
- Used by JSASTAnalyzer when creating assignment metadata
- Returns format: `{file}:EXPRESSION:{expressionType}:{line}:{column}`

**`createFromMetadata(expressionType, file, line, column, options)`**
- Creates EXPRESSION node from assignment metadata with a pre-generated ID
- Used by GraphBuilder when processing variableAssignments
- Validates that the ID uses colon format (throws on legacy format)

**Location:** `/Users/vadimr/grafema/packages/core/src/core/nodes/ExpressionNode.ts` (lines 113-191)

### 2. NodeFactory.ts

Added wrapper methods:

**`generateExpressionId(expressionType, file, line, column)`**
- Delegates to `ExpressionNode.generateId()`

**`createExpressionFromMetadata(expressionType, file, line, column, options)`**
- Delegates to `ExpressionNode.createFromMetadata()`

**Location:** `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts` (lines 489-530)

### 3. JSASTAnalyzer.ts

**Import added:**
```typescript
import { ExpressionNode } from '../../core/nodes/ExpressionNode.js';
```

**Migrated 5 ID generation sites:**

| Expression Type | Old Format | New Format |
|-----------------|------------|------------|
| MemberExpression | `EXPRESSION#obj.prop#file#line:col` | `ExpressionNode.generateId('MemberExpression', file, line, col)` |
| BinaryExpression | `EXPRESSION#binary#file#line:col` | `ExpressionNode.generateId('BinaryExpression', file, line, col)` |
| ConditionalExpression | `EXPRESSION#conditional#file#line:col` | `ExpressionNode.generateId('ConditionalExpression', file, line, col)` |
| LogicalExpression | `EXPRESSION#logical#file#line:col` | `ExpressionNode.generateId('LogicalExpression', file, line, col)` |
| TemplateLiteral | `EXPRESSION#template#file#line:col` | `ExpressionNode.generateId('TemplateLiteral', file, line, col)` |

**Column field added** to all assignment metadata pushes for EXPRESSION nodes.

**Location:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (lines 605-707)

### 4. types.ts

Added `column?: number` field to `VariableAssignmentInfo` interface.

**Location:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts` (line 405)

---

## Verification

### Build
```
npm run build - PASSED
```

### Tests

**Expression.test.js Results:**
- 17 PASSED
- 2 FAILED (pre-existing edge count issues, unrelated to ID format migration)

**All EXPRESSION node creation tests pass:**
- MemberExpression without call - PASS
- ASSIGNED_FROM edge from VARIABLE to EXPRESSION - PASS
- DERIVES_FROM edge from EXPRESSION to object variable - PASS
- Computed property access - PASS
- BinaryExpression node creation - PASS
- BinaryExpression DERIVES_FROM edges - PASS
- ConditionalExpression node creation - PASS
- ConditionalExpression DERIVES_FROM edges - PASS
- LogicalExpression node creation - PASS
- Datalog EXPRESSION queries - PASS
- Alias tracking via EXPRESSION - PASS
- TemplateLiteral node creation - PASS
- TemplateLiteral DERIVES_FROM edges - PASS

**NoLegacyExpressionIds.test.js:**
- Confirms no legacy `EXPRESSION#` patterns remain in JSASTAnalyzer
- Some tests fail for VariableVisitor.ts and CallExpressionVisitor.ts (Phase 2b/3 scope)

---

## ID Format Comparison

**Before (legacy):**
```
EXPRESSION#obj.method#/src/app.ts#25:10
EXPRESSION#binary#/src/app.ts#30:5
EXPRESSION#conditional#/src/app.ts#35:8
```

**After (colon-based):**
```
/src/app.ts:EXPRESSION:MemberExpression:25:10
/src/app.ts:EXPRESSION:BinaryExpression:30:5
/src/app.ts:EXPRESSION:ConditionalExpression:35:8
```

---

## Remaining Work

### Phase 2b: VariableVisitor Migration
- File: `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`
- Still has 1 legacy EXPRESSION# ID generation site

### Phase 3: CallExpressionVisitor Migration
- File: `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`
- Still has 1 legacy EXPRESSION# ID generation site

### Phase 4: GraphBuilder Migration
- Use `createFromMetadata()` for EXPRESSION node creation
- Must be done AFTER Phases 2b and 3 to ensure consistent ID format

---

## Files Modified

1. `/Users/vadimr/grafema/packages/core/src/core/nodes/ExpressionNode.ts`
2. `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts`
3. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
4. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts`

---

## Notes

1. The 2 failing tests in Expression.test.js (`should create ASSIGNED_FROM edges for both branches`) are pre-existing behavior issues related to edge count expectations, not the ID format migration.

2. The `createFromMetadata()` method includes validation that throws an error if a legacy format ID is passed, which will help catch any regression during Phase 4 GraphBuilder migration.

3. Column values use `initExpression.start ?? 0` to handle potential null/undefined values safely.
