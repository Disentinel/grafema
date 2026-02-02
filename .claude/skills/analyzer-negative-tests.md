# Analyzer Negative Test Cases

When writing pattern-matching analyzers in Grafema, always include negative test cases to prevent false positives.

## When to Use

- Creating new analyzer plugin (e.g., FetchAnalyzer, DatabaseAnalyzer)
- Adding new pattern matching logic
- Extending existing analyzer with new patterns

## The Problem

REG-233: FetchAnalyzer matched `console.log()` as `net:request` because pattern was too broad. No negative test caught this before production.

## Pattern

For every positive pattern, write negative tests for similar-looking non-matches:

```typescript
// Positive: what we WANT to detect
test('detects fetch() calls', () => {
  const code = `fetch('/api/users')`;
  const nodes = analyze(code);
  expect(nodes.some(n => n.type === 'net:request')).toBe(true);
});

// NEGATIVE: what we DON'T want to detect
test('does NOT detect console.log() as network request', () => {
  const code = `console.log('/api/users')`;
  const nodes = analyze(code);
  expect(nodes.some(n => n.type === 'net:request')).toBe(false);
});

test('does NOT detect logger.info() as network request', () => {
  const code = `logger.info('/api/users')`;
  const nodes = analyze(code);
  expect(nodes.some(n => n.type === 'net:request')).toBe(false);
});
```

## Common False Positive Sources

| Pattern | False Positives to Test |
|---------|------------------------|
| Network calls | console.*, logger.*, debug() |
| Database queries | cache.get(), map.get() |
| File operations | url.parse(), path.join() |
| Event emitters | console.log(), process.exit() |

## Checklist for New Analyzer

- [ ] Positive tests for each pattern
- [ ] Negative tests for console.* methods
- [ ] Negative tests for logging libraries
- [ ] Negative tests for similar-named utilities
- [ ] Test with real-world code snippets that triggered false positives before
