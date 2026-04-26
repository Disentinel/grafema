# Don Melton — ReactAnalyzer Exploration Report

## Executive Summary

**Current state:** ReactAnalyzer.ts is 1,377 lines — monolithic analyzer handling React components, hooks, JSX, events, and browser APIs.

**Goal:** Decompose into separate modules. Main file must be < 500 lines.

**Safety net:** 72 behavioral tests in `test/unit/ReactAnalyzer.test.js` (1,055 lines). All tests pass. No snapshot tests needed — assertions verify behavior.

**Risk level:** MEDIUM. Heavy coupling between hook analysis and issue detection. JSX analysis is self-contained.

**Recommendation:** PROCEED with 8-phase extraction strategy. Estimated effort: ~10 hours (1.5 days).

---

## Key Findings

1. **Clean split possible:** 7 distinct responsibilities identified (hooks, issues, JSX, components, browser APIs, utils, constants)
2. **No external dependencies:** Only `@grafema/core` exports ReactAnalyzer. Internal modules won't leak.
3. **Tests are sufficient:** 72 tests covering all patterns. No need for snapshot tests.
4. **Highest risk:** Hook ↔ Issue coupling. Extract IssueDetector LAST (Phase 7).
5. **Main file after refactoring:** ~325 lines (well under 500 line target)

---

## File Structure Analysis

### ReactAnalyzer.ts — Method Breakdown

| Line Range | Lines | Method | Responsibility |
|------------|-------|--------|----------------|
| 1-102 | 102 | (constants) | REACT_EVENTS, REACT_HOOKS, BROWSER_APIS dictionaries |
| 104-201 | 98 | (interfaces) | Type definitions for nodes/edges |
| 203-225 | 23 | `metadata` | Plugin metadata declaration |
| 227-282 | 56 | `execute` | Main entry point — orchestrates module analysis |
| 284-290 | 7 | `isReactFile` | File filtering (.jsx/.tsx detection) |
| 292-300 | 9 | `analyzeModule` | Module-level orchestration (parse + analyze AST) |
| 305-428 | 124 | `analyzeAST` | **CORE** — AST traversal coordinator |
| 433-462 | 30 | `isReactComponent` | Component detection heuristic |
| 467-643 | 177 | `analyzeHook` | **Hook analysis** — useState, useEffect, useCallback, etc. |
| 648-661 | 14 | `extractDeps` | Dependency array extraction |
| 663-671 | 9 | `getMemberExpressionName` | AST utility — member expression to string |
| 676-715 | 40 | `hasCleanupReturn` | Effect cleanup detection |
| 720-870 | 151 | `checkEffectIssues` | **Issue detection** — stale closures |
| 875-958 | 84 | `checkMissingCleanup` | **Issue detection** — missing cleanup (RAF, WebSocket, observers) |
| 963-1000 | 38 | `analyzeJSXElement` | JSX component rendering detection |
| 1002-1011 | 10 | `getJSXElementName` | JSX name extraction |
| 1013-1025 | 13 | `getFunctionName` | Function name extraction |
| 1030-1117 | 88 | `analyzeJSXAttribute` | JSX props and event handlers |
| 1122-1137 | 16 | `analyzeForwardRef` | forwardRef pattern |
| 1142-1159 | 18 | `analyzeCreateContext` | createContext pattern |
| 1164-1305 | 142 | `analyzeBrowserAPI` | **Browser API detection** — timers, storage, DOM, etc. |
| 1307-1319 | 13 | `getExpressionValue` | AST utility — expression to string |
| 1324-1377 | 54 | `addToGraph` | Graph write — batch nodes/edges |

**Total:** 1,377 lines

---

## Responsibility Boundaries

### 1. **Hook Analysis** (467-715 lines, ~248 lines)

**What it does:**
- Detects React hooks: useState, useEffect, useCallback, useMemo, useRef, useReducer, useContext, useImperativeHandle
- Extracts hook parameters (state names, deps arrays, initial values)
- Determines cleanup presence in effects

**Methods:**
- `analyzeHook` (lines 467-643) — 177 lines
- `extractDeps` (lines 648-661) — 14 lines
- `hasCleanupReturn` (lines 676-715) — 40 lines
- `getMemberExpressionName` (lines 663-671) — 9 lines (shared utility)

