# Demo Report: REG-275 Track SwitchStatement as BRANCH nodes

**Date:** 2026-01-26
**Demo by:** Steve Jobs
**Result:** PASS

---

## Summary

The feature works exactly as designed. When I analyze a Redux-style reducer with switch statement, Grafema now creates a beautiful, queryable graph structure.

## The Input

```javascript
function reducer(state, action) {
  switch (action.type) {
    case 'ADD': return add(action.payload);
    case 'REMOVE': return remove(action.id);
    default: return state;
  }
}
```

## The Output (Graph Structure)

### BRANCH Node

```
BRANCH nodes found: 1
  - ID: reducer.js->reducer->BRANCH->switch#0
    branchType: switch
    line: 3
```

### CASE Nodes

```
CASE nodes found: 3
  - ID: reducer.js->reducer->CASE->ADD#0
    value: ADD
    isDefault: false
    fallsThrough: false
    isEmpty: false

  - ID: reducer.js->reducer->CASE->REMOVE#1
    value: REMOVE
    isDefault: false
    fallsThrough: false
    isEmpty: false

  - ID: reducer.js->reducer->CASE->default#2
    value: null
    isDefault: true
    fallsThrough: false
    isEmpty: false
```

### Edge Connections

```
HAS_CONDITION edges: 1
  reducer.js->reducer->BRANCH->switch#0 --[HAS_CONDITION]--> EXPRESSION:MemberExpression (action.type)

HAS_CASE edges: 2
  reducer.js->reducer->BRANCH->switch#0 --[HAS_CASE]--> CASE(ADD)
  reducer.js->reducer->BRANCH->switch#0 --[HAS_CASE]--> CASE(REMOVE)

HAS_DEFAULT edges: 1
  reducer.js->reducer->BRANCH->switch#0 --[HAS_DEFAULT]--> reducer.js->reducer->CASE->default#2
```

## Verification Checklist

| Requirement | Status |
|------------|--------|
| BRANCH node created with branchType='switch' | YES |
| HAS_CONDITION edge to discriminant (action.type) | YES |
| HAS_CASE edges to non-default cases | YES (2 edges) |
| HAS_DEFAULT edge to default case | YES |
| CASE nodes have value property | YES |
| Default CASE has isDefault=true | YES |
| Default CASE has value=null | YES |
| fallsThrough detection works | YES (all false for return statements) |

## "Would I Show This On Stage?"

**YES.**

This is clean, elegant, and solves a real problem. Before this feature, switch statements were opaque - you couldn't query them, you couldn't understand the branching logic without reading code.

Now look at what we can do:

1. **Find all Redux action types** - just query for CASE nodes where parent BRANCH has discriminant matching `action.type`

2. **Detect missing defaults** - find BRANCH nodes without HAS_DEFAULT edges

3. **Find fall-through bugs** - query for CASE nodes with `fallsThrough=true` and `isEmpty=false`

4. **Understand state machine transitions** - the graph now captures the full decision tree

The semantic IDs are beautiful: `reducer.js->reducer->BRANCH->switch#0`. You know exactly where you are in the codebase.

## Graph Visualization

```
BRANCH#switch:reducer.js:3
  |
  +--[HAS_CONDITION]--> EXPRESSION(action.type)
  |
  +--[HAS_CASE]--> CASE('ADD')
  |                 - fallsThrough: false
  |                 - isEmpty: false
  |
  +--[HAS_CASE]--> CASE('REMOVE')
  |                 - fallsThrough: false
  |                 - isEmpty: false
  |
  +--[HAS_DEFAULT]--> CASE(default)
                       - isDefault: true
                       - fallsThrough: false
```

---

**Verdict:** Ship it.
