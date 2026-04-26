## Вадим auto — Completeness Review

**Verdict:** REJECT

**Feature completeness:** ISSUES — AC1 and AC3 are not satisfied
**Test coverage:** PARTIAL — tests for existing functionality, but missing coverage for AC1 and AC3
**Commit quality:** N/A — changes are unstaged, no commit yet

---

## AC-by-AC Analysis

### AC1: "All EXPRESSION nodes for listed types have outgoing ASSIGNED_FROM edges to their constituent sub-expressions"

**NOT SATISFIED.**

The task AC says: add outgoing `ASSIGNED_FROM` edges from EXPRESSION nodes to their sub-expressions.

What was actually implemented: RC1 and RC2 make the DataFlowValidator *tolerate* EXPRESSION nodes that have no outgoing edges, by treating them as terminal. This is the opposite of what AC1 asks for. AC1 asks for edges to be added to the graph. The implementation teaches the validator to accept their absence.

The plan (`003-don-plan.md`) acknowledges this mismatch explicitly but argues that Option A (conditional leaf in validator) is the "correct" approach because adding LITERAL sub-nodes for literal operands would be more invasive. However, the acceptance criterion as written says EXPRESSION nodes must have outgoing edges. The implementation delivers a validator that stops complaining about missing edges — it does not deliver the missing edges.

This is a gap between AC1 as written and what was shipped. A user querying the graph for "what does this BinaryExpression derive from when both operands are literals?" will get no answer. The graph is silent, not wrong, but the AC asked for edges.

**Impact:** Whether this is a reject-level issue depends on intent. If the intent of AC1 was "fix the validator warnings," RC1+RC2 achieve that. If the intent was "enrich the graph with actual data flow edges," they do not. The AC text says "have outgoing ASSIGNED_FROM edges" — that is structural, not validator-behavioral.

### AC2: "Ternary EXPRESSION nodes link to condition, consequent, alternate; BRANCH node's HAS_CONSEQUENT/HAS_ALTERNATE point to real node IDs (not dangling)"

**PARTIALLY SATISFIED.**

RC3 (BranchHandler change) correctly prevents dangling `HAS_CONSEQUENT`/`HAS_ALTERNATE` edges for ternary branches where the consequent or alternate is an Identifier, literal, or CallExpression. The `producesExpressionNode()` helper is correctly designed and matches `trackVariableAssignment` case numbers.

However, the first part of AC2 ("Ternary EXPRESSION nodes link to condition, consequent, alternate") is not addressed. The ternary EXPRESSION node itself — the one created for `ConditionalExpression` in case 9 of `trackVariableAssignment` — was supposed to have edges to the condition, consequent, and alternate. The implementation does not add those edges. It only stops BRANCH from creating dangling edges.

The BRANCH dangling-edge fix (no dangling `HAS_CONSEQUENT`/`HAS_ALTERNATE`) is correct and is a real improvement. But "EXPRESSION nodes link to condition, consequent, alternate" describes outgoing `ASSIGNED_FROM`/`DERIVES_FROM` edges from the EXPRESSION node, which are not added.

### AC3: "Member access EXPRESSION nodes link back to the object they access"

**NOT ADDRESSED.**

This AC was listed in the original issue as one of the four affected expression types. There are no changes in `BranchHandler.ts`, `JSASTAnalyzer.ts`, or `AssignmentBuilder.ts` that add a `DERIVES_FROM` edge from a `MemberExpression` EXPRESSION node to the object it accesses.

The test file (`Expression.test.js`) tests that `MemberExpression` creates an EXPRESSION node and that it has a `DERIVES_FROM` edge to the object variable — but these tests existed before this PR (they are in the original file, not in the RC1/RC2/RC3 sections). They test pre-existing behavior, not behavior added by this task.

The `003-don-plan.md` does not include a "Root Cause 4" for member access. The plan focuses on Root Causes 1-3 (all-literal operands, OBJECT/ARRAY_LITERAL leaf types, ternary dangling edges). Member access behavior was not analyzed and the AC3 gap was not addressed.

### AC4: "Zero ERR_NO_LEAF_NODE warnings on Grafema's own codebase"

