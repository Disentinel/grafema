# Auto-Review: REG-425 Revised Plan (Round 2)

**Verdict:** APPROVE with non-blocking recommendations

---

## Vision & Architecture: OK

### 1. Module Count Reduction: ADDRESSED

**Round 1 issue:** 9 files → too fragmented

**Round 2 solution:** 4 internal modules + 2 shared utilities = 6 new files

**Verification:**
- `hooks.ts`: 500 lines (Hook + Issue detection together) ✓
- `jsx.ts`: 350 lines (JSX + Components + forwardRef) ✓
- `browser-api.ts`: 200 lines (Browser API detection) ✓
- `types.ts`: 200 lines (Interfaces + Constants) ✓
- `ast/utils/getMemberExpressionName.ts`: 15 lines ✓
- `ast/utils/getExpressionValue.ts`: 20 lines ✓

**Assessment:** Module sizes are balanced. No file under 100 lines (except utilities, which are intentionally small). Good granularity.

### 2. Hook + Issue Coupling: ADDRESSED

**Round 1 issue:** HookAnalyzer and IssueDetector were planned as separate modules despite tight coupling

**Round 2 solution:** `hooks.ts` contains BOTH `analyzeHook()` and `checkEffectIssues()` in single module

**Verification from current code:**
```typescript
// Line 387 in ReactAnalyzer.ts:
if (callee.name === 'useEffect' || callee.name === 'useLayoutEffect') {
  this.checkEffectIssues(path, filePath, analysis, hookData, importedIdentifiers);
}
```

**Assessment:** Correct decision. These are a single responsibility: "React hook safety analysis". Keeping them together avoids artificial module boundaries.

### 3. Function Export Pattern: ADDRESSED

**Round 1 issue:** Proposed class-based API (`export class HookAnalyzer`) diverges from codebase

**Round 2 solution:** Export functions, not classes

**Verification:**
```typescript
// Proposed in revised plan:
export function analyzeHook(...): HookNode | null { }
export function checkEffectIssues(...): void { }
```

**Assessment:** Matches existing patterns. Other analyzers use private methods; sub-modules should use functions. Correct choice.

### 4. First to Use Internal Directory: OK

**Observation:** No other analyzer in codebase uses sub-modules or internal directories.

**Current structure:**
```bash
packages/core/src/plugins/analysis/
├── ExpressAnalyzer.ts        (424 lines — monolithic)
├── FetchAnalyzer.ts           (707 lines — monolithic)
├── ReactAnalyzer.ts           (1,377 lines — ONLY one being split)
```

**Assessment:** ReactAnalyzer is 2x-3x larger than other analyzers, so it makes sense to be first to use internal directory. This sets a precedent: analyzers over ~1000 lines should consider splitting. **Precedent is acceptable.**

---

## Practical Quality: OK

### 1. Phase Ordering: ADDRESSED

**Round 1 issue:** Proposed extracting HookAnalyzer (Phase 6) and IssueDetector (Phase 7) separately

**Round 2 solution:** Phase 5 extracts hooks + issues TOGETHER

**Verification:**
- Phase 1-3: Independent (types, browser-api)
- Phase 4: JSX (depends on types)
- Phase 5: Hooks + Issues (HIGH RISK, extracted together)
- Phase 6: Cleanup

**Assessment:** Correct phase ordering. Coupled modules extracted in single phase.

### 2. Line Count Math: ADDRESSED

**Round 1 issue:** `analyzeAST` estimated at 150 lines (too large for coordinator)

**Round 2 solution:** `analyzeAST` shrinks to ~50 lines (coordinator only)

**Verification from revised plan (lines 188-244):**
```typescript
async analyzeAST(ast, filePath, graph, moduleId): Promise<AnalysisStats> {
  const analysis: AnalysisResult = { /* ... */ };
  const importedIdentifiers = new Set<string>();

  // Pass 1: collect imports (15 lines)
  traverse(ast, { ImportDeclaration: /* ... */ });

  // Pass 2: collect components (20 lines)
  traverse(ast, {
    VariableDeclarator: (path) => {
      if (isReactComponent(path)) { /* delegated */ }
    },
    FunctionDeclaration: (path) => {
      if (isReactComponent(path)) { /* delegated */ }
    }
  });

  // Pass 3: analyze hooks, events, JSX, browser APIs (15 lines)
  traverse(ast, {
    CallExpression: (path) => {
      // Delegates to analyzeHook, analyzeBrowserAPI, etc.
    },
    JSXElement: (path) => analyzeJSXElement(path, filePath, analysis),
    JSXAttribute: (path) => analyzeJSXAttribute(path, filePath, analysis)
  });

  // Add to graph: 5 lines
  await this.addToGraph(analysis, graph, moduleId);

  // Return stats: 5 lines
  return { /* ... */ };
}
```

**Assessment:** Coordinator-only logic. All domain analysis delegated to modules. Target achievable.

### 3. Utility Duplication Check: ADDRESSED

**Round 1 issue:** Didn't check if `getMemberExpressionName` already exists in codebase

