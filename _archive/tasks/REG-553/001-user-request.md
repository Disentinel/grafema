# User Request: REG-553

**Task:** Index logical/nullish expressions (||, &&, ??) as EXPRESSION nodes
**Priority:** Urgent
**Source:** Linear REG-553

## Goal

Create EXPRESSION nodes for `LogicalExpression` (`||`, `&&`) and `NullishCoalescingExpression` (`??`) AST nodes. Currently these expressions are invisible in the graph.

## Impact

Value Trace shows "No value origins found" for values assigned via `x = a || b` or `x = a ?? b`. The entire logical expression chain is a gap in the data flow.

## Examples missing from graph

* `options.onProgress || (() => {})`
* `options.workerCount || 10`
* `options.parallel || null`
* `options.logger ?? createLogger(options.logLevel ?? 'info')`

## Acceptance Criteria

- [ ] `||`, `&&`, `??` expressions produce EXPRESSION nodes with correct position
- [ ] EXPRESSION node name: short representation (e.g. `"a || b"`, truncated at 64 chars)
- [ ] Both operands linked to the expression node
- [ ] Value Trace can follow data flow through logical expressions
- [ ] Unit test: `const x = a || b` → EXPRESSION node + ASSIGNED_FROM edges
