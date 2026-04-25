# REG-571: GraphBuilder: EXPRESSION nodes for ternary/binary/OR/property-access have no outgoing data flow edges

**Source:** Linear REG-571
**Date:** 2026-02-23

## Problem

When the GraphBuilder creates EXPRESSION nodes for compound expressions (ternary, binary, logical OR, member access, object/array literals), it creates the node but leaves it with zero outgoing edges. This cuts the data flow chain at the expression level, causing DataFlowValidator to emit ERR_NO_LEAF_NODE — 2931 warnings across 307 files in Grafema's own codebase.

## Affected expression types

| Expression type | Example | Expected missing edges |
| -- | -- | -- |
| Ternary | `const name = cond ? a : b` | `EXPRESSION:<ternary>` → consequent, alternate |
| Binary | `const n = arr.length - 1` | `EXPRESSION:<BinaryExpr>` → left operand, right operand |
| Logical OR | `const x = A \|\| B` | `EXPRESSION:… \|\| …` → left, right |
| Member access | `const { x } = options` | `EXPRESSION:options.x` → `PARAMETER:options` |
| Object literal | `const PLUGINS = { ... }` | `EXPRESSION:<object>` → property values |

## Acceptance Criteria

* All EXPRESSION nodes for listed types have outgoing ASSIGNED_FROM edges to their constituent sub-expressions
* Ternary EXPRESSION nodes link to condition, consequent, alternate; BRANCH node's HAS_CONSEQUENT/HAS_ALTERNATE point to real node IDs (not dangling)
* Member access EXPRESSION nodes link back to the object they access
* Running `grafema check dataflow` produces zero ERR_NO_LEAF_NODE warnings on Grafema's own codebase
* New tests covering each expression type
