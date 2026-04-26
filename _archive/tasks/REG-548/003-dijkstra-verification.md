## Dijkstra Plan Verification

**Date:** 2026-02-21
**Verifier:** Edsger Dijkstra (Plan Verifier)
**Plan under review:** 002-don-plan.md (Don Melton)

---

**Verdict:** APPROVE with one noted gap (out-of-scope but must be flagged)

---

## 1. Bug Existence — Verified

The 10 buggy lines exist exactly as Don describes. Direct grep confirms:

| Line | Expression type | Code |
|------|----------------|------|
| 808 | MemberExpression | `const column = initExpression.start ?? 0;` |
| 830 | BinaryExpression | `const column = initExpression.start ?? 0;` |
| 850 | ConditionalExpression | `const column = initExpression.start ?? 0;` |
| 872 | LogicalExpression | `const column = initExpression.start ?? 0;` |
| 895 | TemplateLiteral | `const column = initExpression.start ?? 0;` |
| 924 | UnaryExpression | `const column = initExpression.start ?? 0;` |
| 965 | TaggedTemplateExpression (fallback) | `const column = initExpression.start ?? 0;` |
| 997 | OptionalCallExpression | `const column = initExpression.start ?? 0;` |
| 1025 | OptionalMemberExpression | `const column = initExpression.start ?? 0;` |
| 1519 | MemberExpression (rest destructuring) | `const column = initNode.start ?? 0;` |

The `getColumn` import is confirmed present at line 53:
```ts
import { getLine, getColumn, getEndLocation } from './ast/utils/location.js';
```

`getColumn(node)` returns `node?.loc?.start?.column ?? 0` — confirmed in
`packages/core/src/plugins/analysis/ast/utils/location.ts:87`.

---

## 2. Completeness Table — All Branches of `trackVariableAssignment`

Every branch of the method was enumerated from the source:

| Branch # | Expression type | Uses `.start` as column? | In Don's fix list? |
|----------|----------------|--------------------------|-------------------|
| 0 | AwaitExpression | No — recurses | N/A (recurses) |
| 0.1 | TSAsExpression / TSSatisfiesExpression / TSNonNullExpression / TSTypeAssertion | No — recurses | N/A (recurses) |
| 0.5 | ObjectExpression | No — uses `loc?.start.column` (line 641) | N/A (correct) |
| 0.6 | ArrayExpression | No — uses `loc?.start.column` (line 676) | N/A (correct) |
| 1 | Literal | **Yes — uses `.start` in ID** (line 699) | **Not in list (see Gap section)** |
| 2 | CallExpression (Identifier callee) | No — uses `getColumn()` (line 725) | N/A (correct) |
| 3 | CallExpression (MemberExpression callee) | No — uses `getColumn()` (line 737) | N/A (correct) |
| 4 | Identifier | No — no column field needed | N/A |
| 5 | NewExpression | No — uses `loc?.start.column` (line 771) | N/A (correct) |
| 6 | ArrowFunctionExpression / FunctionExpression | No — no column field | N/A |
| 7 | MemberExpression | **BUGGY** (line 808) | YES |
| 8 | BinaryExpression | **BUGGY** (line 830) | YES |
| 9 | ConditionalExpression | **BUGGY** (line 850) | YES |
| 10 | LogicalExpression | **BUGGY** (line 872) | YES |
| 11 | TemplateLiteral | **BUGGY** (line 895) | YES |
| 12 | UnaryExpression | **BUGGY** (line 924) | YES |
| 13 | TaggedTemplateExpression (Identifier tag) | No — uses `getColumn()` (lines 951–952) | N/A (correct) |
| 13 | TaggedTemplateExpression (MemberExpression tag) | No — uses `getColumn()` (lines 958–959) | N/A (correct) |
| 13 | TaggedTemplateExpression (fallback) | **BUGGY** (line 965) | YES |
| 14 | ClassExpression | No — no column field | N/A |
| 15 | OptionalCallExpression | **BUGGY** (line 997) | YES |
| 16 | OptionalMemberExpression | **BUGGY** (line 1025) | YES |
| 17 | SequenceExpression | No — recurses into last expr | N/A (recurses) |
| 18 | YieldExpression | No — recurses into argument | N/A (recurses) |
| 19 | AssignmentExpression | No — recurses into right side | N/A (recurses) |
| Fallback | Unknown type | No — console.warn, no edge | N/A |

**Conclusion:** Don's list of 9 locations in `trackVariableAssignment` is complete. No EXPRESSION-generating branch within `trackVariableAssignment` was missed.

---

## 3. Completeness Table — `trackDestructuringAssignment` (line 1519)

The function-body destructuring section has one additional buggy location at line 1519, correctly identified by Don. Enumeration:

| Phase | initNode type | Uses `.start` as column? | In Don's fix list? |
|-------|--------------|--------------------------|-------------------|
| Phase 1 — CallExpression init | Various | No — delegates to `varInfo.loc.start.column` (lines 1335, 1367, 1434, 1473) | N/A |
| Phase 3 — MemberExpression init, `isRest` path | MemberExpression | **BUGGY** (line 1519) | YES |
| Phase 3 — MemberExpression init, ObjectPattern path | MemberExpression | No — uses `varInfo.loc.start.column` (line 1537) | N/A |
| Phase 3 — MemberExpression init, ArrayPattern path | MemberExpression | No — uses `varInfo.loc.start.column` (line 1555) | N/A |
| Phase 4 — NewExpression init | NewExpression | No — uses `initNode.loc?.start.column` (line 1587) | N/A |

