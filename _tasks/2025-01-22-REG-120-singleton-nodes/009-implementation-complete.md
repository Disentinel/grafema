# REG-120 Implementation Complete

## Summary

Fixed the bug where `net:request` singleton nodes were not being created when analyzing HTTP requests (fetch calls).

## Changes Made

### 1. FetchAnalyzer.ts (packages/core/src/plugins/analysis/FetchAnalyzer.ts)

- Added import for `NetworkRequestNode`
- Added instance variable `networkNodeCreated = false` for accurate statistics
- Create `net:request` singleton in `execute()` method using `NetworkRequestNode.create()`
- Updated `analyzeModule` signature to accept `networkId` parameter
- Added CALLS edge from each `http:request` node to the `net:request` singleton
- Fixed node/edge count in `createSuccessResult()`

### 2. createTestOrchestrator.js (test/helpers/createTestOrchestrator.js)

- Added import for `FetchAnalyzer`
- Registered `FetchAnalyzer` in the default plugin list

### 3. NetworkRequestNodeMigration.test.js (test/unit/NetworkRequestNodeMigration.test.js)

**Test Infrastructure Fixes:**
- Fixed `beforeEach` to call `backend.connect()` after creating backend
- Changed `after` to `afterEach` for proper cleanup
- Added `collectNodes()` helper to properly collect async generator results
- Changed all `await graph.queryNodes()` to `await collectNodes(graph.queryNodes())`
- Changed `queryEdges` (non-existent method) to `getOutgoingEdges`
- Fixed `backend.client` to `backend` (use RFDBServerBackend, not raw RFDBClient)

**Type Convention Fixes:**
- Changed all `type: 'HTTP_REQUEST'` queries to `type: 'http:request'`
- Updated assertion messages and test names accordingly

## Test Results

All 17 tests in NetworkRequestNodeMigration.test.js pass:
- GraphBuilder creates net:request singleton (6 tests)
- http:request connects to net:request singleton (2 tests)
- Singleton deduplication (3 tests)
- Node structure verification (3 tests)
- Distinction from http:request nodes (3 tests)

## Verification

FetchAnalyzer now correctly:
1. Creates `net:request#__network__` singleton with type `net:request`
2. Creates CALLS edges from each `http:request` node to the singleton
3. Reports accurate node/edge counts in statistics

## Pre-existing Issues

The following test failures are unrelated to this fix:
- QueryDebugging.test.js - missing `levenshtein` export from core
- Several other tests with pre-existing issues

These should be tracked separately.
