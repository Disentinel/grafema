# User Request: REG-200

## Linear Issue

**REG-200: Missing ASSIGNED_FROM edges for NewExpression (new Date, new Map, etc.)**

## Problem

Variables assigned from `new` expressions don't get ASSIGNED_FROM edges:

```javascript
const date = new Date();       // No ASSIGNED_FROM edge
const map = new Map();         // No ASSIGNED_FROM edge
const db = new Database(cfg);  // No ASSIGNED_FROM edge
```

## Impact

* ~20% of constructor calls in modern codebases use built-in constructors
* Data flow queries like "trace where this value comes from" return empty results
* Blocks value set analysis (VDomainAnalyzer) for constructor-assigned variables

## Root Cause (from Linear)

`GraphBuilder.bufferAssignmentEdges()` handles LITERAL, VARIABLE, CALL_SITE, METHOD_CALL but skips NewExpression entirely.

## Solution (proposed in Linear)

1. JSASTAnalyzer: emit variableAssignments for NewExpression init types
2. GraphBuilder: create ASSIGNED_FROM edges from VARIABLE → CLASS (for user classes) or VARIABLE → synthetic BUILTIN_CONSTRUCTOR node (for Date, Map, etc.)

## Acceptance Criteria

- [ ] `const date = new Date()` creates ASSIGNED_FROM edge
- [ ] `const map = new Map()` creates ASSIGNED_FROM edge
- [ ] `const db = new Database(config)` creates ASSIGNED_FROM edge to CLASS node
- [ ] Tests pass
- [ ] Demo: "trace constructor-assigned variables" works
