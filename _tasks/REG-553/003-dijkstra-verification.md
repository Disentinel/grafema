# Dijkstra Plan Verification — REG-553

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-22
**Verifying:** Don's plan (002-don-plan.md)

---

## Verdict: REJECT

The plan contains a **false premise** that is central to the entire implementation. The fix as written produces `TypeScript compile errors` and would output `"… || …"` for ALL inputs, including `const x = a || b` where both operands are Identifiers. The acceptance criteria cannot be met with the proposed code.

---

## Finding 1: `leftSourceName` and `rightSourceName` do not exist in `ExpressionNodeOptions`

### The false premise

Don's plan (line 62) states:

> "The data IS available: `operator`, `leftSourceName`, `rightSourceName` are passed to `_computeName` via `ExpressionNodeOptions`. The method just doesn't use them for `LogicalExpression`."

This is **false**. The actual `ExpressionNodeOptions` interface (verified in source):

```typescript
// packages/core/src/core/nodes/ExpressionNode.ts, lines 31–44
interface ExpressionNodeOptions {
  // MemberExpression
  object?: string;
  property?: string;
  computed?: boolean;
  computedPropertyVar?: string;
  // Binary/Logical
  operator?: string;        // ← exists
  // Tracking
  path?: string;
  baseName?: string;
  propertyPath?: string[];
  arrayIndex?: number;
}
// leftSourceName: ABSENT
// rightSourceName: ABSENT
```

Neither `leftSourceName` nor `rightSourceName` are in `ExpressionNodeOptions`. Don's proposed code:

```typescript
case 'LogicalExpression': {
  const left = options.leftSourceName ?? '…';   // TypeScript error: Property does not exist
  const right = options.rightSourceName ?? '…'; // TypeScript error: Property does not exist
  ...
}
```

This will not compile. `pnpm build` will fail at step 3 of the plan.

### The same gap exists in `ExpressionOptions` in `CoreFactory.ts`

```typescript
// packages/core/src/core/factories/CoreFactory.ts, lines 217–230
interface ExpressionOptions {
  object?: string;
  property?: string;
  computed?: boolean;
  computedPropertyVar?: string;
  operator?: string;
  path?: string;
  baseName?: string;
  propertyPath?: string[];
  arrayIndex?: number;
}
// leftSourceName: ABSENT
// rightSourceName: ABSENT
```

This is the interface passed to `createExpressionFromMetadata`.

---

## Finding 2: AssignmentBuilder silently drops `leftSourceName` and `rightSourceName`

Even if `ExpressionNodeOptions` were fixed, the data would still not reach `_computeName`. Tracing the pipeline:

**Step 1.** `JSASTAnalyzer` populates `VariableAssignmentInfo` correctly (lines 882–883):
```typescript
leftSourceName: initExpression.left.type === 'Identifier' ? initExpression.left.name : null,
rightSourceName: initExpression.right.type === 'Identifier' ? initExpression.right.name : null,
```

**Step 2.** `AssignmentBuilder.bufferAssignmentEdges` destructures them (lines 199–200):
```typescript
leftSourceName,
rightSourceName,
```

**Step 3.** `AssignmentBuilder` calls `NodeFactory.createExpressionFromMetadata` but passes only:
```typescript
{
  id: sourceId,
  object,
  property,
  computed,
  computedPropertyVar: computedPropertyVar ?? undefined,
  operator,       // ← passed
  path,
  baseName,
  propertyPath,
  arrayIndex
  // leftSourceName: NOT PASSED
  // rightSourceName: NOT PASSED
}
```

`leftSourceName` and `rightSourceName` are used only for DERIVES_FROM edge creation (lines 303–328 of AssignmentBuilder). They are never forwarded to the node creation call. The data is available in the builder but is not threaded through to `_computeName`.

---

## Completeness Table: Input Universe for `_computeName` with LogicalExpression (as proposed)

The proposed code:
```typescript
const left = options.leftSourceName ?? '…';
const right = options.rightSourceName ?? '…';
const op = options.operator ?? '||';
const raw = `${left} ${op} ${right}`;
return raw.length > 64 ? raw.slice(0, 61) + '…' : raw;
```

Since `leftSourceName` and `rightSourceName` are absent from `ExpressionNodeOptions`, `options.leftSourceName` is always `undefined` and `options.rightSourceName` is always `undefined` at runtime (TypeScript would reject it at compile time, but at JS runtime these would be `undefined`). Every row collapses to the same case:

| leftSourceName in options | rightSourceName in options | operator | Expected output | Actual output (proposed fix) | Correct? |
|---|---|---|---|---|---|
| `"a"` (via JSASTAnalyzer) | `"b"` (via JSASTAnalyzer) | `"||"` | `"a \|\| b"` | `"… \|\| …"` | NO |
| `"a"` | `null` | `"??"` | `"a ?? …"` | `"… ?? …"` | NO |
| `null` | `"b"` | `"&&"` | `"… && b"` | `"… && …"` | NO |
| `null` | `null` | `"||"` | `"… \|\| …"` | `"… \|\| …"` | YES (accident) |
| `undefined` | `undefined` | `undefined` | `"… \|\| …"` | `"… \|\| …"` | depends on spec |

The only case that produces the correct output by accident is when both operands are non-Identifiers. For the canonical case `const x = a || b` where `a` and `b` are identifiers, the proposed fix still produces `"… || …"`, not `"a || b"`.

---

## Finding 3: The `operator` field IS correctly threaded through

