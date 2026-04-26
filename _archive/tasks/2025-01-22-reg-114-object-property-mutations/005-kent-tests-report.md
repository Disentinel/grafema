# REG-114: Object Property Mutation Tracking - Test Report

**Author:** Kent Beck (Test Engineer)
**Date:** 2025-01-22

---

## Summary

Tests written for REG-114 following TDD principles. All tests are currently RED (failing) as expected - the feature is not yet implemented.

## Test File

**Location:** `/Users/vadimr/grafema/test/unit/ObjectMutationTracking.test.js`

## Test Structure

Following the exact patterns from `ArrayMutationTracking.test.js`:
- Same imports and helper functions
- Same setup/teardown pattern with `createTestBackend()` and `createTestOrchestrator()`
- Same assertion patterns for finding nodes and verifying edges

## Test Coverage

### 1. `obj.prop = value` (Dot Notation)
- **should create FLOWS_INTO edge from assigned variable to object** - Verifies basic property assignment creates edge with correct direction and metadata
- **should handle multiple property assignments to same object** - Verifies multiple edges can point to same object with different propertyName
- **should NOT create FLOWS_INTO edge for literal values** - Confirms only variable assignments create edges (matching array mutation behavior)

### 2. `obj['prop'] = value` (Bracket Notation)
- **should create FLOWS_INTO edge for string literal key** - String literal keys treated as property names, not `<computed>`
- **should track computed key with `<computed>` property name** - Variable keys marked as `<computed>` with mutationType: 'computed'

### 3. `this.prop = value` (Class Context)
- **should track this.prop = value in constructor** - Constructor property assignments with objectName 'this'
- **should track this.prop = value in class methods** - Method property assignments

### 4. `Object.assign(target, source)`
- **should create FLOWS_INTO edge from source to target** - Basic Object.assign creates edge with mutationType: 'assign'
- **should create multiple edges for multiple sources with argIndex** - Multiple sources create edges with argIndex 0, 1, 2
- **should handle spread in Object.assign with isSpread metadata** - Spread operator sets isSpread: true
- **should skip anonymous target: Object.assign({}, source)** - Documented limitation

### 5. Function-Level Mutations
- **should detect property assignments inside functions** - Mutations in function bodies
- **should detect Object.assign inside functions** - Object.assign in function bodies
- **should detect mutations inside arrow functions** - Arrow function support

### 6. Edge Metadata Verification
- **should include mutationType in edge metadata for all mutation types** - Verifies 'property', 'computed', 'assign'
- **should include propertyName in edge metadata** - Verifies actual names, `<computed>`, `<assign>`

### 7. Edge Direction Verification
- **should create edge with correct direction: value -> object** - src=value, dst=object

### 8. Integration Tests
- **should allow tracing objects through property assignment (DI pattern)** - Real DI container scenario
- **should track configuration merging with Object.assign** - Config merging with multiple sources
- **should track event handler registration pattern** - Event emitter pattern

### 9. Edge Cases
- **should handle assignment with expression on right side** - `obj.sum = a + b` (no edge)
- **should handle call expression on right side** - `obj.data = fetchData()` (no edge)
- **should NOT confuse array indexed assignment with object property** - Distinguishes arr[0] from obj[key]

## Test Count

Total: **24 test cases** across 9 describe blocks

## Verification

Tests run and fail as expected (RED state):
```
not ok 1 - should create FLOWS_INTO edge from assigned variable to object
  error: 'Expected FLOWS_INTO edge from "handler" to "config". Found FLOWS_INTO edges: []'
```

This confirms:
1. The test infrastructure works correctly
2. The feature is not yet implemented
3. Tests are properly detecting the absence of FLOWS_INTO edges

## Design Decisions

### 1. Match Array Mutation Patterns
Tests follow the same patterns as `ArrayMutationTracking.test.js` for consistency:
- Only variables create FLOWS_INTO edges (not literals, not expressions)
- Edge direction: value FLOWS_INTO object (src=value, dst=object)
- Metadata includes mutation type and property information

### 2. Edge Metadata
Tests verify three types of mutations:
- `property` - Direct property access (`obj.prop`, `obj['literal']`)
- `computed` - Dynamic key (`obj[variable]`)
- `assign` - Object.assign pattern

### 3. Special Property Names
- Actual property names for dot notation and string literals
- `<computed>` for dynamic keys
- `<assign>` for Object.assign

### 4. Out of Scope (Documented in Tests)
- Nested property access (`obj.nested.prop = value`) - complex scenario for future
- Expression values (`obj.sum = a + b`) - can't resolve to single source
- Call expression values (`obj.data = fn()`) - matches array behavior

## Notes for Rob (Implementation Engineer)

1. The test helpers and patterns are identical to ArrayMutationTracking - use that as reference
2. Tests expect metadata fields: `mutationType`, `propertyName`, `argIndex`, `isSpread`
3. Anonymous targets in Object.assign should be skipped (documented limitation)
4. `this` mutations may need special handling since `this` isn't a variable node

## Ready for Implementation

Tests are complete and RED. Ready for Rob to implement the feature and turn tests GREEN.
