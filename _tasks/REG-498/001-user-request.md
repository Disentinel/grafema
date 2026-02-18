# REG-498: DataFlowValidator: O(n²) performance + ignores DERIVES_FROM edges

**Source:** Linear issue REG-498
**Priority:** High
**Labels:** v0.2, Bug

## Problem

DataFlowValidator has three critical issues:

### 1. Ignores DERIVES_FROM edges — false ERR_MISSING_ASSIGNMENT/ERR_NO_LEAF_NODE

`findPathToLeaf()` and the initial assignment check only look for `ASSIGNED_FROM` edges. But loop variables (`for (const num of numbers)`) create `DERIVES_FROM` edges, not `ASSIGNED_FROM`.

**Result:** Every for-of/for-in loop variable triggers ERR_MISSING_ASSIGNMENT or ERR_NO_LEAF_NODE — false positives.

### 2. O(n×m) performance via getAllEdges + .find() in loop

On a graph with 50k edges × 5k variables = 250M comparisons. Should use `graph.getOutgoingEdges(nodeId)` instead — O(1) per variable.

### 3. Wrong type filter (minor)

Filters for `type === 'VARIABLE_DECLARATION'` but actual variable nodes have `type: 'VARIABLE'`.

## Fix Plan

### Phase 1: Fix DataFlowValidator
- Use `graph.getOutgoingEdges(variable.id)` instead of loading all edges
- Use `graph.queryNodes({ nodeType: 'VARIABLE' })` + `queryNodes({ nodeType: 'CONSTANT' })` instead of getAllNodes
- Include both `ASSIGNED_FROM` and `DERIVES_FROM` in edge traversal
- `findPathToLeaf` should follow both edge types recursively

### Phase 2: Remove getAllEdges/getAllNodes from ALL plugins
Ban `getAllEdges()` and unfiltered `getAllNodes()` from plugin code entirely.

| Plugin | Uses | Replace with |
|--------|------|-------------|
| DataFlowValidator | getAllNodes + getAllEdges | queryNodes + getOutgoingEdges |
| GraphConnectivityValidator | getAllNodes + getAllEdges | queryNodes + getOutgoingEdges + graph traversal |
| TypeScriptDeadCodeValidator | getAllEdges | queryNodes + getIncomingEdges |
| ShadowingDetector | getAllNodes ×4 types | queryNodes ×4 |
| SocketIOAnalyzer | getAllNodes (filtered) | queryNodes (OK, just rename) |

### Phase 3: Enforce at type level
- Remove `getAllEdges` from `PluginGraphBackend` interface (plugins.ts)
- Keep it on `RFDBServerBackend` and `GraphBackend` for internal/export use

## Acceptance Criteria
- No false ERR_MISSING_ASSIGNMENT for for-of/for-in loop variables
- No plugin loads full graph into memory
- getAllEdges removed from PluginGraphBackend type
