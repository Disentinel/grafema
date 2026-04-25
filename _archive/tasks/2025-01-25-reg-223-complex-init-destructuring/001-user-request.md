# User Request

## Source
Linear issue REG-223 (follow-up to REG-201)

## Request
Add ASSIGNED_FROM edges for destructuring with complex init expressions.

## Linear Issue Details

**Title:** ASSIGNED_FROM edges for destructuring with complex init expressions

**Context:**
REG-201 added ASSIGNED_FROM edges for simple destructuring (`const { x } = obj`).
But complex init expressions are not handled:

```javascript
const { data } = await fetchUser();  // ❌ No edge
const { x } = getConfig();           // ❌ No edge
const [first] = arr.filter(x => x);  // ❌ No edge
```

**Problem:**
~20% of destructuring in real codebases uses function calls as init.

**Solution:**
For `const { x } = getConfig()`:
1. Create EXPRESSION node for CallExpression result
2. Create ASSIGNED_FROM edge: `x ← EXPRESSION(getConfig().x)`
3. Create DERIVES_FROM edge: `EXPRESSION ← getConfig` (call site)

**Acceptance Criteria:**
- [ ] `const { data } = await fetch()` creates ASSIGNED_FROM edge
- [ ] `const { x } = getConfig()` creates ASSIGNED_FROM edge
- [ ] `const [first] = arr.map(fn)` creates ASSIGNED_FROM edge
- [ ] Works with MemberExpression init: `const { x } = obj.getConfig()`
- [ ] Tests pass
