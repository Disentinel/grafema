# Demo Report: REG-107 ArgumentExpressionNode Factory Migration

**Date:** 2025-01-22
**Reporter:** Steve Jobs (Product Design / Demo)
**Status:** ❌ FAILED - Build Broken

---

## Summary

**The build is broken. Cannot demo.**

TypeScript compilation fails with type errors in CallExpressionVisitor.ts. The migration introduced a fundamental type system mismatch between NodeFactory records and the Info interfaces they're being cast to.

---

## Build Output

```
packages/core build: src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts(341,71): error TS2345: Argument of type 'ObjectLiteralNodeRecord' is not assignable to parameter of type 'ObjectLiteralInfo'.
packages/core build:   Types of property 'line' are incompatible.
packages/core build:     Type 'number | undefined' is not assignable to type 'number'.
packages/core build:       Type 'undefined' is not assignable to type 'number'.

packages/core build: src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts(394,69): error TS2345: Argument of type 'ArrayLiteralNodeRecord' is not assignable to parameter of type 'ArrayLiteralInfo'.
packages/core build:   Types of property 'line' are incompatible.
packages/core build:     Type 'number | undefined' is not assignable to type 'number'.
packages/core build:       Type 'undefined' is not assignable to type 'number'.
```

---

## Root Cause

The NodeFactory records (ObjectLiteralNodeRecord, ArrayLiteralNodeRecord) extend BaseNodeRecord which has optional fields:

```typescript
interface BaseNodeRecord {
  line?: number;  // OPTIONAL
  column?: number;
  // ...
}
```

But the Info interfaces require these fields:

```typescript
interface ObjectLiteralInfo {
  line: number;  // REQUIRED
  column: number;
  // ...
}
```

The factories guarantee these fields are set at runtime:

```typescript
ObjectLiteralNode.create(file, line, column, options) {
  // line is required, throws if undefined
  return { line, column: column || 0, ... };
}
```

But TypeScript doesn't know this. The type system sees `ObjectLiteralNodeRecord` with `line?: number` and refuses to cast it to `ObjectLiteralInfo` with `line: number`.

---

## The Hack That Failed

CallExpressionVisitor tries to force it with `as unknown as`:

```typescript
const objectNode = ObjectLiteralNode.create(...);
// Factory guarantees line is set, cast to ObjectLiteralInfo
(this.collections.objectLiterals as ObjectLiteralInfo[]).push(
  objectNode as unknown as ObjectLiteralInfo  // ❌ Still fails
);
```

Even with `as unknown as`, TypeScript still sees the incompatible types in the push() call.

---

## Why This is a Product Failure

**User experience is everything.** Right now, the user experience is:

1. ❌ Build doesn't compile
2. ❌ Tests can't run
3. ❌ Demo can't run
4. ❌ Product doesn't work

This isn't a demo problem. This is a **fundamental architecture problem**.

---

## What Should Have Happened

Before marking ANY task complete, the implementer should have verified:

1. ✅ Build compiles without errors
2. ✅ Tests pass
3. ✅ Basic smoke test works

None of these were checked. The code was committed in a broken state.

---

## The Real Issue

This violates the **Small Commits** principle from CLAUDE.md:

> - Each commit must be atomic and working
> - Tests must pass after each commit

This commit is neither atomic nor working.

---

## Recommendation

**STOP. DO NOT PROCEED.**

This is not a "fix a type" issue. This is an architectural mismatch:

1. BaseNodeRecord has optional fields because some nodes genuinely don't have locations
2. Info interfaces require these fields because the database schema requires them
3. Factory guarantees they're set, but type system doesn't reflect this

**Options:**

A. **Create separate "Located" types**: ObjectLiteralNodeRecord should extend a LocatedNodeRecord that makes line/column required

B. **Make factories return narrower types**: ObjectLiteralNode.create() should return a type where line/column are known to be set

C. **Validation layer**: Add runtime validation that converts NodeRecord → Info with proper type guards

This needs **architectural decision**, not a quick fix.

---

## Product Question

**Would I show this on stage?**

No. It doesn't compile. It doesn't run. It doesn't work.

**What needs to happen before this is demo-ready?**

1. Fix the type system architecture
2. Verify build compiles
3. Verify tests pass
4. Then we can talk about demoing

---

## Next Steps

1. **STOP implementation**
2. **Don Melton** needs to analyze the type system architecture
3. **Decide**: How do we bridge NodeRecords (optional fields) → Info interfaces (required fields)?
4. **Implement** the architectural fix
5. **Then** demo

---

## Bottom Line

**This doesn't work. Fix it before we talk about features.**

The vision is beautiful. The execution is broken.