**Conclusion:** The one buggy location in `trackDestructuringAssignment` (line 1519) is correctly identified.

---

## 4. Other Files — Scan for Same Bug Pattern

All analysis plugin `.ts` files were scanned for `node.start ?? 0` or similar patterns used as a column value. Findings:

- **`FunctionVisitor.ts` lines 243, 334:** Use `.start ?? undefined` to pass `start` (byte offset) to function node metadata. This is intentional — the `start` field on function nodes is the byte offset used for hash calculation and incremental analysis, not a column. **Not a column bug.**
- **`CallExpressionVisitor.ts` lines 382, 404, 519:** Use `${callNode.start}:${callNode.end}` as a deduplication key (not a column value). **Not a column bug.**
- **`NewExpressionHandler.ts` line 24:** Same deduplication key pattern. **Not a column bug.**
- **`JSASTAnalyzer.ts` lines 2066, 2132, 3396, 3438, 3560:** All use `.start` and `.end` together as deduplication keys. **Not a column bug.**
- **`BranchHandler.ts` line 55:** Uses `.start!` and `.end!` for `code.substring(...)` to extract text. **Correct use of byte offset.**

No other file has `.start ?? 0` used as a `column` value for node metadata.

---

## 5. Gaps Found

### Gap 1: `initExpression.start` in LITERAL node IDs (lines 699 and 4428) — Out of Scope but Flagged

At line 699:
```ts
const literalId = `LITERAL#${line}:${initExpression.start}#${module.file}`;
```

At line 4428 (in the reassignment handler):
```ts
valueId = `LITERAL#${line}:${rightExpr.start}#${module.file}`;
```

Both use `.start` (byte offset) in the LITERAL node ID string — not as a stored `column` field. This is a different category: the `.start` here serves as a **uniqueness discriminator** within the ID, not as the column metadata stored on the node. The LITERAL node does not appear to store a `column` field at all (the push at lines 700–707 has no `column` key).

**Assessment:** These two usages are out of scope for REG-548 (which targets EXPRESSION node column metadata). However, using byte offset as an ID discriminator has an inconsistency: two literals on the same line but at the same byte offset (impossible) vs. two literals at different byte offsets would generate different IDs, which is correct for uniqueness. The byte offset as a uniqueness discriminator is functionally sound even if it looks like a column misuse. **This should be flagged as a separate issue (potential REG-54x), not blocking this fix.**

### Gap 2: Test assertions use `column < 200` instead of exact values

Don's plan proposes weak assertions (`column < 200`) as primary, with exact assertions only "optionally". The test fixture claims `const x = obj.prop;` puts `obj.prop` at column 10, but this is only true if the file has no leading newline and the exact spacing is as written.

**Assessment:** The test must assert exact column values (e.g., `column === 10`) as the primary assertion. A `column < 200` check would not have caught the original bug in a file where the expression happened to be at byte offset 150 (a small file). The test fixture design is fine; the assertion strength must be tightened in implementation.

---

## 6. Precondition Issues

### Precondition 1: `getColumn` handles `node.loc === null` — VERIFIED

`getColumn(node)` returns `node?.loc?.start?.column ?? 0` — the `?.` chain handles null/undefined `loc`. All 10 fix locations currently use `initExpression.start ?? 0` as fallback, which returns 0 if `start` is undefined. After the fix, `getColumn` also returns 0 for missing `loc`. The semantics are equivalent for the null case. **No regression risk.**

### Precondition 2: `getColumn` import is present — VERIFIED

Line 53: `import { getLine, getColumn, getEndLocation } from './ast/utils/location.js';` — confirmed.

### Precondition 3: `initNode` at line 1519 has the same type constraints as `initExpression` — VERIFIED

At line 1519, `initNode` is confirmed by the enclosing `else if (t.isMemberExpression(initNode))` guard (line 1510) to be a Babel `MemberExpression` node, which has `.loc` per the Babel AST spec. `getColumn(initNode)` is safe.

### Precondition 4: No downstream code relies on `.start` being stored in `column` — VERIFIED

Don's plan states AssignmentBuilder and NodeFactory are clean pass-throughs. The grep of all `column` usages in builders shows only `loc?.start.column` patterns — no code extracts `.start` semantics from the stored `column` field. **No hidden dependency on the wrong value.**

### Precondition 5: EXPRESSION node ID will change — ACKNOWLEDGED, NOT A RISK

Don's plan explicitly notes that EXPRESSION node IDs will change because `column` is part of the ID format. This is expected. No test should be asserting specific EXPRESSION node IDs by their exact string value (tests use graph traversal by type and property). **Confirmed clean.**

---

## 7. Summary

Don's plan is correct and complete with respect to the stated scope:

- All 10 buggy locations are real and correctly identified
- No additional `node.start ?? 0` used as column was found in `trackVariableAssignment` or `trackDestructuringAssignment`
- No other analysis plugin files have the same column bug
- The `getColumn` substitute is safe in all 10 locations

The single out-of-scope observation (LITERAL IDs using `.start`) is functionally sound for ID uniqueness and does not store wrong column metadata on any node. It should be tracked separately.

The test plan is adequate in structure but the implementation must use **exact column assertions** as primary, not as optional.

**APPROVE to proceed with implementation.**
