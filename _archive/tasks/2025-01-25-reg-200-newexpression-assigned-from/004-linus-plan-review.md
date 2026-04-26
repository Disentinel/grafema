# Linus Torvalds: REG-200 Plan Review

## NEEDS REVISION

Don and Joel have done solid analysis work, but the plan has **architectural mistakes** that will create technical debt.

---

## Critical Issues

### 1. BUILTIN_JS is a Hack, Not a Solution

Joel's plan introduces `BUILTIN_JS:Date` singleton nodes. **This is adding complexity for zero value.**

**Why it's wrong:**

```
VARIABLE
    |
    | ASSIGNED_FROM
    v
CONSTRUCTOR_CALL (new Date())
    |
    | INVOKES  <--- THIS EDGE IS POINTLESS
    v
BUILTIN_JS:Date
```

What does `BUILTIN_JS:Date` give us? **Nothing**. It's not user code. We can't analyze it. The `className` field in CONSTRUCTOR_CALL already tells us it's Date. The `isBuiltin` flag already tells us it's built-in.

Compare to EXTERNAL_MODULE - we create singletons because multiple imports reference the same external package. But built-in constructors are **part of the language**, not dependencies.

**Verdict:** Remove BUILTIN_JS entirely. Just use `isBuiltin: boolean` on CONSTRUCTOR_CALL.

---

### 2. INVOKES Edge is Premature

Joel's plan includes `CONSTRUCTOR_CALL -> INVOKES -> CLASS`. Why? What query needs this?

**YAGNI violation.** Don't add edges until we know what questions they answer.

**Verdict:** Remove INVOKES from the plan. CONSTRUCTOR_CALL node is sufficient.

---

## What's Right About This Plan

- **Don's analysis is correct** - root cause properly identified
- **CONSTRUCTOR_CALL node is the right abstraction** - follows METHOD_CALL/CALL_SITE pattern
- **ASSIGNED_FROM edge model is correct** - data flow should point to the expression node

---

## Required Changes

### Change 1: Remove BUILTIN_JS Node Type

Delete all references to BUILTIN_JS. Just use `isBuiltin: boolean` field.

### Change 2: Remove INVOKES Edge

Only create **one edge**:

```
VARIABLE --ASSIGNED_FROM--> CONSTRUCTOR_CALL
```

### Change 3: Simplified ConstructorCallNode

```typescript
interface ConstructorCallNodeRecord extends BaseNodeRecord {
  type: 'CONSTRUCTOR_CALL';
  className: string;       // Date, Map, MyClass, etc.
  column: number;
  isBuiltin: boolean;      // true for Date, Map, etc.
  parentScopeId?: string;
}
```

---

## Summary

**What to fix:**
1. Remove BUILTIN_JS node type and all singleton logic
2. Remove INVOKES edge
3. Simplify to: CONSTRUCTOR_CALL nodes with isBuiltin field + ASSIGNED_FROM edges

**Why this matters:**
Every node, every edge should answer a question. BUILTIN_JS doesn't answer any question that CONSTRUCTOR_CALL.className doesn't already answer. Adding it is **complexity without value**.
