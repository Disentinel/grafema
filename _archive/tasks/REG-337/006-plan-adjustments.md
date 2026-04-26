# Plan Adjustments After Review

## Reviewer Consensus

Both Steve Jobs and Вадим Решетников **CONDITIONALLY APPROVED** with the following required changes:

### 1. DO NOT Change ID Format (MANDATORY)

**Issue**: Adding column to node IDs for BranchNode, CaseNode, DatabaseQueryNode would break existing graph edges.

**Decision**: Add column ONLY to node metadata (record), NOT to the ID format.

```typescript
// KEEP ID FORMAT AS-IS:
const id = `${file}:BRANCH:${branchType}:${line}${counter}`;

// ADD column to RECORD ONLY:
return {
  id,
  type: 'BRANCH' as const,
  name: branchType,
  file,
  line,
  column,  // NEW - in metadata, not in ID
  // ...
};
```

### 2. SCOPE Remains Abstract (DECIDED)

**Issue**: User example mentions SCOPE, but SCOPE represents a range, not a point.

**Decision**: Keep SCOPE without column. The VS Code extension already handles this correctly - SCOPE nodes get lower specificity (column defaults to 0), so point-based nodes win in specificity contests.

**Rationale**: Adding column to SCOPE would be inconsistent (ranges need start/end, not just point). This is a separate enhancement if needed later.

### 3. Remove ArgumentExpressionNode from Scope

**Issue**: Joel listed ArgumentExpressionNode as needing column, but it already has column in ID and metadata.

**Decision**: Remove from implementation scope. No changes needed for ArgumentExpressionNode.

### 4. Add ParameterInfo.column to types.ts

**Issue**: ParameterInfo interface is missing column field, but ParameterNode has it.

**Decision**: Add `column: number` to ParameterInfo interface in types.ts.

### 5. Updated Test Strategy

**Decision**: Run analysis on real project (Grafema codebase) to catch missing column values before merge.

---

## Revised Implementation Scope

### Phase 1: Add column to nodes missing it (3 files, NOT 4)

1. **BranchNode.ts** - Add column to record (NOT to ID)
2. **CaseNode.ts** - Add column to record (NOT to ID)
3. **DatabaseQueryNode.ts** - Add column to record (NOT to ID)

### Phase 2: Move column from OPTIONAL to REQUIRED (17 files)

Same as original plan - move 'column' from OPTIONAL to REQUIRED arrays.

### Phase 3: Update EventListenerNode and HttpRequestNode (2 files)

Same as original plan.

### Phase 4: Update Info Types (1 file)

Add to original list:
- **ParameterInfo** - Add `column: number` (was missing)

### Phase 5: Update NodeFactory signatures (1 file)

Same as original plan - add column parameter to relevant factory methods.

### Phase 6: Update Analyzers

Same as original plan - ensure all analyzers pass column values from AST.

---

## Final Approval Status

- [x] Steve Jobs: CONDITIONALLY APPROVED (conditions addressed above)
- [x] Вадим Решетников: CONDITIONAL APPROVAL (conditions addressed above)

**PROCEED TO IMPLEMENTATION**
