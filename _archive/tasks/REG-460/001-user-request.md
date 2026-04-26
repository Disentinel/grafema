# REG-460: Refactor JSASTAnalyzer.ts (4,739 → ~800 lines)

## Source
Linear issue REG-460, invoked by user with task ID.

## Goal
Reduce JSASTAnalyzer.ts from 4,739 lines to ~800 lines (orchestrator-only).

## Current State (2026-02-24)
- 4,739 lines (grew from 4,042 at issue creation), 9.5x over Uncle Bob's 500-line limit
- ~30 private methods, largest: handleCallExpression (221+ lines, 13 params)
- 70+ `.push()` calls, 39+ manual ID constructions
- Infrastructure already exists: visitors (15), handlers (13), builders (12), IdGenerator

## Approach (from Linear)
Follow proven patterns from GraphBuilder (2,921→528), ReactAnalyzer (1,368→323), CallExpressionVisitor (1,363→496).

Extract to dedicated modules:
1. **ast/extractors/**: handleCallExpression, extractReturnExpressionInfo, handleVariableDeclaration (~600 lines)
2. **ast/mutation-detection/**: detectArrayMutation, detectObjectAssign, detectVariableReassignment, collectUpdateExpression (~500 lines)
3. **ast/utils/**: SwitchStatementAnalyzer, CatchesFromCollector, expression-helpers (~670 lines)
4. **ID generation**: migrate to IdGenerator (~60 lines)
5. **Builder pattern**: node builders to eliminate .push() boilerplate (~200 lines)
6. **Final polish**: inline small methods, consolidate imports (~200-400 lines)

## Risk
No direct unit tests — need snapshot tests before refactoring.

## Acceptance Criteria
- JSASTAnalyzer.ts < 1,000 lines (orchestration only)
- All existing tests pass
- Graph output identical before/after (snapshot verification)
- No new public API changes

## MLA Config
Mini-MLA: Don → Dijkstra → Uncle Bob → Kent ∥ Rob → 3-Review → Vadim
