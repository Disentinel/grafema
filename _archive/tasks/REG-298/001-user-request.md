# REG-298: AST: Track await in loops

## Gap
Sequential await in loops not flagged.

## Example

```javascript
for (const url of urls) {
  const data = await fetch(url);  // Sequential, could be parallel
}
```

## Acceptance Criteria

- [ ] Flag as potential performance issue
- [ ] Suggest Promise.all pattern
