# REG-243: Deduplicate diagnostic category mappings

## Problem

REG-217 introduced category-to-code mapping in two places:

1. `check.ts` - CHECK_CATEGORIES maps category → codes
2. `DiagnosticReporter.ts` - DIAGNOSTIC_CODE_CATEGORIES maps codes → category

This is a DRY violation. Adding new diagnostic codes requires updating both files.

## Solution

Create single source of truth in `@grafema/core/diagnostics`:

* Define categories once
* Export both mapping directions
* Both CLI and reporter import from single source

## Related

* REG-217: Original implementation
