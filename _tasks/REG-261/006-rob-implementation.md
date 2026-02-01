# Rob Pike - Implementation Report: REG-261 BrokenImportValidator

## Summary

Implementation complete. All 15 tests pass.

## Files Created

### 1. `packages/core/src/data/globals/definitions.ts`

Global symbol definitions organized by environment:
- `ECMASCRIPT_GLOBALS` - ECMAScript standard globals
- `NODEJS_GLOBALS` - Node.js-specific globals
- `BROWSER_GLOBALS` - Browser environment globals
- `TEST_GLOBALS` - Testing framework globals
- `ALL_GLOBALS` - Combined Set of all defaults

### 2. `packages/core/src/data/globals/index.ts`

GlobalsRegistry class with:
- `isGlobal(name)` - Check if symbol is a known global
- `addCustomGlobals(names)` - Add custom globals from config
- `removeGlobals(names)` - Remove globals (e.g., for browser-only projects)
- `getAllGlobals()` - Get all registered globals

### 3. `packages/core/src/plugins/validation/BrokenImportValidator.ts`

VALIDATION phase plugin that detects:
- `ERR_BROKEN_IMPORT` - Named/default import without IMPORTS_FROM edge
- `ERR_UNDEFINED_SYMBOL` - CALL without resolution to definition/import/global

**Follows existing validator patterns:**
- Extends `Plugin` base class
- Uses `createSuccessResult()` for return value
- Returns `ValidationError[]` for issues found
- Phase: VALIDATION, Priority: 85

**Skips appropriately:**
- External (npm) imports
- Namespace imports (`import * as X`)
- Type-only imports (`import type { X }`)
- Method calls (have `object` property)
- Resolved calls (have CALLS edge)
- Globals (console, setTimeout, Promise, etc.)

## Files Modified

### 4. `packages/core/src/index.ts`

Added exports:
```typescript
export { GlobalsRegistry, ALL_GLOBALS } from './data/globals/index.js';
export { BrokenImportValidator } from './plugins/validation/BrokenImportValidator.js';
```

### 5. `packages/cli/src/commands/check.ts`

Added 'imports' category to `CHECK_CATEGORIES`:
```typescript
'imports': {
  name: 'Import Validation',
  description: 'Check for broken imports and undefined symbols',
  codes: ['ERR_BROKEN_IMPORT', 'ERR_UNDEFINED_SYMBOL'],
},
```

## Implementation Notes

### Filter Field: `nodeType` vs `type`

Used `nodeType` in `queryNodes()` calls instead of `type`. Both are valid per the `NodeFilter` interface, but:
- Test MockGraph only handles `nodeType`
- RFDBServerBackend maps both to `nodeType` internally
- Using `nodeType` ensures compatibility with test infrastructure

### Error Severities

- `ERR_BROKEN_IMPORT` - `error` severity (definitely broken)
- `ERR_UNDEFINED_SYMBOL` - `warning` severity (might be false positive)

## Test Results

```
# tests 15
# pass 15
# fail 0
```

All test suites:
- ERR_BROKEN_IMPORT (6 tests) - PASS
- ERR_UNDEFINED_SYMBOL (6 tests) - PASS
- Custom Globals (1 test) - PASS
- Metadata (2 tests) - PASS

## Verification

```bash
npm run build  # Success
node --import tsx --test test/unit/core/BrokenImportValidator.test.ts  # 15/15 pass
```

---

**Implementation complete. Ready for review.**
