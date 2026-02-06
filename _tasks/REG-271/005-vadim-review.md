# Vadim Reshetnikov (High-level Review) - REG-271

## Task: Track Class Static Blocks and Private Fields

**Date:** 2026-02-05
**Default Stance:** REJECT
**Reviewed Plans:** 001-user-request.md, 002-don-plan.md, 003-joel-tech-plan.md

---

## Review Summary

The plan is **architecturally sound** and follows Grafema's principles. The implementation reuses existing infrastructure correctly and avoids O(n) scans. However, I've identified **one critical technical issue** that must be addressed before implementation.

---

## Technical Deep Dive

### 1. Semantic ID Format for Private Fields

**Assessment: CORRECT**

The plan correctly handles the `PrivateName` AST node semantics:
- Babel stores `#privateField` as `PrivateName { id: Identifier { name: "privateField" } }` - without the `#` prefix
- Plan correctly prepends `#` for display/storage: `displayName = '#' + privateName.id.name`

The semantic ID will be generated via `computeSemanticId('VARIABLE', '#privateField', scopeTracker.getContext())`, which follows the existing pattern and correctly includes the class scope in the path (e.g., `file.js->Foo->#privateField`).

### 2. HAS_PROPERTY Edge for Class Properties

**Assessment: CORRECT with minor clarification needed**

Current usage of `HAS_PROPERTY`:
- `OBJECT_LITERAL -> property value` (existing)

Proposed usage:
- `CLASS -> VARIABLE (private field)` (new)

This is semantically correct and does NOT conflict:
- Both represent "parent container has property"
- The edge connects different SOURCE node types (OBJECT_LITERAL vs CLASS)
- No ambiguity in edge semantics

The plan correctly notes this in risk assessment and proposes `HAS_FIELD` as fallback if issues arise. **Current choice is acceptable.**

### 3. SCOPE Node for Static Blocks

**Assessment: CORRECT abstraction**

Static blocks ARE scopes:
- They have their own block-scoped variables
- They can contain nested control flow (if, for, try)
- They execute once when class loads

Using `SCOPE` with `scopeType: 'static_block'` is the right choice over alternatives like:
- New `STATIC_BLOCK` node type (unnecessary complexity)
- `FUNCTION` node (incorrect - static blocks are not callable)

### 4. Edge Cases Analysis

**4.1 Computed Private Fields `#[expr]`**
- **NOT VALID JavaScript syntax** - private fields cannot have computed names
- No handling needed. Plan correctly notes this.

**4.2 Private Field in Member Expressions `obj.#field`**
- This is a **runtime access** to a private field, NOT a declaration
- The declaration (`#field = 1;`) creates the VARIABLE node
- Member expression access (`this.#field`) should be handled by existing `MemberExpression` visitor
- **Not in scope for REG-271** (field declaration, not field access)

**4.3 Private Field with Decorator**
- Plan handles this correctly - extracts decorators for private properties
- Note: TC39 decorators on private fields are Stage 3, but Babel supports them

---

## CRITICAL ISSUE: `analyzeFunctionBody` Type Mismatch

**Status: MUST FIX before implementation**

### The Problem

The `AnalyzeFunctionBodyCallback` type signature is:
```typescript
type AnalyzeFunctionBodyCallback = (
  path: NodePath<Function>,  // <-- Expects Function node
  scopeId: string,
  module: VisitorModule,
  collections: VisitorCollections
) => void;
```

But `StaticBlock` is NOT a `Function` type. Its AST structure is:
```typescript
interface StaticBlock extends Node {
  type: "StaticBlock";
  body: Statement[];  // Array of statements, like BlockStatement
}
```

