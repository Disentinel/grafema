# REG-300: AST: Track import.meta

## Description

`import.meta` access is not currently tracked in the graph.

## Examples

```javascript
const __dirname = new URL('.', import.meta.url).pathname;
const env = import.meta.env.MODE;
```

## Acceptance Criteria

- [ ] Track import.meta.url, import.meta.env
- [ ] MODULE node metadata for which meta properties used
