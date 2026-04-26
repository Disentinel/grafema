# Kent Beck's Test Report: REG-307 - Natural Language Query Support

## Summary

Created comprehensive test suite for natural language scope queries. All tests are written first (TDD) and fail as expected, waiting for Rob's implementation.

**Test file:** `/Users/vadimr/grafema-worker-8/packages/cli/test/query-natural-language.test.ts`

---

## Test Categories

### 1. Unit Tests: `parseQuery()` (12 tests)

Tests the query parsing function that extracts type, name, file scope, and function scopes from natural language patterns.

| Test Case | Input | Expected Output |
|-----------|-------|-----------------|
| Simple name | `"response"` | `{ type: null, name: "response", file: null, scopes: [] }` |
| Type + name | `"variable response"` | `{ type: "VARIABLE", name: "response", file: null, scopes: [] }` |
| Name + function scope | `"response in fetchData"` | `{ type: null, name: "response", file: null, scopes: ["fetchData"] }` |
| Name + file path | `"response in src/app.ts"` | `{ type: null, name: "response", file: "src/app.ts", scopes: [] }` |
| Name + file extension | `"response in app.js"` | `{ type: null, name: "response", file: "app.js", scopes: [] }` |
| Multiple scopes | `"error in catch in fetchData"` | `{ type: null, name: "error", file: null, scopes: ["catch", "fetchData"] }` |
| Full specification | `"variable response in fetchData in src/app.ts"` | `{ type: "VARIABLE", name: "response", file: "src/app.ts", scopes: ["fetchData"] }` |
| Name with "in" (signin) | `"signin"` | `{ type: null, name: "signin", file: null, scopes: [] }` |
| Name with "in" (xindex) | `"function xindex"` | `{ type: "FUNCTION", name: "xindex", file: null, scopes: [] }` |
| Name with "in" (main) | `"function main"` | `{ type: "FUNCTION", name: "main", file: null, scopes: [] }` |
| Nested block scopes | `"x in try in processData"` | `{ type: null, name: "x", file: null, scopes: ["try", "processData"] }` |
| Trailing whitespace | `"response in fetchData "` | `{ type: null, name: "response", file: null, scopes: ["fetchData"] }` |

### 2. Unit Tests: `isFileScope()` (11 tests)

Tests the heuristic for detecting file paths vs function/class names.

| Test Case | Input | Expected |
|-----------|-------|----------|
| Path with slash | `"src/app.ts"` | `true` |
| .ts extension | `"app.ts"` | `true` |
| .js extension | `"app.js"` | `true` |
| .tsx extension | `"Component.tsx"` | `true` |
| .jsx extension | `"Component.jsx"` | `true` |
| .mjs extension | `"module.mjs"` | `true` |
| .cjs extension | `"module.cjs"` | `true` |
| Function name | `"fetchData"` | `false` |
| Class name | `"UserService"` | `false` |
| Block scope | `"catch"` | `false` |
| Try keyword | `"try"` | `false` |

### 3. Unit Tests: `matchesScope()` (12 tests)

Tests scope matching against semantic IDs. Uses `parseSemanticId()` from `@grafema/core` for robust ID parsing.

