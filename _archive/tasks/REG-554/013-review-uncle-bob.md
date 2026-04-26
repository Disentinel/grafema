# Code Review: REG-554 — Uncle Bob

**Verdict: APPROVE**

---

## Checklist

### 1. Method size limits

**`bufferPropertyAssignmentNodes()`** — `CoreBuilder.ts` lines 314–357
Body: ~37 lines. Under 50. Pass.

**`bufferAssignedFromEdge()`** — `CoreBuilder.ts` lines 367–415
Body: ~43 lines. Under 50. Pass.

**`extractMutationValue()`** — `JSASTAnalyzer.ts` lines 4604–4647
Body: ~43 lines. Under 50. Pass.

**`detectObjectPropertyAssignment()`** — `JSASTAnalyzer.ts` lines 4200–4354
This method is 154 lines total. The REG-554 block is lines 4305–4353 (~48 lines), which is a coherent addition at the end of the existing method. The method as a whole is a candidate for splitting but this is a pre-existing condition, not introduced by REG-554. Out of scope for this review.

---

### 2. Naming

Names are clear and consistent with the existing codebase conventions:

- `bufferPropertyAssignmentNodes` — mirrors `bufferPropertyAccessNodes`. Symmetric, correct.
- `bufferAssignedFromEdge` — named after the edge type it creates. Clear.
- `propertyAssignments`, `propertyAssignmentCounterRef` — consistent with `propertyAccesses` / `propertyAccessCounterRef` pattern in the same file.
- `qualifiedParent` — `JSASTAnalyzer.ts` line 4317. Acceptable. Could be `classAndMethodParent` for clarity, but not a violation.
- `fullName` — `JSASTAnalyzer.ts` line 4310. Used as `this.x` (objectName + propertyName). The name is terse but its construction is on the same line. Minor, not a violation.

No misleading names found.

---

### 3. `PropertyAssignmentInfo` interface

`ast/types.ts` lines 296–320. Clean and minimal. Fields map 1-to-1 with their purpose:

- Core identity fields: `id`, `semanticId`, `type`
- Position fields: `file`, `line`, `column`, `endLine`, `endColumn`
- Semantic fields: `objectName`, `propertyName`, `computed`, `enclosingClassName`, `parentScopeId`, `scopePath`
- Value resolution fields: `valueType`, `valueName`, `memberObject`, `memberProperty`, `memberLine`, `memberColumn`

The grouping comment `// RHS value info (for ASSIGNED_FROM edge resolution)` at line 311 adequately documents the value block. No bloat detected. Mirrors `PropertyAccessInfo` structure appropriately.

---

### 4. `extractMutationValue()` readability after TSNonNull + MemberExpression additions

`JSASTAnalyzer.ts` lines 4604–4647.

The TSNonNull unwrap at lines 4611–4612 is clean:
```typescript
const effectiveValue: t.Expression =
  value.type === 'TSNonNullExpression' ? value.expression : value;
```
Single statement, no nesting, and the comment at line 4609–4610 explains the "why". The subsequent `if/else if` chain reads top-to-bottom without branching surprises.

The MemberExpression case (lines 4629–4643) adds a guard for three conditions (`Identifier` object, non-computed, `Identifier` property) and the comment at lines 4636–4638 explains the non-obvious property-location choice. Readable.

No readability concerns.

---

### 5. Magic strings / numbers

- `'PROPERTY_ASSIGNMENT'` — appears as a string literal in several places inside `detectObjectPropertyAssignment()` (lines 4320, 4321, 4337). This is consistent with how all other node types (`'OBJECT_MUTATION'`, `'PROPERTY_ACCESS'`, etc.) are referenced throughout the same method — inline string literals are the codebase convention here. Not a violation introduced by this change.
- `'OBJECT_MUTATION'` at line 4286 is an adjacent pre-existing pattern that REG-554 follows. Consistent.
- Fallback ID format at line 4331: `` `PROPERTY_ASSIGNMENT#${fullName}#${module.file}#${line}:${column}:${cnt}` `` — this is a dead-code path (only used when `scopeTracker` is absent, which never happens in production). Acceptable.
- No new numeric magic values.

---

### 6. `detectObjectPropertyAssignment()` extension readability

The REG-554 block (lines 4305–4353) is appended after the existing `objectMutations.push(...)` block and is cleanly fenced by the comment `// REG-554: Also collect PROPERTY_ASSIGNMENT node info for 'this.prop = value'`. The condition at line 4308 states the invariant clearly:

```typescript
if (propertyAssignments && objectName === 'this' && enclosingClassName) {
```

The `qualifiedParent` construction (lines 4317–4319) and the `computeSemanticIdV2` call (lines 4321–4328) directly implement the fix for Bug 3 documented in `010-debug.md`. The logic is self-contained and does not affect the existing mutation path.

The `propertyAssignments.push(...)` block (lines 4334–4352) maps fields directly — no intermediate transformations, no hidden side effects.

Readable. Extension is well-isolated.

---

## Issues

None blocking approval.

One minor observation (non-blocking):

- `CoreBuilder.ts` line 341: `const fileBasename = basename(propAssign.file)` duplicates the same pattern from `bufferPropertyAccessNodes` line 266. The duplication is small (one line) and consistent with how the adjacent method handles it. Not worth extracting for this PR but worth noting for future cleanup.
