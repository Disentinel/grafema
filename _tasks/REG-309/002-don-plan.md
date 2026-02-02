# Don Melton - High-Level Plan for REG-309

## Task: Scope-aware variable lookup for mutations

**Date**: 2026-02-01
**Author**: Don Melton (Tech Lead)

---

## Executive Summary

REG-309 exposes a **fundamental architecture gap** in our mutation tracking system. We track variable mutations (reassignments, array mutations, object mutations), but we use **file-level variable lookup** instead of **scope-aware lookup**. This means shadowed variables in nested scopes incorrectly resolve to outer scope variables.

**Critical finding**: This is NOT a feature request. It's a **correctness bug** that undermines the integrity of data flow analysis in any codebase with nested scopes.

---

## Current State Analysis

### 1. The Bug

```javascript
let x = 1;
function foo() {
  let x = 2;
  x += 3;  // Currently creates edge to outer x (WRONG)
}
```

**What happens**:
- `detectVariableReassignment()` captures `variableName: "x"`
- `bufferVariableReassignmentEdges()` builds lookup: `varLookup.set("file.js:x", outerX)`
- **BUG**: Lookup key is `file:name`, not `file:scope:name`
- Inner `x` resolves to outer `x`
- FLOWS_INTO edge goes to wrong variable node

### 2. Where This Happens

**All three mutation handlers use the same broken pattern**:

| Handler | File-Level Lookup | Bug Line |
|---------|-------------------|----------|
| `bufferVariableReassignmentEdges()` | `varLookup.set(\`${v.file}:${v.name}\`)` | GraphBuilder.ts:1763 |
| `bufferArrayMutationEdges()` | `varLookup.set(\`${v.file}:${v.name}\`)` | GraphBuilder.ts:1595 |
| `bufferObjectMutationEdges()` | `variableDeclarations.find(v => v.name === objectName && v.file === file)` | GraphBuilder.ts:1708 |

**All three are broken** for shadowed variables.

### 3. What We Have Available

**Analysis phase (JSASTAnalyzer)**:
- `ScopeTracker` maintains current scope path during traversal
- Can generate semantic IDs with full scope: `file->scope1->scope2->TYPE->name`
- Has access to `scopeTracker.getContext()` → `{ file, scopePath: ['func', 'if#0'] }`

**Enrichment phase (GraphBuilder)**:
- Only receives collected info (no AST, no scope tracker)
- Variable nodes have `semanticId` with scope path embedded
- Can parse semantic IDs back: `parseSemanticId()` → `{ file, scopePath, type, name }`

**Current mutation info**:
```typescript
interface VariableReassignmentInfo {
  variableName: string;           // Name only, no scope
  variableLine: number;           // Line where mutation happens
  file: string;
  // ... value metadata
}
```

**Current variable nodes**:
```typescript
interface VariableDeclarationInfo {
  id: string;                     // Could be semantic ID
  semanticId?: string;            // Stable ID: file->scope->VARIABLE->name
  name: string;
  file: string;
  parentScopeId?: string;         // Runtime scope ID (unstable)
  // ...
}
```

---

## Architectural Decision: Where to Resolve Scope?

### Option A: Analysis-Time Resolution (Early Binding)

**When**: JSASTAnalyzer detects mutation, resolve variable immediately using ScopeTracker.

**How**:
```typescript
// In detectVariableReassignment():
const variableName = leftId.name;
const scopePath = scopeTracker.getContext().scopePath;
const semanticId = computeSemanticId('VARIABLE', variableName, scopeTracker.getContext());

variableReassignments.push({
  variableName,
  targetSemanticId: semanticId,  // NEW: resolved at analysis time
  // ...
});
```

**GraphBuilder**:
```typescript
// Simple lookup by semantic ID
const targetVar = variableDeclarations.find(v => v.semanticId === reassignment.targetSemanticId);
```

**Pros**:
- ✅ Scope is known with certainty at analysis time
- ✅ GraphBuilder logic is simple
- ✅ Semantic IDs are stable across edits

**Cons**:
- ❌ Assumes variable is declared in SAME scope as mutation
- ❌ Breaks for variables declared in parent scope:
  ```javascript
  let total = 0;
  for (item of items) {
    total += item.price;  // total is in PARENT scope (file-level)
  }
  ```
- ❌ JavaScript variables are visible in child scopes (lexical scoping)

### Option B: Enrichment-Time Resolution (Late Binding)

**When**: GraphBuilder receives mutation info with scope path, resolves variable by walking scope chain.

