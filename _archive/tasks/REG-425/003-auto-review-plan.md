# Auto-Review: REG-425 Plan

**Verdict:** REJECT

---

## Vision & Architecture: CRITICAL ISSUES

### 1. Module Granularity: Too Fine-Grained

**Issue:** 9 files for 1,377 lines is excessive fragmentation.

**Evidence from codebase:**
- `ExpressAnalyzer.ts`: 424 lines (NOT split)
- `DatabaseAnalyzer.ts`: 340 lines (NOT split)
- `ServiceLayerAnalyzer.ts`: 457 lines (NOT split)
- `FetchAnalyzer.ts`: 730 lines (NOT split)
- `ReactAnalyzer.ts`: 1,377 lines → proposed 9 files

**Pattern in codebase:** Analyzers under 500 lines stay monolithic. ReactAnalyzer at 1,377 lines is 3x the typical size, but the split should match complexity, not arbitrary line count.

**Problem with proposed split:**
- `ComponentDetector.ts`: 70 lines — TOO SMALL to be separate file
- `utils.ts`: 40 lines — TOO SMALL to be separate file
- `constants.ts`: 100 lines — constants don't need separate file unless reused externally

**Better approach:** 4-5 modules, not 9.

### 2. Architectural Mismatch: Class-Based API vs Codebase Pattern

**Don's proposed API:**
```typescript
export class HookAnalyzer {
  analyzeHook(path: NodePath<CallExpression>, filePath: string): HookNode | null;
}
```

**Actual codebase pattern:** Analyzers are plugins (extend `Plugin` class). No evidence of standalone analyzer classes used as dependencies.

**Check ExpressAnalyzer pattern:**
```typescript
export class ExpressAnalyzer extends Plugin {
  // Single class, methods are private
  private analyzeRoute(...) { }
  private analyzeMiddleware(...) { }
}
```

**Problem:** Introducing class-based sub-analyzers is architectural divergence. Other analyzers don't do this.

### 3. Missing "Extend Existing" Check

**Root Cause Policy violation:** Before proposing 9 new modules, should check if existing infrastructure can be extended.