Unlike `leftSourceName`/`rightSourceName`, `operator` IS already in `ExpressionNodeOptions` and IS passed from AssignmentBuilder. So `options.operator` will correctly be `"||"`, `"&&"`, or `"??"` in `_computeName`. The `?? '||'` fallback for operator is therefore overly defensive but not harmful.

---

## Finding 4: Truncation logic is correct

The '…' character is U+2026 HORIZONTAL ELLIPSIS, a single Unicode code point. JavaScript `string.length` counts UTF-16 code units. U+2026 is in the BMP (Basic Multilingual Plane), so it counts as 1. The arithmetic is correct:

- `raw.length > 64`: checks if total exceeds 64 chars
- `raw.slice(0, 61) + '…'`: 61 chars + 1 char = 62 total. This is within 64. (There is actually slack — the result would be ≤ 62 chars even though 64 was the stated limit. This is acceptable but slightly inconsistent with "truncated at 64 chars" claim.)

This is **not a blocking issue** but worth noting.

---

## Finding 5: Existing tests do NOT assert on `name` for LogicalExpression

Verified by reading `test/unit/Expression.test.js`. The two existing `LogicalExpression` describe blocks (lines 327–382 and 449–548) assert only:
- `expressionNode.operator === '||'` or `'&&'`
- `expressionNode.expressionType === 'LogicalExpression'`
- Edge counts and targets

No assertion checks `expressionNode.name`. The name change from `'<LogicalExpression>'` to whatever the new implementation produces will not break existing tests. Don is correct on this point.

---

## Finding 6: Don's note on `createFromMetadata` vs `create` paths is misleading

Don writes (section 4.6):
> "The fix in `_computeName` covers both code paths."

This is technically true — `_computeName` is called from both `create` and `createFromMetadata`. But it obscures the real problem: neither path receives `leftSourceName` or `rightSourceName` because `ExpressionNodeOptions` does not define them. The real fix requires changes to THREE locations, not one:

1. `ExpressionNodeOptions` interface — add `leftSourceName` and `rightSourceName` fields
2. `ExpressionOptions` in `CoreFactory.ts` — same addition
3. `AssignmentBuilder.bufferAssignmentEdges` — pass the fields when calling `createExpressionFromMetadata`
4. `_computeName` in `ExpressionNode.ts` — the one change Don identified

The plan says "1 file needs changes." The correct answer is 3–4 files.

---

## Precondition Issues

| Precondition | Status |
|---|---|
| `leftSourceName` reaches `_computeName` via `ExpressionNodeOptions` | FALSE — field does not exist in the interface |
| `rightSourceName` reaches `_computeName` via `ExpressionNodeOptions` | FALSE — field does not exist in the interface |
| AssignmentBuilder passes `leftSourceName` to `createExpressionFromMetadata` | FALSE — explicitly excluded from the options object |
| The fix compiles with TypeScript strict mode | FALSE — accessing non-existent properties is a compile error |
| Fix is limited to 1 file | FALSE — minimum 3 files required |

---

## Summary of Required Changes (Corrected Plan)

### File 1: `packages/core/src/core/nodes/ExpressionNode.ts`

Add `leftSourceName` and `rightSourceName` to `ExpressionNodeOptions`:

```typescript
interface ExpressionNodeOptions {
  // MemberExpression
  object?: string;
  property?: string;
  computed?: boolean;
  computedPropertyVar?: string;
  // Binary/Logical
  operator?: string;
  leftSourceName?: string | null;   // ADD
  rightSourceName?: string | null;  // ADD
  // Tracking
  path?: string;
  baseName?: string;
  propertyPath?: string[];
  arrayIndex?: number;
}
```

Then implement `_computeName` as Don proposed (now it will compile and have real data).

### File 2: `packages/core/src/core/factories/CoreFactory.ts`

Add the same fields to `ExpressionOptions` (lines 217–230):

```typescript
interface ExpressionOptions {
  object?: string;
  property?: string;
  computed?: boolean;
  computedPropertyVar?: string;
  operator?: string;
  leftSourceName?: string | null;   // ADD
  rightSourceName?: string | null;  // ADD
  path?: string;
  baseName?: string;
  propertyPath?: string[];
  arrayIndex?: number;
}
```

### File 3: `packages/core/src/plugins/analysis/ast/builders/AssignmentBuilder.ts`

Pass the fields into `createExpressionFromMetadata` (lines 219–231):

```typescript
const expressionNode = NodeFactory.createExpressionFromMetadata(
  expressionType || 'Unknown',
  exprFile || '',
  exprLine || 0,
  exprColumn || 0,
  {
    id: sourceId,
    object,
    property,
    computed,
    computedPropertyVar: computedPropertyVar ?? undefined,
    operator,
    leftSourceName: leftSourceName ?? undefined,   // ADD
    rightSourceName: rightSourceName ?? undefined, // ADD
    path,
    baseName,
    propertyPath,
    arrayIndex
  }
);
```

### File 4: `test/unit/Expression.test.js`

As described in Don's plan — the test additions are correct in structure. They will now actually pass once the above three production-code fixes are in place.

---

## I don't THINK the plan handles all cases — I have PROVED it does not.

The fix as specified in Don's plan will compile with TypeScript errors and, if run as JavaScript, will produce `"… || …"` for all LogicalExpression nodes regardless of operand types. The core claim — "the data IS available via ExpressionNodeOptions" — is demonstrably false. The scope of the fix is underestimated by a factor of 3–4 files.

**Required action:** Return to Don for plan revision. The revised plan must include interface additions to `ExpressionNodeOptions` and `ExpressionOptions`, and the `AssignmentBuilder` must be updated to thread the fields through. Only then can Rob implement with confidence.
