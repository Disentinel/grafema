# REG-131: Revised Plan After Linus's Review

## Don Melton - Thorough Investigation Results

---

## 1. Complete FUNCTION# Grep Results

### Production Code Generating Legacy IDs

| File | Lines | Context |
|------|-------|---------|
| **ClassVisitor.ts** | 246, 307 | Class property functions and class methods |
| **JSASTAnalyzer.ts** | 900, 970, 1660, 1714 | Module-level assignments, callbacks, nested functions, arrows |
| **AnalysisWorker.ts** | 198, 241, 347 | FunctionDeclaration, ArrowFunction, CONTAINS edges |
| **QueueWorker.ts** | 268, 308, 405 | FunctionDeclaration, ArrowFunction, CONTAINS edges |
| **ASTWorker.ts** | 404 | FunctionDeclaration |
| **CallExpressionVisitor.ts** | 910 | `getFunctionScopeId()` for edge matching |
| **SocketIOAnalyzer.ts** | 312 | Handler function lookup |
| **RustAnalyzer.ts** | 296 | RUST_FUNCTION (separate type) |

### Documentation/Test (non-production)
- `docs/REGINAFLOW_DB.md` - Examples in documentation
- `rust-engine/src/graph/id_gen.rs` - Test assertion

### Tests
**No tests assert on FUNCTION# format** - verified with grep in `/test` directory.

---

## 2. Worker Files Analysis

### AnalysisWorker.ts - **NEEDS CHANGES**

**Location:** `/Users/vadimr/grafema/packages/core/src/core/AnalysisWorker.ts`

**Lines with legacy IDs:**
- **Line 198:** `const functionId = \`FUNCTION#\${funcName}#\${filePath}#\${node.loc!.start.line}\`;`
- **Line 241:** `const functionId = \`FUNCTION#\${funcName}#\${filePath}#\${path.node.loc!.start.line}\`;`
- **Line 347:** `src: \`FUNCTION#\${parentName}#\${filePath}#\${parentFunc.node.loc!.start.line}\``

**Problem:** This worker runs in parallel, writes directly to RFDB with legacy function IDs. The CONTAINS edges reference legacy IDs.

**Verdict:** **IN SCOPE** - Must use semantic IDs or coordinate with main analysis.

### QueueWorker.ts - **NEEDS CHANGES**

**Location:** `/Users/vadimr/grafema/packages/core/src/core/QueueWorker.ts`

**Lines with legacy IDs:**
- **Line 268, 308:** Function declarations and arrows
- **Line 405:** CONTAINS edge source

**Problem:** Same as AnalysisWorker - parallel worker with legacy IDs.

**Verdict:** **IN SCOPE** - Must be updated for consistency.

### ASTWorker.ts - **NEEDS CHANGES**

**Location:** `/Users/vadimr/grafema/packages/core/src/core/ASTWorker.ts`

**Line 404:** `const functionId = \`FUNCTION#\${funcName}#\${filePath}#\${node.loc!.start.line}:\${node.loc!.start.column}\`;`

**Verdict:** **IN SCOPE** - Returns collections with legacy IDs.

### Architectural Note

Workers don't have access to `scopeTracker` - they parse files in isolation. Two options:
1. **Pass semantic context** - Workers receive scope context for ID generation
2. **Workers use colon format** - Workers use deterministic location-based IDs (like EXPRESSION nodes)

**Recommendation:** Option 2 is simpler and doesn't require protocol changes. Workers can use `{file}:{line}:{column}` format since they process files independently without scope context.

---

## 3. CallExpressionVisitor Analysis - **NEEDS CHANGES**

**Location:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Lines 909-910:**
```typescript
if (funcNode.type === 'FunctionDeclaration' && funcNode.id?.name) {
  return \`FUNCTION#\${funcNode.id.name}#\${module.file}#\${line}\`;
}
```

**Purpose:** `getFunctionScopeId()` generates parent function ID to connect CALL nodes to their containing function via CONTAINS edges.