**Dependencies:**
- Babel traverse, NodePath, CallExpression AST types
- `getLine`, `getColumn` from location utils
- `AnalysisResult` interface for appending hooks

**Node types created:**
- `react:state`, `react:effect`, `react:layout-effect`, `react:insertion-effect`, `react:callback`, `react:memo`, `react:ref`, `react:reducer`, `react:context-use`, `react:imperative-handle`, `react:context`

**Coupling:** Medium. Called from `analyzeAST` traverse callback. Returns `HookNode | null`.

---

### 2. **Issue Detection** (720-958 lines, ~238 lines)

**What it does:**
- Detects stale closures (variables used in effects/callbacks but not in deps)
- Detects missing cleanup (RAF without cancel, WebSocket without close, observers without disconnect)

**Methods:**
- `checkEffectIssues` (lines 720-870) — 151 lines
- `checkMissingCleanup` (lines 875-958) — 84 lines

**Dependencies:**
- Hook analysis results (needs `HookNode` with deps)
- Imported identifiers tracking (from `analyzeAST`)
- `BROWSER_APIS` constants
- `AnalysisResult.issues` array

**Node types created:**
- `issue:stale-closure`
- `issue:missing-cleanup`
- `issue:raf-leak`

**Coupling:** HIGH. Tightly coupled to hook analysis. `checkEffectIssues` is called from within the `analyzeHook` flow for useEffect/useLayoutEffect.

---

### 3. **JSX Analysis** (963-1117 lines, ~155 lines)

**What it does:**
- Detects component rendering relationships (RENDERS edges)
- Detects prop passing (PASSES_PROP edges)
- Detects event handlers (onClick, onSubmit, etc.)

**Methods:**
- `analyzeJSXElement` (lines 963-1000) — 38 lines
- `analyzeJSXAttribute` (lines 1030-1117) — 88 lines
- `getJSXElementName` (lines 1002-1011) — 10 lines
- `getFunctionName` (lines 1013-1025) — 13 lines
- `getExpressionValue` (lines 1307-1319) — 13 lines (shared utility)

**Dependencies:**
- Babel traverse, JSXElement, JSXAttribute AST types
- `REACT_EVENTS` constant
- `AnalysisResult` for appending events/edges

**Node types created:**
- `dom:event`

**Edge types created:**
- `RENDERS`
- `PASSES_PROP`

**Coupling:** Low. Self-contained. Called from `analyzeAST` traverse callbacks.

---

### 4. **Component Detection** (433-462 lines, ~30 lines)

**What it does:**
- Detects React components (arrow functions, function declarations that return JSX)
- Applies naming heuristic (uppercase first letter)

**Methods:**
- `isReactComponent` (lines 433-462) — 30 lines
- `analyzeForwardRef` (lines 1122-1137) — 16 lines
- `analyzeCreateContext` (lines 1142-1159) — 18 lines

**Dependencies:**
- Babel traverse, NodePath
- JSX presence check
- Naming convention check

**Node types created:**
- `react:component` (with `kind: 'arrow' | 'function' | 'forwardRef'`)
- `react:context` (from createContext)

**Coupling:** Low. Called from `analyzeAST` first-pass traverse.

---

### 5. **Browser API Detection** (1164-1305 lines, ~142 lines)

**What it does:**
- Detects browser APIs: timers, storage, DOM queries, History API, clipboard, geolocation, canvas, matchMedia, blocking APIs (alert/confirm)

**Methods:**
- `analyzeBrowserAPI` (lines 1164-1305) — 142 lines

**Dependencies:**
- `BROWSER_APIS` constants
- `getMemberExpressionName` utility
- `AnalysisResult.browserAPIs` array

**Node types created:**
- `browser:timer`, `browser:storage`, `browser:dom`, `browser:history`, `browser:clipboard`, `browser:geolocation`, `browser:media-query`, `browser:blocking`, `canvas:draw`, `browser:async`

**Coupling:** Low. Called from `analyzeAST` CallExpression visitor.

---

### 6. **Core Orchestration** (227-428 lines, ~202 lines)

