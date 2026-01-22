# REG-107: Integration Summary - Complete Migration Plan

**Date:** 2025-01-22
**Author:** Joel Spolsky (Implementation Planner)
**Status:** REVISED - incorporates Don's findings

---

## Overview

This document integrates the revised Part 2.3 (GraphBuilder) with the original tech plan.

**Key change:** GraphBuilder is a PRIMARY factory, not reconstruction code. It must be migrated to use ExpressionNode factory methods.

---

## Complete File Change List

### New Files
1. `/Users/vadimr/grafema/packages/core/src/core/nodes/ArgumentExpressionNode.ts` - NEW
2. `/Users/vadimr/grafema/test/unit/NoLegacyExpressionIds.test.js` - NEW

### Modified Files (Implementation Order)

**Phase 1: Infrastructure**
1. `/Users/vadimr/grafema/packages/core/src/core/nodes/index.ts`
   - Export ArgumentExpressionNode

2. `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts`
   - Add `createArgumentExpression()` method

**Phase 2a: JSASTAnalyzer (NEW - CRITICAL)**
3. `/Users/vadimr/grafema/packages/core/src/core/nodes/ExpressionNode.ts`
   - Add `generateId()` static method
   - Add `createFromMetadata()` static method

4. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
   - Import ExpressionNode
   - Replace 5 inline ID generation sites with `generateId()`
   - Add `column` field to assignment metadata

**Phase 2b: VariableVisitor**
5. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`
   - Import NodeFactory
   - Replace inline EXPRESSION creation with factory
   - Remove `LiteralExpressionInfo` interface

**Phase 3: CallExpressionVisitor**
6. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`
   - Import NodeFactory
   - Replace inline EXPRESSION creation with `createArgumentExpression()`

**Phase 4: GraphBuilder**
7. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
   - Import ExpressionNode
   - Replace manual node construction with `createFromMetadata()`
   - Keep edge creation logic unchanged

**Phase 5: Testing**
8. `/Users/vadimr/grafema/test/unit/Expression.test.js`
   - Add ID format validation tests
   - Add edge resolution tests

---

## Revised Implementation Phases

### Phase 1: Infrastructure (No Breaking Changes)

**Goal:** Set up ArgumentExpression subtype

**Tasks:**
1. Create `ArgumentExpressionNode.ts` (see tech plan Part 1.1)
2. Export from `nodes/index.ts` (Part 1.2)
3. Add `createArgumentExpression()` to NodeFactory (Part 1.3)
4. Create `NoLegacyExpressionIds.test.js` (Part 4.1) - will fail initially

**Commit:** `feat(REG-107): add ArgumentExpressionNode for call argument context`

**Time estimate:** 1 hour

---

### Phase 2a: JSASTAnalyzer ID Generation (CRITICAL NEW PHASE)

**Goal:** Migrate ID generation from legacy format to factory format

**Why first:** GraphBuilder depends on JSASTAnalyzer generating correct IDs

**Tasks:**

1. **Update ExpressionNode.ts** (007-joel-part23-update.md, Step 1)

   Add two methods:
   ```typescript
   static generateId(expressionType, file, line, column): string
   static createFromMetadata(expressionType, file, line, column, options): ExpressionNodeRecord
   ```

