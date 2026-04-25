# REG-287: AST Track ConditionalExpression (ternary) as BRANCH

## Gap

Ternary tracked as EXPRESSION but not as branching.

## Example

```javascript
const result = isValid ? processValid(data) : handleError(data);
```

## Acceptance Criteria

- [ ] Option to track ternary as BRANCH node
- [ ] Contributes to cyclomatic complexity count
