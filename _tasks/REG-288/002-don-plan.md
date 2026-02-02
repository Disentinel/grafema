# Don Melton's Analysis: REG-288 - Track UpdateExpression modifications

## Current State Analysis

### How MODIFIES edges work today

**Existing mechanism:**
UpdateExpression (`i++`, `--count`) IS already tracked, but through an indirect SCOPE-based mechanism:

1. **JSASTAnalyzer.ts:3299-3321** - UpdateExpression visitor:
   - Finds the variable being modified
   - Adds to `scope.modifies` array
   - Stores: `{ variableId, variableName, line }`

2. **GraphBuilder.ts:379-388** - bufferScopeEdges():
   - Iterates `scope.modifies`
   - Creates MODIFIES edges: `SCOPE --MODIFIES--> VARIABLE`

**Critical insight:** MODIFIES edges point FROM SCOPE, not from the update expression itself.

### The Problem

The issue title says "MODIFIES edge missing" but that's NOT accurate. The edge EXISTS, but:

1. **Wrong source node:** Edge is `SCOPE --MODIFIES--> VARIABLE`, not `UPDATE_EXPR --MODIFIES--> VARIABLE`
2. **No UPDATE_EXPRESSION nodes created** - UpdateExpression AST nodes don't become graph nodes
3. **Poor queryability:**
   - Can't ask "what modifications happen at line X?"
   - Can't distinguish `i++` from `arr.push(i)` - both are just SCOPE modifications
   - Can't trace data flow through increment operations

### Comparison: How AssignmentExpression works

**REG-290** recently added variable reassignment tracking:

1. **JSASTAnalyzer.ts:2738-2748** - AssignmentExpression visitor (function-level):
   - Calls `detectVariableReassignment()` for simple identifiers (x = y)
   - Stores complete metadata in `VariableReassignmentInfo`

2. **JSASTAnalyzer.ts:3917-4026** - detectVariableReassignment():
   - Extracts operator, value type, metadata
   - Supports LITERAL, VARIABLE, CALL_SITE, METHOD_CALL, EXPRESSION
   - Creates structured info for GraphBuilder

3. **GraphBuilder.ts:1753-1876** - bufferVariableReassignmentEdges():
   - Creates inline LITERAL/EXPRESSION nodes
   - Creates FLOWS_INTO edges: `source --FLOWS_INTO--> variable`
   - For compound operators (+=): creates READS_FROM self-loop

**Key pattern:** Source expression becomes a graph node, edges point from expression to variable.

### Architectural Mismatch

**Current UpdateExpression approach violates project vision:**

> "AI should query the graph, not read code."

When AI asks "where is count modified?", current implementation returns:
- SCOPE node that contains the modification
- No information about WHAT kind of modification
- No data flow tracking (count++ is read+write operation)

**This is a ROOT CAUSE issue, not a feature gap.**

UpdateExpression needs first-class graph representation like AssignmentExpression has.

## What Needs to Change

### 1. Create UPDATE_EXPRESSION graph nodes

Add to `types.ts`:
```typescript
export interface UpdateExpressionInfo {
  id: string;
  type: 'UPDATE_EXPRESSION';
  variableName: string;
  operator: '++' | '--';
  prefix: boolean;  // ++i (true) vs i++ (false)
  file: string;
  line: number;
  column: number;
  parentScopeId?: string;
}
```

### 2. Collect UpdateExpression metadata in AST analyzer

**Module-level handler** (like AssignmentExpression at line 1323):
```typescript
// After traverse_assignments, before traverse_classes
this.profiler.start('traverse_updates');
traverse(ast, {
  UpdateExpression: (updatePath) => {
    const functionParent = updatePath.getFunctionParent();
    if (functionParent) return;  // Skip function-level, handled elsewhere
    
    this.collectUpdateExpression(updatePath.node, module, updateExpressions);
  }
});
this.profiler.end('traverse_updates');
```

**Function-level handler** (in analyzeFunctionBody, alongside existing UpdateExpression at line 3299):
- Replace scope.modifies tracking
- Call `collectUpdateExpression()` instead
- Store in `collections.updateExpressions`

### 3. Create edges in GraphBuilder

Follow VariableReassignment pattern (GraphBuilder.ts:1753):

```typescript
private bufferUpdateExpressionEdges(
  updateExpressions: UpdateExpressionInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[]
): void {
  // Build lookup cache
  const varLookup = buildVarLookup(...);
  
  for (const update of updateExpressions) {
    // 1. Create UPDATE_EXPRESSION node
    this._bufferNode({
      type: 'UPDATE_EXPRESSION',
      id: update.id,
      operator: update.operator,
      prefix: update.prefix,
      file: update.file,
      line: update.line,
      column: update.column
    });
    
    // 2. Find target variable
    const targetVar = varLookup.get(`${update.file}:${update.variableName}`);
    if (!targetVar) continue;
    
    // 3. Create edges (like compound assignment: x += 1)
    // READS_FROM: variable reads its current value
    this._bufferEdge({
      type: 'READS_FROM',
      src: targetVar.id,
      dst: targetVar.id  // Self-loop
    });
    
    // MODIFIES: update expression modifies variable
    this._bufferEdge({
      type: 'MODIFIES',
      src: update.id,           // UPDATE_EXPRESSION node
      dst: targetVar.id          // VARIABLE node
    });
    
    // CONTAINS: scope contains update expression
    if (update.parentScopeId) {
      this._bufferEdge({
        type: 'CONTAINS',
        src: update.parentScopeId,
        dst: update.id
      });
    }
  }
}
```

### 4. Remove old scope.modifies mechanism

**IMPORTANT:** This is a breaking change.

Current code:
- `ScopeInfo.modifies` array
- `bufferScopeEdges()` creates SCOPE --MODIFIES--> VARIABLE

