## Вадим auto — Completeness Review

**Verdict:** APPROVE

**Feature completeness:** OK
**Test coverage:** OK — with one noted gap that is within acceptable bounds
**Commit quality:** N/A — implementation in progress

---

### 1. All 10 locations fixed — verified

The grep of `initExpression.start`, `initNode.start`, and `.start ?? 0` in `JSASTAnalyzer.ts` confirms zero remaining instances used as a `column` value for EXPRESSION nodes. All 10 changed locations now call `getColumn(initExpression)` or `getColumn(initNode)`:

| # | Expression Type | Location (post-fix) |
|---|----------------|---------------------|
| 1 | MemberExpression (branch 7) | `const column = getColumn(initExpression)` ~L808 |
| 2 | BinaryExpression (branch 8) | `const column = getColumn(initExpression)` ~L830 |
| 3 | ConditionalExpression (branch 9) | `const column = getColumn(initExpression)` ~L850 |
| 4 | LogicalExpression (branch 10) | `const column = getColumn(initExpression)` ~L872 |
| 5 | TemplateLiteral (branch 11) | `const column = getColumn(initExpression)` ~L895 |
| 6 | UnaryExpression (branch 12) | `const column = getColumn(initExpression)` ~L924 |
| 7 | TaggedTemplateExpression fallback (branch 13) | `const column = getColumn(initExpression)` ~L965 |
| 8 | OptionalCallExpression (branch 15) | `const column = getColumn(initExpression)` ~L997 |
| 9 | OptionalMemberExpression (branch 16) | `const column = getColumn(initExpression)` ~L1025 |
| 10 | MemberExpression rest destructuring | `const column = getColumn(initNode)` ~L1519 |

### 2. Remaining `.start` uses — all out of scope

Two remaining uses of `initExpression.start` / `rightExpr.start` exist at lines 699 and 4428:

```ts
const literalId = `LITERAL#${line}:${initExpression.start}#${module.file}`;
```

These are LITERAL node ID strings, not `column` fields on any node. The `.start` byte offset here serves as a uniqueness discriminator within the ID, which is functionally correct — LITERAL nodes do not store a `column` field at all (confirmed: the `literals.push({...})` calls have no `column` key). This is out of scope for REG-548.

Dijkstra flagged this in the verification step (003-dijkstra-verification.md, Section 5, Gap 1) and assessed it as a separate concern that does not affect the current fix. The assessment is correct.

### 3. Test quality — 8 tests, exact assertions, good regression design

The test file `test/unit/ExpressionNodeColumn.test.js` covers:

- MemberExpression, BinaryExpression, LogicalExpression, ConditionalExpression, UnaryExpression, TemplateLiteral, OptionalMemberExpression — 7 specific expression types
- Column ID consistency test — verifies `node.column` matches the column embedded in `node.id`

**Assertion strength:** All 7 type-specific tests use `assert.strictEqual(node.column, EXPECTED_COLUMN)` where `EXPECTED_COLUMN = 10`. These are exact, not range-based. This satisfies Dijkstra's pre-condition that assertions must be exact.

**Regression design is sound:** The padding fixture pushes byte offsets to >200 bytes before the first expression. With the bug, column values would be >200; after the fix, they are exactly 10. There is no false-negative window.

**Gap noted:** There is no explicit test for TaggedTemplateExpression (branch 13 fallback, fix location 7) or OptionalCallExpression (branch 15, fix location 8). These two expression types from the fix do not appear as test cases. The 8 tests cover 7 of the 10 fixed patterns (MemberExpression appears twice — standard and optional). This gap is minor: the missing types are structurally identical to covered types and the shared ID/column consistency test provides a catch-all that would fail if any EXPRESSION node had a wrong column. Acceptable.

### 4. Scope — no creep

The changes are purely mechanical substitutions within `JSASTAnalyzer.ts`. No new abstractions, no changes to other files, no alterations to LITERAL handling, no gratuitous refactoring. The `getColumn` import was already present. Scope is clean.

### 5. Existing test suites — green

Rob confirmed: Expression.test.js (19/19) and VariableAssignmentCoverage.test.js (16/16) pass. These are the regression guards for the affected code paths. No regressions introduced.

---

### Summary

The implementation correctly fixes all 10 instances of the bug. The two remaining `.start` uses are LITERAL ID uniquifiers, not stored column fields, and are out of scope. Tests use exact assertions and a well-designed fixture. No scope creep. The implementation satisfies all three acceptance criteria from REG-548:

- All EXPRESSION nodes have `column = loc.start.column` (0-indexed) — YES
- Column values in expected range (0–300) — YES, enforced by exact test assertions at 10
- Unit test with known position and correct column — YES (8 tests, all exact)
