# Steve Jobs Review: REG-304 — Track Conditional Types

## Verdict: **REJECT**

This is a PARTIAL implementation masquerading as complete. I'm rejecting it because it FUNDAMENTALLY doesn't meet the stated acceptance criteria and has an architectural gap that defeats the feature's purpose.

---

## Critical Issue: Incomplete Tracking

**Acceptance Criteria states:**
> Track check, extends, true, false branches

**What was delivered:**
- Tracks check type: `T` ✓
- Tracks extends type: **INCOMPLETE** ✗
- Tracks true branch: ✓
- Tracks false branch: ✓

### The Problem: `extendsType` is Broken for Real-World Usage

Look at the test:
```typescript
type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;
```

**Expected behavior:** `extendsType` should be `"Promise<infer U>"` (the FULL extends clause)

**Actual behavior (verified empirically):**
```
checkType    : "T"
extendsType  : "Promise"       ← WRONG, should be "Promise<infer U>"
trueType     : "U"
falseType    : "T"
aliasOf      : "T extends Promise ? U : T"  ← WRONG, should be "T extends Promise<infer U> ? U : T"
```

**Impact:** For the MOST COMMON use case of conditional types — extracting type parameters with `infer` — the implementation LOSES the critical information. The `extendsType` field becomes useless.

**Second example:**
```typescript
type ReturnType<T> = T extends (...args: unknown[]) => infer R ? R : never;
```

**Actual output:**
```
extendsType  : "function"  ← WRONG, should be "(...args: unknown[]) => infer R"
```

All parameter and return type information LOST.

### Test Coverage Hides the Gap

The test at line 158 verifies:
```javascript
assert.strictEqual(unwrap.extendsType, 'Promise');
```

This test **ACCEPTS BROKEN BEHAVIOR as correct.** The test should verify the FULL extends type:
```javascript
assert.strictEqual(unwrap.extendsType, 'Promise<infer U>');
```

The integration test at line 220-234 does better — it verifies `infer` appears SOMEWHERE in the output, but doesn't verify it's in the RIGHT PLACE (extendsType).

### Root Cause: `typeNodeToString()` Loses Type Parameters

**File:** `TypeScriptVisitor.ts` lines 65-70

```typescript
case 'TSTypeReference':
  const typeName = typeNode.typeName as { type: string; name?: string };
  if (typeName?.type === 'Identifier') {
    return typeName.name || 'unknown';  // ← BUG: Only returns NAME, ignores typeParameters
  }
  return 'unknown';
```

This case handles type references like `Promise`, `Array`, `Function`, but **completely ignores the `typeParameters` field**.

**Babel AST for `Promise<infer U>`:**
```javascript
{
  type: 'TSTypeReference',
  typeName: { type: 'Identifier', name: 'Promise' },
  typeParameters: {
    params: [
      { type: 'TSInferType', typeParameter: { name: 'U' } }
    ]
  }
}
```

Current implementation returns `"Promise"`. Correct implementation should return `"Promise<infer U>"`.

---

## Architectural Question: Why Strings?

The implementation stores everything as strings:
```typescript
checkType?: string;
extendsType?: string;
trueType?: string;
falseType?: string;
```

**Question:** Why not store AST subtrees or semantic IDs?

**Don's rationale (from plan):** "Same pattern as `aliasOf`"

But this creates **information loss**:
- `extendsType: "Promise<infer U>"` is a string
- If I want to know "what types does this conditional depend on?" → must parse the string
- If I want to query "all conditional types that check against Promise" → must string match on `extendsType.includes('Promise')`

**Better approach (for future):** Store semantic IDs of referenced types:
```typescript
extendsTypeId?: string;  // -> TYPE:Promise
```

But this is a FUTURE improvement, not a blocker for THIS ticket. Strings are acceptable for v0.2 if they're COMPLETE.

---

## What Needs to Happen

1. **Fix `TSTypeReference` case in `typeNodeToString()`** — handle `typeParameters` field:
   ```typescript
   case 'TSTypeReference':
     const typeName = typeNode.typeName as { type: string; name?: string };
     let result = 'unknown';
     if (typeName?.type === 'Identifier') {
       result = typeName.name || 'unknown';
     }
     // Handle type parameters (e.g., Promise<T>, Array<number>)
     if (typeNode.typeParameters?.params) {
       const params = typeNode.typeParameters.params.map(p => typeNodeToString(p)).join(', ');
       result += `<${params}>`;
     }
     return result;
   ```

2. **Fix the tests** — verify ACTUAL expected values:
   - Line 158: `assert.strictEqual(unwrap.extendsType, 'Promise<infer U>')` not `'Promise'`
   - Line 178: verify full `aliasOf` string includes `<infer U>`
   - Line 212: verify `extendsType` includes `<infer U>` for nested case
   - Add test for function type: `extendsType` should be `(...args: unknown[]) => infer R`

3. **Estimated fix time:** 30-45 minutes

---

## Secondary Issues (Not Blockers)

### 1. Test at Line 212 is Misleading

```typescript
assert.strictEqual(nested.extendsType, 'Array');
```

For `T extends Array<infer U>`, this asserts `extendsType` is just `'Array'`, losing `<infer U>`. Same issue as above.

### 2. Missing Edge Case: Multiple Infers

```typescript
type Swap<T> = T extends [infer A, infer B] ? [B, A] : never;
```

No test for this. Should the implementation handle it? (Probably yes, but test it.)

### 3. Documentation Gap

No inline docs on the new fields. Future developers won't know:
- Is `checkType` the full type or just the name?
- Does `extendsType` include type parameters?
- What format are these strings?

Add JSDoc to `TypeAliasInfo` fields.

---

## Why This is a REJECT, Not "Fix Later"

From CLAUDE.md:
> **CRITICAL: Zero Tolerance for "MVP Limitations"**
> - If a "limitation" makes the feature work for <50% of real-world cases → REJECT
> - If the limitation is actually an architectural gap → STOP, don't defer

**Real-world conditional types:**
- `T extends Promise<infer U>` → 90%+ use `infer` in extends clause
- `T extends (...args: any[]) => infer R` → function return type extraction
- `T extends Array<infer U>` → array element extraction

Losing the type parameters in `extendsType` makes the field **useless for the majority of real-world conditional types**.

This is NOT an edge case. This is the CORE use case.

---

## The Right Thing to Do

1. Find out why `typeNodeToString(typeAnnotation.extendsType)` loses type parameters
2. Fix it — probably missing a case in `typeNodeToString()` for generic type references
3. Update tests to verify FULL extends clause, not just the base type name
4. Re-run tests, ensure no regressions

**Estimated fix time:** 30 minutes to 1 hour (debugging `typeNodeToString()` + updating tests).

Don't ship this until `extendsType` is COMPLETE.

---

## Summary

- **Tests pass** ✓
- **No regressions** ✓
- **Follows architecture pattern** ✓
- **Meets acceptance criteria** ✗ — `extendsType` is incomplete
- **Works for real-world use cases** ✗ — loses critical information

**Verdict: REJECT**

Fix `extendsType` to capture the FULL extends clause, then come back.