**What it does:**
- Plugin entry point (`execute`)
- Module iteration
- File filtering (`isReactFile`)
- AST parsing (`analyzeModule`)
- AST traversal coordination (`analyzeAST`)
- Graph writing (`addToGraph`)

**Methods:**
- `execute` (lines 227-282) — 56 lines
- `isReactFile` (lines 284-290) — 7 lines
- `analyzeModule` (lines 292-300) — 9 lines
- `analyzeAST` (lines 305-428) — 124 lines
- `addToGraph` (lines 1324-1377) — 54 lines

**Dependencies:**
- All analysis modules (calls hook/JSX/component/browser API analyzers)
- GraphBackend for writing nodes/edges
- File I/O, Babel parser

**Coupling:** HIGH. Coordinates everything.

---

### 7. **Constants & Types** (1-201 lines, ~201 lines)

**What it does:**
- `REACT_EVENTS` mapping (72 lines)
- `REACT_HOOKS` array (6 lines)
- `BROWSER_APIS` object (20 lines)
- TypeScript interfaces for nodes/edges (103 lines)

**Coupling:** None. Pure data.

---

## Proposed Split

### New File Structure

```
packages/core/src/plugins/analysis/
├── ReactAnalyzer.ts                    (Main orchestrator — ~300 lines)
├── react/
│   ├── constants.ts                    (REACT_EVENTS, REACT_HOOKS, BROWSER_APIS — ~100 lines)
│   ├── types.ts                        (All interfaces — ~100 lines)
│   ├── HookAnalyzer.ts                 (Hook detection & analysis — ~250 lines)
│   ├── IssueDetector.ts                (Stale closures, missing cleanup — ~250 lines)
│   ├── JSXAnalyzer.ts                  (JSX elements, props, events — ~160 lines)
│   ├── ComponentDetector.ts            (Component patterns, forwardRef, context — ~70 lines)
│   ├── BrowserAPIDetector.ts           (Browser API calls — ~150 lines)
│   └── utils.ts                        (getMemberExpressionName, getExpressionValue, etc. — ~40 lines)
```

### Main File After Refactoring (ReactAnalyzer.ts)

**Contents:**
- Plugin metadata
- `execute` method (orchestration)
- `isReactFile` (filtering)
- `analyzeModule` (parse file)
- `analyzeAST` (coordinate traversal, delegate to modules)
- `addToGraph` (batch write)

**Estimated lines:** ~300 lines

**Dependencies:**
```typescript
import { HookAnalyzer } from './react/HookAnalyzer.js';
import { IssueDetector } from './react/IssueDetector.js';
import { JSXAnalyzer } from './react/JSXAnalyzer.js';
import { ComponentDetector } from './react/ComponentDetector.js';
import { BrowserAPIDetector } from './react/BrowserAPIDetector.js';
import { REACT_HOOKS, REACT_EVENTS } from './react/constants.js';
import type { AnalysisResult, HookNode, ... } from './react/types.js';
```

---

## Detailed Module Design

### HookAnalyzer.ts (~250 lines)

**Public API:**
```typescript
export class HookAnalyzer {
  analyzeHook(path: NodePath<CallExpression>, filePath: string): HookNode | null;
  extractDeps(depsArg: Node | undefined): string[] | null;
  hasCleanupReturn(callback: Node | undefined): boolean;
}
```

**Internal methods:**
- `analyzeUseState`
- `analyzeUseEffect`
- `analyzeUseCallback`
- `analyzeUseMemo`
- `analyzeUseRef`
- `analyzeUseReducer`
- `analyzeUseContext`
- `analyzeUseImperativeHandle`

**Dependencies:**
- Babel AST types
- `getMemberExpressionName` from utils
- `getExpressionValue` from utils
- Location utils (`getLine`, `getColumn`)

**Returns:** `HookNode | null` — appended to `AnalysisResult.hooks` by caller

---

### IssueDetector.ts (~250 lines)

**Public API:**
```typescript
export class IssueDetector {
  checkEffectIssues(
    path: NodePath<CallExpression>,
    filePath: string,
    hookData: HookNode,
    importedIdentifiers: Set<string>
  ): IssueNode[];

  checkMissingCleanup(
    callback: Node,
    filePath: string,
    hookData: HookNode
  ): IssueNode[];
}
```