| Test Case | Semantic ID | File | Scopes | Expected |
|-----------|-------------|------|--------|----------|
| No constraints | `src/app.ts->fetchData->try#0->VARIABLE->response` | `null` | `[]` | `true` |
| File scope match | same | `"src/app.ts"` | `[]` | `true` |
| Wrong file | same | `"src/other.ts"` | `[]` | `false` |
| Function scope | same | `null` | `["fetchData"]` | `true` |
| Numbered scope (try#0) | same | `null` | `["try"]` | `true` |
| Multiple scopes (AND) | same | `null` | `["fetchData", "try"]` | `true` |
| Missing scope | same | `null` | `["fetchData", "catch"]` | `false` |
| File + function | same | `"src/app.ts"` | `["fetchData"]` | `true` |
| Wrong file + scope | same | `"src/other.ts"` | `["fetchData"]` | `false` |
| Basename match | same | `"app.ts"` | `[]` | `true` |
| Scope order independence | same | `null` | `["try", "fetchData"]` | `true` |
| Hierarchical (class contains method) | `src/app.ts->UserService->login->VARIABLE->token` | `null` | `["UserService"]` | `true` |

### 4. Unit Tests: `extractScopeContext()` (10 tests)

Tests human-readable scope context extraction from semantic IDs.

| Test Case | Semantic ID | Expected |
|-----------|-------------|----------|
| Global scope | `src/app.ts->global->FUNCTION->main` | `null` |
| Function scope | `src/app.ts->fetchData->VARIABLE->response` | `"inside fetchData"` |
| Try block | `src/app.ts->fetchData->try#0->VARIABLE->response` | `"inside fetchData, inside try block"` |
| Catch block | `src/app.ts->processData->catch#0->VARIABLE->error` | `"inside processData, inside catch block"` |
| Class.method | `src/app.ts->UserService->login->VARIABLE->token` | `"inside UserService, inside login"` |
| Conditional (if) | `src/app.ts->validate->if#0->VARIABLE->isValid` | `"inside validate, inside conditional"` |
| Else block | `src/app.ts->validate->else#0->VARIABLE->fallback` | `"inside validate, inside else block"` |
| For loop | `src/app.ts->processItems->for#0->VARIABLE->item` | `"inside processItems, inside loop"` |
| While loop | `src/app.ts->waitLoop->while#0->VARIABLE->done` | `"inside waitLoop, inside loop"` |
| Switch | `src/app.ts->handleAction->switch#0->VARIABLE->action` | `"inside handleAction, inside switch"` |

### 5. Integration Tests: CLI with Scope Support (11 tests)

End-to-end tests using real graph database.

| Test Case | Description |
|-----------|-------------|
| Variable in function scope | `grafema query "response in fetchData"` finds variable inside function |
| File scope filter | `grafema query "response in src/app.js"` filters to specific file |
| Type + scope | `grafema query "variable response in fetchData"` combines both |
| Signin not split | `grafema query "signin"` finds function, doesn't parse as "sign in n" |
| Basename collision | `grafema query "response in app.js"` matches both src/app.js and test/app.js |
| Basename disambiguation | `grafema query "response in src/app.js"` matches only src/app.js |
| Empty results suggestion | Shows helpful message with `Try:` suggestion when no results |
| --type with scope | `grafema query --type VARIABLE "token in UserService"` respects explicit type |
| JSON includes scopeContext | `--json` output includes `scopeContext` field |
| Human-readable scope | Output shows "inside X" context |
| Help text documents syntax | `--help` mentions " in " scope syntax |

---

## Linus Review Test Cases: Coverage

All 8 additional test cases from Linus's review are covered:

1. **Basename collision** - `matchesScope` test: "should match basename (app.ts matches src/app.ts)"
2. **Basename disambiguation** - Integration test: "should match only specific file with full path"
3. **Scope order independence** - `matchesScope` test: "should match scopes regardless of order in query"
4. **Empty results suggestion** - Integration test: "should suggest removing scope when no results found"
5. **--type flag with scope** - Integration test: "should respect --type flag with scope"
6. **Numbered block scope** - `matchesScope` test: "should match numbered scope (try matches try#0)"
7. **Hierarchical scope** - `matchesScope` test: "should match hierarchical scopes (class contains method)"
8. **JSON scopeContext** - Integration test: "should include scopeContext in JSON output"

---

## Running Tests

```bash
cd packages/cli
node --import tsx --test test/query-natural-language.test.ts
```

**Current status:** All 59 tests fail with clear messages like:
```
"parseQuery not exported from query.ts - implement and export it"
```

This is expected TDD behavior - tests are written first, implementation comes next.

---

## Implementation Notes for Rob

### Functions to Export from `query.ts`

```typescript
// Add these exports for testability
export { parseQuery, matchesScope, extractScopeContext, isFileScope };
```

### ParseSemanticId Usage

Use `parseSemanticId()` from `@grafema/core` instead of custom regex:

```typescript
import { parseSemanticId } from '@grafema/core';

function matchesScope(semanticId: string, file: string | null, scopes: string[]): boolean {
  const parsed = parseSemanticId(semanticId);
  if (!parsed) return false;

  // File matching
  if (file !== null) {
    // Full path match
    if (parsed.file === file) { /* match */ }
    // Basename match: "app.ts" matches "src/app.ts"
    else if (parsed.file.endsWith('/' + file)) { /* match */ }
    else return false;
  }

  // Scope matching - check scopePath array
  for (const scope of scopes) {
    // Handle numbered scopes: "try" matches "try#0"
    const matches = parsed.scopePath.some(s =>
      s === scope || s.startsWith(scope + '#')
    );
    if (!matches) return false;
  }

  return true;
}
```

### Key Design Decisions

1. **Split on ` in ` (space-padded)** - Avoids breaking names like "signin", "main", "index"
2. **AND logic for multiple scopes** - All scopes must match
3. **Scope order independence** - `["try", "fetchData"]` matches same as `["fetchData", "try"]`
4. **Basename matching** - `"app.ts"` matches `"src/app.ts"` for user convenience
5. **scopeContext in JSON** - Included for AI agent consumption

---

## Files Created

1. `/Users/vadimr/grafema-worker-8/packages/cli/test/query-natural-language.test.ts` - 600+ lines of tests
2. This report

---

*Kent Beck, Test Engineer*
*"Tests communicate intent. These tests define exactly what natural language scope queries should do."*
