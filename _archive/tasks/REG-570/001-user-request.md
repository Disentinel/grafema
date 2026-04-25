# User Request: REG-570

**Task:** ClassVisitor: missing ASSIGNED_FROM edges for class field initializers

**Source:** Linear issue REG-570

## Problem

`ClassVisitor` creates `VARIABLE` nodes for class field declarations but never wires them to their initializer expressions via `ASSIGNED_FROM` edges. This causes `DataFlowValidator` to emit `ERR_MISSING_ASSIGNMENT` for every class field — **1330 false warnings** across the entire codebase.

## Expected Behavior

```
CLASS:ProgressRenderer
  →HAS_PROPERTY→ VARIABLE:phases
                   →ASSIGNED_FROM→ ARRAY_LITERAL(['discovery', 'indexing', ...])
```

## Acceptance Criteria

* `ClassVisitor` (or the relevant AST builder) creates `ASSIGNED_FROM` edge from field `VARIABLE` node to the initializer node when a class field has an initializer
* Running `grafema check dataflow` produces zero `ERR_MISSING_ASSIGNMENT` warnings for class field declarations on Grafema's own codebase
* Existing tests pass; new test added covering class field with initializer

## Workflow

**Config:** Mini-MLA
**Pipeline:** Don → Dijkstra → Uncle Bob → Kent ∥ Rob → 3-Review → Vadim
