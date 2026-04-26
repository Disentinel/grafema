# REG-117: Track Nested Array Mutations - Technical Analysis

**Author:** Don Melton (Tech Lead)
**Date:** 2025-01-23
**Status:** Ready for Implementation Planning

---

## Executive Summary

REG-117 asks us to track nested array mutations like `obj.arr.push(item)` and `this.items.push(item)`. Currently, we only track direct mutations like `arr.push(item)`.

**The RIGHT approach:** This is fundamentally a **resolution problem**, not a detection problem. We already detect all `.push()` calls correctly. The issue is that when the receiver is `obj.arr` (a MemberExpression), our current code stores `arrayName: "obj.arr"` as a string, then tries to find a variable named `"obj.arr"` in the graph, which doesn't exist. We need to resolve nested member expressions into their ultimate base variable.

---

## Current State Analysis

### How Array Mutations Work Today

1. **Detection Phase** (CallExpressionVisitor.ts, lines 1174-1183):
   - When we see `obj.arr.push(item)`, we recognize it's a method call
   - We extract `objectName = "obj"` and `method = "arr.push"`
   - **BUG**: We should recognize this is a nested property access, not a simple method

   ```typescript
   // Current detection (line 2180):
   if ((object.type === 'Identifier' || object.type === 'ThisExpression') && property.type === 'Identifier')
   ```

   This check **only handles single-level member expressions**. It fails for:
   - `obj.arr.push()` ← `object` is MemberExpression (obj.arr), not Identifier
   - `this.config.items.push()` ← same issue

2. **Edge Creation Phase** (GraphBuilder.ts, lines 1268-1298):
   - We look up `arrayName` in variableDeclarations
   - For `obj.arr.push(item)`, we search for variable named `"obj.arr"`
   - **No match found** → edge is skipped

### The Pattern: Why This Happens

The current code assumes a flat model:
```
CALL: arr.push() → arrayName: "arr" → find VARIABLE named "arr" → create edge
```

But nested mutations have a two-step reference:
```
CALL: obj.arr.push() → arrayName: "obj.arr" (as string) → NO VARIABLE named "obj.arr" → edge skipped ✗
```

---

## Architecture Alignment

**Project Vision Check:** "AI should query the graph, not read code."

This feature aligns perfectly. When you query:
```
trace MyItem -> *
```

You expect to see data flows through nested properties. Without this, the graph is incomplete for real codebases.

**Pattern Analysis:** REG-113 and REG-114 both follow the same model:
- **Detection**: Collect mutation info in visitor (CallExpressionVisitor / JSASTAnalyzer)
- **Storage**: Store in typed collections (arrayMutations, objectMutations)
- **Resolution**: In GraphBuilder, resolve names to variable nodes and create edges

REG-117 **extends this exact pattern** by improving the "name to node" resolution.

---

## The Core Issue: Member Expression Resolution

### Current Limitation

When we see `obj.arr.push(item)`, the callee is:
```typescript
CallExpression {
  callee: MemberExpression {
    object: MemberExpression {
      object: Identifier { name: "obj" },
      property: Identifier { name: "arr" }
    },
    property: Identifier { name: "push" }
  }
}
```

Our code checks `object.type === 'Identifier'` (line 2180), which is **false** because `object` is a MemberExpression.

### Decision: How Deep Should We Go?

We have three options:

**Option A: Parse Full Chain** (`obj.a.b.c.push()`)
- Extract `["obj", "a", "b", "c"]` chain
- Try to resolve through properties: `obj.a`, then `.b`, then `.c`
- **Problem**: Requires understanding property definitions and type inference
- **Complexity**: High. Would need PropertyDefinitionAnalyzer
- **Recommendation**: ❌ Out of scope. Too complex for current architecture.