The plan (Joel's tech spec, section 3.3) says:
```typescript
// Analyze static block body using existing infrastructure
analyzeFunctionBody(staticBlockPath, staticBlockScopeId, module, collections);
```

This will **fail TypeScript compilation** because `NodePath<StaticBlock>` is not assignable to `NodePath<Function>`.

### Solution Options

**Option A: Widen the callback type (RECOMMENDED)**
```typescript
// In FunctionVisitor.ts
export type AnalyzeBodyCallback = (
  path: NodePath<Function | StaticBlock>,  // Widen to include StaticBlock
  scopeId: string,
  module: VisitorModule,
  collections: VisitorCollections
) => void;
```

Pros: Simple, reuses existing infrastructure
Cons: Slightly changes public API (but backward compatible)

**Option B: Create separate `analyzeBlockBody` callback**
```typescript
export type AnalyzeBlockBodyCallback = (
  path: NodePath<StaticBlock | BlockStatement>,
  scopeId: string,
  module: VisitorModule,
  collections: VisitorCollections
) => void;
```

Pros: Clean separation of concerns
Cons: More code, potential duplication

**Option C: Type assertion (NOT RECOMMENDED)**
```typescript
analyzeFunctionBody(staticBlockPath as any, ...);
```

Pros: Quick fix
Cons: Hides type errors, violates TypeScript discipline

### Recommendation

Use **Option A**. The existing `analyzeFunctionBody` implementation likely just traverses the body statements - `StaticBlock.body` is `Statement[]`, same as `FunctionBody.body`. The implementation should work with minimal changes, just the type signature needs updating.

---

## Architecture Check

| Check | Status | Notes |
|-------|--------|-------|
| No O(n) over all nodes | PASS | Only processes class members during class traversal |
| Forward registration | PASS | Analyzer marks data (isPrivate, isStatic), no backward scanning |
| Reuses existing infrastructure | PASS | Uses SCOPE, VARIABLE, FUNCTION nodes; HAS_PROPERTY, CONTAINS edges |
| Plugin-based, modular | PASS | All changes confined to ClassVisitor + GraphBuilder |
| Extensibility | PASS | No enricher changes needed for new framework support |

---

## Complexity Assessment

Joel's Big-O analysis is correct:
- **Analysis phase:** O(c * m) where c = classes, m = avg members per class
- **GraphBuilder phase:** O(c * m) for edge creation
- **NOT O(n) over all nodes** - correctly scoped to class members

This is acceptable and matches existing patterns.

---

## Vision Alignment

**Does this align with "AI should query the graph, not read code"?**

YES. After implementation:
- AI can query: "What private fields does class X have?"
- AI can query: "Does class X have static initialization logic?"
- AI can query: "What side effects occur when class X loads?" (via static block contents)

Without this feature, AI must read the source code to answer these questions.

---

## Minor Suggestions (Non-blocking)

1. **Test: Private accessor pair with same name**
   ```javascript
   class Foo {
     get #value() { return this._v; }
     set #value(v) { this._v = v; }
   }
   ```
   Should create TWO FUNCTION nodes, both with `name: '#value'` but different `methodKind`. Plan mentions this in test cases (5.4) but verify semantic IDs are unique (they will be, due to method kind being part of the function body).

2. **Documentation:** After implementation, update `_readme/` or project docs to explain:
   - How to query private class members via Datalog
   - What `isPrivate: true` means for encapsulation analysis

3. **Consider future extension:** Private fields can be accessed via `WeakMap` pattern in transpiled code. Document that Grafema tracks *native* private fields, not the WeakMap pattern (out of scope for REG-271).

---

## Verdict

### CONDITIONALLY APPROVED

**Condition:** Fix the `AnalyzeFunctionBodyCallback` type mismatch before implementation begins.

The plan is architecturally sound, follows existing patterns, and correctly uses Grafema's infrastructure. The complexity estimate (2-3 days) is realistic. The test matrix is comprehensive.

Once the callback type is widened to accept `StaticBlock`, proceed with implementation.

---

**Reviewed by:** Vadim Reshetnikov (High-level Reviewer)
**Date:** 2026-02-05
**Status:** **CONDITIONALLY APPROVED** (pending callback type fix)
