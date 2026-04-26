# REG-533: Implementation Plan — Add DERIVES_FROM edges to control flow EXPRESSION nodes

**Don Melton (Tech Lead)**
**Date:** 2026-02-20

---

## Root Cause Analysis

After reading the code, I've identified the precise gap:

**EXISTING COVERAGE:**
- AssignmentBuilder: Creates EXPRESSION nodes with DERIVES_FROM for assignments (`const x = a + b`)
- ReturnBuilder: Creates EXPRESSION nodes with DERIVES_FROM for return statements (`return x + y`)
- YieldBuilder: Creates EXPRESSION nodes with DERIVES_FROM for yield expressions (`yield x.prop`)
- MutationBuilder: Creates EXPRESSION nodes with DERIVES_FROM for reassignments (`x = a + b`)

**THE GAP:**
- **ControlFlowBuilder: Creates EXPRESSION nodes BUT NO DERIVES_FROM edges**

Specifically, ControlFlowBuilder creates EXPRESSION nodes for:
1. Loop test conditions (`while (i < 10)`, `for (...; i < arr.length; ...)`)
2. Loop update expressions (`for (...; ...; i++)`)
3. Branch discriminants (`switch(action.type)`, `if (x > y)`)

These EXPRESSION nodes are created (lines 156-164, 174-190, 262-270 in ControlFlowBuilder.ts) but have NO outgoing DERIVES_FROM edges.

**WHY THIS IS THE GAP:**

The `extractDiscriminantExpression` method used by handlers (LoopHandler.ts, BranchHandler.ts) returns ONLY:
- `id`
- `expressionType`
- `line`
- `column`

It does NOT return operand metadata (no `leftSourceName`, `rightSourceName`, `objectSourceName`, etc.).

This means ControlFlowBuilder has NO DATA to create DERIVES_FROM edges, even if it wanted to.

---

## Solution Architecture

### Strategy: Extract Operand Metadata in Handlers → Use in ControlFlowBuilder

We'll follow the existing pattern from AssignmentBuilder but apply it to control flow contexts.

**Step 1: Enhance metadata extraction in handlers**
- Modify `extractDiscriminantExpression` to return operand names
- Add operand extraction for loop test/update expressions

**Step 2: Store metadata in LoopInfo / BranchInfo**
- Add optional fields for operand names (matching pattern from VariableAssignmentInfo)

**Step 3: Create DERIVES_FROM edges in ControlFlowBuilder**
- Reuse the pattern from AssignmentBuilder (lines 242-373)
- Add edge creation for each expression type

---

## Detailed Changes

### 1. Enhance JSASTAnalyzer.extractDiscriminantExpression

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Current return type:**
```typescript
{ id: string; expressionType: string; line: number; column: number }
```

**New return type:**
```typescript
{
  id: string;
  expressionType: string;
  line: number;
  column: number;
  // Operand metadata (same pattern as AssignmentBuilder)
  leftSourceName?: string;
  rightSourceName?: string;
  objectSourceName?: string;
  consequentSourceName?: string;
  alternateSourceName?: string;
  operator?: string;
  object?: string;
  property?: string;
  computed?: boolean;
}
```

**Implementation:**
- For `BinaryExpression` / `LogicalExpression`: extract left/right operand names
- For `MemberExpression`: extract object name
- For `ConditionalExpression`: extract consequent/alternate names
- For `Identifier`: extract the identifier name as objectSourceName (for scope lookup)
- Use helper: `extractOperandName(node: t.Expression): string | undefined`

**Example:**
```typescript
// switch(action.type)
// Returns: { objectSourceName: 'action', property: 'type', object: 'action' }

// if (x > 10)
// Returns: { leftSourceName: 'x', operator: '>' }

// while (i < arr.length)
// Returns: { leftSourceName: 'i', objectSourceName: 'arr', property: 'length' }
```

---

### 2. Add operand fields to LoopInfo interface

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

Add to `LoopInfo`:
```typescript
// For test expression (condition) operands
testLeftSourceName?: string;
testRightSourceName?: string;
testObjectSourceName?: string;
testConsequentSourceName?: string;
testAlternateSourceName?: string;
testOperator?: string;
testObject?: string;
testProperty?: string;
testComputed?: boolean;

// For update expression operands
updateObjectSourceName?: string;
updateOperator?: string;
updateArgSourceName?: string;  // For i++ (unary), arg is 'i'
```

---

### 3. Add operand fields to BranchInfo interface

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

Add to `BranchInfo`:
```typescript
// For discriminant operands
discriminantLeftSourceName?: string;
discriminantRightSourceName?: string;
discriminantObjectSourceName?: string;
discriminantConsequentSourceName?: string;
discriminantAlternateSourceName?: string;
discriminantOperator?: string;
discriminantObject?: string;
discriminantProperty?: string;
discriminantComputed?: boolean;
```

---

### 4. Populate metadata in LoopHandler

