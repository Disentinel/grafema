# REG-399: Parameter destructuring — create PARAMETER nodes for destructured function params

## Problem

When a function uses destructured parameters, no PARAMETER nodes are created for the destructured bindings:

```javascript
function foo({ maxBodyLength }) { ... }  // ✗ No PARAMETER node for maxBodyLength
function foo(maxBodyLength) { ... }      // ✓ PARAMETER node created
```

This is explicitly documented as TODO in `createParameterNodes.ts` (lines 28-31).

## Acceptance Criteria

- [ ] `function foo({ maxBodyLength }) {}` creates PARAMETER node for `maxBodyLength`
- [ ] Nested: `function foo({ data: { user } }) {}` creates PARAMETER for `user` with propertyPath
- [ ] Renaming: `function foo({ old: newName }) {}` creates PARAMETER for `newName`
- [ ] Array: `function foo([first, second]) {}` creates PARAMETER nodes
- [ ] Rest: `function foo({ a, ...rest }) {}` creates PARAMETER for `rest`
- [ ] Default values: `function foo({ x = 42 }) {}` works
- [ ] Arrow functions: `({ x }) => x` works

## Implementation Hint

Follow the pattern from `VariableVisitor.ts` (lines 330-480) which already handles destructuring for variable declarations. Extend `createParameterNodes.ts` to recursively extract names from ObjectPattern/ArrayPattern.
