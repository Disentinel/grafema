# Linus Torvalds - Plan Review for REG-130

## VERDICT: APPROVED

### Root Cause - VERIFIED
The error `Unexpected reserved word 'enum'. (2:13)` occurs only when TypeScript plugin is missing from parser.

### Analysis - CORRECT
- JSModuleIndexer line 77: `new Walker()` with no config
- Every other parser uses `plugins: ['jsx', 'typescript']`
- JSModuleIndexer is the only outlier - this is a bug, not a design choice

### Solution - CORRECT
```typescript
this.walker = new Walker({
  plugins: ['jsx', 'typescript']
});
```

This is NOT a workaround - it's the legitimate fix. Without TypeScript plugin, JSModuleIndexer cannot process TypeScript files at all.

### Why This Is Right

The tests are not "flaky" - they expose a real bug. JSModuleIndexer was configured to parse only JavaScript/JSX, not TypeScript. The module indexer is the first phase in the analysis pipeline, so it must handle TypeScript syntax for any downstream processing to work.

Grafema's vision is to support large codebases including TypeScript. Blocking TypeScript at the indexing phase blocks the entire system.

### Risk Assessment - LOW
- Adding parser plugins only adds functionality
- Cannot break existing JavaScript/JSX parsing
- Fully backwards compatible

**PROCEED TO IMPLEMENTATION.**
