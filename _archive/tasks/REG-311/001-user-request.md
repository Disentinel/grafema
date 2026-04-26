# REG-311: AST: Track async error patterns (Promise.reject, reject callback)

**Linear:** https://linear.app/reginaflow/issue/REG-311/ast-track-async-error-patterns-promisereject-reject-callback

**Labels:** v0.2, Feature

## Gap

Async error patterns are not tracked, only synchronous `throw` statements.

## Untracked patterns

```javascript
// 1. Promise.reject()
function fail() {
  return Promise.reject(new ValidationError('fail'));
}

// 2. reject() inside Promise constructor
function asyncOp() {
  return new Promise((resolve, reject) => {
    if (bad) reject(new Error('bad'));
  });
}

// 3. Error-first callback pattern (Node.js)
function readFile(path, callback) {
  if (!exists(path)) {
    callback(new Error('not found'));
    return;
  }
}
```

## Proposed solution

1. **REJECTS edge** from function to error class for:
   - `Promise.reject(new Error())` calls
   - `reject(new Error())` inside Promise constructor
2. **canReject metadata** on functions containing rejection patterns
3. **Optional:** Track error-first callback patterns (`callback(new Error())`)

## Design considerations

- REJECTS vs THROWS: different error mechanisms (async vs sync)
- Static analysis limitation: can only detect `new Error()` patterns, not variable rejections
- Promise constructor: need to identify `reject` parameter name

## Acceptance Criteria

- [ ] REJECTS edge from function to error class for Promise.reject()
- [ ] Track reject() calls inside Promise constructors
- [ ] canReject metadata on functions
- [ ] Consider error-first callback tracking (optional)

## Related

- REG-286 (ThrowStatement tracking)