**How**:
```typescript
// In detectVariableReassignment():
const variableName = leftId.name;
const scopePath = scopeTracker.getContext().scopePath;  // ['processData', 'for#0']

variableReassignments.push({
  variableName,
  mutationScopePath: scopePath,  // NEW: where mutation happens
  // ...
});
```

**GraphBuilder**:
```typescript
// Walk scope chain to find variable
function resolveVariableInScope(
  name: string,
  scopePath: string[],
  variables: VariableDeclarationInfo[]
): VariableDeclarationInfo | null {
  // Try current scope, then parent, then grandparent, etc.
  for (let i = scopePath.length; i >= 0; i--) {
    const searchScope = scopePath.slice(0, i);
    const matchingVar = variables.find(v => {
      if (v.name !== name || v.file !== file) return false;
      const varScope = parseSemanticId(v.semanticId)?.scopePath ?? [];
      return arraysEqual(varScope, searchScope);
    });
    if (matchingVar) return matchingVar;
  }
  return null;  // Global/module-level variable
}
```

**Pros**:
- ✅ Correct JavaScript semantics (lexical scoping)
- ✅ Finds variables in parent scopes
- ✅ Handles shadowing correctly (inner scope wins)

**Cons**:
- ❌ More complex GraphBuilder logic
- ❌ Requires semantic IDs on ALL variable nodes

### Option C: Store Mutation Line, Resolve by Line Range

**When**: GraphBuilder uses line numbers to determine which variable declaration is in scope.

**Rationale**: Variable scope in JavaScript is determined by lexical position. If mutation happens at line 15, and there are two declarations of `x` (line 5 and line 12), the one at line 12 is in scope if it's in a nested block.

**Problems**:
- ❌ Line numbers are NOT stable across edits
- ❌ Breaks for function-level scope (variable declared after mutation in source order)
- ❌ Doesn't align with our semantic ID vision

---

## Recommended Approach

**Option B: Late Binding with Scope Chain Resolution**

### Why This Is Right

1. **Correct semantics**: JavaScript uses lexical scoping. Variables are visible in child scopes. This is not negotiable.

2. **Matches variable lookup behavior at runtime**:
   ```javascript
   let x = 1;
   function foo() {
     let x = 2;
     x += 3;  // Looks up x in: foo scope → file scope → global
   }
   ```
   Our lookup should mirror this.

3. **Stable across edits**: Semantic IDs don't change when you add/remove lines elsewhere.

4. **Consistent with existing architecture**: We already use semantic IDs for stable node identification.

### Implementation Strategy

**Phase 1: Capture Scope Path at Analysis Time**

Add scope path to mutation info types:

```typescript
// types.ts - extend existing types
export interface VariableReassignmentInfo {
  variableName: string;
  variableLine: number;
  mutationScopePath?: string[];  // NEW: scope where mutation happens
  // ... existing fields
}

export interface ArrayMutationInfo {
  arrayName: string;
  arrayLine?: number;
  mutationScopePath?: string[];  // NEW
  // ... existing fields
}

export interface ObjectMutationInfo {
  objectName: string;
  objectLine?: number;
  mutationScopePath?: string[];  // NEW
  // ... existing fields
}
```

**Phase 2: Update Analysis Handlers**

All detection methods already have access to `scopeTracker`:

```typescript
// JSASTAnalyzer.ts
private detectVariableReassignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  variableReassignments: VariableReassignmentInfo[],
  scopeTracker: ScopeTracker  // NEW parameter
): void {
  const variableName = leftId.name;
  const scopePath = scopeTracker.getContext().scopePath;

  variableReassignments.push({
    variableName,
    mutationScopePath: scopePath,  // NEW
    // ... existing fields
  });
}
```

**Wait, does detectVariableReassignment have scopeTracker?**

Looking at the code:
```typescript
// Line 1390 (module-level)
this.detectVariableReassignment(assignNode, module, variableReassignments);

// Line 2748 (function body)
this.detectVariableReassignment(assignNode, module, variableReassignments);
```

**NO, it doesn't receive scopeTracker!** This is a problem.

But `detectObjectPropertyAssignment` does:
```typescript
// Line 1398, 2768
this.detectObjectPropertyAssignment(assignNode, module, objectMutations, scopeTracker);
```

**Action**: Add `scopeTracker` parameter to all mutation detection methods.

**Phase 3: Implement Scope Chain Resolver in GraphBuilder**