After change:
- Remove `modifies` field from ScopeInfo
- Remove MODIFIES edge creation in bufferScopeEdges
- MODIFIES edges come ONLY from UPDATE_EXPRESSION nodes

**Migration impact:**
- Queries expecting SCOPE --MODIFIES--> edges will break
- Need to update to query UPDATE_EXPRESSION --MODIFIES--> instead
- This is CORRECT - better semantic model

## Alignment with Project Vision

### Why this is RIGHT, not just working

1. **Graph-first thinking:**
   - Every syntax construct that has semantic meaning = graph node
   - `i++` is a distinct operation, not just "scope modifies i"
   - Queryable: "Show me all increment operations on counter variables"

2. **Data flow completeness:**
   - UpdateExpression is BOTH read and write (like compound assignment)
   - READS_FROM self-loop matches `x += 1` pattern (REG-290)
   - Enables value tracing through increments

3. **Consistency:**
   - AssignmentExpression creates nodes + edges
   - UpdateExpression should do the same
   - Same pattern, same structure

4. **AI-friendly:**
   - "Where is count incremented?" → UPDATE_EXPRESSION nodes with operator="++"
   - "Does this loop modify external state?" → Follow MODIFIES edges from SCOPE's children
   - "Trace count value" → READS_FROM + MODIFIES chain

### What we're fixing

**Before (current):**
```
SCOPE --MODIFIES--> count
```
Query: "What modifies count?"
Answer: "Some scope" (useless)

**After (correct):**
```
SCOPE --CONTAINS--> UPDATE_EXPRESSION
UPDATE_EXPRESSION --MODIFIES--> count
count --READS_FROM--> count (self-loop)
```
Query: "What modifies count?"
Answer: "Increment operation at line 42, prefix=false (count++)"

Query: "What does count++ read?"
Answer: "count (reads current value before increment)"

## Architectural Concerns

### 1. Breaking change to MODIFIES semantics

**Issue:** Changing MODIFIES source from SCOPE to UPDATE_EXPRESSION.

**Resolution:**
- This is CORRECT architectural fix
- Document in migration guide
- Update MCP tools to query new pattern
- Benefits outweigh migration cost

### 2. Do we need UPDATE_EXPRESSION node type?

**Alternative:** Treat as EXPRESSION with metadata.

**Decision:** Dedicated node type is better because:
- Distinct semantic meaning (read+write operation)
- Simpler queries (type='UPDATE_EXPRESSION' vs parsing expression metadata)
- Matches pattern: dedicated nodes for dedicated semantics

### 3. Relationship to VariableReassignment (REG-290)

**Question:** Is `i++` just syntactic sugar for `i = i + 1`?

**Answer:** YES semantically, but NO in graph model.
- Different AST constructs = different nodes
- Both create READS_FROM + MODIFIES/FLOWS_INTO
- UpdateExpression is more specific (always read+write)
- Keep separate for query precision

### 4. Array/Object member updates

**Out of scope:** `arr[i]++`, `obj.prop++`

Current UpdateExpression visitor (line 3301) checks:
```typescript
if (updateNode.argument.type === 'Identifier')
```

This handles ONLY simple variables. Member expressions need separate handling.

**Decision:** Start with simple identifiers (matches REG-288 acceptance criteria).
Create follow-up issue for member expression updates.

## Implementation Plan

### Phase 1: Add UpdateExpressionInfo type
- Add to `types.ts`
- Add to ASTCollections
- Add to BuildResult

### Phase 2: Collect at module level
- Add traverse_updates profiler section
- Module-level UpdateExpression visitor
- Implement `collectUpdateExpression()` helper

### Phase 3: Collect at function level
- Update existing UpdateExpression visitor (line 3299)
- Replace scope.modifies tracking
- Reuse `collectUpdateExpression()` helper

### Phase 4: Create graph nodes and edges
- Implement `bufferUpdateExpressionEdges()` in GraphBuilder
- Follow VariableReassignment pattern
- Create UPDATE_EXPRESSION nodes, MODIFIES edges, READS_FROM self-loops

### Phase 5: Remove old mechanism
- Remove `modifies` from ScopeInfo
- Remove MODIFIES edge creation in bufferScopeEdges
- Update existing tests if any

### Phase 6: Tests
- Test simple cases: `i++`, `--count`
- Test prefix vs postfix
- Test in different scopes (module, function, nested)
- Verify READS_FROM + MODIFIES edges
- Verify CONTAINS edges to parent scope

## Success Criteria

1. **Graph nodes created:**
   ```javascript
   let count = 0;
   count++;
   ```
   Creates: UPDATE_EXPRESSION node with operator="++"

2. **Edges created:**
   - `UPDATE_EXPRESSION --MODIFIES--> count`
   - `count --READS_FROM--> count` (self-loop)
   - `SCOPE --CONTAINS--> UPDATE_EXPRESSION`

3. **Both prefix and postfix work:**
   - `i++` → prefix=false
   - `++i` → prefix=true

4. **Module and function level:**
   - Module-level: `count++` at top level
   - Function-level: `count++` inside function

5. **No regression:**
   - Existing tests pass
   - No broken MODIFIES edges for other operations

## Risk Assessment

**LOW RISK:**
- Additive change (new nodes, new edges)
- Clear pattern to follow (VariableReassignment)
- Small scope (UpdateExpression with Identifier only)

**MEDIUM RISK:**
- Breaking change to MODIFIES semantics
- Mitigation: document, update MCP tools

**Timeline:** 2-4 hours (straightforward implementation, mostly mechanical).

---

**Verdict:** This is the RIGHT way to track modifications. Current SCOPE-based approach is a hack. Let's fix the root cause.
