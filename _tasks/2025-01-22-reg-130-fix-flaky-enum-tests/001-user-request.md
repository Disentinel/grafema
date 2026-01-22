# REG-130: Fix flaky ENUM integration tests in EnumNodeMigration.test.js

## Context

Discovered during REG-129 that 2 tests in `test/unit/EnumNodeMigration.test.js` are consistently failing:

1. `should analyze const enum correctly` - ENUM node "Direction" not found
2. `should create unique IDs for different enums` - Status not found

## Analysis

These failures are **not related to ID format changes**. They fail both with and without the REG-129 changes.

The tests query for ENUM nodes by name after running analysis, but nodes are not being found. Possible causes:

* Race condition in test setup
* Const enum handling issue
* Backend query issue

## Files

* `test/unit/EnumNodeMigration.test.js` - lines 268, 367

## Acceptance Criteria

- [ ] All tests in EnumNodeMigration.test.js pass consistently
