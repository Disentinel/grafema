## Uncle Bob PREPARE Review: JSASTAnalyzer.ts

**File size:** 4618 lines — CRITICAL (hard limit: 700 lines)
**Methods to modify:** `trackVariableAssignment` (lines 609–1073, 465 lines)

---

**File-level:**

- CRITICAL: 4618 lines is 6.6× the hard limit. This file has accumulated visitors, builders, analyzers, and helpers into one monolith. It should be split into separate visitor/handler modules. However, that split is a multi-week refactoring effort with its own REG ticket and is completely out of scope for a 10-line bug fix.

**Method-level:** `JSASTAnalyzer.ts:trackVariableAssignment`

- **Line count:** 465 lines — 9× the 50-line candidate threshold
- **Parameter count:** 13 parameters — far exceeds the 3–4 parameter guideline
- **Nesting depth:** up to depth 5 (10 leading spaces at 2-space indent)
- **Structure:** A long if-chain dispatching on `initExpression.type`. Each branch is self-contained, numbered 0 through 19, and terminates with `return`. There are no shared locals mutated across branches. The 13-parameter list is load-bearing: all parameters are passed through on every recursive call, which is why they must all be present.

- **Recommendation:** SKIP

**Justification:**

The method is large by any measure, but its internal structure is flat: it is a dispatch table, not entangled logic. Each numbered branch reads its own local `column`, builds its own object, pushes it, and returns. There is no cross-branch state. The 10 bug sites (`initExpression.start ?? 0` instead of `initExpression.loc?.start.column ?? 0`) each appear on a single line inside one of these self-contained branches.

The correct fix is a mechanical one-line substitution repeated 10 times. Refactoring the method before applying that fix would:
1. Require moving all 13 recursive call sites simultaneously (high risk of introducing merge errors or parameter mismatches)
2. Produce a much larger diff with no relation to the bug
3. Delay the fix without improving correctness

The two lines that already use `.loc?.start.column` correctly (lines 641 and 676, for ObjectExpression and ArrayExpression) confirm the pattern is established in the method. The remaining 9 expression branches (lines 808, 830, 850, 872, 895, 924, 965, 997, 1025) and the literal ID at line 699 use `.start` (absolute byte offset) where `.loc?.start.column` (zero-based column) is required.

Splitting this method should be tracked as separate tech debt. It is not a prerequisite here.

**Risk:** LOW
**Estimated scope:** 9 lines changed in `trackVariableAssignment` (branches 7–9, 10, 11, 12, 13-fallback, 15, 16). Line 699 (literal ID construction) is a separate pattern — confirm with the implementer whether it is also in scope for REG-548.
