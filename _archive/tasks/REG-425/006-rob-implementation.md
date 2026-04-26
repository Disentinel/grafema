# Rob Pike - Implementation Report: REG-425

## Summary

Decomposed `ReactAnalyzer.ts` (1,377 lines) into 4 internal modules plus 2 shared utilities. Main file reduced to 322 lines (coordinator-only). All 72 ReactAnalyzer tests pass. Full suite (1,953 tests) also passes.

## Execution

Six phases executed sequentially. Each phase: build + test after changes. Zero test failures throughout.

### Phase 1: Shared Utilities (ast/utils/)

Created two standalone functions extracted from private methods:

- `getMemberExpressionName.ts` (33 lines) -- Recursive MemberExpression name resolution. Self-recursive call `this.getMemberExpressionName()` replaced with direct `getMemberExpressionName()`.
- `getExpressionValue.ts` (34 lines) -- Human-readable expression value extraction.
- Updated `index.ts` to re-export both.

### Phase 2: react-internal/types.ts

Created `react-internal/` directory. Moved all constants and interfaces:

- `REACT_EVENTS`, `REACT_HOOKS`, `BROWSER_APIS` (constants)
- `ComponentNode`, `HookNode`, `EventNode`, `BrowserAPINode`, `IssueNode`, `EdgeInfo`, `AnalysisResult`, `AnalysisStats` (interfaces)

183 lines. All exported. ReactAnalyzer.ts imports from `./react-internal/types.js`.

### Phase 3: react-internal/browser-api.ts

Extracted `analyzeBrowserAPI` method to standalone function. 168 lines.

Imports: `getLine` (location), `getMemberExpressionName` (ast/utils), `BROWSER_APIS` (types).

### Phase 4: react-internal/jsx.ts

Extracted 7 methods, 5 exported + 2 module-internal:

**Exported:**
- `isReactComponent` -- component detection via JSX presence
- `analyzeJSXElement` -- RENDERS edge creation
- `analyzeJSXAttribute` -- event handler + PASSES_PROP edge creation
- `analyzeForwardRef` -- forwardRef component registration
- `analyzeCreateContext` -- context provider registration

**Module-internal:**
- `getJSXElementName` -- recursive JSX name resolution
- `getFunctionName` -- parent function name extraction

279 lines. Both `analyzeJSXElement` and `analyzeJSXAttribute` call `getFunctionName` and `getJSXElementName`, so all stayed together per plan.

### Phase 5: react-internal/hooks.ts (highest risk)

Extracted 5 methods, 2 exported + 3 module-internal:

**Exported:**
- `analyzeHook` -- main hook analysis (switch over all hook types)
- `checkEffectIssues` -- stale closure + missing cleanup detection

**Module-internal:**
- `extractDeps` -- dependency array extraction
- `hasCleanupReturn` -- cleanup return detection
- `checkMissingCleanup` -- timer/WebSocket/observer cleanup checking

517 lines. Critical `this.` replacements:
- `this.extractDeps()` -> `extractDeps()`
- `this.hasCleanupReturn()` -> `hasCleanupReturn()`
- `this.getExpressionValue()` -> `getExpressionValue()` (imported from ast/utils)
- `this.checkMissingCleanup()` -> `checkMissingCleanup()`

### Phase 6: Cleanup

Removed unused imports from ReactAnalyzer.ts:
- `getMemberExpressionName`, `getExpressionValue` (now only used by extracted modules)
- `REACT_EVENTS`, `BROWSER_APIS` (only used by extracted modules)
- `EventNode`, `IssueNode`, `HookNode` (only used by extracted modules)

Verified no dead code remains.

## Final File Structure

```
packages/core/src/plugins/analysis/
  ReactAnalyzer.ts                     322 lines (was 1,377)
  react-internal/
    types.ts                           183 lines
    hooks.ts                           517 lines
    jsx.ts                             279 lines
    browser-api.ts                     168 lines
  ast/utils/
    getMemberExpressionName.ts          33 lines (new)
    getExpressionValue.ts               34 lines (new)
    index.ts                            14 lines (updated)
                                     -----
                                     1,550 lines total
```

## Test Results

- ReactAnalyzer tests: 72 pass, 0 fail (15 suites)
- Full test suite: 1,953 pass, 0 fail (5 skipped, 17 todo)

## Design Decisions

1. **Functions, not classes** -- matches codebase convention (see `location.ts` pattern).
2. **Module-internal helpers** -- `getJSXElementName`, `getFunctionName`, `extractDeps`, `hasCleanupReturn`, `checkMissingCleanup` are not exported. They are implementation details.
3. **Import paths use `.js` extension** -- ESM requirement.
4. **`traverse` hack stays in ReactAnalyzer.ts** -- only the coordinator does AST traversal.
5. **No behavioral changes** -- pure structural refactoring. Same inputs, same outputs.
6. **Unused imports cleaned up** -- ReactAnalyzer.ts only imports what it directly uses.