**CANNOT VERIFY** — tests pass for the scenarios tested, and the logic changes (RC1+RC2) should reduce warnings. But whether the count reaches zero on the actual Grafema codebase is unknown without running `grafema check dataflow`. Given that AC3 (member access) was not addressed, it is likely that `MemberExpression` nodes where the object has no resolvable `DERIVES_FROM` edges would still trigger the warning.

### AC5: "New tests covering each expression type"

**PARTIALLY SATISFIED.**

Tests were added for:
- RC2: OBJECT_LITERAL, ARRAY_LITERAL as leaf types — 2 tests, good
- RC1: BinaryExpression with all-literal operands (terminal), BinaryExpression with mixed operands, LogicalExpression with literal fallback — 3 tests, good
- RC3: Ternary with Identifier branches (no dangling), Ternary with literal branches (no dangling), Ternary with expression branches (HAS_CONSEQUENT valid) — 3 tests, good

Missing:
- No tests for AC3 (MemberExpression DERIVES_FROM edge to object) as new behavior — the existing tests cover pre-existing behavior
- No negative tests: what happens when an EXPRESSION genuinely should have DERIVES_FROM edges but they were dropped by an enricher bug? RC1's "silent terminal" treatment would swallow that gap. There is no test that verifies the validator DOES report an error when an EXPRESSION has non-literal operands with no DERIVES_FROM edges.

The tests for RC1/RC2/RC3 are well-structured, meaningful, and test the actual graph structure (not just absence of errors). The LogicalExpression tests are thorough (||, &&, ??, readable names, fallback names). This is good quality work within scope.

---

## Code Quality Observations

### DataFlowValidator.ts (RC1 + RC2)
- Changes are minimal and correct within the intended scope.
- `OBJECT_LITERAL` and `ARRAY_LITERAL` are genuinely terminal — adding them to `leafTypes` is semantically correct.
- The EXPRESSION-with-zero-DERIVES_FROM check is placed correctly (after the `leafTypes` check, before the `incomingUses` check). Logic is sound.
- Steve's review correctly flags the risk: if an enricher bug drops DERIVES_FROM edges for variable-operand expressions, RC1 would silently treat them as all-literal terminals. This is a real risk but was accepted.

### BranchHandler.ts (RC3)
- `EXPRESSION_PRODUCING_TYPES` set is well-commented with case numbers from `trackVariableAssignment`.
- `producesExpressionNode()` handles the conditional cases (`TaggedTemplateExpression`, `TemplateLiteral`) correctly.
- The comment "Must be kept in sync with cases 7-12, 15-16 of trackVariableAssignment" documents the maintenance contract clearly.
- The `OptionalMemberExpression -> 'MemberExpression'` mapping is handled correctly in both the ID generation.

### No forbidden patterns: no TODOs, no FIXMEs, no commented-out code, no empty implementations.

---

## Summary of Issues

1. **AC1 gap:** EXPRESSION nodes with all-literal operands still have zero outgoing data flow edges. The validator is taught to accept this, but the graph is not enriched. Whether this is acceptable depends on whether the AC intent was "fix warnings" or "add edges."

2. **AC2 partial gap:** Ternary EXPRESSION node does not have outgoing edges to its condition/consequent/alternate. Only the BRANCH dangling edge problem was fixed.

3. **AC3 not addressed:** Member access EXPRESSION nodes are not newly connected to the object they access. The plan silently dropped this scope item.

4. **AC4 uncertain:** Zero ERR_NO_LEAF_NODE across the full codebase cannot be confirmed without running analysis.

If the intent was "fix the 2931 warnings" then RC1+RC2+RC3 likely achieve significant reduction and may be sufficient. If the intent was "add outgoing edges from EXPRESSION nodes to their constituents" (as AC1-AC3 literally state), the implementation does not deliver.

**Recommendation:** Clarify with team whether AC1 "outgoing ASSIGNED_FROM edges" was the actual requirement or whether "fix the validator warnings" is acceptable. If the latter, approve after confirming AC4. If the former, RC1 must be replaced with actual edge emission for literal operands.