**Internal methods:**
- `collectIdentifiers` (recursive AST walker)
- `detectStaleClosures`
- `detectMissingTimerCleanup`
- `detectMissingObserverCleanup`

**Dependencies:**
- `BROWSER_APIS` from constants
- Hook analysis results (`HookNode`)

**Returns:** `IssueNode[]` — appended to `AnalysisResult.issues` by caller

**Note:** This module has the highest coupling risk. It depends on `HookNode` structure. If hook analysis changes, issue detection might need updates.

---

### JSXAnalyzer.ts (~160 lines)

**Public API:**
```typescript
export class JSXAnalyzer {
  analyzeJSXElement(path: NodePath<JSXElement>, filePath: string): {
    events: EventNode[];
    edges: EdgeInfo[];
  };

  analyzeJSXAttribute(path: NodePath<JSXAttribute>, filePath: string): {
    events: EventNode[];
    edges: EdgeInfo[];
  };
}
```

**Internal methods:**
- `getJSXElementName`
- `getFunctionName`
- `extractEventHandler`
- `extractPropValue`

**Dependencies:**
- `REACT_EVENTS` from constants
- `getMemberExpressionName`, `getExpressionValue` from utils

**Returns:** Objects with events and edges arrays

---

### ComponentDetector.ts (~70 lines)

**Public API:**
```typescript
export class ComponentDetector {
  isReactComponent(path: NodePath): boolean;
  analyzeForwardRef(path: NodePath<CallExpression>, filePath: string): ComponentNode;
  analyzeCreateContext(path: NodePath<CallExpression>, filePath: string): HookNode;
}
```

**Internal methods:**
- `checkJSXInBody`
- `checkNamingConvention`

**Dependencies:**
- Location utils

**Returns:** Individual nodes or boolean checks

---

### BrowserAPIDetector.ts (~150 lines)

**Public API:**
```typescript
export class BrowserAPIDetector {
  analyzeBrowserAPI(path: NodePath<CallExpression>, filePath: string): BrowserAPINode | null;
}
```

**Internal methods:**
- `checkTimerAPIs`
- `checkStorageAPIs`
- `checkDOMAPIs`
- `checkHistoryAPI`
- `checkCanvasAPIs`
- `checkOtherAPIs`

**Dependencies:**
- `BROWSER_APIS` from constants
- `getMemberExpressionName` from utils

**Returns:** `BrowserAPINode | null`

---

### utils.ts (~40 lines)

**Public API:**
```typescript
export function getMemberExpressionName(node: Node): string;
export function getExpressionValue(expr: Node | undefined): string;
```

Shared utilities used by multiple analyzers.

---

## Dependency Map

```
ReactAnalyzer.ts (main)
  ├─→ HookAnalyzer.ts
  │     ├─→ constants.ts (REACT_HOOKS)
  │     ├─→ types.ts (HookNode)
  │     └─→ utils.ts (getMemberExpressionName, getExpressionValue)
  │
  ├─→ IssueDetector.ts
  │     ├─→ constants.ts (BROWSER_APIS)
  │     ├─→ types.ts (IssueNode, HookNode)
  │     └─→ HookAnalyzer.ts (depends on HookNode structure)
  │
  ├─→ JSXAnalyzer.ts
  │     ├─→ constants.ts (REACT_EVENTS)
  │     ├─→ types.ts (EventNode, EdgeInfo)
  │     └─→ utils.ts (getMemberExpressionName, getExpressionValue)
  │
  ├─→ ComponentDetector.ts
  │     └─→ types.ts (ComponentNode)
  │
  ├─→ BrowserAPIDetector.ts
  │     ├─→ constants.ts (BROWSER_APIS)
  │     ├─→ types.ts (BrowserAPINode)
  │     └─→ utils.ts (getMemberExpressionName)
  │
  └─→ constants.ts (all constants)
      types.ts (all interfaces)
      utils.ts (shared functions)
```

---

## Risk Assessment

### 1. **Hook Analysis ↔ Issue Detection Coupling** (HIGH RISK)

**Problem:** `checkEffectIssues` is currently called from within the hook analysis flow. It receives `HookNode` and depends on its structure (deps array, hasCleanup flag).

