# Don Melton: REG-200 Analysis

## Current Architecture Understanding

### Data Flow for Assignments

The assignment edge system works through a two-phase process:

1. **Collection Phase (JSASTAnalyzer.trackVariableAssignment)**:
   - Analyzes each variable initializer expression
   - Emits `VariableAssignmentInfo` records with `sourceType` indicating what kind of value is being assigned
   - Currently handles: LITERAL, CALL_SITE, METHOD_CALL (CALL), VARIABLE, CLASS, FUNCTION, EXPRESSION

2. **Graph Building Phase (GraphBuilder.bufferAssignmentEdges)**:
   - Processes `variableAssignments` collection
   - Creates ASSIGNED_FROM edges based on `sourceType`
   - **Critical observation**: CLASS sourceType is skipped in `bufferAssignmentEdges()` (line 734-737) and deferred to async `createClassAssignmentEdges()`

3. **Async Resolution Phase (GraphBuilder.createClassAssignmentEdges)**:
   - Queries the graph for CLASS nodes by name
   - Creates ASSIGNED_FROM edges when CLASS node is found
   - **Problem**: Only creates edge if a CLASS node exists in the graph

### How NewExpression Currently Works

Looking at JSASTAnalyzer line 668-680:
```typescript
// 5. NewExpression
if (initExpression.type === 'NewExpression') {
  const callee = initExpression.callee;
  if (callee.type === 'Identifier') {
    variableAssignments.push({
      variableId,
      sourceType: 'CLASS',
      className: callee.name,
      line: line
    });
  }
  return;
}
```

This emits a variableAssignment with `sourceType: 'CLASS'`, which is then handled by `createClassAssignmentEdges()`.

### The Root Cause

The Linear issue diagnosis is **partially correct but incomplete**:

1. **Correct**: `bufferAssignmentEdges()` skips CLASS sourceType
2. **Correct**: NewExpression is handled, but only for user-defined classes
3. **Incomplete**: The real problem is that `createClassAssignmentEdges()` only creates edges when a CLASS node EXISTS in the graph

For built-in constructors (Date, Map, Set, Array, etc.):
- No CLASS node is created because these are JavaScript built-ins, not user-defined classes
- `createClassAssignmentEdges()` queries `graph.queryNodes({ type: 'CLASS' })` and finds nothing
- Result: **No ASSIGNED_FROM edge is created**

For user-defined classes declared in the same codebase:
- CLASS node exists (created by `bufferClassDeclarationNodes`)
- Edge creation works, but with potential race conditions (class might be in a different file not yet analyzed)

## Root Cause Validation

**Confirmed**: The root cause is that:
1. Built-in constructors have no CLASS nodes to link to
2. The code assumes all NewExpressions will have a corresponding CLASS node
3. There's no fallback for when CLASS node doesn't exist

## Architectural Concerns

### Problem 1: Conflation of User Classes and Built-ins

The current design treats all `new X()` expressions the same, expecting a CLASS node. This is architecturally wrong because:
- User-defined classes: Have CLASS nodes we create
- Built-in constructors (Date, Map, Set): Are language primitives, NOT user code
- Imported classes: Might exist in other files or external modules

### Problem 2: INSTANCE_OF vs ASSIGNED_FROM Confusion

Current state:
- `bufferClassNodes()` creates INSTANCE_OF edges (variable -> CLASS) for user classes
- `createClassAssignmentEdges()` creates ASSIGNED_FROM edges

These serve different purposes:
- **INSTANCE_OF**: Type relationship - "this variable holds an instance of class X"
- **ASSIGNED_FROM**: Data flow - "this variable's value comes from expression Y"

For `const db = new Database(cfg)`:
- We need INSTANCE_OF: db -> CLASS:Database (semantic typing)
- We ALSO need ASSIGNED_FROM: db -> ??? (data flow tracing)

### Problem 3: What Should ASSIGNED_FROM Point To?

Options:
1. **CLASS node** - Current approach, but doesn't work for built-ins
2. **Synthetic BUILTIN_CONSTRUCTOR node** - Linear's suggestion
3. **CALL_SITE or NewExpression node** - Treat `new X()` as a call

**Analysis**: Option 3 is architecturally cleanest. A `new X(args)` expression IS a call - it:
- Invokes a constructor function
- Passes arguments
- Returns a value

