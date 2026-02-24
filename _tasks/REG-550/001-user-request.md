# REG-550: Fix PARAMETER nodes storing column=0 instead of actual parameter position

## Goal

Fix PARAMETER node positions: `constructor(options: OrchestratorOptions = {})` at L85 shows `PARAMETER options L85:0` — column should be the position of `options` in the signature (~12), not 0.

## Symptoms

* `PARAMETER options L85:0` — should be `L85:12`
* `PARAMETER p L155:0` — should be position of `p` in `p => ...`

## Root Cause

In the parameter visitor/builder, `getColumn(node)` is likely called on the function node rather than on the individual parameter identifier node.

## Acceptance Criteria

- [ ] PARAMETER column = position of the parameter name identifier
- [ ] Unit test: function with multiple params, each gets correct column

## Meta

- **Priority:** Urgent
- **Labels:** Bug, v0.2
- **Linear:** REG-550
