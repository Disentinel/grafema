# REG-480: Scope DatabaseAnalyzer and SQLiteAnalyzer function queries

## Problem

Both analyzers call `queryNodes({ type: 'FUNCTION' })` without file scoping, returning ALL functions globally.

### DatabaseAnalyzer
- `getFunctions()` at line 125 returns ALL functions globally
- `findParentFunction()` does O(F) linear scan per query
- Complexity: O(S x (F + Q x F))

### SQLiteAnalyzer (WORSE)
- Calls `queryNodes({ type: 'FUNCTION' })` INSIDE the per-query inner loop (line 311)
- Not once per module, but once per SQL query found
- Complexity: O(S x M x Q_sq x F)

## Fix

### DatabaseAnalyzer
- `queryNodes({ type: 'FUNCTION', file: module.file })` — scope by file
- Move query from execute() into per-module loop

### SQLiteAnalyzer
1. Scope query: `queryNodes({ type: 'FUNCTION', file: module.file })`
2. Move query OUTSIDE the per-query loop (fetch once per module, not per query)

## Expected Impact
~100x reduction per module (F/F_per_file), plus loop restructure in SQLiteAnalyzer.
