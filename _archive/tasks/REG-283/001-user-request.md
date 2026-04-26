# REG-283: AST: Track ForInStatement (LOOP + ITERATES_OVER)

**Source:** Linear task REG-283

## Problem

`ForInStatement` AST node is completely ignored during analysis.

## Example

```javascript
for (const key in object) {
  console.log(key, object[key]);
}
```

## Acceptance Criteria

- [ ] LOOP node with loopType: 'for-in'
- [ ] DECLARES edge to loop variable
- [ ] ITERATES_OVER edge to iterated object (iterates: 'keys')
