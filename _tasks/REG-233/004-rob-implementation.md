# Rob Pike Implementation Report - REG-233

## Changes Made

### 1. `packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Problem:** The `net:request` singleton was created unconditionally in `execute()`, causing disconnected nodes when no HTTP requests exist.

**Fix:** Lazy initialization - singleton only created when first HTTP request is detected.

Changes:
- Added `networkNodeId: string | null` property to track singleton state
- Removed unconditional singleton creation from `execute()`
- Added `ensureNetworkNode()` helper that creates singleton on-demand
- Modified `analyzeModule()` to call `ensureNetworkNode()` when creating CALLS edge

### 2. `packages/cli/test/doctor.test.ts`

**Removed workaround:** The integration test previously overrode config to exclude GraphConnectivityValidator. With the fix, default plugins work correctly.

### 3. New test file: `test/scenarios/08-no-http-requests.test.js`

Tests for code with no HTTP requests:
- `should not create net:request singleton when no HTTP requests exist` ✅
- `should not create http:request nodes for console.log calls` ✅
- `should still analyze modules and functions correctly` ✅
- `should have no EXTERNAL nodes` ✅

### 4. New fixture: `test/fixtures/08-no-http-requests/`

Simple fixture with `console.log()` but no HTTP requests.

## Test Results

**New tests (08-no-http-requests.test.js):** 4/4 passed

**Doctor integration test:** ✅ Passed with default plugins

**Pre-existing issue:** 07-http-requests.test.js has one failing test (`should have valid graph structure`) due to missing `Headers` class node - unrelated to this fix.

## Verification

The fix correctly:
1. Creates `net:request` singleton only when HTTP requests are found
2. Maintains existing behavior when HTTP requests exist
3. Allows GraphConnectivityValidator to pass on simple fixtures
