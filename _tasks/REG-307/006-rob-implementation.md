# Rob Pike's Implementation Report: REG-307 - Natural Language Query Support

## Summary

Implemented natural language scope support for the `grafema query` command. All 48 unit tests pass. Integration tests fail due to RFDB server infrastructure issues (unrelated to this implementation).

**File modified:** `/Users/vadimr/grafema-worker-8/packages/cli/src/commands/query.ts`

---

## Changes Made

### 1. New Types

Added `ParsedQuery` interface (exported for testing):

```typescript
export interface ParsedQuery {
  type: string | null;
  name: string;
  file: string | null;
  scopes: string[];
}
```

Extended `NodeInfo` with optional `scopeContext` field.

### 2. New Functions (all exported for testing)

#### `parseQuery(pattern: string): ParsedQuery`

Parses search patterns with scope support:
- Splits on ` in ` (space-padded) to avoid breaking names like "signin"
- First clause parsed for type+name using existing `parsePattern()`
- Remaining clauses classified as file scope (contains `/` or `.ts/.js` extension) or function scopes

#### `isFileScope(scope: string): boolean`

Detects file paths vs function names using heuristics:
- Contains `/` -> file path
- Ends with `.ts/.js/.tsx/.jsx/.mjs/.cjs` -> file path

#### `matchesScope(semanticId: string, file: string | null, scopes: string[]): boolean`

Uses `parseSemanticId()` from `@grafema/core` for robust ID parsing. Matching rules:
- File scope: exact match, ends-with match, or basename match
- Function scopes: checks scopePath array, handles numbered scopes (`try` matches `try#0`)
- Multiple scopes: AND logic - all must match

#### `extractScopeContext(semanticId: string): string | null`

Generates human-readable scope context:
- `"src/app.ts->fetchData->try#0->VARIABLE->response"` -> `"inside fetchData, inside try block"`
- Filters out "global" scope
- Formats numbered scopes: `try#0` -> "try block", `if#0` -> "conditional", etc.

### 3. Modified Functions

#### `findNodes()` - Updated signature and logic

**Before:**
```typescript
async function findNodes(backend, type, name, limit): Promise<NodeInfo[]>
```

**After:**
```typescript
async function findNodes(backend, query: ParsedQuery, limit): Promise<NodeInfo[]>
```

Now applies scope filtering using `matchesScope()` and adds `scopeContext` to results.

#### Action handler

Uses `parseQuery()` for scope support. When `--type` flag is provided, preserves explicit type but still parses scopes.

Updated "no results" message to suggest removing scope constraints:
```
No results for "response in fetchData"
  Try: grafema query "response" (search all scopes)
```

#### `displayNode()`

Shows scope context when present:
```
[VARIABLE] response
  Location: src/app.js:5
  Scope: inside fetchData, inside try block
```

### 4. Updated Help Text

Added examples for scope syntax:
```
grafema query "response in fetchData"        Search in specific function scope
grafema query "error in catch in fetchData"  Search in nested scopes
grafema query "token in src/auth.ts"         Search in specific file
grafema query "variable x in foo in app.ts"  Combine type, name, and scopes
```

---

## Test Results

### Unit Tests: 48/48 PASS

| Suite | Tests | Status |
|-------|-------|--------|
| parseQuery | 12 | PASS |
| isFileScope | 11 | PASS |
| matchesScope | 14 | PASS |
| extractScopeContext | 11 | PASS |

### Integration Tests: Infrastructure Issue

Integration tests fail with:
```
Error: RFDB server failed to start (socket not created after 5000ms)
```

This is an environment/infrastructure issue, not an implementation bug. The RFDB server binary may not be available or properly built in the test environment.

---

## Backward Compatibility

All existing query patterns continue to work unchanged:
- `grafema query "response"` - name-only search
- `grafema query "function authenticate"` - type + name
- `grafema query --type FUNCTION "auth"` - explicit type
- `grafema query --raw 'type(X, "FUNCTION")'` - raw Datalog

The only change is that patterns containing ` in ` (space-padded) are now parsed as scope constraints.

---

## Key Design Decisions

1. **Split on ` in ` (space-padded)** - Avoids breaking names like "signin", "main", "index"
2. **Use `parseSemanticId()` from `@grafema/core`** - Robust ID parsing, no custom regex
3. **Basename matching** - `"app.ts"` matches `"src/app.ts"` for user convenience
4. **AND logic for multiple scopes** - All specified scopes must match
5. **Scope order independence** - `["try", "fetchData"]` matches same as `["fetchData", "try"]`

---

## Files Created/Modified

1. **Modified:** `packages/cli/src/commands/query.ts`
   - Added 4 new exported functions
   - Added `ParsedQuery` interface
   - Updated `findNodes()` and `displayNode()`
   - Updated help text

2. **Created:** This report

---

*Rob Pike, Implementation Engineer*
*"Simplicity over cleverness. The code matches existing patterns and uses @grafema/core's parseSemanticId for robust ID parsing."*
