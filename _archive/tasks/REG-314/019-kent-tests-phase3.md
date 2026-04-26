# Kent Beck - Tests for REG-314 Phase 3: Standard Rules Library

**Date:** 2026-02-03
**Status:** TESTS WRITTEN, FAILING (TDD Step 1 Complete)

---

## Summary

Created test file and placeholder implementation for Phase 3 standard rules library.
All 12 tests fail with "Not implemented" error - ready for Rob to implement.

---

## Files Created

### 1. Test File

**Path:** `test/unit/guarantees/standard-rules.test.js`

**Test groups:**
- `getStandardRule()` - 3 tests
- `listStandardRules()` - 3 tests
- `Rule content validation` - 3 tests
- `Edge cases` - 3 tests

**Total:** 12 tests

### 2. Standard Rules YAML

**Path:** `packages/core/src/guarantees/standard-rules.yaml`

Contains one smoke test rule: `n-squared-same-scale`

```yaml
n-squared-same-scale:
  description: "Nested loops both at same cardinality scale (potential O(n^2))"
  rule: |
    violation(Outer, Inner, File, Line) :-
      node(Outer, "LOOP"),
      node(Inner, "LOOP"),
      edge(Outer, Inner, "CONTAINS"),
      edge(Outer, Coll1, "ITERATES_OVER"),
      edge(Inner, Coll2, "ITERATES_OVER"),
      attr_edge(Outer, Coll1, "ITERATES_OVER", "cardinality.scale", Scale),
      attr_edge(Inner, Coll2, "ITERATES_OVER", "cardinality.scale", Scale),
      attr(Outer, "file", File),
      attr(Outer, "line", Line).
  severity: error
```

### 3. Placeholder Implementation

**Path:** `packages/core/src/guarantees/index.ts`

Exports:
- `getStandardRule(ruleId: string): StandardRule | null` - throws "not implemented"
- `listStandardRules(): string[]` - throws "not implemented"
- `StandardRule` interface

### 4. Core Package Export

Added to `packages/core/src/index.ts`:
```typescript
// Standard rules library (REG-314 Phase 3)
export {
  getStandardRule,
  listStandardRules,
} from './guarantees/index.js';
export type {
  StandardRule,
} from './guarantees/index.js';
```

---

## Test Results

```
# tests 12
# suites 5
# pass 0
# fail 12
```

All tests fail with:
```
Error: 'Not implemented: getStandardRule'
Error: 'Not implemented: listStandardRules'
```

This is expected - TDD Step 1 complete.

---

## Test Coverage Details

### Group 1: getStandardRule()

| Test | Description |
|------|-------------|
| Rule exists | `getStandardRule('n-squared-same-scale')` returns rule object |
| Rule not found | `getStandardRule('nonexistent-rule-xyz')` returns `null` |
| Clean ID | Rule ID without "standard:" prefix works |

### Group 2: listStandardRules()

| Test | Description |
|------|-------------|
| Returns array | Returns array of rule IDs |
| Includes rule | Array includes 'n-squared-same-scale' |
| All retrievable | Every listed rule can be retrieved |

### Group 3: Rule Content Validation

| Test | Description |
|------|-------------|
| Required fields | Rule has: id, description, rule, severity |
| Valid Datalog | Rule has `violation(` head, `:-` separator, ends with `.` |
| All rules valid | Every rule in library passes validation |

### Group 4: Edge Cases

| Test | Description |
|------|-------------|
| Empty string | `getStandardRule('')` returns `null` |
| Special chars | `getStandardRule('../../etc/passwd')` returns `null` |
| Fresh array | `listStandardRules()` returns new array each call |

---

## Implementation Notes for Rob

1. **YAML Loading:**
   - Use `yaml` package (already in deps)
   - Load YAML file once at module init (or lazy load)
   - Parse into Map<string, StandardRule>

2. **API Contract:**
   - `getStandardRule`: Return `null` for not found, not `undefined`
   - `listStandardRules`: Return fresh array each call (defensive copy)

3. **Rule Structure:**
   - `id`: Rule identifier (key in YAML)
   - `description`: Human-readable
   - `rule`: Datalog query string
   - `severity`: 'error' | 'warning' | 'info'

4. **File Location:**
   - YAML: `packages/core/src/guarantees/standard-rules.yaml`
   - Need to resolve path relative to module

---

## Next Steps

1. Rob implements `getStandardRule()` and `listStandardRules()` in `index.ts`
2. Run tests: `node --test test/unit/guarantees/standard-rules.test.js`
3. All 12 tests should pass

---

**TDD Status: Step 1 Complete - Tests Written, All Failing**

Ready for implementation.
