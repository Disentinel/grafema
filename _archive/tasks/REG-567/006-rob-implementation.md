# Rob Pike - Implementation Report (REG-567)

## Change

**File:** `packages/core/src/core/ASTWorker.ts`
**Line:** 351

### Before
```typescript
const shouldBeConstant = isConst && (isLiteral || isNewExpr);
```

### After
```typescript
const shouldBeConstant = isConst && isLiteral;
```

## Verification

- `isNewExpr` variable declaration remains on line 350: `const isNewExpr = decl.init?.type === 'NewExpression';`
- `isNewExpr` is still used on line 367 to guard the `classInstantiations.push()` block.
- No other lines were modified.

## Rationale

`new SomeClass()` is not a compile-time constant. Marking `const x = new Foo()` as a CONSTANT node was incorrect -- it should be classified as VARIABLE. The `isNewExpr` flag correctly remains in use for tracking class instantiations, which is a separate concern from constant classification.