```typescript
// GraphBuilder.ts
/**
 * Resolve variable by name using scope chain lookup.
 * Mirrors JavaScript lexical scoping: search current scope, then parent, etc.
 *
 * @param name - Variable name
 * @param scopePath - Scope path where reference occurs (from ScopeTracker)
 * @param file - File path
 * @param variables - All variable declarations
 * @returns Variable declaration or null if not found
 */
private resolveVariableInScope(
  name: string,
  scopePath: string[],
  file: string,
  variables: VariableDeclarationInfo[]
): VariableDeclarationInfo | null {
  // Try current scope, then parent, then grandparent, etc.
  for (let i = scopePath.length; i >= 0; i--) {
    const searchScopePath = scopePath.slice(0, i);

    const matchingVar = variables.find(v => {
      if (v.name !== name || v.file !== file) return false;

      // If variable has semantic ID, parse it to get scope
      if (v.semanticId) {
        const parsed = parseSemanticId(v.semanticId);
        if (!parsed) return false;
        return this.scopePathsMatch(parsed.scopePath, searchScopePath);
      }

      // Fallback: no semantic ID means file-level variable
      return searchScopePath.length === 0;
    });

    if (matchingVar) return matchingVar;
  }

  return null;
}

/**
 * Check if two scope paths match.
 * Handles: ['foo', 'if#0'] vs ['foo', 'if#0']
 */
private scopePathsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, idx) => item === b[idx]);
}
```

**Phase 4: Update Mutation Edge Handlers**

Replace file-level lookup with scope-aware lookup:

```typescript
// Before (BROKEN):
const varLookup = new Map<string, VariableDeclarationInfo>();
for (const v of variableDeclarations) {
  varLookup.set(`${v.file}:${v.name}`, v);
}
const targetVar = varLookup.get(`${file}:${variableName}`);

// After (CORRECT):
const targetVar = this.resolveVariableInScope(
  reassignment.variableName,
  reassignment.mutationScopePath ?? [],
  reassignment.file,
  variableDeclarations
);
```

Apply to:
- `bufferVariableReassignmentEdges()`
- `bufferArrayMutationEdges()`
- `bufferObjectMutationEdges()`

---

## Scope Definition

### In Scope

1. **Add scope path to mutation info** (all three types):
   - VariableReassignmentInfo
   - ArrayMutationInfo
   - ObjectMutationInfo

2. **Update analysis handlers** to capture scope:
   - `detectVariableReassignment()` - add scopeTracker param
   - Array mutation detection - add scopeTracker param
   - `detectObjectPropertyAssignment()` - already has it, use it

3. **Implement scope chain resolver** in GraphBuilder:
   - `resolveVariableInScope()` - walks scope chain
   - `scopePathsMatch()` - helper for array comparison

4. **Update all three mutation edge handlers**:
   - `bufferVariableReassignmentEdges()`
   - `bufferArrayMutationEdges()`
   - `bufferObjectMutationEdges()`

5. **Tests for shadowing scenarios**:
   - Variable reassignment in nested scope
   - Array mutation in nested scope
   - Object mutation in nested scope

### Out of Scope

1. **Parameter lookup** (defer to future work):
   - Parameters are special: they're in function scope but declared at function level
   - Current code does handle parameters separately (paramLookup)
   - Can be addressed in follow-up if needed

2. **Global variables** (defer):
   - Variables declared with `var` at top level
   - Implicit globals (assignment without declaration)
   - Complex scope rules, defer to later

3. **Cross-file variable resolution** (defer):
   - Imported variables
   - Requires cross-file scope analysis
   - Out of scope for this task

---

## Data Structure Changes

### Extend Mutation Info Types (types.ts)

```typescript
export interface VariableReassignmentInfo {
  variableName: string;
  variableLine: number;
  mutationScopePath?: string[];  // NEW: ['processData', 'for#0']
  // ... existing fields
}

export interface ArrayMutationInfo {
  arrayName: string;
  arrayLine?: number;
  mutationScopePath?: string[];  // NEW
  // ... existing fields
}

export interface ObjectMutationInfo {
  objectName: string;
  objectLine?: number;
  mutationScopePath?: string[];  // NEW
  // ... existing fields
}
```

### No Changes to Variable Nodes

Variable nodes already have `semanticId` with scope embedded. No changes needed.

---

## Testing Strategy

### Test Cases (Kent Beck will expand)

1. **Basic shadowing**:
   ```javascript
   let x = 1;
   function foo() {
     let x = 2;
     x += 3;  // FLOWS_INTO → inner x (not outer x)
   }
   ```

