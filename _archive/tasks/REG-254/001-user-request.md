# REG-254: Variable tracing stops at function call boundaries

## Problem

When tracing variable values, Grafema doesn't follow calls to internal functions.

### Example

```tsx
async function fetchInvitations() {
  const response = await authFetch('/api/invitations')  // authFetch is internal helper
  return await response.json()
}
```

When querying `fetchInvitations`:

* `calls: []` - shows empty
* Doesn't show that it calls `authFetch()`
* Doesn't show that `authFetch` makes HTTP request

## Why This Matters

* Most code is composed of helper functions
* Understanding a function requires understanding what it calls
* Without this, users must manually trace through multiple functions

## Acceptance Criteria

- [ ] Function nodes show internal function calls in `calls` field
- [ ] Async/await function calls are resolved
- [ ] Transitive calls available (A calls B calls C)
- [ ] Works for: regular functions, async functions, methods

## Technical Notes

This may be related to how call expressions are analyzed. Need to verify:

1. Are call expressions being detected inside function bodies?
2. Are they being linked to function definitions?
3. Is the issue in analysis or in query output?

Root cause investigation needed before implementation.
