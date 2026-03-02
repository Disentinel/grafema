# Plan: REG-602 — delete obj.prop: deferred scope_lookup targets wrong name

## Problem Analysis

### Bug 1: `visitUnaryExpression` — delete (lines 802-817)

```typescript
if (unary.operator === 'delete' && unary.argument.type === 'MemberExpression') {
  const prop = unary.argument.property;
  if (prop.type === 'Identifier') {
    result.deferred.push({
      kind: 'scope_lookup',
      name: prop.name,        // ← BUG: looks up "prop" as a variable name
      edgeType: 'DELETES',
      ...
    });
  }
}
```

Three problems:
1. scope_lookup on property name (`prop`), not root variable (`obj`)
2. Only handles non-computed properties (`prop.type === 'Identifier'`)
3. Doesn't handle `OptionalMemberExpression` (`delete obj?.prop`)

### Bug 2: `visitUpdateExpression` — obj.prop++ (lines 843-854)

```typescript
if (update.argument.type === 'Identifier') {
  // scope_lookup on argument.name → MODIFIES
}
// MemberExpression argument entirely ignored
```

`obj.prop++` creates no deferred to root variable — mutation is invisible to graph.

## Approach

Follow **PROPERTY_ASSIGNMENT pattern** from `visitAssignmentExpression` (lines 690-705):
use `extractRootIdentifier()` on `member.object` + `WRITES_TO` deferred.

### Fix 1: visitUnaryExpression (delete)

**Before:**
- `delete obj.prop` → scope_lookup on `"prop"` → tries to find variable named `prop` → wrong
- `delete obj[key]` → silently skipped
- `delete obj?.prop` → silently skipped

**After:**
- `delete obj.prop` → scope_lookup on `"obj"` → WRITES_TO → VARIABLE:obj
- `delete obj[key]` → scope_lookup on `"obj"` → WRITES_TO → VARIABLE:obj
- `delete obj?.prop` → scope_lookup on `"obj"` → WRITES_TO → VARIABLE:obj
- `delete this.prop` → extractRootIdentifier returns null → no deferred (correct)
- `delete a.b.c` → scope_lookup on `"a"` → WRITES_TO → VARIABLE:a

### Fix 2: visitUpdateExpression (++/--)

**Before:**
- `obj.prop++` → no deferred at all
- `this.x++` → no deferred

**After:**
- `obj.prop++` → scope_lookup on `"obj"` → WRITES_TO → VARIABLE:obj
- `this.x++` → extractRootIdentifier returns null → no deferred (correct)
- `a.b.c--` → scope_lookup on `"a"` → WRITES_TO → VARIABLE:a

## Edge Cases

### delete

| Input | Root variable | Behavior |
|-------|--------------|----------|
| `delete obj.prop` | `obj` | WRITES_TO → VARIABLE:obj |
| `delete obj[key]` | `obj` | WRITES_TO → VARIABLE:obj |
| `delete obj?.prop` | `obj` | WRITES_TO → VARIABLE:obj |
| `delete a.b.c` | `a` | WRITES_TO → VARIABLE:a |
| `delete this.prop` | null | No deferred (correct) |
| `delete super.prop` | null | No deferred (correct) |
| `delete fn().prop` | null | No deferred (correct — can't track) |
| `delete variable` | N/A | Not MemberExpression → not handled (bare delete is non-strict only) |
| `delete obj[fn()]` | `obj` | WRITES_TO → VARIABLE:obj |

### update (++/--)

| Input | Root variable | Behavior |
|-------|--------------|----------|
| `obj.prop++` | `obj` | WRITES_TO → VARIABLE:obj |
| `obj[key]--` | `obj` | WRITES_TO → VARIABLE:obj |
| `this.x++` | null | No deferred (correct) |
| `a.b.c++` | `a` | WRITES_TO → VARIABLE:a |
| `i++` | `i` | Unchanged — existing MODIFIES logic (line 843) |

## Known Limitations (NOT fixing)

1. **Edge-map USES stays**: `UnaryExpression.argument` edge-map creates `EXPRESSION(delete) --USES--> PROPERTY_ACCESS`. Semantically imprecise for delete but edge-map is static — can't conditionally change. Both USES (structural) and WRITES_TO (semantic) edges coexist. Fixing requires architectural change to edge-map.

2. **`delete variable`**: Bare identifier delete in non-strict mode. Extremely rare, SyntaxError in strict mode. Not in scope.

## Files to Modify

1. **`packages/core-v2/src/visitors/expressions.ts`** — Fix both visitors (~15 lines changed)
2. **`test/unit/DeleteExpression.test.js`** — New test file for delete + update edge cases

## Graph Invariants (Acceptance Criteria)

### delete
1. `delete obj.prop` → EXPRESSION(delete) has WRITES_TO edge to VARIABLE:obj
2. `delete obj[key]` → EXPRESSION(delete) has WRITES_TO edge to VARIABLE:obj
3. `delete obj?.prop` → EXPRESSION(delete) has WRITES_TO edge to VARIABLE:obj
4. `delete this.prop` → EXPRESSION(delete) has NO WRITES_TO deferred
5. No deferred ref has `name` equal to a property name — only root variable names

### update
6. `obj.prop++` → EXPRESSION(++) has WRITES_TO edge to VARIABLE:obj
7. `obj[key]--` → EXPRESSION(--) has WRITES_TO edge to VARIABLE:obj
8. `i++` → unchanged (MODIFIES edge to VARIABLE:i)

### structural (unchanged)
9. EXPRESSION --USES--> PROPERTY_ACCESS edge exists (from edge-map)

## Test Strategy

New test file `test/unit/DeleteExpression.test.js`:
- **delete cases**: obj.prop, obj[key], obj?.prop, a.b.c, this.prop
- **update cases**: obj.prop++, obj[key]--, this.x++, a.b.c++
- Assert WRITES_TO edges to correct root VARIABLE
- Assert NO WRITES_TO for this/super/fn() roots
- Assert PROPERTY_ACCESS node exists
- Assert no deferred on property names

## Atomic Changes

1. **Commit 1**: Tests first — `test/unit/DeleteExpression.test.js` (red tests)
2. **Commit 2**: Fix `visitUnaryExpression` + `visitUpdateExpression` in expressions.ts (green tests)