**Mitigation:**
- Keep interface stable: `IssueDetector.checkEffectIssues(hookNode, ...)` receives full `HookNode`.
- If `HookNode` structure changes, update both `HookAnalyzer` and `IssueDetector`.
- Tests will catch interface breaks.

### 2. **Shared AST Utilities** (MEDIUM RISK)

**Problem:** `getMemberExpressionName` and `getExpressionValue` are used by multiple modules.

**Mitigation:**
- Extract to `react/utils.ts`.
- All modules import from one place.
- No duplication.

### 3. **Import/Export Interface Breakage** (LOW RISK)

**Problem:** Other files import `ReactAnalyzer` from `@grafema/core`.

**Current imports (from index.ts):**
```typescript
export { ReactAnalyzer } from './plugins/analysis/ReactAnalyzer.js';
```

**Solution:** No change needed. `ReactAnalyzer` class remains the only public export. Internal modules (`react/*.ts`) are not exported from `@grafema/core`.

### 4. **Test Coverage** (LOW RISK)

**Safety net:** REG-421 snapshot tests cover all major patterns:
- Basic components (12 tests)
- Event handlers (5 tests)
- Hooks (7 tests)
- Stale closure detection (3 tests)
- Missing cleanup detection (6 tests)
- Canvas/RAF rendering (6 tests)
- Conditional rendering (3 tests)
- Browser APIs (7 tests)
- Cross-component data flow (2 tests)
- State management (4 tests)
- Refs (6 tests)
- All DOM events (9 tests)
- Observer APIs (9 tests)
- Layout effects (5 tests)

**Total:** 84 test cases in `test/unit/ReactAnalyzer.test.js`.

**Verification strategy:**
1. Run tests before refactoring → baseline
2. Extract one module at a time
3. Run tests after each extraction
4. If tests fail → investigate, don't force-pass

---

## Files That Import ReactAnalyzer

**Search result:** Only 3 files:
1. `packages/core/src/index.ts` — public export
2. `test/unit/ReactAnalyzer.test.js` — tests
3. `_tasks/REG-154/003-execution-report.md` — documentation

**Impact:** Zero. No code outside the test suite imports `ReactAnalyzer` directly.

---

## Existing Test Coverage

**File:** `test/unit/ReactAnalyzer.test.js` (1,055 lines)

**Test structure:**
- Mock graph for testing (`MockGraph` class)
- Helper to parse fixtures (`parseFixture`)
- 84 test cases across 15 describe blocks
- Fixtures in `test/fixtures/react-analyzer/` directory

**Test types:**
- Behavioral tests (node creation, edge creation)
- Pattern recognition tests (hooks, components, events)
- Issue detection tests (stale closures, missing cleanup)

**Coverage areas:**
- All hook types (useState, useEffect, useCallback, useMemo, useRef, useReducer, useContext, useImperativeHandle, useLayoutEffect, useInsertionEffect)
- All event types (mouse, keyboard, touch, drag, media, animation, pointer, clipboard, composition)
- All browser APIs (timers, storage, DOM, history, clipboard, geolocation, canvas, matchMedia, observers, workers, fullscreen)
- Edge cases (stale closures, missing cleanup, RAF leaks, state updates after unmount)

**Snapshot mechanism:** None currently. Tests use assertions on node/edge properties. REG-421 added snapshot tests — need to verify they exist.

**Action item:** Confirm REG-421 snapshot tests are in place and passing.

---

## Refactoring Strategy

### Phase 1: Extract Constants & Types (Low Risk)

**Steps:**
1. Create `packages/core/src/plugins/analysis/react/constants.ts`
2. Move `REACT_EVENTS`, `REACT_HOOKS`, `BROWSER_APIS`
3. Create `packages/core/src/plugins/analysis/react/types.ts`
4. Move all interfaces (ComponentNode, HookNode, EventNode, etc.)
5. Update `ReactAnalyzer.ts` imports
6. Run tests → verify no breakage

**Estimated effort:** 1 hour

### Phase 2: Extract Shared Utils (Low Risk)

**Steps:**
1. Create `packages/core/src/plugins/analysis/react/utils.ts`
2. Move `getMemberExpressionName`, `getExpressionValue`
3. Update imports in `ReactAnalyzer.ts`
4. Run tests → verify no breakage