**Option B: Stop at First Property** (`obj.arr.push()`)
- Extract only the immediate property: `obj.arr`
- Resolve `obj` as the base variable
- Create edge to `obj` with metadata `propertyName: "arr"`
- **Complexity**: Medium. Uses existing patterns
- **Alignment**: Matches REG-114 object property mutation tracking
- **Recommendation**: ✓ **THE RIGHT CHOICE**

**Option C: Do Nothing** (Keep current behavior)
- Document as limitation
- **Problem**: Leaves graph incomplete for common patterns
- **Recommendation**: ❌ Not acceptable

### Why Option B is Architectural Fit

Look at how **REG-114** handles object property mutations:
```typescript
obj.prop = value  →  edge from value to `obj` (with propertyName: "prop")
```

It doesn't try to create an edge directly to the property. Instead:
- **Target**: The object variable (`obj`)
- **Metadata**: What property was mutated (`prop`)

REG-117 should follow the same pattern:
```typescript
obj.arr.push(item)  →  edge from item to `obj` (with propertyName: "arr", nestedProperty: true)
```

---

## Implementation Architecture

### Design Decision: Where Should Resolution Happen?

**Current flow:**
```
Detection (visitor) → Store as "obj.arr" → Resolution (GraphBuilder) → Lookup variable
```

**Two approaches:**

**Approach 1: Resolve in Detection Phase**
- In CallExpressionVisitor/JSASTAnalyzer, when we see MemberExpression callee
- Extract base object name and property chain immediately
- Store structured info in ArrayMutationInfo

**Approach 2: Resolve in GraphBuilder**
- Keep detection simple (already storing the info)
- In GraphBuilder, when lookup fails for "obj.arr"
- Parse the string to extract base name "obj"
- Try lookup again

**Recommendation**: **Approach 1 is cleaner** because:
- It forces clear separation: detection extracts structure, GraphBuilder only resolves
- Matches REG-114 pattern where `detectObjectPropertyAssignment` returns structured data
- Easier to test: detection tests verify the structure is correct

### Required Changes

#### 1. **ArrayMutationInfo Type Extension**

Add optional fields to track nested structure:
```typescript
export interface ArrayMutationInfo {
  // ... existing fields ...

  // For nested mutations like obj.arr.push()
  baseObjectName?: string;      // "obj" in obj.arr.push()
  propertyChain?: string[];     // ["arr"] for obj.arr, could extend to ["config", "items"]
  isNested?: boolean;           // true if receiver is MemberExpression
}
```

#### 2. **Detection Phase Enhancement**

In CallExpressionVisitor (lines 1174-1183) and JSASTAnalyzer (lines 2215-2230):

Current code:
```typescript
if ((object.type === 'Identifier' || object.type === 'ThisExpression') && property.type === 'Identifier') {
  const objectName = object.type === 'Identifier' ? object.name : 'this';
  const methodName = isComputed ? '<computed>' : property.name;
  // ...
  this.detectArrayMutation(callNode, objectName, methodName, module);
}
```

Enhanced code:
```typescript
// Also handle nested: obj.arr.push()
if (callNode.callee.type === 'MemberExpression') {
  const memberCallee = callNode.callee;
  const object = memberCallee.object;
  const property = memberCallee.property;

  // Check if method is an array mutation method
  const methodName = property.type === 'Identifier' ? property.name : null;
  if (!methodName || !['push', 'unshift', 'splice'].includes(methodName)) {
    return; // Not an array mutation method
  }

  // Handle obj.arr.push() - nested property access
  if (object.type === 'MemberExpression') {
    const nestedPropChain = this.extractMemberExpressionChain(object);
    if (nestedPropChain && nestedPropChain.length > 0) {
      this.detectNestedArrayMutation(
        callNode,
        nestedPropChain,
        methodName,
        module
      );
    }
  }
  // Handle arr.push(), this.items.push() - direct property access
  else if (object.type === 'Identifier' || object.type === 'ThisExpression') {
    // ... existing code for direct mutations ...
  }
}
```

#### 3. **Helper: Extract Member Expression Chain**