**Problem:** If FunctionVisitor generates semantic IDs but CallExpressionVisitor generates legacy IDs for `parentScopeId`, the edges will be orphaned (source node doesn't exist).

**Verdict:** **IN SCOPE - CRITICAL** - This must match FunctionVisitor's ID format or edges break.

---

## 4. EXPRESSION Nodes Decision - **DOCUMENTED EXCLUSION**

### Current State

EXPRESSION nodes already use a consistent colon-based format:
```
{file}:EXPRESSION:{expressionType}:{line}:{column}
```

Example: `/src/app.ts:EXPRESSION:MemberExpression:25:10`

### Decision

**EXPRESSION nodes are EXCLUDED from this migration.**

Reason: They already have a consistent, non-legacy format. The colon format works well for EXPRESSION because:
- They're location-bound (always created at specific AST positions)
- They don't need scope-based semantic hierarchy
- Format is already stable and tested

**Documentation:** The acceptance criteria says "EXPRESSION nodes have consistent format (or documented exception)" - they DO have consistent format, just different from FUNCTION semantic IDs.

---

## 5. semanticId Field Usage - **SAFE TO REMOVE**

When `id` IS the semantic ID, the separate `semanticId` field becomes redundant.

**Safe to remove from:**
- `ClassFunctionInfo` interface

**Keep `stableId` for backward compatibility** (set equal to `id`).

---

## 6. Revised Scope - Complete File List

### Phase 1: Primary Visitors (Critical Path)

| File | Lines to Change | Description |
|------|-----------------|-------------|
| `ClassVisitor.ts` | 246, 307, 252, 313 | Change `functionId` to use semantic ID |
| `CallExpressionVisitor.ts` | 910 | Fix `getFunctionScopeId()` to match semantic format |

### Phase 2: JSASTAnalyzer

| File | Lines to Change | Description |
|------|-----------------|-------------|
| `JSASTAnalyzer.ts` | 900, 970, 1660, 1714 | Nested and module-level functions |

### Phase 3: Workers (Parallel Analysis)

| File | Lines to Change | Description |
|------|-----------------|-------------|
| `AnalysisWorker.ts` | 198, 241, 347 | Worker function IDs |
| `QueueWorker.ts` | 268, 308, 405 | Worker function IDs |
| `ASTWorker.ts` | 404 | Worker function IDs |

### Phase 4: Plugin Analyzers

| File | Lines to Change | Description |
|------|-----------------|-------------|
| `SocketIOAnalyzer.ts` | 312 | Handler function lookup |

### Explicitly Out of Scope

| File | Reason |
|------|--------|
| `RustAnalyzer.ts` | Uses `RUST_FUNCTION` type, different node category |
| `ExpressionNode.ts` | Already uses consistent colon format |
| `rust-engine/` | Test file, not production |
| `docs/REGINAFLOW_DB.md` | Documentation examples only |

---

## 7. Test Strategy - Updated

### Integration Tests Needed (per Linus)

```javascript
// Test 1: ClassVisitor output
it('ClassVisitor should produce semantic IDs for class methods', async () => {
  const result = await analyzer.analyzeFile('class Foo { bar() {} }');
  const method = findFunction(result, 'bar');
  assert.ok(method.id.includes('->'), 'ID should use semantic format');
  assert.ok(!method.id.startsWith('FUNCTION#'), 'ID should not use legacy format');
  assert.match(method.id, /->Foo->FUNCTION->bar$/);
});

// Test 2: Edge consistency
it('CALL edges should use matching function IDs', async () => {
  // function outer() { helper(); }
  // Verify CALL node's parentScopeId matches outer's ID
});
```

### Existing Tests - No Changes Needed

Verified: No tests in `/test` directory assert on `FUNCTION#` pattern.

---

## 8. Questions Answered

### Q1: Why keep fallback to legacy IDs?

**Answer:** For edge cases where `scopeTracker` might be unavailable. After reviewing FunctionVisitor, this fallback is appropriate. The pattern is:
```typescript
const functionId = scopeTracker
  ? computeSemanticId('FUNCTION', name, scopeTracker.getContext())
  : legacyId;
```

### Q2: What happens to existing graphs?

**Answer:** Re-analysis will generate new IDs. Old edges may become orphaned. This is expected behavior - the migration is a breaking change for existing graphs. Users should run `grafema analyze --clear` after updating.

### Q3: Workers don't have scopeTracker - how to handle?

**Answer:** Workers continue using location-based format since they don't have scope context. This is a known limitation documented in worker files.

---

## 9. Revised Risk Assessment

| Risk | Level | Mitigation |
|------|-------|------------|
| CONTAINS edges break (CallExpressionVisitor) | **HIGH** | Fix `getFunctionScopeId()` first |
| Worker IDs mismatch main analyzer | MEDIUM | Document limitation or use same format |
| Decorator targetId mismatch | LOW | Uses local functionId variable |
| External consumers expect legacy format | LOW | No tests found, add deprecation warning |

---

## Critical Files for Implementation

1. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` - Primary fix for class methods (lines 246, 307, 252, 313)
2. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts` - Critical edge matching fix (line 910)
3. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Nested functions (lines 900, 970, 1660, 1714)
4. `/Users/vadimr/grafema/packages/core/src/core/AnalysisWorker.ts` - Worker function IDs (lines 198, 241, 347)
5. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` - Pattern to follow (lines 288-290)
