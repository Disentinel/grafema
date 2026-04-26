# User Request: REG-135

**Issue:** [REG-135 - Computed Property Value Resolution](https://linear.app/reginaflow/issue/REG-135)

## Request

Implement computed property value resolution to resolve `obj[key]` when `key` is deterministic.

## Summary from Linear

When analyzing computed property access like `obj[key] = value`, Grafema currently stores `propertyName: '<computed>'` because the value of `key` is not known at parse time. This loses precision even when the key is statically determinable.

**Goal:** Resolve computed property names when the key variable has a deterministic value at static analysis time.

## Acceptance Criteria (Phase 1)

- [ ] Add `computedPropertyVar?: string` field to `ObjectMutationInfo`
- [ ] Store variable name during AST analysis for computed property mutations
- [ ] Implement `ResolutionStatus` enum in types
- [ ] Create enrichment step to resolve single-hop and multi-hop literal assignments
- [ ] Update `FLOWS_INTO` edge metadata with resolved `propertyName` and `resolutionStatus`
- [ ] Conditional assignments resolve with `isConditional: true`
- [ ] Tests for all Phase 1 patterns
- [ ] Performance impact < 5% on analysis time

## Patterns to Handle

| Pattern | Example | Resolution |
|---------|---------|------------|
| Direct literal | `const k = 'x'; obj[k]` | RESOLVED |
| Literal chain | `const a = 'x'; const b = a; obj[b]` | RESOLVED |
| Ternary | `const k = c ? 'a' : 'b'; obj[k]` | RESOLVED_CONDITIONAL |
| Parameter | `function f(k) { obj[k] }` | UNKNOWN_PARAMETER |
| External call | `const k = getKey(); obj[k]` | UNKNOWN_RUNTIME |
| Cross-file | `const k = imported.KEY; obj[k]` | DEFERRED_CROSS_FILE |
