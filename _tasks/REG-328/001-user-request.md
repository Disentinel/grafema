# REG-328: JSASTAnalyzer - ASSIGNED_FROM edges for ObjectExpression initializers

## Problem

When a variable is initialized with an object literal, no ASSIGNED_FROM edge is created:

```javascript
const statusData = { status: 'ok', timestamp: Date.now() };
```

The VARIABLE node `statusData` exists, but has no outgoing ASSIGNED_FROM edges. This means `traceValues()` cannot trace the data source.

## Impact

**Critical for REG-326 (Backend value tracing).**

Object literals are ~98% of JSON API responses:

```javascript
app.get('/status', (req, res) => {
  const data = { status: 'ok' };  // No ASSIGNED_FROM
  res.json(data);  // Can link to data, but can't trace further
});
```

Without this fix, REG-326 only works for ~2% of real-world cases.

## Root Cause

In `JSASTAnalyzer.trackVariableAssignment()`, there's no handler for `ObjectExpression` AST node type.

## Acceptance Criteria

- [ ] `const x = { key: value }` creates ASSIGNED_FROM edge from VARIABLE to OBJECT_LITERAL
- [ ] OBJECT_LITERAL node created for the object expression
- [ ] Nested objects handled: `const x = { nested: { deep: true } }`
- [ ] Spread handled: `const x = { ...other, key: val }`
- [ ] Existing tests pass
- [ ] `traceValues()` can trace through object literal assignments

## Technical Notes

Location: `packages/core/src/visitors/VariableVisitor.ts` or `trackVariableAssignment()` in JSASTAnalyzer

Related: REG-326 (blocked by this)
