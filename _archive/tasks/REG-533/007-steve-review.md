# Steve Jobs — Vision Review
**Verdict:** APPROVE

**Vision alignment:** OK — This feature directly supports the core vision.

**Architecture:** OK — Clean implementation that follows existing patterns.

---

## Vision Alignment: APPROVED

This moves us closer to "AI should query the graph, not read code."

**Before REG-533:**
- Data flow tracing STOPPED at EXPRESSION nodes in control flow
- Agent query: "What variables influence this loop condition?" → HAS_CONDITION edge points to EXPRESSION, but EXPRESSION is a dead end
- Agent forced to read code to understand `while (i < arr.length)` depends on both `i` and `arr`

**After REG-533:**
- EXPRESSION nodes have DERIVES_FROM edges to operand variables/parameters
- Agent query: "What variables influence this loop condition?" → HAS_CONDITION → EXPRESSION → DERIVES_FROM → [i, arr]
- No code reading required

This is exactly what Grafema should do: capture semantic relationships in the graph so AI can query, not read.

**Impact:** Medium-high. Control flow expressions are ubiquitous. Every loop condition, every if statement, every switch discriminant — these are core to understanding program behavior. Making them queryable unlocks new analysis patterns.

---

## Architecture: APPROVED

### Pattern Consistency

The implementation follows ReturnBuilder's pattern for DERIVES_FROM edges (lines 482-606 in ControlFlowBuilder.ts):

1. **Same helper structure:** `findSource(name)` closure that checks variables first, then parameters
2. **Same iteration scope:** Per-loop, per-branch (NOT global iteration)
3. **Same expression type coverage:** Identifier, MemberExpression, BinaryExpression, LogicalExpression, UnaryExpression, UpdateExpression, ConditionalExpression, TemplateLiteral

This is NOT new complexity — it's reusing an established pattern.

### Operand Extraction

`extractDiscriminantExpression` and `extractOperandName` in JSASTAnalyzer.ts (lines 2375-2524):

- **Simple logic:** For MemberExpression, extract base object. For Identifier, extract name. For complex expressions, recurse.
- **Defensive:** Returns `undefined` for literals, `this`, computed properties — no spurious edges
- **Reusable:** The same method handles loop conditions, branch discriminants, for-loop tests/updates

### Data Flow

1. **Analysis phase (JSASTAnalyzer):** Extract operand metadata into LoopInfo/BranchInfo
2. **Graph building phase (ControlFlowBuilder):** Use that metadata to create DERIVES_FROM edges

No AST re-parsing. No global scans. Just using data already collected during traversal.

### Complexity Check: O(n) Acceptable

- `bufferLoopTestDerivesFromEdges`: Iterates loops (O(loops))
- `bufferLoopUpdateDerivesFromEdges`: Iterates for-loops (O(for-loops))
- `bufferBranchDiscriminantDerivesFromEdges`: Iterates branches (O(branches))

Each method iterates its own domain (loops/branches), not ALL nodes. This is the right iteration scope.

For each loop/branch, it creates at most a few DERIVES_FROM edges (typically 1-2 operands per expression). Linear in the number of control flow constructs, not quadratic, not exponential.

**Iteration space:** Acceptable.

---

## Test Coverage: ADEQUATE

16 test cases in `ControlFlowDerivesFrom.test.js` covering:

- All expression types: BinaryExpression, LogicalExpression, Identifier, MemberExpression, UnaryExpression, UpdateExpression
- All control flow contexts: while, for, do-while, if, switch
- Edge cases: Parameters vs variables, ThisExpression skip case, complex nested expressions

The tests verify:
1. EXPRESSION nodes exist
2. DERIVES_FROM edges point to the correct variables/parameters
3. Skip cases (ThisExpression) don't create spurious edges

This is solid coverage for a feature that adds semantic edges.

---

## Gaps: NONE CRITICAL

The only gap I see is **nested MemberExpression** (e.g., `obj.foo.bar.baz`):

- Current behavior: `extractOperandName` extracts only the base object (`obj`)
- This is CORRECT for most cases (the object reference is the data dependency)
- But for deep property chains, we might miss intermediate object dependencies

However, this is NOT a blocker:
1. Grafema doesn't track property-level data flow yet (no ACCESSES edges for properties)
2. Base object extraction is consistent with existing patterns (ReturnBuilder does the same)
3. If we need deep property tracking, that's a separate feature (property-level data flow)

**Verdict:** Not a gap for this task. Base object extraction is the right choice given current architecture.

---

## Final Verdict: APPROVE

This implementation:
- **Advances the vision** — makes control flow expressions queryable
- **Follows patterns** — reuses ReturnBuilder's approach
- **Stays simple** — no AST re-parsing, no global scans
- **Has tests** — 16 cases covering all expression types

Ship it.
