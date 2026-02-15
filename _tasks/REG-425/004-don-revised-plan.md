# Don's Revised Plan: REG-425 — ReactAnalyzer Refactoring

**Status:** Revised after Auto-Review REJECT
**Date:** 2026-02-15

---

## Auto-Review Feedback Summary

1. **9 files → 4-5 files** (over-fragmentation)
2. **Extract Hook + Issue together** (they're coupled, not separate)
3. **Use functions, not classes** (match codebase pattern)
4. **Check existing utilities** (avoid duplication)
5. **Fix line count math** (`analyzeAST` should shrink to ~50 lines, not grow to 150)

**All issues addressed below.**

---

## Codebase Pattern Analysis

### Existing Utilities (ast/utils/)

**Found:**
- `getLine()`, `getColumn()` — location utilities (already used)
- `createParameterNodes()` — parameter extraction
- `extractNamesFromPattern()` — pattern matching
- NO `getMemberExpressionName` utility exists

**Conclusion:** `getMemberExpressionName()` (lines 663-671) should be extracted to `ast/utils/` for reuse, not kept in `react-internal/`.

### Existing Analyzer Patterns

**Pattern from ExpressAnalyzer (424 lines):**
```typescript
export class ExpressAnalyzer extends Plugin {
  // Public API
  async execute(context) { ... }

  // Private methods
  private analyzeRoute(...) { }
  private analyzeMiddleware(...) { }
  private extractRouteInfo(...) { }
}
```

**Pattern from FetchAnalyzer (730 lines):**
- Single file, no sub-modules
- All logic in private methods

**Conclusion:** NO analyzer in codebase uses sub-modules. ReactAnalyzer will be FIRST to use internal directory.

**Export pattern:** Functions, not classes. Sub-modules export functions that are called by main analyzer.

### Test Structure Verification

**Current tests (test/unit/ReactAnalyzer.test.js):**
```javascript
import { ReactAnalyzer } from '@grafema/core';
// ✓ Tests import from PUBLIC API only
// ✓ No mocking of internal methods
// ✓ Tests verify graph output (nodes/edges counts)
```

**Conclusion:** Safe to refactor internals. Tests won't break.

---

## Revised Module Structure

### Target: 4 modules (down from 9)

```
packages/core/src/plugins/analysis/
├── ReactAnalyzer.ts                 (~350 lines — coordinator only)
├── react-internal/
│   ├── hooks.ts                     (~500 lines — Hook + Issue detection together)
│   ├── jsx.ts                       (~350 lines — JSX + Components + forwardRef)
│   ├── browser-api.ts               (~200 lines — Browser API detection)
│   └── types.ts                     (~200 lines — Interfaces + Constants)
```

**Rationale:**

1. **hooks.ts (500 lines):**
   - `analyzeHook()` (lines 467-643, 177 lines)
   - `checkEffectIssues()` (lines 720-870, 150 lines)
   - `checkMissingCleanup()` (lines 875-958, 84 lines)
   - Helpers: `extractDeps()`, `hasCleanupReturn()`
   - **Coupling:** `checkEffectIssues` is called FROM `analyzeHook` flow (line 387). Must stay together.

2. **jsx.ts (350 lines):**
   - `isReactComponent()` (lines 433-462, 30 lines)
   - `analyzeJSXElement()` (lines 963-1000, 38 lines)
   - `analyzeJSXAttribute()` (lines 1030-1117, 88 lines)
   - `analyzeForwardRef()` (lines 1122-1137, 16 lines)
   - `analyzeCreateContext()` (lines 1142-1159, 18 lines)
   - Helpers: `getJSXElementName()`, `getFunctionName()`
   - **Coupling:** JSX + Components are related domain logic

3. **browser-api.ts (200 lines):**
   - `analyzeBrowserAPI()` (lines 1164-1305, 142 lines)
   - Helpers: browser API detection logic
   - **Coupling:** None. Self-contained.

4. **types.ts (200 lines):**
   - All interfaces (180 lines)
   - All constants (REACT_EVENTS, REACT_HOOKS, BROWSER_APIS — 103 lines)
   - **Rationale:** Data definitions. No logic.

**What about utilities?**

- `getMemberExpressionName()` (8 lines) → extract to `ast/utils/getMemberExpressionName.ts`
- `getExpressionValue()` (12 lines) → extract to `ast/utils/getExpressionValue.ts`
- Reusable across analyzers, not React-specific

---

## Export Pattern: Functions, Not Classes

**Proposed API (hooks.ts):**

```typescript
import type { NodePath } from '@babel/traverse';
import type { CallExpression } from '@babel/types';
import type { HookNode, IssueNode, AnalysisResult } from './types.js';

/**
 * Analyze React hook call expression
 * Returns hook node data or null if not a recognized hook
 */
export function analyzeHook(
  path: NodePath<CallExpression>,
  filePath: string
): HookNode | null {
  // Implementation
}

/**
 * Check for issues in useEffect/useLayoutEffect
 * Mutates analysis.issues array
 */
export function checkEffectIssues(
  path: NodePath<CallExpression>,
  filePath: string,
  analysis: AnalysisResult,
  hookData: HookNode,
  importedIdentifiers: Set<string>
): void {
  // Implementation
}
```

**Rationale:** Matches existing pattern. No classes in sub-modules. Functions are simpler.

---

## Main File After Refactoring

**ReactAnalyzer.ts (~350 lines):**

```typescript
import { Plugin } from '../Plugin.js';
import { analyzeHook, checkEffectIssues } from './react-internal/hooks.js';
import { analyzeJSXElement, analyzeJSXAttribute, isReactComponent, /* ... */ } from './react-internal/jsx.js';
import { analyzeBrowserAPI } from './react-internal/browser-api.js';
import { REACT_HOOKS, REACT_EVENTS, type AnalysisResult, /* ... */ } from './react-internal/types.js';
import { getMemberExpressionName, getExpressionValue } from '../ast/utils/index.js';

export class ReactAnalyzer extends Plugin {
  // Metadata: 25 lines
  get metadata(): PluginMetadata { /* ... */ }

  // Main loop: 60 lines
  async execute(context): Promise<PluginResult> {
    // Unchanged — orchestration only
  }

  // File filtering: 10 lines
  private isReactFile(filePath: string): boolean { /* ... */ }

  // Module analysis: 15 lines
  private async analyzeModule(module, graph, projectPath): Promise<AnalysisStats> {
    // Parse AST
    // Call analyzeAST
  }

  // AST traversal COORDINATOR: ~50 lines (down from 124)
  async analyzeAST(ast, filePath, graph, moduleId): Promise<AnalysisStats> {
    const analysis: AnalysisResult = { /* ... */ };
    const importedIdentifiers = new Set<string>();

    // Pass 1: collect imports (15 lines)
    traverse(ast, { ImportDeclaration: /* ... */ });

    // Pass 2: collect components (20 lines)
    traverse(ast, {
      VariableDeclarator: (path) => {
        if (isReactComponent(path)) {
          analysis.components.push(/* ... */);
        }
      },
      FunctionDeclaration: (path) => {
        if (isReactComponent(path)) {
          analysis.components.push(/* ... */);
        }
      }
    });

    // Pass 3: analyze hooks, events, JSX, browser APIs (15 lines)
    traverse(ast, {
      CallExpression: (path) => {
        const callee = path.node.callee;

        // Hooks
        if (callee.type === 'Identifier' && REACT_HOOKS.includes(callee.name)) {
          const hookData = analyzeHook(path, filePath);
          if (hookData) {
            analysis.hooks.push(hookData);
            if (callee.name === 'useEffect' || callee.name === 'useLayoutEffect') {
              checkEffectIssues(path, filePath, analysis, hookData, importedIdentifiers);
            }
          }
        }

        // forwardRef, createContext
        if (callee.type === 'Identifier' && callee.name === 'forwardRef') {
          analyzeForwardRef(path, filePath, analysis);
        }
        // ...

        // Browser APIs
        analyzeBrowserAPI(path, filePath, analysis);
      },
      JSXElement: (path) => analyzeJSXElement(path, filePath, analysis),
      JSXAttribute: (path) => analyzeJSXAttribute(path, filePath, analysis)
    });

    // Add to graph: 5 lines
    await this.addToGraph(analysis, graph, moduleId);

    // Return stats: 5 lines
    return { /* ... */ };
  }

  // Graph writing: 55 lines
  private async addToGraph(analysis, graph, moduleId): Promise<void> { /* ... */ }
}
```

**Line count:**
- Imports: 10 lines
- Metadata: 25 lines
- execute: 60 lines
- isReactFile: 10 lines
- analyzeModule: 15 lines
- analyzeAST: **50 lines** (coordinator only, all logic delegated)
- addToGraph: 55 lines
- **Total: 225 lines** (well under 500)

**Why 225, not 350?** Conservative estimate. Including blank lines, comments, edge cases → ~300-350 lines realistic.

---

## Revised Phases

### Phase 1: Extract Shared Utilities (LOW RISK)

**Extract to `ast/utils/`:**

1. `getMemberExpressionName.ts` (15 lines total with docs)
   ```typescript
   import type { Node } from '@babel/types';

   /**
    * Get full name from MemberExpression (e.g., "obj.prop.nested")
    */
   export function getMemberExpressionName(node: Node): string {
     // Implementation from lines 663-671
   }
   ```

2. `getExpressionValue.ts` (20 lines total with docs)
   ```typescript
   import type { Node } from '@babel/types';

   /**
    * Get string representation of expression value
    */
   export function getExpressionValue(expr: Node | undefined): string {
     // Implementation from lines 1307-1319
   }
   ```

3. Update `ast/utils/index.ts`:
   ```typescript
   export { getMemberExpressionName } from './getMemberExpressionName.js';
   export { getExpressionValue } from './getExpressionValue.js';
   ```

**Tests:** None needed (covered by ReactAnalyzer tests).

**Validation:** Run snapshot tests.

---

### Phase 2: Create Internal Directory + Extract Types/Constants (LOW RISK)

**Create:**
- `packages/core/src/plugins/analysis/react-internal/types.ts`

**Move:**
- All interfaces (lines 104-200)
- All constants (lines 27-102)

**Export pattern:**
```typescript
// Constants
export const REACT_EVENTS: Record<string, string> = { /* ... */ };
export const REACT_HOOKS = [ /* ... */ ];
export const BROWSER_APIS = { /* ... */ };

// Interfaces
export interface ComponentNode { /* ... */ }
export interface HookNode { /* ... */ }
export interface AnalysisResult { /* ... */ }
export interface AnalysisStats { /* ... */ }
```

**Update ReactAnalyzer.ts:**
```typescript
import {
  REACT_EVENTS,
  REACT_HOOKS,
  BROWSER_APIS,
  type ComponentNode,
  type HookNode,
  type AnalysisResult,
  type AnalysisStats
} from './react-internal/types.js';
```

**Tests:** Run snapshot tests.

---

### Phase 3: Extract Browser API Detection (LOW RISK)

**Create:**
- `packages/core/src/plugins/analysis/react-internal/browser-api.ts`

**Move:**
- `analyzeBrowserAPI()` method (lines 1164-1305, 142 lines)

**Export:**
```typescript
import type { NodePath } from '@babel/traverse';
import type { CallExpression } from '@babel/types';
import type { BrowserAPINode, AnalysisResult } from './types.js';
import { BROWSER_APIS } from './types.js';
import { getLine } from '../ast/utils/location.js';
import { getMemberExpressionName } from '../ast/utils/index.js';

/**
 * Analyze browser API calls (timers, storage, DOM, etc.)
 * Mutates analysis.browserAPIs array
 */
export function analyzeBrowserAPI(
  path: NodePath<CallExpression>,
  filePath: string,
  analysis: AnalysisResult
): void {
  // Implementation
}
```

**Update ReactAnalyzer.ts:**
```typescript
import { analyzeBrowserAPI } from './react-internal/browser-api.js';

// In analyzeAST traverse:
CallExpression: (path) => {
  // ... hook logic ...
  analyzeBrowserAPI(path, filePath, analysis);
}
```

**Tests:** Run snapshot tests.

---

### Phase 4: Extract JSX + Component Logic (MEDIUM RISK)

**Create:**
- `packages/core/src/plugins/analysis/react-internal/jsx.ts`

**Move:**
- `isReactComponent()` (lines 433-462)
- `analyzeJSXElement()` (lines 963-1000)
- `analyzeJSXAttribute()` (lines 1030-1117)
- `analyzeForwardRef()` (lines 1122-1137)
- `analyzeCreateContext()` (lines 1142-1159)
- `getJSXElementName()` (lines 1002-1011)
- `getFunctionName()` (lines 1013-1025)

**Export:**
```typescript
import type { NodePath } from '@babel/traverse';
import type { JSXElement, JSXAttribute, CallExpression, VariableDeclarator, FunctionDeclaration } from '@babel/types';
import type { ComponentNode, EventNode, HookNode, AnalysisResult } from './types.js';
import { REACT_EVENTS } from './types.js';
import { getLine, getColumn } from '../ast/utils/location.js';
import { getMemberExpressionName, getExpressionValue } from '../ast/utils/index.js';

/**
 * Check if function path is a React component (returns JSX)
 */
export function isReactComponent(path: NodePath): boolean { /* ... */ }

/**
 * Analyze JSX element for component rendering
 */
export function analyzeJSXElement(
  path: NodePath<JSXElement>,
  filePath: string,
  analysis: AnalysisResult
): void { /* ... */ }

/**
 * Analyze JSX attribute for props and event handlers
 */
export function analyzeJSXAttribute(
  path: NodePath<JSXAttribute>,
  filePath: string,
  analysis: AnalysisResult
): void { /* ... */ }

/**
 * Analyze forwardRef usage
 */
export function analyzeForwardRef(
  path: NodePath<CallExpression>,
  filePath: string,
  analysis: AnalysisResult
): void { /* ... */ }

/**
 * Analyze createContext usage
 */
export function analyzeCreateContext(
  path: NodePath<CallExpression>,
  filePath: string,
  analysis: AnalysisResult
): void { /* ... */ }

// Internal helpers (not exported)
function getJSXElementName(nameNode: Node): string { /* ... */ }
function getFunctionName(path: NodePath): string | null { /* ... */ }
```

**Update ReactAnalyzer.ts:**
```typescript
import {
  isReactComponent,
  analyzeJSXElement,
  analyzeJSXAttribute,
  analyzeForwardRef,
  analyzeCreateContext
} from './react-internal/jsx.js';
```

**Tests:** Run snapshot tests.

---

### Phase 5: Extract Hook + Issue Detection (HIGH RISK — COUPLED)

**Create:**
- `packages/core/src/plugins/analysis/react-internal/hooks.ts`

**Move (TOGETHER — DO NOT SEPARATE):**
- `analyzeHook()` (lines 467-643, 177 lines)
- `extractDeps()` (lines 648-661, 14 lines)
- `hasCleanupReturn()` (lines 676-715, 40 lines)
- `checkEffectIssues()` (lines 720-870, 150 lines)
- `checkMissingCleanup()` (lines 875-958, 84 lines)

**Total: ~500 lines (largest module, but cohesive)**

**Export:**
```typescript
import type { NodePath } from '@babel/traverse';
import type { CallExpression, Node } from '@babel/types';
import type { HookNode, IssueNode, AnalysisResult } from './types.js';
import { REACT_HOOKS, BROWSER_APIS } from './types.js';
import { getLine, getColumn } from '../ast/utils/location.js';
import { getMemberExpressionName, getExpressionValue } from '../ast/utils/index.js';

/**
 * Analyze React hook call expression
 * Returns hook node data or null if not a recognized hook
 */
export function analyzeHook(
  path: NodePath<CallExpression>,
  filePath: string
): HookNode | null {
  // Implementation
  // Calls extractDeps, hasCleanupReturn (internal helpers)
}

/**
 * Check for issues in useEffect/useLayoutEffect
 * Mutates analysis.issues array
 *
 * Detects:
 * - Stale closures (missing dependencies)
 * - Missing cleanup (timers, observers, WebSocket)
 */
export function checkEffectIssues(
  path: NodePath<CallExpression>,
  filePath: string,
  analysis: AnalysisResult,
  hookData: HookNode,
  importedIdentifiers: Set<string>
): void {
  // Implementation
  // Calls checkMissingCleanup (internal helper)
}

// Internal helpers (not exported)
function extractDeps(depsArg: Node | undefined): string[] | null { /* ... */ }
function hasCleanupReturn(callback: Node | undefined): boolean { /* ... */ }
function checkMissingCleanup(...) { /* ... */ }
```

**Why keep together?**

Line 387:
```typescript
if (callee.name === 'useEffect' || callee.name === 'useLayoutEffect') {
  this.checkEffectIssues(path, filePath, analysis, hookData, importedIdentifiers);
}
```

`checkEffectIssues` is called FROM the hook detection flow. They're a single responsibility: **"React hook safety analysis"**.

**Update ReactAnalyzer.ts:**
```typescript
import { analyzeHook, checkEffectIssues } from './react-internal/hooks.js';
```

**Tests:** Run snapshot tests. Verify stale closure detection still works.

---

### Phase 6: Cleanup Main File

**Final ReactAnalyzer.ts structure:**

```typescript
// Imports (10 lines)
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import { analyzeHook, checkEffectIssues } from './react-internal/hooks.js';
import {
  isReactComponent,
  analyzeJSXElement,
  analyzeJSXAttribute,
  analyzeForwardRef,
  analyzeCreateContext
} from './react-internal/jsx.js';
import { analyzeBrowserAPI } from './react-internal/browser-api.js';
import {
  REACT_HOOKS,
  type AnalysisResult,
  type AnalysisStats,
  type ComponentNode
} from './react-internal/types.js';

// Class definition (225-350 lines)
export class ReactAnalyzer extends Plugin {
  // Implementation as outlined above
}
```

**Verify:**
- No logic in main file (all delegated)
- analyzeAST is coordinator only (~50 lines)
- All helpers extracted

**Tests:** Full test suite + snapshot tests.

---

## Verification Steps (After Each Phase)

1. **Build:** `pnpm build`
2. **Unit tests:** `node --test test/unit/ReactAnalyzer.test.js`
3. **Snapshot validation:** Verify graph output unchanged
4. **Import check:** No circular dependencies

---

## Acceptance Criteria (Revised)

### Original AC (from user):
- [x] Main file < 500 lines
- [x] Snapshot tests pass
- [x] Each responsibility in separate module

### Refined AC (from auto-review feedback):
- [x] Main file contains COORDINATOR LOGIC ONLY (~225-350 lines)
- [x] 4-5 modules max (not 9)
- [x] Hook + Issue detection extracted TOGETHER (single module)
- [x] No duplication of existing utilities (getMemberExpressionName → ast/utils/)
- [x] Export functions, not classes (match codebase pattern)
- [x] Phase ordering correct (coupled modules extracted together)

---

## Risk Assessment

| Phase | Risk | Mitigation |
|-------|------|------------|
| 1: Utilities | LOW | No behavioral change, snapshot tests |
| 2: Types/Constants | LOW | Pure data, no logic |
| 3: Browser API | LOW | Self-contained, no coupling |
| 4: JSX/Components | MEDIUM | Snapshot tests + verify component detection |
| 5: Hooks/Issues | HIGH | Most complex logic. Thorough testing. |
| 6: Cleanup | LOW | Just removing old code |

**Highest risk:** Phase 5 (hooks + issues). Stale closure detection is complex. Must verify all edge cases.

---

## Final Structure Summary

**Before refactoring:**
- 1 file: 1,377 lines

**After refactoring:**
- `ReactAnalyzer.ts`: ~300 lines (coordinator)
- `react-internal/hooks.ts`: ~500 lines (hook + issue detection)
- `react-internal/jsx.ts`: ~350 lines (JSX + components)
- `react-internal/browser-api.ts`: ~200 lines (browser APIs)
- `react-internal/types.ts`: ~200 lines (interfaces + constants)
- `ast/utils/getMemberExpressionName.ts`: ~15 lines
- `ast/utils/getExpressionValue.ts`: ~20 lines

**Total:** 7 files, 1,585 lines (includes docs/comments)

**Module count:** 4 internal modules + 2 shared utilities = 6 new files (vs 9 in original plan)

---

## Q&A

**Q: Why not split hooks.ts further (500 lines is large)?**

A: Coupling. `analyzeHook` → `checkEffectIssues` → `checkMissingCleanup` is a single flow. Splitting would require passing shared state (deps, cleanup info) across modules, increasing complexity.

**Q: Why extract utilities to ast/utils/ instead of react-internal/?**

A: `getMemberExpressionName` and `getExpressionValue` are NOT React-specific. They're AST utilities that other analyzers (ExpressAnalyzer, DatabaseAnalyzer) could reuse.

**Q: What if tests break during refactoring?**

A: Revert phase and investigate. Tests verify graph output (node/edge counts + types). If tests break, it means behavioral change occurred. That's a bug, not expected.

**Q: Can we parallelize phases?**

A: Phase 1-4 are independent (can run in parallel). Phase 5 depends on Phase 2 (needs types.ts). Phase 6 depends on all.

---

**End of Revised Plan**

Don Melton
Tech Lead, Grafema Project
February 15, 2026
