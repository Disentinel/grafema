# REG-275: AST: Track SwitchStatement (BRANCH node)

## Gap

`SwitchStatement` AST node is completely ignored.

## Example

```javascript
switch (action.type) {
  case 'ADD': return add(action.payload);
  case 'REMOVE': return remove(action.id);
  default: return state;
}
```

## Expected Graph

```
BRANCH#switch:file.js:1
  ├─[HAS_CONDITION]→ EXPRESSION(action.type)
  ├─[HAS_CASE]→ CASE('ADD')
  ├─[HAS_CASE]→ CASE('REMOVE')
  └─[HAS_DEFAULT]→ CASE(default)
```

## User Impact

* Can't analyze Redux reducers, state machines
* Can't detect missing cases
* Can't trace which case handles which value

## Acceptance Criteria

- [ ] BRANCH node created for SwitchStatement
- [ ] HAS_CONDITION edge to discriminant
- [ ] HAS_CASE edges to each case clause
- [ ] Track fall-through patterns
