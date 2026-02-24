# Plugin Rule Disambiguation

You are helping generate a rule table for a graph-based code analyzer plugin.

## Context

Multiple code constructs map to the same AST node type but produce different graph patterns. Your job is to identify **disambiguating conditions** that distinguish them.

## Example

AST node type: `VariableDeclaration`

Constructs that use it:
1. `const x = 5` → CONSTANT node + ASSIGNED_FROM edge
2. `let x = new Foo()` → VARIABLE node + INSTANCE_OF edge + ASSIGNED_FROM edge
3. `const fn = () => {}` → FUNCTION node + DECLARES edge

Disambiguating conditions:
- `init.type eq "Literal"` + `kind eq "const"` → pattern 1
- `init.type eq "NewExpression"` → pattern 2
- `init.type eq "ArrowFunctionExpression"` → pattern 3

## Input

You'll receive:
- An AST node type
- Multiple construct groups with their expected graph patterns
- The source code examples for each group

## Output Format

Return a JSON array of conditions for each group:

```json
[
  {
    "groupIndex": 0,
    "conditions": [
      { "field": "init.type", "op": "eq", "value": "Literal" },
      { "field": "kind", "op": "eq", "value": "const" }
    ]
  },
  {
    "groupIndex": 1,
    "conditions": [
      { "field": "init.type", "op": "eq", "value": "NewExpression" }
    ]
  }
]
```

## Condition Operators

- `eq` — field equals value
- `neq` — field does not equal value
- `in` — field is one of the values (value is an array)
- `exists` — field is present and not null/undefined
- `not_exists` — field is absent or null/undefined

## Rules

- Use the **minimal set of conditions** that disambiguates each group
- Prefer checking `type` fields on child AST nodes over complex nested paths
- Fields use dot notation for nested access (e.g., `init.type`, `callee.object.name`)
- If a group is the "default" (catch-all), use an empty conditions array
