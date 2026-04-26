# RFD-4: Semantic ID v2

## Linear Issue
https://linear.app/reginaflow/issue/RFD-4/t14-semantic-id-v2

## Request
Implement Semantic ID v2 format: `file->TYPE->name[in:namedParent]`

Fully TS-side, RFDB stores strings — format is irrelevant to it.

~600 LOC changes, ~30 tests

### New Format

```
file->TYPE->name[in:namedParent]                    // base
file->TYPE->name[in:namedParent,h:xxxx]             // + content hash on collision
file->TYPE->name[in:namedParent,h:xxxx]#N           // + counter for identical duplicates
```

Scope path completely removed from ID. Anonymous scopes (if, for, try) don't participate → adding/removing blocks doesn't cascade.

### Subtasks

1. `computeSemanticIdV2()` in SemanticId.ts
2. `parseSemanticIdV2()` — parsing new format
3. `ScopeTracker.getNamedParent()` — nearest named ancestor
4. Content hash computation per node type (FNV-1a, no new deps)
5. `CollisionResolver` — graduated disambiguation (base → hash → counter)
6. `IdGenerator` v2 — switch generate/generateSimple
7. Update FunctionVisitor (anonymous naming, arrow→variable, arrow→ObjectProperty)
8. Update CallExpressionVisitor (CALL, METHOD_CALL)
9. Update VariableVisitor (VARIABLE/CONSTANT)
10. Update ClassVisitor (methods, static blocks, private fields)
11. Update PropertyAccessVisitor, TypeScriptVisitor
12. Migration tests: v1 ID → v2 ID mapping

### Key Design: CollisionResolver

Called AFTER all visitors complete for a file, BEFORE edges sent to RFDB. Two-pass ID assignment (single-pass AST traversal + O(n) fixup).

### Validation

* Stability: add if-block → IDs of children unchanged (THE KEY TEST)
* Collision: two `console.log` in same function → different IDs via hash
* Full analysis of test fixtures: compare v1 vs v2 IDs
* Regression: analysis of real project → no duplicate IDs within any file
