# REG-282: AST: Track ForStatement (LOOP node)

## Gap

`ForStatement` AST node is completely ignored.

## Example

```javascript
for (let i = 0; i < items.length; i++) {
  process(items[i]);
}
```

## User Impact

- Classic loop pattern not represented
- Can't analyze loop bounds
- Can't detect off-by-one patterns

## Acceptance Criteria

- [ ] LOOP node for ForStatement
- [ ] HAS_INIT, HAS_CONDITION, HAS_UPDATE, HAS_BODY edges