2. **Update JSASTAnalyzer.ts** (007-joel-part23-update.md, Step 2)

   Replace 5 inline ID generation sites:
   - Line ~607: MemberExpression
   - Line ~635: BinaryExpression
   - Line ~653: ConditionalExpression
   - Line ~673: LogicalExpression
   - Line ~694: TemplateLiteral

   Replace:
   ```typescript
   const expressionId = `EXPRESSION#${path}#${file}#${line}:${col}`;
   ```

   With:
   ```typescript
   const expressionId = ExpressionNode.generateId(
     'MemberExpression',  // or other type
     module.file,
     line,
     initExpression.start
   );
   ```

   Also add `column` field to assignment metadata.

3. **Test ID format**

   Run: `node --test test/unit/Expression.test.js`

   Verify: EXPRESSION nodes now have colon-based IDs

**Commit:** `feat(REG-107): migrate JSASTAnalyzer to ExpressionNode.generateId()`

**Breaking change:** Yes - EXPRESSION IDs change format

**Time estimate:** 1.5 hours

---

### Phase 2b: VariableVisitor (Original Phase 2)

**Goal:** Migrate destructuring EXPRESSION creation to factory

**Tasks:**

1. Add NodeFactory import to VariableVisitor
2. Replace inline object (lines 228-241) with factory call
3. Remove `LiteralExpressionInfo` interface
4. Test destructuring cases

**Commit:** `feat(REG-107): migrate VariableVisitor to ExpressionNode factory`

**Time estimate:** 1 hour

---

### Phase 3: CallExpressionVisitor (Unchanged)

**Goal:** Migrate call argument EXPRESSION creation to ArgumentExpression factory

**Tasks:**

1. Add NodeFactory import to CallExpressionVisitor
2. Replace inline object (lines 276-290) with `createArgumentExpression()`
3. Test call argument cases with binary/logical expressions

**Commit:** `feat(REG-107): migrate CallExpressionVisitor to ArgumentExpressionNode factory`

**Time estimate:** 1 hour

---

### Phase 4: GraphBuilder (REVISED)

**Goal:** Migrate PRIMARY EXPRESSION node creation from manual construction to factory

**Tasks:**

1. **Update GraphBuilder.ts** (007-joel-part23-update.md, Step 3)

   Replace lines 815-857:
   ```typescript
   // OLD: Manual construction
   const expressionNode: GraphNode = {
     id: sourceId,
     type: 'EXPRESSION',
     expressionType,
     file: exprFile,
     line: exprLine
   };

   if (expressionType === 'MemberExpression') {
     expressionNode.object = object;
     // ... manual field population
   }
   ```

   With:
   ```typescript
   // NEW: Factory creation
   const expressionNode = ExpressionNode.createFromMetadata(
     expressionType,
     exprFile,
     exprLine,
     exprColumn || 0,
     {
       id: sourceId,  // Use ID from JSASTAnalyzer
       object,
       property,
       computed,
       computedPropertyVar,
       operator
     }
   );
   ```

2. **Keep edge creation unchanged** (lines 859-930)
   - ASSIGNED_FROM edge creation
   - DERIVES_FROM edge creation
   - No changes to this logic

3. **Test complete flow**

   Run: `node --test test/unit/Expression.test.js`

   Verify:
   - All EXPRESSION nodes created
   - Edges resolve correctly
   - Node structure complete

**Commit:** `feat(REG-107): migrate GraphBuilder to ExpressionNode.createFromMetadata()`

**Time estimate:** 1 hour

---

### Phase 5: Verification and Documentation

**Goal:** Ensure complete migration, no legacy code remains

**Tasks:**

1. Run enforcement test: `node --test test/unit/NoLegacyExpressionIds.test.js`
   - Should PASS (no EXPRESSION# in production code)

2. Run full test suite: `npm test`
   - All tests should pass

3. Verify edge resolution works
   - Test DERIVES_FROM edges
   - Test ASSIGNED_FROM edges
   - Check edge src/dst use new IDs

4. Update CHANGELOG.md with breaking change notice

5. Create migration guide for users

**Commit:** `feat(REG-107): complete EXPRESSION node factory migration`

**Time estimate:** 1.5 hours

---

## Critical Dependencies

### Why Phase 2a Must Come Before Phase 4

```
JSASTAnalyzer.generateId()
    ↓ creates sourceId
    ↓
variableAssignments[]
    ↓ assignment.sourceId
    ↓
GraphBuilder.createFromMetadata()
    ↓ uses assignment.sourceId
    ↓
EXPRESSION node created
```

**If Phase 2a is skipped:**
- JSASTAnalyzer generates `EXPRESSION#...` IDs
- GraphBuilder's `createFromMetadata()` validation fails
- Throws: "Invalid ID format"

