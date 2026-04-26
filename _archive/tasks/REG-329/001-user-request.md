# REG-329: Implement proper scope chain resolution for variable lookups

## Problem

Current variable resolution uses string prefix matching on semantic IDs:

```typescript
// Handler ID: "routes.js->anonymous[1]->FUNCTION->anonymous[1]"
// Scope prefix: "routes.js->anonymous[1]->"
// Variable ID: "routes.js->anonymous[1]->VARIABLE->statusData" ✓ matches
```

This approach:

1. **Misses module-level variables** — `routes.js->MODULE->VARIABLE->API_KEY` doesn't match handler prefix
2. **Doesn't handle shadowing** — Can't distinguish between inner/outer scope variables
3. **Fragile** — Depends on semantic ID string format

## Solution

Implement proper JavaScript scope chain resolution:

1. Start from identifier usage location
2. Walk up through scope hierarchy (function → outer function → module)
3. Find first matching declaration
4. Handle shadowing correctly (inner scope wins)

## Example

```javascript
const API_KEY = 'secret';  // Module scope

router.get('/data', (req, res) => {
  const localVar = 'local';  // Handler scope
  res.json({ key: API_KEY, local: localVar });
});
```

Resolution should find:

* `localVar` → handler scope (first tier)
* `API_KEY` → module scope (fallback tier)

## Acceptance Criteria

- [ ] Local scope variables resolved first
- [ ] Module-level variables resolved as fallback
- [ ] Shadowing handled correctly (inner scope wins)
- [ ] Works for nested functions
- [ ] Performance acceptable (can use parentScopeId index if needed)
- [ ] Existing tests pass

## Technical Notes

May need:

* `parentScopeId` field on nodes for efficient scope walking
* Scope chain abstraction for reuse across analyzers

Related: REG-326 (blocked by this)
