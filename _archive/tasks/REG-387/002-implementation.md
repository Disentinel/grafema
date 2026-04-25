# REG-387: Implementation Report

## Root Cause

`FetchAnalyzer.test.ts` (and 14 other `.ts` test files) used `db.cleanup()` in their `after()` hooks. This method only closes the individual test database client connection, but leaves the **shared RFDB server connection** (`sharedServerInstance.client`) alive with a ref'd socket, preventing Node.js from exiting.

The established pattern in all `.js` test files is to use `cleanupAllTestDatabases()` which:
1. Gracefully closes all test database connections
2. Forcefully silences all sockets (removes listeners, destroys sockets)
3. Kills the shared server process if owned by this process
4. Clears the `sharedServerInstance` singleton

## Fix

For all 15 affected `.ts` test files:
1. Added `cleanupAllTestDatabases` to the import from `TestRFDB.js`
2. Replaced `after(async () => { if (db) await db.cleanup(); })` with `after(cleanupAllTestDatabases)`

The `beforeEach` hooks that call `db.cleanup()` before re-creating were left unchanged — that's correct cleanup-before-recreate behavior.

## Files Changed

- `test/unit/plugins/analysis/FetchAnalyzer.test.ts`
- `test/unit/plugins/analysis/ExpressResponseAnalyzer.test.ts`
- `test/unit/plugins/analysis/ExpressResponseAnalyzer.linking.test.ts`
- `test/unit/plugins/analysis/ast/property-access.test.ts`
- `test/unit/plugins/analysis/ast/meta-property.test.ts`
- `test/unit/plugins/analysis/ast/loop-nodes.test.ts`
- `test/unit/plugins/analysis/ast/method-call-uses-edges.test.ts`
- `test/unit/plugins/analysis/ast/object-property-edges.test.ts`
- `test/unit/plugins/analysis/ast/switch-statement.test.ts`
- `test/unit/plugins/analysis/ast/ternary-branch.test.ts`
- `test/unit/plugins/analysis/ast/try-catch-nodes.test.ts`
- `test/unit/plugins/analysis/ast/function-metadata.test.ts`
- `test/unit/plugins/analysis/ast/if-statement-nodes.test.ts`
- `test/unit/analysis/async-error-tracking.test.ts`
- `test/unit/GuaranteeAPI.test.ts`

## Verification

- `FetchAnalyzer.test.ts`: 14/14 pass, exits cleanly (was hanging)
- `property-access.test.ts`: 35/35 pass, exits cleanly
- `GuaranteeAPI.test.ts`: 30/30 pass, exits cleanly
- Existing `.js` tests: no regression