**Solution:** Always migrate Phase 2a before Phase 4

### Why Visitors Can Be Migrated Independently

VariableVisitor and CallExpressionVisitor:
- Create nodes and push to `literals[]`
- GraphBuilder processes `literals[]` separately
- No dependency on JSASTAnalyzer flow
- Can be done in any order relative to Phase 2a/4

---

## Testing Matrix

| Phase | Test | Expected Result |
|-------|------|-----------------|
| Phase 1 | NoLegacyExpressionIds.test.js | FAIL (EXPRESSION# still exists) |
| Phase 1 | Expression.test.js | PASS (no changes yet) |
| Phase 2a | NoLegacyExpressionIds.test.js | FAIL (visitors still have EXPRESSION#) |
| Phase 2a | Expression.test.js | PASS (IDs changed, behavior same) |
| Phase 2b | NoLegacyExpressionIds.test.js | FAIL (CallExpressionVisitor remaining) |
| Phase 2b | Expression.test.js | PASS |
| Phase 3 | NoLegacyExpressionIds.test.js | FAIL (GraphBuilder might have comments) |
| Phase 3 | Expression.test.js | PASS |
| Phase 4 | NoLegacyExpressionIds.test.js | PASS (all migration complete) |
| Phase 4 | Expression.test.js | PASS |
| Phase 5 | npm test | PASS (all tests) |

---

## Risk Mitigation

### Risk: ID Mismatch

**Scenario:** JSASTAnalyzer generates one format, GraphBuilder expects another

**Mitigation:**
1. Phase 2a migrates BOTH simultaneously
2. `createFromMetadata()` validates ID format
3. Test immediately after Phase 2a

### Risk: Edge Resolution Breaks

**Scenario:** Edges reference old IDs, nodes have new IDs

**Mitigation:**
1. Keep edge creation logic unchanged
2. Use `assignment.sourceId` (already migrated)
3. Test edge queries after each phase

### Risk: Missing Column Data

**Scenario:** `assignment.column` is undefined

**Mitigation:**
1. Add fallback: `exprColumn || 0`
2. JSASTAnalyzer provides `initExpression.start`
3. Validate column exists in tests

---

## Success Criteria

### Code Quality
- [ ] No `EXPRESSION#` strings in production code
- [ ] All EXPRESSION nodes created via factory
- [ ] Consistent ID format: `{file}:EXPRESSION:{type}:{line}:{column}`
- [ ] No manual node construction
- [ ] ArgumentExpression properly tracks call context

### Tests
- [ ] NoLegacyExpressionIds.test.js passes
- [ ] Expression.test.js passes (all existing tests)
- [ ] Edge resolution tests pass
- [ ] Full test suite passes

### Documentation
- [ ] CHANGELOG.md documents breaking change
- [ ] Migration guide for users
- [ ] Code comments explain two creation paths
- [ ] ExpressionNode API documented

---

## Time Estimate

| Phase | Time |
|-------|------|
| Phase 1: Infrastructure | 1 hour |
| Phase 2a: JSASTAnalyzer | 1.5 hours |
| Phase 2b: VariableVisitor | 1 hour |
| Phase 3: CallExpressionVisitor | 1 hour |
| Phase 4: GraphBuilder | 1 hour |
| Phase 5: Verification | 1.5 hours |
| **Total** | **7 hours** |

Plus buffer for debugging and edge cases: **2 hours**

**Total estimate: 9 hours**

---

## Conclusion

The revised plan correctly identifies GraphBuilder as a PRIMARY EXPRESSION node factory, not reconstruction code. The migration must:

1. Add `generateId()` and `createFromMetadata()` to ExpressionNode
2. Migrate JSASTAnalyzer first (ID generation)
3. Migrate visitors (independent paths)
4. Migrate GraphBuilder last (depends on JSASTAnalyzer)
5. Test edge resolution at each step

This approach:
- Preserves architectural separation (ID generation vs. node creation)
- Maintains edge consistency
- Provides clear validation
- Has well-defined breaking change boundaries

**Ready for implementation.**
