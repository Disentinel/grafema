# REG-154: Fix skipped tests

## User Request

Fix 4 skipped test files that were skipped during REG-95 implementation:

1. **NoLegacyClassIds.test.js** — `describe.skip`, REG-99 ClassNode migration
2. **NoLegacyExpressionIds.test.js** — `describe.skip`, REG-107 EXPRESSION migration
3. **IndexedArrayAssignmentRefactoring.test.js** — `describe.skip`, REG-116 TDD refactoring
4. **ReactAnalyzer.test.js.skip** — moved to `_skip/`, missing @babel/parser

## Acceptance Criteria

- All 4 test files either pass or are intentionally deprecated
- No `describe.skip` without documented reason in Linear
- No files in `_skip/` directory
