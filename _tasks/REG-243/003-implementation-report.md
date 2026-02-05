# REG-243: Implementation Report

## Summary

Created single source of truth for diagnostic category mappings in `@grafema/core/diagnostics/categories.ts`.

## Changes

### New File: `packages/core/src/diagnostics/categories.ts`

Single source of truth defining:
- `DIAGNOSTIC_CATEGORIES`: category → codes mapping
- `CODE_TO_CATEGORY`: code → category metadata (auto-derived)
- `getCategoryForCode()`: lookup helper
- `getCodesForCategory()`: lookup helper
- `DiagnosticCategory`, `DiagnosticCategoryKey`, `CodeCategoryInfo` types

### Modified Files

1. **`packages/core/src/diagnostics/index.ts`**
   - Added exports for new categories module

2. **`packages/core/src/index.ts`**
   - Added exports for categories constants and types

3. **`packages/core/src/diagnostics/DiagnosticReporter.ts`**
   - Removed local `DIAGNOSTIC_CODE_CATEGORIES` constant
   - Now imports `CODE_TO_CATEGORY` from categories.ts

4. **`packages/cli/src/commands/check.ts`**
   - Removed local `CHECK_CATEGORIES` constant and `DiagnosticCheckCategory` interface
   - Now imports `DIAGNOSTIC_CATEGORIES` from @grafema/core
   - Re-exports `DIAGNOSTIC_CATEGORIES as CHECK_CATEGORIES` for backward compatibility

### New Test: `test/unit/core/diagnostics/categories.test.ts`

Tests verifying:
- All categories defined with name, description, codes
- No duplicate codes across categories
- CODE_TO_CATEGORY correctly derived from DIAGNOSTIC_CATEGORIES
- Helper functions work correctly
- Bidirectional consistency

## API Changes

**Exported from `@grafema/core`:**
- `DIAGNOSTIC_CATEGORIES` - canonical category definitions
- `CODE_TO_CATEGORY` - derived code→category mapping
- `getCategoryForCode(code)` - lookup helper
- `getCodesForCategory(category)` - lookup helper
- Types: `DiagnosticCategory`, `DiagnosticCategoryKey`, `CodeCategoryInfo`

**Backward Compatibility:**
- CLI re-exports `DIAGNOSTIC_CATEGORIES as CHECK_CATEGORIES` (deprecated)

## Categories

| Key | Name | Codes |
|-----|------|-------|
| connectivity | Graph Connectivity | ERR_DISCONNECTED_NODES, ERR_DISCONNECTED_NODE |
| calls | Call Resolution | ERR_UNRESOLVED_CALL |
| dataflow | Data Flow | ERR_MISSING_ASSIGNMENT, ERR_BROKEN_REFERENCE, ERR_NO_LEAF_NODE |
| imports | Import Validation | ERR_BROKEN_IMPORT, ERR_UNDEFINED_SYMBOL |

## Test Results

- `test/unit/cli/check-categories.test.ts`: 25 tests pass
- `test/unit/core/diagnostics/categories.test.ts`: 11 tests pass
