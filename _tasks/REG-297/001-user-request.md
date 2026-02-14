# REG-297: AST: Track top-level await

## Gap
Top-level await not marked.

## Example

```javascript
// module.js
const data = await fetchData();
export { data };
```

## Acceptance Criteria

- [ ] MODULE node with hasTopLevelAwait: true
- [ ] Track which top-level expressions await
