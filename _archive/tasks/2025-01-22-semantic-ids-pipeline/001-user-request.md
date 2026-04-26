# User Request: REG-123

## Linear Issue
https://linear.app/reginaflow/issue/REG-123/integrate-semantic-ids-into-analysis-pipeline

## Summary

Integrate the Semantic ID system (already implemented) into the full analysis pipeline to enable stable, line-number-independent node identification.

## Background

Infrastructure already built:

* `SemanticId.ts` - ID generation with `->` separator format
* `ScopeTracker.ts` - scope tracking during AST traversal
* 8 node contracts with `createWithContext()` methods
* 171 tests passing

Currently integrated (partial):

* FunctionVisitor generates semantic IDs
* ClassVisitor generates semantic IDs for classes and methods
* TypeScriptVisitor generates semantic IDs for interfaces, types, enums

## Remaining Work

1. **Complete visitor integration:**
   * VariableVisitor - generate semantic IDs for variables
   * CallExpressionVisitor - generate semantic IDs for call sites
   * ImportExportVisitor - generate semantic IDs for imports/exports
2. **GraphBuilder integration:**
   * Use `createWithContext()` methods instead of inline object creation
   * Pass ScopeTracker through analysis pipeline
3. **Storage layer:**
   * Ensure semantic IDs are used as primary identifiers where appropriate
   * Handle ID format migration if needed

## Dependencies

* Depends on: REG-98 (NodeFactory migration) - **DONE**

## Acceptance Criteria

- [ ] All node types have semantic IDs generated during analysis
- [ ] Semantic IDs are stable across re-analysis (same code = same IDs)
- [ ] Line number changes don't affect semantic IDs
- [ ] All existing tests pass
- [ ] New tests verify semantic ID stability