2. **Parent scope lookup**:
   ```javascript
   let total = 0;
   for (const item of items) {
     total += item.price;  // FLOWS_INTO → outer total
   }
   ```

3. **Array mutation in nested scope**:
   ```javascript
   let arr = [];
   function foo() {
     let arr = [];
     arr.push(1);  // FLOWS_INTO → inner arr
   }
   ```

4. **Object mutation with shadowing**:
   ```javascript
   let obj = {};
   if (condition) {
     let obj = {};
     obj.prop = 1;  // FLOWS_INTO → inner obj
   }
   ```

5. **Multiple levels of nesting**:
   ```javascript
   let x = 1;
   function outer() {
     let x = 2;
     function inner() {
       let x = 3;
       x += 4;  // FLOWS_INTO → innermost x
     }
   }
   ```

---

## Risk Assessment

### High Risk

- **Semantic ID availability**: Are ALL variable nodes guaranteed to have semantic IDs?
  - If some variables don't have semantic IDs, fallback logic needed
  - Need to verify in codebase

- **Scope path consistency**: Do mutation scope paths match variable declaration scope paths?
  - ScopeTracker generates: `['MyClass', 'myMethod', 'if#0']`
  - Variable semantic ID has: `file->MyClass->myMethod->if#0->VARIABLE->x`
  - Must ensure they match

### Medium Risk

- **Performance**: Scope chain lookup is O(n*m) where n = mutations, m = variables
  - Mitigated by: most codebases have shallow nesting (2-3 levels)
  - Can optimize with scope-indexed cache if needed

### Low Risk

- **Backward compatibility**: Mutation info types are internal, not public API
- **Edge duplication**: No risk, we're fixing existing logic, not adding new edges

### Mitigation

- **Verify semantic ID coverage**: Check if all variables have semantic IDs (or add fallback)
- **Test with real codebases**: Run on grafema-worker-6 itself
- **Performance profiling**: Measure before/after on large files

---

## Open Questions for Joel

1. **Semantic ID coverage**: Are we confident ALL variable declarations have `semanticId` populated?
   - If not, what's the fallback strategy?
   - Should we add semantic ID generation to all variable declarations?

2. **Module-level variables**: How are file-level variables represented in scope path?
   - Is scope path empty `[]` or `['global']`?
   - Need consistency check

3. **Array mutation detection**: Does it currently receive scopeTracker?
   - Code review needed to find where array mutations are detected
   - May need to update call sites

4. **Performance optimization**: Should we build scope-indexed cache?
   - `Map<file:scope:name, VariableDeclarationInfo>`
   - Only if profiling shows performance issue

5. **Parameters vs variables**: Should parameters use same resolution logic?
   - Parameters are in function scope but declared at function level
   - Current code has separate `paramLookup` - is this correct?

---

## Alignment with Vision

**"AI should query the graph, not read code."**

**Before this fix**:
```
Agent: "Show me data flow into x in function foo."
Graph: [outer x] --FLOWS_INTO--> [inner x]
Agent: "But there are two x variables!"
User: "The graph is wrong. Shadowing bug."
```

**After this fix**:
```
Agent: "Show me data flow into x in function foo."
Graph: [literal(3)] --FLOWS_INTO--> [foo.x]
Agent: "And what flows into outer x?"
Graph: [literal(1)] --ASSIGNED_FROM--> [file.x]
Agent: "Perfect, two separate variables."
```

**This is CRITICAL for correctness**. Without scope-aware lookup, the graph lies about data flow in any codebase with nested scopes. That's most real-world code.

---

## Conclusion

REG-309 is a **correctness bug**, not a feature request. File-level variable lookup is wrong for JavaScript lexical scoping. This undermines trust in the graph for any code with shadowed variables.

**Recommended path**:
1. Add scope path to mutation info (all three types)
2. Update analysis handlers to capture scope (add scopeTracker parameter)
3. Implement scope chain resolver in GraphBuilder
4. Update all three mutation edge handlers to use scope-aware lookup
5. Test with shadowing scenarios

This aligns with our vision: the graph must be **correct**, not just working. If you can't trust the graph, you can't use it.

**Critical blocker**: Verify that all variable nodes have semantic IDs. If not, this needs semantic ID generation first.

**Next step**: Joel expands this into detailed technical plan with file-by-file changes, call site updates, and semantic ID verification.

---

**Don Melton**
Tech Lead, Grafema
