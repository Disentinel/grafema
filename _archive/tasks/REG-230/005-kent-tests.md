# Kent Beck: REG-230 Test Report

## Test File Location

`/Users/vadimr/grafema-worker-8/test/unit/commands/trace-sink.test.js`

## Test Suite Overview

Created comprehensive TDD test suite for sink-based trace functionality (`grafema trace --to "fn#0.property"`).

## Test Cases Written

### Part 1: Sink Spec Parsing (8 tests)

**Valid sink specs:**
1. `"fn#0.type"` - Basic format with function, argIndex, property
2. `"addNode#0.config.options"` - Multi-level property path
3. `"fn#0"` - No property path (Linus requirement: traces entire argument)
4. `"fn#5.value"` - Higher argument index
5. Function names with underscores/numbers: `"add_node_v2#1.type"`

**Invalid sink specs:**
6. `"#0.type"` - No function name (should throw)
7. `"fn#abc.type"` - Non-numeric argIndex (should throw)
8. `"fn"` - No # separator (should throw)
9. `"fn#-1.type"` - Negative argIndex (should throw)
10. Empty string (should throw)
11. `"fn#.type"` - Missing argIndex (should throw)

### Part 2: Sink Resolution (16 tests)

**Call site discovery:**
1. Find call sites for direct function calls
2. Find call sites for method calls (`obj.addNode()`)
3. Return empty array when function not found

**Argument extraction:**
4. Extract argument at specified index via PASSES_ARGUMENT edge
5. Return null when argument index out of range

**Value tracing through objects:**
6. Trace property "type" to LITERAL values (main use case)
7. Find multiple values from different call sites

**Tracing entire argument (no property path):**
8. Trace entire argument when no property specified
9. Trace variable to literal when no property specified

**Edge cases:**
10. Return empty possibleValues when function not found
11. Skip call site when argument index out of range
12. Mark unknown when property does not exist
13. Handle method calls (`obj.fn()`) same as direct calls
14. Detect PARAMETER as nondeterministic source

**Output structure:**
15. Return correct output structure with sources
16. Deduplicate same values from different call sites

## Test Design Principles

### TDD Approach
- All tests fail until implementation exists (expected)
- Tests define the contract before code
- Helper functions return null when functions not exported yet

### Linus Requirements Coverage

| Requirement | Test Coverage |
|-------------|---------------|
| Property path OPTIONAL | Test #3, #8, #9 verify `fn#0` format works |
| Handle direct calls | Tests #1, #6, #7 use direct function calls |
| Handle method calls | Test #12, #14 verify `obj.fn()` pattern |
| Use ValueDomainAnalyzer | Integration tests verify value tracing works |

### Graph Structures Tested

```
Simple argument:
  CALL -> PASSES_ARGUMENT -> LITERAL

Variable argument:
  CALL -> PASSES_ARGUMENT -> VARIABLE -> ASSIGNED_FROM -> LITERAL

Object property access:
  CALL -> PASSES_ARGUMENT -> VARIABLE
       -> ASSIGNED_FROM -> OBJECT_LITERAL
       -> HAS_PROPERTY -> LITERAL
```

## Running Tests

```bash
# Run sink trace tests only
node --test test/unit/commands/trace-sink.test.js

# Expected: All tests FAIL (TDD - implementation comes next)
```

## Current Status

All 24 tests written and verified to fail with:
```
"parseSinkSpec not implemented yet (expected for TDD)"
"resolveSink not implemented yet (expected for TDD)"
```

This is the expected TDD behavior - implementation phase is next.

## What Each Test Verifies

| Test | What It Verifies |
|------|------------------|
| Parsing tests | Correct extraction of functionName, argIndex, propertyPath |
| Call site tests | Finding CALL nodes by name or method attribute |
| Argument tests | Following PASSES_ARGUMENT edges with argIndex |
| Value tracing | Following ASSIGNED_FROM through variables to literals |
| Property tests | Following HAS_PROPERTY edges from OBJECT_LITERAL |
| Edge cases | Graceful handling of missing data, out-of-range indices |
| Output tests | Correct structure for JSON and human-readable output |

## Dependencies

- `TestBackend` from `test/helpers/TestRFDB.js` (existing)
- Will use `ValueDomainAnalyzer.getValueSet()` from `@grafema/core` (existing)
- Implementation will be inline in `packages/cli/src/commands/trace.ts`
