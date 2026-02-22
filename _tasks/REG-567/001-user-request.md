# REG-567: Fix ASTWorker parallel path: const x = new Foo() classified as CONSTANT instead of VARIABLE

**Source:** Linear issue REG-567
**Date:** 2026-02-22
**Priority:** High
**Labels:** Bug, v0.2

## Goal

Fix a pre-existing bug in the ASTWorker parallel analysis path where `const x = new Foo()` is incorrectly classified as CONSTANT instead of VARIABLE.

## Background

During review of REG-551, Steve Jobs identified that `ASTWorker.ts` line 351 still contains the bug that was fixed in REG-546 for the sequential path (JSASTAnalyzer). The issue is that `isNewExpr` is included in the `shouldBeConstant` condition.

## Impact

* `const x = new Foo()` in the parallel analysis path creates CONSTANT nodes instead of VARIABLE nodes
* Class instantiations become invisible to data flow analysis in the enrichment layer
* Any code using the parallel worker analysis path bypasses this fix

## Root Cause

The fix applied to JSASTAnalyzer in REG-546 removed `isNewExpr` from the `shouldBeConstant` condition, but the equivalent code path in ASTWorker.ts was not updated.

## Acceptance Criteria

- [ ] ASTWorker.ts line 351 region removes `isNewExpr` from `shouldBeConstant` logic
- [ ] `const x = new SomeClass()` creates VARIABLE nodes (not CONSTANT) in parallel analysis
- [ ] INSTANCE_OF edges are created for all NewExpression regardless of const/let
- [ ] Unit test verifies parallel path behavior matches sequential path
- [ ] All existing tests pass
