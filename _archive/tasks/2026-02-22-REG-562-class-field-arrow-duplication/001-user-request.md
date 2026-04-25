# REG-562: Fix class field arrow function node duplication

**Date:** 2026-02-22
**Priority:** Urgent
**Labels:** Bug, v0.2

## Goal

Fix duplicate FUNCTION nodes for arrow functions in class field initializers. `class A { field = x => x }` produces two separate FUNCTION nodes at the same position.

## Root Cause

Two code paths create a FUNCTION node for the same class field arrow:

1. `FunctionVisitor.ArrowFunctionExpression` — runs during full-AST traversal (`traverse(ast, functionVisitor.getHandlers())` in JSASTAnalyzer.ts:1863). For class field arrows, `path.getFunctionParent()` returns `null` (ClassProperty is not a function boundary in Babel), so any `getFunctionParent()` guard added for REG-559 does NOT filter these.
2. `ClassVisitor.ClassProperty` (ClassVisitor.ts ~line 286) — creates a FUNCTION node via `computeSemanticIdV2('FUNCTION', propName, module.file, scopeTracker.getNamedParent())` when processing class properties with arrow initializers.

The two paths use different scope contexts when calling `computeSemanticIdV2`:

* FunctionVisitor: runs at global/module scope → `namedParent = undefined`
* ClassVisitor.ClassProperty: runs with class scope active → `namedParent = className`

Different IDs → two distinct FUNCTION nodes at same source position.

## Acceptance Criteria

- [ ] `class A { field = x => x }` produces exactly **one** FUNCTION node
- [ ] `class A { handler = (e) => this.handle(e) }` produces exactly **one** FUNCTION node
- [ ] Unit test with regression coverage