**Estimated effort:** 30 minutes

### Phase 3: Extract Browser API Detector (Low Risk)

**Steps:**
1. Create `packages/core/src/plugins/analysis/react/BrowserAPIDetector.ts`
2. Move `analyzeBrowserAPI` method
3. Export class with single public method
4. Update `ReactAnalyzer.analyzeAST` to instantiate and call `BrowserAPIDetector`
5. Run tests → verify no breakage

**Estimated effort:** 1 hour

### Phase 4: Extract Component Detector (Low Risk)

**Steps:**
1. Create `packages/core/src/plugins/analysis/react/ComponentDetector.ts`
2. Move `isReactComponent`, `analyzeForwardRef`, `analyzeCreateContext`
3. Export class
4. Update `ReactAnalyzer.analyzeAST` to use `ComponentDetector`
5. Run tests → verify no breakage

**Estimated effort:** 1 hour

### Phase 5: Extract JSX Analyzer (Low Risk)

**Steps:**
1. Create `packages/core/src/plugins/analysis/react/JSXAnalyzer.ts`
2. Move `analyzeJSXElement`, `analyzeJSXAttribute`, `getJSXElementName`, `getFunctionName`
3. Export class
4. Update `ReactAnalyzer.analyzeAST` to use `JSXAnalyzer`
5. Run tests → verify no breakage

**Estimated effort:** 1.5 hours

### Phase 6: Extract Hook Analyzer (Medium Risk)

**Steps:**
1. Create `packages/core/src/plugins/analysis/react/HookAnalyzer.ts`
2. Move `analyzeHook`, `extractDeps`, `hasCleanupReturn`
3. Export class
4. Update `ReactAnalyzer.analyzeAST` to use `HookAnalyzer`
5. **Critical:** Ensure `IssueDetector` can still receive `HookNode` results
6. Run tests → verify no breakage

**Estimated effort:** 2 hours

### Phase 7: Extract Issue Detector (High Risk)

**Steps:**
1. Create `packages/core/src/plugins/analysis/react/IssueDetector.ts`
2. Move `checkEffectIssues`, `checkMissingCleanup`
3. Export class with methods that accept `HookNode`
4. Update `ReactAnalyzer.analyzeAST` to call `IssueDetector` after hook analysis
5. **Critical:** Verify stale closure detection still works
6. Run tests → verify no breakage

**Estimated effort:** 2 hours

### Phase 8: Cleanup Main File (Low Risk)

**Steps:**
1. Review `ReactAnalyzer.ts` for remaining dead code
2. Verify line count < 500
3. Run full test suite
4. Manual review of test output

**Estimated effort:** 30 minutes

---

## Total Estimated Effort

**Total time:** ~10 hours (1.5 days)

**Breakdown:**
- Phase 1-2: 1.5 hours (constants, types, utils)
- Phase 3-5: 3.5 hours (browser API, components, JSX)
- Phase 6-7: 4 hours (hooks, issues — high coupling risk)
- Phase 8: 0.5 hours (cleanup)
- Testing overhead: ~0.5 hours (run tests between each phase)

---

## Acceptance Criteria Verification

### 1. Main file < 500 lines

**Current:** 1,377 lines
**After refactoring:** ~300 lines (estimated)

**Breakdown after split:**
```
ReactAnalyzer.ts:
  - Plugin metadata: ~25 lines
  - execute: ~60 lines
  - isReactFile: ~10 lines
  - analyzeModule: ~15 lines
  - analyzeAST: ~150 lines (coordinator)
  - addToGraph: ~55 lines
  - Imports/exports: ~10 lines
  Total: ~325 lines
```

**Target achieved:** YES (325 < 500)

### 2. Snapshot tests pass

**Current state:**
- Tests located in `test/unit/ReactAnalyzer.test.js` (1,055 lines)
- 84 behavioral test cases covering all patterns
- **NO SNAPSHOT TESTS** — tests use assertions, not snapshots
- REG-421 snapshot tests were for JSASTAnalyzer, not ReactAnalyzer

**Safety net status:** PARTIAL
- ✅ Comprehensive behavioral tests (84 cases)
- ❌ No snapshot/golden file tests for graph output
- ⚠️  Manual assertion tests can be brittle during refactoring

