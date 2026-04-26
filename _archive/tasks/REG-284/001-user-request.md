# REG-284: AST: Track ForOfStatement (LOOP + ITERATES_OVER)

**Gap:** `ForOfStatement` AST node is completely ignored.

**Example:**

```javascript
for (const item of items) {
  process(item);
}

for await (const chunk of stream) {
  buffer.push(chunk);
}
```

**User Impact:**

* Most common iteration pattern in modern JS not tracked
* Can't trace data flow from arrays to loop variables
* for-await-of not handled for async iteration

**Acceptance Criteria:**

- [ ] LOOP node with loopType: 'for-of'
- [ ] DECLARES edge to loop variable(s)
- [ ] ITERATES_OVER edge to iterable
- [ ] Support destructuring in loop variable
- [ ] Track async: true for for-await-of