**File:** `packages/core/src/plugins/analysis/ast/handlers/LoopHandler.ts`

**Changes at lines 138-164 (condition extraction):**
```typescript
if (loopType === 'while' || loopType === 'do-while') {
  const testNode = (node as t.WhileStatement | t.DoWhileStatement).test;
  if (testNode) {
    const condResult = analyzer.extractDiscriminantExpression(testNode, ctx.module);
    conditionExpressionId = condResult.id;
    conditionExpressionType = condResult.expressionType;
    conditionLine = condResult.line;
    conditionColumn = condResult.column;

    // NEW: Extract operands
    testLeftSourceName = condResult.leftSourceName;
    testRightSourceName = condResult.rightSourceName;
    testObjectSourceName = condResult.objectSourceName;
    testOperator = condResult.operator;
    testObject = condResult.object;
    testProperty = condResult.property;
    testComputed = condResult.computed;
  }
}
```

**Changes at lines 98-112 (test/update for classic for loop):**
- Extract test operands (same as above)
- Extract update operands for `UpdateExpression` (i++, i--)

**Changes at lines 166-196 (push to ctx.loops):**
- Add all new operand fields to the pushed LoopInfo

---

### 5. Populate metadata in BranchHandler

**File:** `packages/core/src/plugins/analysis/ast/handlers/BranchHandler.ts`

Similar changes to LoopHandler:
- Extract operands from `extractDiscriminantExpression` result
- Store in local variables
- Add to pushed BranchInfo

---

### 6. Create DERIVES_FROM edges in ControlFlowBuilder

**File:** `packages/core/src/plugins/analysis/ast/builders/ControlFlowBuilder.ts`

**Add new private method:** `bufferLoopTestDerivesFromEdges`

Pattern (reuse from AssignmentBuilder lines 303-373):
```typescript
private bufferLoopTestDerivesFromEdges(
  loops: LoopInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[]
): void {
  for (const loop of loops) {
    if (!loop.testExpressionId || !loop.testExpressionType) continue;

    const file = loop.file;

    // Helper to find variable or parameter
    const findSource = (name: string): string | null => {
      const variable = variableDeclarations.find(v =>
        v.name === name && v.file === file
      );
      if (variable) return variable.id;

      const param = parameters.find(p =>
        p.name === name && p.file === file
      );
      if (param) return param.id;

      return null;
    };

    // BinaryExpression / LogicalExpression
    if (loop.testExpressionType === 'BinaryExpression' ||
        loop.testExpressionType === 'LogicalExpression') {
      if (loop.testLeftSourceName) {
        const srcId = findSource(loop.testLeftSourceName);
        if (srcId) {
          this.ctx.bufferEdge({
            type: 'DERIVES_FROM',
            src: loop.testExpressionId,
            dst: srcId
          });
        }
      }
      if (loop.testRightSourceName) {
        const srcId = findSource(loop.testRightSourceName);
        if (srcId) {
          this.ctx.bufferEdge({
            type: 'DERIVES_FROM',
            src: loop.testExpressionId,
            dst: srcId
          });
        }
      }
    }

    // MemberExpression
    if (loop.testExpressionType === 'MemberExpression' && loop.testObjectSourceName) {
      const srcId = findSource(loop.testObjectSourceName);
      if (srcId) {
        this.ctx.bufferEdge({
          type: 'DERIVES_FROM',
          src: loop.testExpressionId,
          dst: srcId
        });
      }
    }

    // Identifier (variable reference in condition)
    if (loop.testExpressionType === 'Identifier' && loop.testObjectSourceName) {
      const srcId = findSource(loop.testObjectSourceName);
      if (srcId) {
        this.ctx.bufferEdge({
          type: 'DERIVES_FROM',
          src: loop.testExpressionId,
          dst: srcId
        });
      }
    }
  }
}
```

**Add similar methods:**
- `bufferLoopUpdateDerivesFromEdges` (for `i++` in for loops)
- `bufferBranchDiscriminantDerivesFromEdges` (for switch/if discriminants)

**Call from `buffer()` method:**
```typescript
buffer(module: ModuleNode, data: ASTCollections): void {
  // ... existing code ...

  // NEW: Add DERIVES_FROM edges
  this.bufferLoopTestDerivesFromEdges(loops, variableDeclarations, parameters);
  this.bufferLoopUpdateDerivesFromEdges(loops, variableDeclarations, parameters);
  this.bufferBranchDiscriminantDerivesFromEdges(branches, variableDeclarations, parameters);
}
```

---

## Expression Types to Handle

Based on AssignmentBuilder coverage, handle:

1. **BinaryExpression** (e.g., `i < 10`, `x + y`)
   - DERIVES_FROM → left operand
   - DERIVES_FROM → right operand

2. **LogicalExpression** (e.g., `x && y`, `a || b`)
   - DERIVES_FROM → left operand
   - DERIVES_FROM → right operand

