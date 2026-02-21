## Uncle Bob PREPARE Review: REG-533

**Task:** Add DERIVES_FROM edges to control flow EXPRESSION nodes
**Reviewer:** Robert Martin (Uncle Bob)
**Date:** 2026-02-20

---

### File Reviews

#### File 1: JSASTAnalyzer.ts
**Path:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
- **Current file size:** 4117 lines — **CRITICAL VIOLATION** (>700 lines)
- **Methods to modify:**
  - `extractDiscriminantExpression` (lines 2334-2376) — 43 lines
  - `extractOperandName` (NEW method) — ~15 lines
- **Planned changes:**
  - Expand `extractDiscriminantExpression` from ~43 lines to ~200 lines (+157 lines)
  - Add `extractOperandName` helper (~15 lines)
  - Total addition: ~172 lines
- **Post-implementation estimate:** 4117 + 172 = **4289 lines** — **CATASTROPHIC**
- **Recommendation:** **MUST REFACTOR BEFORE IMPLEMENTATION**

**Analysis:** This file is already 8x over the 500-line limit and 6x over the critical 700-line threshold. Adding 172 more lines to an already bloated file is architectural malpractice. The file is clearly doing too much and needs to be split into focused modules.

**Specific concern:** The `extractDiscriminantExpression` method will grow from 43 lines to ~200 lines, making it a massive method that violates SRP. This method should be extracting expression metadata, but it's becoming a mini-compiler with case handling for 12+ expression types.

---

#### File 2: types.ts
**Path:** `packages/core/src/plugins/analysis/ast/types.ts`
- **Current file size:** 1250 lines — **CRITICAL VIOLATION** (>700 lines)
- **Planned changes:**
  - Add ~15 fields to `LoopInfo` interface (~20 lines with comments)
  - Add ~10 fields to `BranchInfo` interface (~15 lines with comments)
  - Total addition: ~35 lines
- **Post-implementation estimate:** 1250 + 35 = **1285 lines** — **CRITICAL**
- **Recommendation:** **REFACTOR FIRST** (but less urgent than JSASTAnalyzer)

**Analysis:** This is a type definition file that's already too large. The additions are relatively minor (+35 lines), but the file as a whole needs splitting into domain-specific type files (loop types, branch types, function types, etc.).

**Pragmatic decision:** The additions are small enough that we could PROCEED if JSASTAnalyzer gets fixed first. But ideally, this file should be split.

---

#### File 3: LoopHandler.ts
**Path:** `packages/core/src/plugins/analysis/ast/handlers/LoopHandler.ts`
- **Current file size:** 240 lines — **OK**
- **Methods to modify:**
  - Lines 138-164 (condition extraction) — ~27 lines
  - Lines 107-112 (update extraction) — ~6 lines
  - Lines 166-196 (push to ctx.loops) — ~31 lines
- **Planned changes:**
  - Extract operand metadata from test expressions (~30 lines added to condition extraction)
  - Extract operand metadata from update expressions (~5 lines added)
  - Add operand fields to ctx.loops.push (~15 lines added)
  - Total addition: ~50 lines
- **Post-implementation estimate:** 240 + 50 = **290 lines** — **OK**
- **Recommendation:** **PROCEED**

**Analysis:** File size is healthy. The additions are straightforward metadata extraction that fits the file's purpose. Post-implementation size of 290 lines is well within acceptable limits.

---

#### File 4: BranchHandler.ts
**Path:** `packages/core/src/plugins/analysis/ast/handlers/BranchHandler.ts`
- **Current file size:** 313 lines — **OK**
- **Methods to modify:**
  - Line 93 (`extractDiscriminantExpression` call in `createIfStatementVisitor`)
  - Line 224 (`extractDiscriminantExpression` call in `createConditionalExpressionVisitor`)
  - Lines 100-113 (push to ctx.branches in `createIfStatementVisitor`)
  - Lines 245-259 (push to ctx.branches in `createConditionalExpressionVisitor`)
- **Planned changes:**
  - Extract and store operand metadata from discriminants (~30 lines total)
  - Total addition: ~30 lines
- **Post-implementation estimate:** 313 + 30 = **343 lines** — **OK**
- **Recommendation:** **PROCEED**

**Analysis:** File size is healthy. Changes are localized and follow existing patterns. Post-implementation size is well within limits.

---

#### File 5: ControlFlowBuilder.ts
**Path:** `packages/core/src/plugins/analysis/ast/builders/ControlFlowBuilder.ts`
- **Current file size:** 470 lines — **OK (near limit)**
- **Planned changes:**
  - Add `bufferLoopTestDerivesFromEdges` method (~100 lines)
  - Add `bufferLoopUpdateDerivesFromEdges` method (~30 lines)
  - Add `bufferBranchDiscriminantDerivesFromEdges` method (~100 lines)
  - Add 3 method calls in `buffer()` (~3 lines)
  - Total addition: ~233 lines