We should create a node representing the NewExpression itself (like we do for method calls).

### Problem 4: Cross-File Issues

Previous REG-121 analysis noted that `createClassAssignmentEdges()` has the same cross-file race condition issues as import edges. This should eventually move to the enrichment phase.

## High-Level Plan

### Phase 1: Create CONSTRUCTOR_CALL Node Type (Core Fix)

Instead of trying to link to a CLASS node that may not exist, treat NewExpression as its own entity:

1. **Add ConstructorCallNode contract** to types
   - Type: 'CONSTRUCTOR_CALL'
   - Fields: className, file, line, column, arguments info
   - ID format: `{file}->CONSTRUCTOR_CALL->{className}:{line}:{column}`

2. **Update JSASTAnalyzer.trackVariableAssignment**:
   - For NewExpression, emit sourceType: 'CONSTRUCTOR_CALL' instead of 'CLASS'
   - Include source location info (line, column) for ID generation

3. **Update GraphBuilder**:
   - Buffer CONSTRUCTOR_CALL nodes in `bufferAssignmentEdges()`
   - Create ASSIGNED_FROM edge from variable to CONSTRUCTOR_CALL node
   - Optionally create INSTANTIATES edge from CONSTRUCTOR_CALL to CLASS (if class exists)

### Phase 2: Handle INSTANCE_OF Separately

The INSTANCE_OF edge (semantic typing) is separate from data flow:

1. Keep current `bufferClassNodes()` for INSTANCE_OF edges
2. INSTANCE_OF should link to:
   - User CLASS node if available
   - Synthetic BUILTIN_GLOBAL:ClassName for built-ins (Date, Map, etc.)

### Phase 3: Built-in Constructors (Optional Enhancement)

For semantic completeness, create singleton nodes for JavaScript built-ins:

```javascript
const BUILTIN_CONSTRUCTORS = [
  'Date', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Array', 'Object', 'String', 'Number', 'Boolean',
  'RegExp', 'Error', 'TypeError', 'RangeError',
  'Promise', 'ArrayBuffer', 'DataView',
  'Int8Array', 'Uint8Array', /* ... */
];
```

Create `BUILTIN_GLOBAL:Date` style nodes as singletons. The INSTANCE_OF edge can point to these for built-in types.

### Recommended Approach (Minimal Viable Fix)

For the immediate fix, I recommend:

1. **Create CONSTRUCTOR_CALL nodes** for all `new X()` expressions
2. **ASSIGNED_FROM** points to CONSTRUCTOR_CALL node (guaranteed to exist)
3. **INSTANCE_OF** continues working as-is for user classes
4. Built-in constructors get CONSTRUCTOR_CALL nodes but no INSTANCE_OF (acceptable for now)

This aligns with how we handle method calls - we create METHOD_CALL nodes and link to them.

## Decision Points for Discussion

### 1. Node Type Naming
- `NEW_EXPRESSION` (matches Babel AST)
- `CONSTRUCTOR_CALL` (more semantic)
- `INSTANTIATION` (shorter)

**My recommendation**: `CONSTRUCTOR_CALL` - it's what it semantically IS.

### 2. INSTANCE_OF for Built-ins
- Option A: Create BUILTIN_GLOBAL nodes for built-in constructors
- Option B: Skip INSTANCE_OF for built-ins (acceptable limitation)
- Option C: Create EXTERNAL_CLASS nodes (like EXTERNAL_MODULE pattern)

**My recommendation**: Option B for now, Option C for future enhancement.

### 3. Cross-File CLASS Resolution
- Keep in GraphBuilder (current, has race issues)
- Move to enrichment phase (like ImportExportLinker)

**My recommendation**: Defer to separate issue (same as REG-121 decision).

---

## Critical Files for Implementation

- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Core fix: add CONSTRUCTOR_CALL buffering and ASSIGNED_FROM edge creation
- `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - Update trackVariableAssignment to emit CONSTRUCTOR_CALL sourceType
- `packages/core/src/plugins/analysis/ast/types.ts` - Add ConstructorCallInfo interface and update VariableAssignmentInfo
- `packages/core/src/core/NodeFactory.ts` - Add createConstructorCall() factory method
- `test/unit/DataFlowTracking.test.js` - Add/fix tests for NewExpression ASSIGNED_FROM edges