**Questions NOT answered:**
- Can `ast/` directory utilities be reused? (Don found `getLine`, `getColumn` there, but didn't explore other utilities)
- Are there shared AST traversal patterns in `JSASTAnalyzer.ts` that ReactAnalyzer should use?
- Is there a pattern for splitting large analyzers? (Answer: NO — no other analyzer is split)

---

## Practical Quality: CONCERNS

### 1. Phase Ordering Risk

**Don's claim:** "Extract IssueDetector LAST (Phase 7) to mitigate Hook ↔ Issue coupling"

**Reality check:** The coupling is bidirectional. `checkEffectIssues` is called FROM `analyzeHook` flow (line 387):

```typescript
// In current code:
if (callee.name === 'useEffect' || callee.name === 'useLayoutEffect') {
  this.checkEffectIssues(path, filePath, analysis, hookData, importedIdentifiers);
}
```

**Problem:** If you extract `HookAnalyzer` in Phase 6 WITHOUT extracting `IssueDetector`, you'll need to:
1. Keep issue detection logic in HookAnalyzer temporarily (duplication)
2. OR break the flow and defer issue detection to main analyzer (architectural mess)
3. OR extract both together (Don's phases are wrong)

**Correct approach:** Extract HookAnalyzer + IssueDetector TOGETHER (single phase), not separately.

### 2. Test Safety Net Assumption

**Don's claim:** "72-84 behavioral tests are sufficient safety net"

**Missing verification:**
- Are tests actually independent of internal structure?
- Do tests import from public API only? (Yes, verified: `import { ReactAnalyzer } from '@grafema/core'`)
- Do tests verify graph output or just method calls? (NOT CHECKED)

**Risk:** If tests mock internal methods, refactoring will break mocks. Don didn't verify this.

### 3. Line Count Math Doesn't Add Up

**Don's estimate:** Main file after refactoring: ~325 lines

**Breakdown:**
- Plugin metadata: 25 lines
- execute: 60 lines
- isReactFile: 10 lines
- analyzeModule: 15 lines
- analyzeAST: **150 lines** ← THIS IS THE PROBLEM
- addToGraph: 55 lines
- Imports: 10 lines
- **Total: 325 lines**

**Issue:** `analyzeAST` at 150 lines means it's still doing TOO MUCH. It should be coordinator only (30-50 lines). If it's 150 lines, the split isn't deep enough.

**Actual `analyzeAST` (lines 305-428):** 124 lines today. After "extracting" modules, Don estimates it will GROW to 150 lines? That's backwards.

---

## Code Quality: ISSUES

### 1. Proposed Module Sizes Are Unbalanced

**Don's estimates:**
- `HookAnalyzer.ts`: 250 lines ✓ OK
- `IssueDetector.ts`: 250 lines ✓ OK
- `JSXAnalyzer.ts`: 160 lines ✓ OK
- `BrowserAPIDetector.ts`: 150 lines ✓ OK
- `ComponentDetector.ts`: **70 lines** ✗ TOO SMALL
- `constants.ts`: **100 lines** ✗ NOT A MODULE
- `types.ts`: **100 lines** ✗ NOT A MODULE
- `utils.ts`: **40 lines** ✗ TOO SMALL

**Rule of thumb:** Module < 100 lines should be merged with another module or kept inline.

### 2. Duplication Risk: `getMemberExpressionName`

**Don's plan:** Extract to `utils.ts`

**Problem:** This utility is likely already in `ast/utils/` directory. Check before extracting.

**Actual location check:**
```bash
$ ls packages/core/src/plugins/analysis/ast/utils/
```

Don didn't do this check. High risk of duplicating existing utility.

### 3. Circular Dependency Risk NOT Fully Addressed

**Don's claim:** "No cycles possible"

**His dependency graph:**
```
ReactAnalyzer.ts
  ↓ imports
HookAnalyzer, IssueDetector, JSXAnalyzer, ComponentDetector, BrowserAPIDetector
  ↓ import
constants.ts, types.ts, utils.ts
```

**Missing edge:** `IssueDetector` needs `HookAnalyzer.extractDeps()` or `HookAnalyzer.hasCleanupReturn()` (shared logic).

**If Don's plan:** IssueDetector imports from `utils.ts`, HookAnalyzer also imports from `utils.ts` → OK
**If reality:** IssueDetector imports from HookAnalyzer → CYCLE

Don didn't verify WHERE shared hook logic lives after split.

---

## Recommendations (BLOCKING)

### 1. Rethink Module Granularity

**Target:** 4-5 modules max, not 9.

**Proposed structure:**
```
packages/core/src/plugins/analysis/
├── ReactAnalyzer.ts                 (Main plugin — ~350 lines)
├── react-internal/
│   ├── hooks.ts                     (Hook detection + issue detection — ~500 lines)
│   ├── jsx.ts                       (JSX + components + forwardRef — ~300 lines)
│   ├── browser-api.ts               (Browser APIs — ~200 lines)
│   └── types.ts                     (Interfaces + constants — ~200 lines)
```

**Rationale:**
- Hook + Issue detection are coupled → keep together
- JSX + Component detection are related → keep together
- Constants + Types are data → keep together
- Browser API is self-contained → separate OK

**Result:** Main file ~350 lines (under 500), 4 internal modules.

### 2. Fix Phase Ordering

**Correct phases:**
1. Extract types + constants (low risk)
2. Extract browser API (low risk, no coupling)
3. Extract JSX + components (low risk, self-contained)
4. Extract hooks + issues TOGETHER (high risk, tightly coupled)
5. Cleanup

**DO NOT** extract HookAnalyzer and IssueDetector separately. They're a single responsibility: "React effect safety analysis".

### 3. Check for Existing Patterns FIRST

**Before implementing:**
1. Check `ast/utils/` for existing utilities (avoid duplication)
2. Check if any other analyzer uses sub-modules (follow existing pattern)
3. Check test structure — do tests verify graph output or implementation details?

### 4. Verify Line Count Target Is Real

**Current target:** Main file < 500 lines

**Question:** Why 500? Is this arbitrary or based on codebase standard?

**Evidence:**
- `ExpressAnalyzer.ts`: 424 lines (close to 500)
- `FetchAnalyzer.ts`: 730 lines (EXCEEDS 500, not split)

**Conclusion:** 500-line target is arbitrary. Real target should be: "coordinator logic only, domain logic extracted".

**Better AC:** "Main file contains only: metadata, execute loop, file filtering, AST parsing, graph writing. All domain analysis delegated to modules."

---

## Final Verdict

**REJECT** — Don's plan has architectural mismatches and overcomplicated module structure.

**Required changes before proceeding:**
1. Reduce to 4-5 modules (merge small modules)
2. Keep Hook + Issue detection together (single module)
3. Verify no duplication of existing utilities
4. Fix phase ordering (extract coupled modules together)
5. Clarify line count target (coordinator-only, not arbitrary 500)

**Don't start implementation until these issues are resolved.**

---

**Auto-Review Agent**
February 15, 2026
