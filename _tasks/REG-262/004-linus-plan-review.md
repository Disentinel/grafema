# Linus Torvalds' Review: REG-262 Plan

## APPROVED - with minor observations

Don and Joel got this right. Let me explain why.

## 1. Is this the RIGHT solution or a band-aid?

**It's the right solution.**

The fundamental problem is that the graph lacks semantic information about method call receivers. We have:
- `PASSES_ARGUMENT` for function arguments (CALL -> arg)
- `ASSIGNED_FROM` for data flow
- But nothing for "this call uses this object as receiver"

The `USES` edge fills this semantic gap. It's not a workaround - it's the correct way to model this relationship in the graph.

## 2. Edge direction: METHOD_CALL -> VARIABLE

**Correct.**

The direction `METHOD_CALL --USES--> variable` is semantically accurate:
- "This call uses this variable"
- Consistent with `PASSES_ARGUMENT` direction (CALL -> arg)
- Follows the "actor USES object" pattern

The alternative (`variable --RECEIVER_OF--> call`) would work but requires a new edge type and is less general. `USES` already exists and can be reused for other usage patterns.

## 3. Edge cases

**Properly handled:**

| Case | Decision | Verdict |
|------|----------|---------|
| `this.method()` | No USES edge | Correct - `this` is not a variable node |
| `obj.a.method()` | USES -> base `obj` | Correct - trace to the root variable |
| Parameters | Check parameters too | Correct - `param.method()` must work |
| Computed `obj[x]()` | USES -> `obj` | Correct |

The plan correctly identifies that `object.includes('.')` means nested access and extracts the base name via `.split('.')[0]`. Simple and correct.

## 4. DataFlowValidator change

**Correct approach.**

The plan adds a check for incoming `USES` edges BEFORE following `ASSIGNED_FROM`. This means:

```typescript
// Current: only follows ASSIGNED_FROM outward
variable -> ASSIGNED_FROM -> ... -> leaf

// New: also checks if variable has incoming USES
variable <-- USES -- METHOD_CALL  // Variable is used, not dead
```

This is the minimal change needed. The validator doesn't need to traverse USES edges recursively - just having a USES edge pointing at the variable is proof it's used.

## 5. What I like

1. **No new edge types** - reuses existing `USES` type
2. **No interface changes** - `MethodCallInfo.object` already has the receiver name
3. **Minimal code changes** - two focused modifications
4. **TDD approach** - tests first with clear test cases
5. **Performance consideration acknowledged** - one edge per method call is acceptable overhead

## 6. Minor observations (not blockers)

**a) Import edge case**: Joel's plan mentions "import is not a variable" but doesn't explicitly handle it. However, since imports aren't in `variableDeclarations` or `parameters`, this case naturally falls through with no edge created. Fine.

**b) Global/external objects**: `console.log()`, `Math.abs()` - these have no variable to link to. The plan handles this implicitly (no match in variableDeclarations/parameters = no edge). Good.

**c) Chained calls**: `arr.map().filter()` - only the first call gets USES to `arr`. The intermediate `.map()` result is not a variable, so no edge. This is correct behavior.

## Verdict

**APPROVED.**

This is a clean, minimal fix that:
- Adds the correct semantic information to the graph
- Uses existing infrastructure (USES edge type)
- Requires minimal code changes
- Has clear test coverage

Proceed with implementation.