3. **MemberExpression** (e.g., `arr.length`, `action.type`)
   - DERIVES_FROM → object

4. **ConditionalExpression** (e.g., ternary in discriminant)
   - DERIVES_FROM → consequent
   - DERIVES_FROM → alternate

5. **Identifier** (e.g., `switch(x)`, `while(flag)`)
   - DERIVES_FROM → variable/parameter

6. **UpdateExpression** (e.g., `i++`, `--count`)
   - DERIVES_FROM → argument (the variable being updated)

7. **UnaryExpression** (e.g., `!flag`, `-x`)
   - DERIVES_FROM → argument

8. **TemplateLiteral** (less common in control flow, but possible)
   - DERIVES_FROM → each embedded expression

---

## Helper Method: extractOperandName

Add to JSASTAnalyzer:

```typescript
private extractOperandName(node: t.Expression | t.PrivateName): string | undefined {
  if (t.isIdentifier(node)) {
    return node.name;
  }
  if (t.isMemberExpression(node) && t.isIdentifier(node.object)) {
    return node.object.name;  // For x.y, return 'x'
  }
  // For complex expressions, don't extract (will be handled by nested EXPRESSION nodes)
  return undefined;
}
```

This mirrors the logic in AssignmentVisitor for extracting operand names.

---

## Files Changed

1. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
   - Modify `extractDiscriminantExpression` to return operand metadata
   - Add `extractOperandName` helper
   - ~50 lines changed

2. `packages/core/src/plugins/analysis/ast/types.ts`
   - Add operand fields to `LoopInfo`
   - Add operand fields to `BranchInfo`
   - ~30 lines added

3. `packages/core/src/plugins/analysis/ast/handlers/LoopHandler.ts`
   - Extract and store operand metadata from test/update expressions
   - ~40 lines changed

4. `packages/core/src/plugins/analysis/ast/handlers/BranchHandler.ts`
   - Extract and store operand metadata from discriminants
   - ~30 lines changed

5. `packages/core/src/plugins/analysis/ast/builders/ControlFlowBuilder.ts`
   - Add `bufferLoopTestDerivesFromEdges`
   - Add `bufferLoopUpdateDerivesFromEdges`
   - Add `bufferBranchDiscriminantDerivesFromEdges`
   - Call from `buffer()` method
   - ~150 lines added

**Total estimate:** ~300 lines of code across 5 files

---

## Edge Cases

1. **Nested member expressions** (`obj.nested.prop`)
   - Extract base object only ('obj') for DERIVES_FROM
   - Property chain captured in EXPRESSION node metadata

2. **Complex expressions in operands** (`arr[i + 1].length`)
   - Only extract top-level identifiers
   - Nested expressions handled by their own EXPRESSION nodes

3. **Computed properties** (`obj[key]`)
   - Store `computed: true` flag
   - Extract both object and computed property var if available

4. **Null/undefined test expressions** (`for (;;)`)
   - Skip DERIVES_FROM creation (no operands to link)

5. **CallExpression discriminants** (`switch(getType())`)
   - Already handled by existing code (links to CALL_SITE, not EXPRESSION)
   - No DERIVES_FROM needed (call site has its own edges)

---

## Testing Strategy

After implementation, verify:

1. **Smoke test:** Re-run ERR_NO_LEAF_NODE check
   - Expected: ~2640 errors → ~0 errors (or significantly reduced)

2. **Unit tests:** Add to `test/unit/ControlFlowBuilder.test.js`
   - Loop test with binary expression: `while (i < arr.length)`
   - For loop update with increment: `for (let i = 0; i < 10; i++)`
   - Switch discriminant with member expression: `switch(action.type)`
   - If condition with logical expression: `if (x && y)`

3. **Integration test:** Check full data flow path
   - Start: VARIABLE declaration
   - Middle: EXPRESSION in loop condition with DERIVES_FROM
   - End: Follow ASSIGNED_FROM → DERIVES_FROM chain to leaf nodes

---

## Why This is the RIGHT Fix

This fix addresses the ROOT CAUSE:

1. **Architectural consistency:** Control flow EXPRESSION nodes now have the same DERIVES_FROM coverage as assignment/return/yield EXPRESSION nodes

2. **Data completeness:** Handlers extract all metadata needed for edge creation (no silent gaps)

3. **No workarounds:** We're not patching symptoms — we're ensuring the graph correctly models data flow through control structures

4. **Reuses proven patterns:** The DERIVES_FROM edge creation logic is identical to AssignmentBuilder (battle-tested)

5. **Scales correctly:** Adding new expression types to control flow is now trivial (just add operand extraction)

The question isn't "does it work?" — the question is "is it RIGHT?" And yes, this fix makes the graph model match reality.

---

## Open Questions

None. The plan is complete and ready for implementation.

**Next step:** Hand to Dijkstra for TDD implementation.
