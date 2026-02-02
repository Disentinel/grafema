# Don Melton's Plan for REG-274: AST Track IfStatement (BRANCH node)

## Executive Summary

This task requires introducing a new node type `BRANCH` to represent control flow decision points. Currently, `IfStatement` nodes create `SCOPE` nodes which represent lexical scope boundaries but don't properly model the control flow graph. We need `BRANCH` nodes with edges to condition expressions and consequent/alternate scopes.

## Current State Analysis

### What Exists

1. **IfStatement handling** in `JSASTAnalyzer.createIfStatementHandler()`:
   - Creates `SCOPE` nodes with `scopeType: 'if_statement'` and `scopeType: 'else_statement'`
   - Stores condition text and parsed constraints on SCOPE nodes
   - Links SCOPE to parent via `CONTAINS` edge

2. **No control flow representation**:
   - No `BRANCH` node type exists
   - No `HAS_CONDITION`, `HAS_CONSEQUENT`, `HAS_ALTERNATE` edge types
   - Cannot answer "what conditions guard this operation?"

### Target State

```javascript
if (user.isAdmin) {
  deleteAll();
} else {
  showError();
}
```

Should produce:
```
BRANCH#if:file.js:1
  ├─[HAS_CONDITION]→ EXPRESSION(user.isAdmin)
  ├─[HAS_CONSEQUENT]→ SCOPE#if_statement:file.js:1
  └─[HAS_ALTERNATE]→ SCOPE#else_statement:file.js:3
```

## Key Design Decision

**BRANCH coexists with SCOPE** (not replaces):
- SCOPE = lexical scope boundary (variable declarations, closures)
- BRANCH = control flow decision point
- This is semantically correct and maintains backward compatibility

## Files That Need Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `packages/types/src/nodes.ts` | Add | `BRANCH` to `NODE_TYPE`, `BranchNodeRecord` |
| `packages/types/src/edges.ts` | Add | `HAS_CONDITION`, `HAS_CONSEQUENT`, `HAS_ALTERNATE` |
| `packages/core/src/plugins/analysis/ast/types.ts` | Add | `BranchInfo` interface |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Modify | Create BRANCH nodes in IfStatement handlers |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Add | `bufferBranchNodes()` method |

## Implementation Steps

1. Define types (NODE_TYPE, edge types, interfaces)
2. Write tests first (TDD)
3. Modify JSASTAnalyzer to create BRANCH nodes
4. Modify GraphBuilder to buffer BRANCH nodes and edges
5. Run tests to verify

## Risk Assessment

- SCOPE nodes remain unchanged (backward compatible)
- Minimal performance overhead (one extra node per if)
- New edge types are unique and descriptive
