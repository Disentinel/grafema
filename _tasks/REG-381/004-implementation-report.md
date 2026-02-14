# Implementation Report: REG-381

## Changes Made

### 1. `packages/cli/src/commands/query.ts` — Core Fix

**`executeRawQuery` function (line 1014-1041):**
- Added `:-` detection to route rules to `checkGuarantee` and direct queries to `datalogQuery`
- Both methods return the same `{bindings: [{name, value}]}` format

**`--raw` option help text (line 76-98):**
- Added explanation that both direct queries and rules are supported
- Added rule examples (`violation(X) :- node(X, "FUNCTION").`)
- Clarified that rules must define `violation/1` predicate

### 2. `test/helpers/TestRFDB.js` — Test Backend Fix

**`TestDatabaseBackend.datalogQuery()` (line 536-542):**
- Added bindings format conversion (`{X: "value"}` → `[{name: "X", value: "value"}]`)
- This was already done for `checkGuarantee` but missing for `datalogQuery`
- Aligns test backend with `RFDBServerBackend.datalogQuery()` behavior

### 3. `test/unit/RawDatalogQueryRouting.test.js` — New Test

8 tests across 4 suites:
- **datalogQuery (direct queries)**: verifies `node(X, "FUNCTION")` and `node(X, "MODULE")` return results
- **checkGuarantee (rule queries)**: verifies rules with `violation(X) :- ...` return results, including compound rules
- **consistency**: verifies both paths return the same count for FUNCTION and MODULE
- **routing logic**: verifies `:-` detection correctly classifies direct vs rule queries

## Follow-up Issues Created

- **RFD-27**: `parse_query()` should error on unconsumed input (blocked by REG-381)
- **RFD-28**: Consider unified Datalog execution endpoint (blocked by REG-381)
