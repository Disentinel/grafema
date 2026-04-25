# REG-290: AST Track AssignmentExpression with compound operators

## Gap

`+=`, `-=`, etc. should create both READ and WRITE edges.

## Example

```javascript
total += item.price;  // Reads total, writes total
```

## Acceptance Criteria

- [ ] READS_FROM edge for compound operators
- [ ] WRITES_TO edge for assignment target
- [ ] Support all compound operators (+=, -=, *=, /=, &&=, ||=, ??=)
