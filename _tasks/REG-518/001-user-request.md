# REG-518: `type()` predicate not implemented in Rust evaluator

## Source
Linear issue REG-518, assigned by user.

## Problem
CLI help text documents `type()` as the primary node predicate and `node()` as the alias. However, the Rust evaluator has no `"type"` branch in `eval_atom()` — `type()` falls through to `eval_derived()` and silently returns empty results.

## Acceptance Criteria
Add `"type" => self.eval_node(atom)` to the Rust dispatch table, making `type()` a true alias for `node()`.

## Configuration
Single Agent (well-understood, single file, <50 LOC change)
