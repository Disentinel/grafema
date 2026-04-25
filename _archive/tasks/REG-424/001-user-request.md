# REG-424: Refactor CallExpressionVisitor.ts — Reduce Complexity

## Goal

Decompose CallExpressionVisitor.ts (1,526 lines). Already extracted visitor for module-level call expressions, but itself became too large.

## Workflow

1. **Safety net** — snapshot tests
2. **Uncle Bob review** — identify internal split boundaries
3. **Refactoring** — extract helper classes / split into sub-visitors
4. **Graph identity check**

## Acceptance Criteria

- [ ] Main file < 500 lines
- [ ] Snapshot tests pass
- [ ] Long methods (>50 lines) split
