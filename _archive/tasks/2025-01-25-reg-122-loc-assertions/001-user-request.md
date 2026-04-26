# User Request: REG-122

Execute Linear issue REG-122: Tech Debt - Audit and replace non-null loc assertions with defensive checks.

## Issue Summary

Replace dangerous `node.loc!` non-null assertions with defensive checks throughout JSASTAnalyzer and visitor files.

## Acceptance Criteria

1. Find all occurrences of `loc!` in JSASTAnalyzer.ts and visitor files
2. Replace with defensive checks: `loc?.start.line ?? 0`
3. Establish fallback convention: 0:0 means "unknown location"
4. Document this convention in code comments
5. All tests pass after changes

## Selected Lens

Mini-MLA (Don → Rob → Linus) - well-defined refactoring task with clear boundaries.
