# REG-546: VARIABLE nodes not created for NewExpression initializers

## Problem

GraphBuilder does not create VARIABLE nodes when a variable is initialized with a `NewExpression` (`new X()` or `new X<T>()`). Only CallExpression and MemberExpression initializers produce VARIABLE nodes.

**Verified in** `packages/core/src/core/buildDependencyGraph.ts`:

| Line | Declaration | Initializer Type | VARIABLE node? |
| -- | -- | -- | -- |
| 57 | `const consumerIndex = new Map<string, Set<string>>()` | NewExpression | ❌ missing |
| 61 | `const deps = new Set<string>()` | NewExpression | ❌ missing |
| 59 | `const items = plugins.map(...)` | CallExpression | ✅ exists |
| 60 | `const meta = plugin.metadata` | MemberExpression | ✅ exists |
| 67 | `let consumers = consumerIndex.get(edgeType)` | CallExpression | ✅ exists |
| 74 | `const edgeProducers = producers.get(edgeType)` | CallExpression | ✅ exists |

## Impact

* Clicking on a variable initialized with `new X()` in VS Code falls through to the nearest other node (e.g. the CALL node on the same line)
* Value trace, blast radius, and data flow are broken for these variables
* Any enricher doing `resolveVariableInScope` for such variables returns null

## Root Cause

`trackVariableAssignment` in GraphBuilder handles CallExpression and MemberExpression but skips `NewExpression`. REG-534 fixed expression type coverage but missed this case.

## Acceptance Criteria

- [ ] `const x = new Foo()` creates a VARIABLE node for `x`
- [ ] `const x = new Foo<T>()` (with type parameters) also creates a VARIABLE node
- [ ] VARIABLE node is linked to the CONSTRUCTOR_CALL node via ASSIGNED_FROM edge
- [ ] Test coverage for NewExpression initializers
- [ ] Re-analysis of grafema repo: `consumerIndex`, `deps` and similar variables now appear in graph

## Labels

- Bug, v0.2, Urgent
