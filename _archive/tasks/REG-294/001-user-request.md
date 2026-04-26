# REG-294: AST: Track dynamic import()

## Gap

Dynamic imports not tracked.

## Example

```javascript
const mod = await import('./dynamic.js');
const config = await import(`./config/${env}.js`);
```

## Acceptance Criteria

- [ ] IMPORT node with isDynamic: true
- [ ] Resolve literal paths
- [ ] Mark template literal paths as partially resolved