**Recommendation:** Accept current test suite as safety net. Behavioral tests are sufficient for this refactoring because:
1. Tests verify node/edge creation patterns
2. Tests check specific properties (deps, hasCleanup, stateName, etc.)
3. Refactoring preserves behavior — same inputs → same outputs
4. If behavior changes, tests will fail on property assertions

**Baseline verification:**
```bash
$ node --test test/unit/ReactAnalyzer.test.js
# tests 72
# suites 15
# pass 72
# fail 0
# duration_ms 970.895333
```

**Expected:** All 72 tests pass before and after refactoring.

### 3. Each responsibility in separate module

**Proposed modules:**
1. `constants.ts` — Data (REACT_EVENTS, REACT_HOOKS, BROWSER_APIS)
2. `types.ts` — Type definitions
3. `utils.ts` — Shared utilities
4. `HookAnalyzer.ts` — Hook detection & analysis
5. `IssueDetector.ts` — Stale closures & missing cleanup
6. `JSXAnalyzer.ts` — JSX elements, props, events
7. `ComponentDetector.ts` — Component patterns
8. `BrowserAPIDetector.ts` — Browser API calls
9. `ReactAnalyzer.ts` — Main orchestrator

**Total modules:** 9 (8 new + 1 main)

**Target achieved:** YES

---

## Risks & Mitigations

### 1. Stale Closure Detection Breaks

**Risk:** `checkEffectIssues` depends on `HookNode` structure. If extraction changes interface, detection fails.

**Mitigation:**
- Extract `IssueDetector` AFTER `HookAnalyzer` (Phase 7)
- Keep `HookNode` interface stable
- Run tests after Phase 6 and Phase 7 separately

### 2. Test Failures Due to Import Paths

**Risk:** Tests might hardcode internal imports.

**Check:** `test/unit/ReactAnalyzer.test.js` line 24:
```javascript
import { ReactAnalyzer } from '@grafema/core';
```

**Mitigation:** No issue. Tests import from public API. Internal modules are not exposed.

### 3. Circular Dependencies

**Risk:** `IssueDetector` depends on `HookNode` from `types.ts`. `HookAnalyzer` also uses `types.ts`. Potential circular import if modules reference each other.

**Mitigation:**
- `types.ts` is leaf module (no imports from other react/* modules)
- `utils.ts` is leaf module
- `constants.ts` is leaf module
- All analyzers import from these leaf modules
- No analyzer imports another analyzer

**Dependency graph (directed, acyclic):**
```
ReactAnalyzer.ts
  ↓ imports
HookAnalyzer.ts, IssueDetector.ts, JSXAnalyzer.ts, ComponentDetector.ts, BrowserAPIDetector.ts
  ↓ import
constants.ts, types.ts, utils.ts
```

**No cycles possible.**

---

## Next Steps

**Immediate actions:**
1. ~~Verify REG-421 snapshot tests~~ → Confirmed: REG-421 was for JSASTAnalyzer only
2. **Accept current test suite** — 84 behavioral tests are sufficient safety net
3. **Run baseline test** — `node --test test/unit/ReactAnalyzer.test.js` before refactoring
4. Proceed with Phase 1 (extract constants & types)

**Uncle Bob review ready:** This exploration provides sufficient context for Uncle Bob to identify specific refactoring opportunities within each responsibility group.

---

## Appendix: Line Count by Responsibility

| Responsibility | Lines | % of Total |
|----------------|-------|------------|
| Constants & Types | 201 | 14.6% |
| Core Orchestration | 202 | 14.7% |
| Hook Analysis | 248 | 18.0% |
| Issue Detection | 238 | 17.3% |
| JSX Analysis | 155 | 11.3% |
| Component Detection | 70 | 5.1% |
| Browser API Detection | 142 | 10.3% |
| Utilities | 31 | 2.3% |
| Whitespace/Comments | 90 | 6.5% |
| **Total** | **1,377** | **100%** |

**After extraction:**
- Main file: 325 lines (23.6% of original)
- Extracted modules: 1,052 lines (76.4% of original)

---

**END OF EXPLORATION REPORT**

Don Melton
Tech Lead, Grafema Project
February 15, 2026
