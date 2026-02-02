# REG-280: AST Track WhileStatement (LOOP node)

## Gap

`WhileStatement` AST node is completely ignored.

## Example

```javascript
while (queue.length > 0) {
  process(queue.shift());
}
```

## Expected Graph

```
LOOP#while:file.js:1
  ├─[HAS_CONDITION]→ EXPRESSION(queue.length > 0)
  └─[HAS_BODY]→ SCOPE#loop-body
       └─[CONTAINS]→ CALL(process)
```

## User Impact

* Can't detect potential infinite loops
* Can't understand iteration patterns
* Missing from complexity metrics

## Acceptance Criteria

- [ ] LOOP node created for WhileStatement
- [ ] HAS_CONDITION edge to test expression
- [ ] HAS_BODY edge to loop body scope
