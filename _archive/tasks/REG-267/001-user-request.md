# REG-267: Implement Control Flow Layer

## Problem

Control flow statements (if, switch, for, while, try/catch) are currently **completely ignored** in Grafema's graph. This is a critical gap that prevents:

1. **Dead code detection** - Can't find unreachable code after return/throw
2. **Complexity metrics** - Can't calculate cyclomatic complexity
3. **Error flow analysis** - Can't track which functions can throw, what catches them
4. **Loop analysis** - Can't detect potential infinite loops, understand iteration patterns
5. **Condition analysis** - Can't answer "what conditions guard this operation?"

## Confirmed Design

### New Node Types

```
BRANCH          - Conditional branching (if, switch, ternary)
LOOP            - Loop construct (for, while, do-while, for-in, for-of)
TRY_BLOCK       - Exception handling block
CATCH_BLOCK     - Catch clause
FINALLY_BLOCK   - Finally clause
```

### New Edge Types

```
HAS_CONDITION   - BRANCH/LOOP → condition expression
HAS_CONSEQUENT  - BRANCH → consequent (then) block
HAS_ALTERNATE   - BRANCH → alternate (else) block
HAS_BODY        - LOOP → loop body
HAS_CATCH       - TRY_BLOCK → CATCH_BLOCK
HAS_FINALLY     - TRY_BLOCK → FINALLY_BLOCK
ITERATES_OVER   - LOOP → iterated collection (for-in/for-of)
```

### Function Metadata

Annotate FUNCTION nodes with control flow metadata:

```typescript
interface FunctionControlFlowMetadata {
  hasBranches: boolean;
  hasLoops: boolean;
  hasTryCatch: boolean;
  hasEarlyReturn: boolean;
  hasThrow: boolean;
  cyclomaticComplexity: number;
}
```

## Examples

### If Statement

```javascript
if (user.isAdmin) {
  deleteAll();
} else {
  showError();
}
```

Graph:

```
BRANCH#if:file.js:5
  ├─[HAS_CONDITION]→ EXPRESSION(user.isAdmin)
  ├─[HAS_CONSEQUENT]→ SCOPE#then:file.js:5
  │    └─[CONTAINS]→ CALL(deleteAll)
  └─[HAS_ALTERNATE]→ SCOPE#else:file.js:7
       └─[CONTAINS]→ CALL(showError)
```

### For-Of Loop

```javascript
for (const item of items) {
  process(item);
}
```

Graph:

```
LOOP#for-of:file.js:10
  ├─[ITERATES_OVER]→ VARIABLE(items)
  ├─[DECLARES]→ VARIABLE(item)
  └─[HAS_BODY]→ SCOPE#loop-body:file.js:10
       └─[CONTAINS]→ CALL(process)
```

## Files to Modify

1. **New:** `ControlFlowVisitor.ts` - Handle IfStatement, SwitchStatement, WhileStatement, ForStatement, TryStatement
2. `packages/types/src/nodes.ts` - Add BRANCH, LOOP, TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK
3. `packages/types/src/edges.ts` - Add HAS_CONDITION, HAS_CONSEQUENT, HAS_ALTERNATE, HAS_BODY, HAS_CATCH, HAS_FINALLY, ITERATES_OVER
4. `GraphBuilder.ts` - Process control flow collections
5. `FunctionVisitor.ts` - Compute control flow metadata

## Use Cases Enabled

1. **"Show me all functions that can throw"** - Query for FUNCTION -[THROWS]→ or FUNCTION.hasThrow
2. **"Find complex functions"** - Query cyclomaticComplexity > threshold
3. **"What guards this database write?"** - Trace back through BRANCH conditions
4. **"Find infinite loop risks"** - Query LOOP without clear termination

## Acceptance Criteria

- [ ] BRANCH nodes created for if/switch statements
- [ ] LOOP nodes created for for/while/do-while
- [ ] TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK nodes created
- [ ] All new edge types functional
- [ ] Function metadata populated
- [ ] Tests cover all statement types
- [ ] Documentation updated
