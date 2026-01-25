# Test Report: Class Impact Analysis (REG-208)

**Agent:** Kent Beck (Test Engineer)
**Date:** 2025-01-25
**Task:** Write tests for class impact aggregation

## Test File Created

**Location:** `/Users/vadimr/grafema-worker-3/packages/cli/test/impact-class.test.ts`

## Test Coverage

### 1. Class Impact Aggregation (Core Functionality)

**Test: "should aggregate callers from all methods of a class"**
- Creates UserModel class with 4 methods: findById, create, validate, delete
- Creates 6 external functions that call these methods
- Verifies that `grafema impact "class UserModel"` shows at least 6 direct callers
- Currently expects FAILURE: implementation shows "0 direct callers" for classes

**Test: "should include instantiation sites in impact analysis"**
- Verifies that functions creating `new UserModel()` are included
- All service/controller functions instantiate the class
- Should show these instantiation sites in caller list

**Test: "should aggregate multiple calls to same method"**
- findById is called by 3 different functions
- Verifies all 3 are counted as separate callers
- Tests that aggregation doesn't deduplicate legitimate separate call sites

**Test: "should NOT count internal method calls as external impact"**
- create() internally calls validate()
- Verifies this internal call doesn't inflate external caller count
- Only external callers should be counted

### 2. JSON Output with Breakdown

**Test: "should include method breakdown in JSON output"**
- Runs `grafema impact "class UserModel" --json`
- Verifies JSON has target, directCallers > 0
- Expects at least 6 direct callers
- Foundation for future method-level breakdown

**Test: "should show affected modules for class impact"**
- Verifies affectedModules field in JSON
- Should include services.js and controllers.js
- Validates module-level impact tracking

### 3. Edge Cases

**Test: "should handle class with no external callers"**
- Creates UnusedClass with no usage
- Should show "0 direct callers"
- Should show "LOW" risk

**Test: "should handle class where methods only call each other"**
- InternalClass with only internal method calls (methodA -> methodB -> methodC)
- Should show "0 direct callers" (internal calls don't count)
- Tests proper filtering of internal vs external calls

**Test: "should handle class not found"**
- Searches for NonExistentClass
- Should exit gracefully with "not found" message
- No crash or unclear error

### 4. Text Output Formatting

**Test: "should show clear summary of class impact"**
- Verifies presence of key sections:
  - "Direct impact:"
  - "Affected modules:"
  - "Risk level:"

**Test: "should list direct callers by function name"**
- Should show specific function names (getUser, createUser, etc.)
- Validates human-readable output

**Test: "should show risk level based on impact size"**
- With 6+ callers, should show MEDIUM or HIGH risk
- Tests risk assessment logic

### 5. Pattern Matching

**Test: "should accept 'class UserModel' pattern"**
- Tests explicit "class" prefix in pattern

**Test: "should accept just 'UserModel' without class prefix"**
- Tests automatic type detection
- Should analyze UserModel as a class even without explicit type

### 6. Comparison with Function Impact

**Test: "class impact should be >= single method impact"**
- Compares `grafema impact "class UserModel"` vs `grafema impact "function findById"`
- Class impact should be at least as large as any single method
- Validates that aggregation makes sense

## Test Fixture

### Directory Structure
```
tempDir/
├── package.json
└── src/
    ├── models.js        # UserModel class definition
    ├── services.js      # Functions using UserModel
    └── controllers.js   # More functions using UserModel
```

### models.js (UserModel)
- 4 methods: findById, create, validate, delete
- validate is internal helper (called by create)
- Standard CRUD operations

### services.js
- 4 functions: getUser, createUser, anotherGetUser, deleteUser
- Each creates new UserModel() and calls a method
- Covers multiple methods and repeated calls to same method

### controllers.js
- 2 functions: handleGetRequest, handleCreateRequest
- Also uses UserModel
- Tests cross-module impact

### Expected Call Graph
```
UserModel class
├── findById (3 external callers)
│   ├── getUser
│   ├── anotherGetUser
│   └── handleGetRequest
├── create (2 external callers)
│   ├── createUser
│   └── handleCreateRequest
├── delete (1 external caller)
│   └── deleteUser
└── validate (1 internal caller - NOT counted)
    └── create (internal)

Total external impact: 6 callers
```

## Test Patterns Followed

Following patterns from `explore.test.ts`:
- Same test structure and helpers
- Same CLI invocation pattern (runCli helper)
- Same fixture setup pattern (mkdtemp, init, analyze)
- Same JSON validation approach
- Same timeout (60000ms)

## Expected Test Status

**Current Status:** ALL TESTS WILL FAIL

These tests are written against the EXPECTED behavior. The current implementation in `impact.ts` shows "0 direct callers" for classes because it only looks for direct CALLS edges to the class node itself, not aggregated calls to methods.

## Implementation Requirements

For these tests to pass, `impact.ts` needs to:

1. **Detect CLASS target type**
   - When target is a CLASS node, use different traversal strategy

2. **Find all methods of the class**
   - Query for nodes with HAS_METHOD or DECLARES edges from class
   - Collect all method nodes

3. **Aggregate callers across all methods**
   - For each method, find callers (existing logic)
   - Deduplicate callers (same function calling multiple methods = one caller)
   - Sum up total impact

4. **Include instantiation sites**
   - Find NEW_EXPRESSION nodes referencing the class
   - Include containing functions as callers

5. **(Future) Breakdown by method**
   - JSON output could include methodBreakdown field
   - Show which methods contribute most to impact

## Test Commands

```bash
# Run only these tests
node --test packages/cli/test/impact-class.test.ts

# Run all CLI tests
npm test --workspace=packages/cli

# Run with verbose output
node --test --test-reporter=spec packages/cli/test/impact-class.test.ts
```

## Notes

1. **TDD Approach:** Tests written first, implementation follows
2. **Clear failure messages:** Tests will show exactly what's wrong
3. **Comprehensive coverage:** Edge cases, error handling, output formats
4. **Realistic fixtures:** Mimics real-world class usage patterns
5. **Incremental verification:** Each test checks one specific aspect

## Next Steps

Hand off to **Rob Pike** for implementation. Tests are ready to guide development.