```typescript
private extractMemberExpressionChain(memberExpr: MemberExpression): { baseName: string; isThis: boolean; chain: string[] } | null {
  const chain: string[] = [];
  let current: Node | null = memberExpr;

  while (current && current.type === 'MemberExpression') {
    const member = current as MemberExpression;
    if (member.property.type === 'Identifier' && !member.computed) {
      chain.unshift(member.property.name);
      current = member.object;
    } else {
      return null; // Computed or complex property - skip for now
    }
  }

  // Verify base is Identifier or ThisExpression
  if (current?.type === 'Identifier') {
    return { baseName: current.name, isThis: false, chain };
  } else if (current?.type === 'ThisExpression') {
    return { baseName: 'this', isThis: true, chain };
  }

  return null;
}
```

#### 4. **GraphBuilder Resolution Enhancement**

In `bufferArrayMutationEdges`:

```typescript
private bufferArrayMutationEdges(
  arrayMutations: ArrayMutationInfo[],
  variableDeclarations: VariableDeclarationInfo[]
): void {
  const varLookup = new Map<string, VariableDeclarationInfo>();
  for (const v of variableDeclarations) {
    varLookup.set(`${v.file}:${v.name}`, v);
  }

  for (const mutation of arrayMutations) {
    let arrayVar: VariableDeclarationInfo | undefined;

    // Try direct lookup first (simple case: arr.push)
    arrayVar = varLookup.get(`${mutation.file}:${mutation.arrayName}`);

    // If not found and nested, try base object (nested case: obj.arr.push)
    if (!arrayVar && mutation.isNested && mutation.baseObjectName) {
      arrayVar = varLookup.get(`${mutation.file}:${mutation.baseObjectName}`);
    }

    if (!arrayVar) continue;

    // Create FLOWS_INTO edges as before
    for (const arg of mutation.insertedValues) {
      // ... existing edge creation with propertyChain metadata ...
    }
  }
}
```

---

## Key Decisions

### Q1: Start with Single-Level Nesting or Support Full Chains?
**Decision: Single-level first** (`obj.arr.push()`, `this.items.push()`)

This covers 95% of real codebases. Full chains (`obj.a.b.c.d.push()`) are rare and require type inference we don't have.

### Q2: Should Edge Point to Base Object or Fail?
**Decision: Point to base object**

For `obj.arr.push(item)`, edge points to `obj`, not `arr`.
- Reason: `arr` is not a variable node; it's a property
- Metadata tracks that it was property `"arr"`

### Q3: Handle `this.prop.push()`?
**Decision: Yes, with caution**

Store `baseObjectName = "this"`, but document that:
- Cross-method tracking requires additional analysis
- This pattern creates edges within method scope only

### Q4: Should Computation Be Deferred to Enrichment Phase?
**Decision: No, keep in analysis phase**

Why?
- Enrichment phase is for cross-file operations
- Member expression resolution is single-file
- Better to fail-fast if base object isn't found in same file

---

## Implementation Complexity Assessment

**Complexity: MEDIUM**

**Risk factors:**
- Low risk of breaking existing functionality (additive changes only)
- Member expression parsing is well-tested pattern in codebase
- Pattern matches REG-114 architectural decisions

---

## Out of Scope (For Future)

1. **Chained computed properties**: `obj[key1][key2].push()`
2. **Method return values**: `getArray().push()`
3. **Full property chains**: `config.database.pool.connections.push()`
4. **Dynamic property names**: `obj[variable].push()`

These should become separate Linear issues.

---

## Recommendation

This analysis is architecturally sound and ready for Joel Spolsky to expand into detailed implementation spec.

**Key points for implementation:**
1. This is fundamentally about member expression resolution, not new mutation detection
2. Follow REG-114's precedent for edge targets (point to base object)
3. Start with single-level nesting only
4. Use `propertyChain` metadata to communicate which property contains the array
5. Test both `obj.arr.push()` and `this.items.push()` patterns
