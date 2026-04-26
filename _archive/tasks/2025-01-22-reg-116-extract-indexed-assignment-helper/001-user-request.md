# User Request: REG-116

## Linear Issue

**REG-116: Tech Debt: Extract indexed assignment detection helper in JSASTAnalyzer**

## Problem

The indexed assignment detection logic is duplicated in `JSASTAnalyzer.ts`:

* Lines 910-952: Module-level `AssignmentExpression` handler
* Lines 1280-1332: Inside `analyzeFunctionBody`

Both blocks contain nearly identical ~40 lines of code. This violates DRY and creates maintenance burden.

## Solution

Extract to helper method:

```typescript
private detectIndexedArrayAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  arrayMutations: ArrayMutationInfo[]
): void { ... }
```

Then call from both locations.

## Additional minor items

* Rename `arguments` property in `ArrayMutationInfo` to `insertedValues` (shadows built-in)
* Add explicit `void` return type to `detectArrayMutation` in CallExpressionVisitor
* Add defensive `loc` checks with fallback values instead of non-null assertions

## Source

From REG-113 implementation review (Kevlin Henney)