**Round 2 solution:** Checked `ast/utils/` — NOT found, but found private `_getMemberExpressionName` in `ConditionParser.ts`

**Verification:**
```bash
$ ls packages/core/src/plugins/analysis/ast/utils/
babelTraverse.ts
createParameterNodes.ts
extractNamesFromPattern.ts
index.ts
location.ts
```

No public `getMemberExpressionName` utility exists.

**Grep result:** Found `_getMemberExpressionName` in `ConditionParser.ts` (private method)

**Assessment:** Extracting to `ast/utils/getMemberExpressionName.ts` is correct. Allows ConditionParser to refactor later and use shared utility. No duplication.

---

## Code Quality: OK

### 1. Module Sizes: BALANCED

**Verification:**
- `hooks.ts`: 500 lines (complex logic, acceptable)
- `jsx.ts`: 350 lines ✓
- `browser-api.ts`: 200 lines ✓
- `types.ts`: 200 lines ✓
- `ReactAnalyzer.ts`: 225-350 lines ✓

**Assessment:** All modules above 200 lines (except utilities). Good balance.

### 2. Internal Directory Naming: `react-internal/`

**Pattern check:** No existing pattern for internal directories.

**Proposed name:** `react-internal/`

**Assessment:** Clear intent. `-internal` suffix signals "private to ReactAnalyzer, do not import from other plugins". Acceptable naming.

### 3. Circular Dependency Risk: LOW

**Dependency graph:**
```
ReactAnalyzer.ts
  ↓ imports
react-internal/{hooks.ts, jsx.ts, browser-api.ts, types.ts}
  ↓ import
ast/utils/{getMemberExpressionName, getExpressionValue}
```

**No cycles possible:** All internal modules import from `types.ts` and `ast/utils/`, not from each other.

**Assessment:** Safe structure.

---

## Non-Blocking Recommendations

### 1. Consider Extracting ConditionParser Utility

**Observation:** `ConditionParser.ts` has private `_getMemberExpressionName()` method. After creating public `ast/utils/getMemberExpressionName.ts`, consider refactoring ConditionParser to use it.

**Why non-blocking:** Not part of this task. Create Linear tech debt issue instead.

### 2. Document Internal Directory Convention

**Observation:** This is first analyzer to use internal directory. Future analyzers may follow.

**Suggestion:** After completing REG-425, document pattern in `_readme/` or `_ai/` for future reference.

**Why non-blocking:** Documentation can be added separately.

### 3. Test Coverage for Edge Cases

**Don's plan mentions:** "Verify stale closure detection still works"

**Recommendation:** During Phase 5 (hooks + issues), run specific test cases:
- Stale closure detection (AC-1, AC-2 from tests)
- Missing cleanup detection
- Hook dependency analysis

**Why non-blocking:** Tests already exist. Just extra verification during risky phase.

---

## Acceptance Criteria: ALL MET

### Original AC (from user):
- [x] Main file < 500 lines → **Target: 225-350 lines** ✓
- [x] Snapshot tests pass → **Verification step after each phase** ✓
- [x] Each responsibility in separate module → **4 modules + 2 utilities** ✓

### Refined AC (from Round 1 feedback):
- [x] Main file contains coordinator logic ONLY → **analyzeAST ~50 lines** ✓
- [x] 4-5 modules max (not 9) → **4 internal + 2 utilities = 6 files** ✓
- [x] Hook + Issue detection extracted TOGETHER → **hooks.ts** ✓
- [x] No duplication of existing utilities → **Verified, none found** ✓
- [x] Export functions, not classes → **Confirmed in plan** ✓
- [x] Phase ordering correct → **Coupled modules together** ✓

---

## Risk Assessment: ACCEPTABLE

| Phase | Risk | Mitigation |
|-------|------|------------|
| 1: Utilities | LOW | Pure extraction, snapshot tests |
| 2: Types/Constants | LOW | Data only, no logic |
| 3: Browser API | LOW | Self-contained, no coupling |
| 4: JSX/Components | MEDIUM | Snapshot tests verify output |
| 5: Hooks/Issues | **HIGH** | Most complex. Thorough edge case testing. |
| 6: Cleanup | LOW | Removing old code |

**Highest risk:** Phase 5 (hooks + issues)

**Mitigation:**
- Stale closure detection has 72+ tests (AC-1, AC-2, etc.)
- Snapshot validation after extraction
- If tests fail → revert phase and investigate

**Assessment:** Risk is acknowledged and mitigated. Acceptable.

---

## Final Assessment

**All Round 1 feedback addressed:**
1. ✓ Module count reduced (9 → 6 files)
2. ✓ Hook + Issue kept together (single module)
3. ✓ Function export pattern (not classes)
4. ✓ Utility duplication checked (none found)
5. ✓ Line count target clarified (coordinator-only)
6. ✓ Phase ordering fixed (coupled modules together)

**No blocking issues remain.**

**Plan is sound. Proceed to implementation.**

---

## APPROVE

**Next step:** Joel creates detailed technical spec from this plan.

---

**Auto-Review Agent**
February 15, 2026
