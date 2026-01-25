# REG-232: FunctionCallResolver: Support re-export chains

## Summary

Add support for resolving function calls through re-export chains.

## Background

FunctionCallResolver (REG-225) currently skips re-exports where EXPORT has a `source` field:

```javascript
// index.js re-exports from other.js
export { foo } from './other';

// consumer.js
import { foo } from './index';
foo(); // Currently NOT resolved because of re-export
```

## Implementation

When EXPORT has a `source` field:

1. Resolve the source file path
2. Find the EXPORT in the source file
3. Recursively follow until finding a non-re-export EXPORT
4. Then find the FUNCTION as usual

Handle circular re-exports gracefully (detect and skip).

## Acceptance Criteria

- [ ] Single-hop re-exports resolve correctly
- [ ] Multi-hop re-export chains resolve correctly
- [ ] Circular re-exports don't cause infinite loops
- [ ] Performance remains acceptable

## Related

* REG-225 (FunctionCallResolver implementation)
