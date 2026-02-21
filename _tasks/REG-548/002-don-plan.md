# REG-548: Don Melton — Tech Lead Plan

**Date:** 2026-02-21
**Status:** Planning complete

---

## 1. Root Cause (Confirmed)

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

The `trackVariableAssignment` method (and a related section for function-body destructuring) uses `initExpression.start` — which is an absolute byte offset from the beginning of the file — instead of `initExpression.loc?.start?.column` as column when building EXPRESSION node metadata. The `getColumn()` utility is imported and available in the file but is not used here.

### Exact lines:

| Line | Expression type | Buggy code |
|------|----------------|------------|
| 808 | MemberExpression | `const column = initExpression.start ?? 0;` |
| 830 | BinaryExpression | `const column = initExpression.start ?? 0;` |
| 850 | ConditionalExpression | `const column = initExpression.start ?? 0;` |
| 872 | LogicalExpression | `const column = initExpression.start ?? 0;` |
| 895 | TemplateLiteral | `const column = initExpression.start ?? 0;` |
| 924 | UnaryExpression | `const column = initExpression.start ?? 0;` |
| 965 | TaggedTemplateExpression (fallback) | `const column = initExpression.start ?? 0;` |
| 997 | OptionalCallExpression | `const column = initExpression.start ?? 0;` |
| 1025 | OptionalMemberExpression | `const column = initExpression.start ?? 0;` |
| 1519 | MemberExpression (rest destructuring in function body) | `const column = initNode.start ?? 0;` |

Each of these constructs an `expressionId` via `ExpressionNode.generateId(...)` and then pushes a `variableAssignments` entry with `column: column`. That column value flows downstream through `AssignmentBuilder.bufferAssignmentEdges` into `NodeFactory.createExpressionFromMetadata`, where it becomes the `column` field stored on the EXPRESSION node.

### Why this produces values like 3000, 6585, 6608

In Babel/OXC ASTs, `node.start` is the byte offset from byte 0 of the source file — it grows monotonically across the entire file. For code on line 86, the offset could be thousands of bytes. `node.loc.start.column` is the 0-based column within that specific line, which is always a small number (typically 0–120 for normal code).

### The correct helper

`getColumn` is already imported at line 53:
```ts
import { getLine, getColumn, getEndLocation } from './ast/utils/location.js';
```

`getColumn(node)` returns `node?.loc?.start?.column ?? 0` — exactly what is needed.

---

## 2. Fix

Replace every `initExpression.start ?? 0` (and `initNode.start ?? 0`) used as `column` in `trackVariableAssignment` and the function-body destructuring section with `getColumn(initExpression)` / `getColumn(initNode)`.

**Specific changes** (all in `JSASTAnalyzer.ts`):

- Line 808: `const column = initExpression.start ?? 0;` → `const column = getColumn(initExpression);`
- Line 830: same pattern for BinaryExpression
- Line 850: same pattern for ConditionalExpression
- Line 872: same pattern for LogicalExpression
- Line 895: same pattern for TemplateLiteral
- Line 924: same pattern for UnaryExpression
- Line 965: same pattern for TaggedTemplateExpression fallback
- Line 997: same pattern for OptionalCallExpression
- Line 1025: same pattern for OptionalMemberExpression
- Line 1519: `const column = initNode.start ?? 0;` → `const column = getColumn(initNode);`

**No other files need to change.** The `getColumn` import is already present. The downstream flow (AssignmentBuilder → NodeFactory → ExpressionNode.createFromMetadata) receives and uses `column` correctly; the bug is 100% in the source extraction.

---

## 3. Test Approach

**Test file to create:** `test/unit/ExpressionNodeColumn.test.js`

This is a new unit test that directly verifies the column value on EXPRESSION nodes produced from known source code positions.

### What the test should verify

Write source code with EXPRESSION assignments at a known, predictable column position. Then assert that the EXPRESSION nodes in the graph have a `column` value in the correct small range (not a large byte offset).

**Example fixture:**

```js
// Column 10 from line start: 0123456789A (0-indexed)
const x = obj.prop;     // 'obj.prop' starts at column 10
const y = a + b;        // 'a + b' starts at column 10
const z = a && b;       // 'a && b' starts at column 10
const t = c ? d : e;    // 'c ? d : e' starts at column 10
```

**Assertions:**

1. EXPRESSION node for `MemberExpression` has `column < 200` (not a byte offset like 3000+)
2. EXPRESSION node for `BinaryExpression` has `column < 200`
3. EXPRESSION node for `LogicalExpression` has `column < 200`
4. EXPRESSION node for `ConditionalExpression` has `column < 200`
5. Optionally: assert exact column value (e.g., `column === 10`) when the position is precisely known

**Pattern to follow:** The existing test infrastructure is well established in `test/unit/Expression.test.js`. Use `createTestDatabase`, `analyzeProject`, and `backend.queryNodes({ type: 'EXPRESSION' })` — same as that file.

---

## 4. Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Replace `initExpression.start ?? 0` and `initNode.start ?? 0` with `getColumn(initExpression)` / `getColumn(initNode)` at 10 locations |
| `test/unit/ExpressionNodeColumn.test.js` | **New file** — unit test verifying correct column values on EXPRESSION nodes |

No changes required to:
- `ExpressionNode.ts` — takes `column` as a parameter, not responsible for extraction
- `CoreFactory.ts` / `NodeFactory.ts` — clean pass-through
- `AssignmentBuilder.ts` — correctly reads `column` from upstream metadata
- `MutationBuilder.ts` — uses `column` from `variableReassignments`, not `node.start`
- `VariableVisitor.ts` — already uses `varInfo.loc.start.column` correctly

---

## 5. Verification Plan

1. `pnpm build` — TypeScript compile must succeed with no errors
2. `node --test test/unit/ExpressionNodeColumn.test.js` — new test must pass
3. `node --test test/unit/Expression.test.js` — existing tests must remain green
4. `node --test test/unit/VariableAssignmentCoverage.test.js` — related tests must remain green
5. `node --test --test-concurrency=1 'test/unit/*.test.js'` — full suite must pass

---

## 6. Risk Assessment

**Risk: Low**

- The fix is a pure substitution of `node.start` (wrong) with `getColumn(node)` (correct) — exactly what `getColumn` was designed for
- `getColumn` is already imported and used correctly in 10+ other places in the same file
- No logic change, only the source of the column value changes
- The ID format for EXPRESSION nodes (`{file}:EXPRESSION:{type}:{line}:{column}`) will change for affected nodes — this is expected and correct behavior; any cached/stored graph data will need re-analysis, which is normal for a bug fix

**Note on ID stability:** Because `column` is part of the EXPRESSION node ID, fixing the column value will produce different IDs for EXPRESSION nodes created from the `trackVariableAssignment` path. This is correct — the old IDs were wrong (encoding a file offset). The new IDs will correctly encode the line-relative column. This is not a concern for production correctness; it just means old graphs need re-analysis after the fix.