- **Post-implementation estimate:** 470 + 233 = **703 lines** — **AT CRITICAL THRESHOLD**
- **Recommendation:** **PROCEED WITH CAUTION** (but monitor for future refactoring)

**Analysis:** This file is currently at a healthy size, but the planned additions will push it to 703 lines — just over the critical 700-line threshold. However:

1. The additions are three focused methods with clear SRP (each handles one type of DERIVES_FROM edge creation)
2. The file structure remains clean and navigable
3. The methods are ~30-100 lines each (within acceptable method size limits)
4. No existing methods exceed 50 lines

**Pragmatic decision:** This is a borderline case. The file will be at the critical limit but not catastrophically oversized. The new methods are well-factored and follow SRP. We can PROCEED, but this file should be flagged for refactoring in the next cleanup cycle (split into separate builders for loop/branch/case edges).

---

### Overall Verdict: **REFACTOR JSASTAnalyzer.ts FIRST**

#### Critical Blocker
- **JSASTAnalyzer.ts** (4117 lines → 4289 lines) — **MUST BE SPLIT BEFORE THIS TASK**

#### Acceptable Files
- **LoopHandler.ts** (240 → 290 lines) — OK
- **BranchHandler.ts** (313 → 343 lines) — OK
- **ControlFlowBuilder.ts** (470 → 703 lines) — Borderline, but acceptable for now

#### Should Refactor (but not blocking)
- **types.ts** (1250 → 1285 lines) — Already oversized, additions are minor

---

### Recommended Action Plan

#### Option 1: REFACTOR BEFORE PROCEEDING (RECOMMENDED)

**Step 1:** Extract expression metadata logic from JSASTAnalyzer.ts
- Create new file: `packages/core/src/plugins/analysis/ast/ExpressionMetadataExtractor.ts`
- Move `extractDiscriminantExpression` and `extractOperandName` to new class
- Estimated size: ~250 lines (including new expression type handlers)
- Remaining JSASTAnalyzer.ts size: ~4067 lines (still critical, but better)

**Step 2:** Implement REG-533 changes
- Add expression type handlers to `ExpressionMetadataExtractor`
- Update handlers and builders to use new extractor
- All files except JSASTAnalyzer remain in healthy size ranges

**Step 3:** (Future) Continue splitting JSASTAnalyzer.ts
- The file is clearly doing too much
- Should be split into domain-specific analyzers (FunctionAnalyzer, ControlFlowAnalyzer, etc.)
- Not blocking for this task, but critical technical debt

---

#### Option 2: PROCEED AS-IS (NOT RECOMMENDED)

If we proceed without refactoring:
- JSASTAnalyzer.ts becomes 4289 lines (10.5x over limit)
- Technical debt compounds
- Future changes become increasingly difficult
- Risk of creating unmaintainable monster file

**My professional opinion:** This is a violation of our commitment to code quality. We should not add 172 lines to a file that's already 8x oversized.

---

### Specific Method Analysis

#### extractDiscriminantExpression (JSASTAnalyzer.ts, lines 2334-2376)
- **Current size:** 43 lines
- **Post-implementation size:** ~200 lines
- **Assessment:** **VIOLATES METHOD SIZE LIMIT** (>50 lines = candidate for split)
- **Recommendation:** Extract to separate class with one method per expression type

**Why this matters:** A 200-line method with 12+ case branches is a maintenance nightmare. It violates SRP (should do ONE thing) and is hard to test in isolation.

**Better approach:**
```typescript
class ExpressionMetadataExtractor {
  extract(node: Expression): ExpressionMetadata {
    if (t.isIdentifier(node)) return this.extractIdentifier(node);
    if (t.isBinaryExpression(node)) return this.extractBinaryExpression(node);
    // ... etc
  }

  private extractIdentifier(node: Identifier): ExpressionMetadata { ... }
  private extractBinaryExpression(node: BinaryExpression): ExpressionMetadata { ... }
  // ... one method per expression type (~15 methods, 10-20 lines each)
}
```

This creates:
- Clear separation of concerns (one method = one expression type)
- Easy to test (test each extractor method independently)
- Easy to extend (add new expression type = add new method)
- Readable code (each method is short and focused)

---

### Final Recommendation

**REFACTOR FIRST.** Extract expression metadata logic to a new `ExpressionMetadataExtractor` class before implementing REG-533.

**Rationale:**
1. JSASTAnalyzer.ts is already 8x oversized
2. Adding 172 lines makes it worse, not better
3. The `extractDiscriminantExpression` method will violate method size limits (200 lines >> 50 line threshold)
4. The refactoring is straightforward and makes the code MORE maintainable, not less
5. This aligns with our commitment to quality and our Root Cause Policy

**If forced to choose between quality and speed:** I choose quality. The right fix takes longer but prevents compounding technical debt.

---

**SIGNATURE:** Robert Martin (Uncle Bob)
**PRINCIPLE APPLIED:** "The only way to go fast is to go well."
