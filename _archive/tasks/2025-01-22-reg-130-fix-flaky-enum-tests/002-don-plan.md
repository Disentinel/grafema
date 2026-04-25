# Don Melton - Analysis and High-Level Plan for REG-130

## Root Cause Analysis

The two failing tests fail due to **a parser configuration bug in `JSModuleIndexer`**.

### Test 1: `should analyze const enum correctly` (line 268)
**Error**: `Unexpected reserved word 'enum'. (2:13)`

The `const enum` syntax is TypeScript-only. The parser fails because `JSModuleIndexer` uses `node-source-walk` with default plugins (`jsx`, `flow`) but **missing the `typescript` plugin**.

### Test 2: `should create unique IDs for different enums` (line 367)
**Error**: `Export 'Status' is not defined. (17:9)`

The `enum` keyword without `export` is TypeScript-only. Without the `typescript` plugin, the parser treats these as syntax errors.

## The Architectural Mismatch

**Every other parser in the codebase** correctly includes the `typescript` plugin:
- `AnalysisWorker.ts`: `plugins: ['jsx', 'typescript']`
- `ASTWorker.ts`: `plugins: ['jsx', 'typescript']`
- `QueueWorker.ts`: `plugins: ['jsx', 'typescript']`
- `IncrementalModuleIndexer.ts`: `plugins: ['jsx', 'typescript']`
- `JSASTAnalyzer.ts`: `plugins: ['jsx', 'typescript']`
- etc.

**Only `JSModuleIndexer.ts`** uses `new Walker()` without passing parser options - line 77.

## Impact Chain

1. `JSModuleIndexer` fails to parse TypeScript file
2. File is not added to the module tree
3. No `MODULE` node is created
4. `JSASTAnalyzer` never processes the file
5. No `ENUM` nodes are created
6. Tests fail with "ENUM node not found"

## The RIGHT Fix

This is NOT a test issue - it's a **production code bug**.

### Recommended Fix: Configure Walker with TypeScript plugin

```typescript
// JSModuleIndexer constructor
this.walker = new Walker({
  plugins: ['jsx', 'typescript']  // Match other parsers
});
```

This is minimal, correct, and aligns with established patterns.

## Critical Files

- `packages/core/src/plugins/indexing/JSModuleIndexer.ts` - **Bug location: line 77**
- `test/unit/EnumNodeMigration.test.js` - Test file (no changes needed)
