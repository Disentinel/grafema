# REG-233: FetchAnalyzer incorrectly treats console.log() as network request

## Problem

FetchAnalyzer pattern-matches `console.log()` calls and incorrectly creates disconnected `net:request` nodes.

**Example:**

```javascript
function hello() {
  console.log('Hello');
}
module.exports = { hello };
```

When analyzed, this creates a `net:request` node that's disconnected from the main graph, causing GraphConnectivityValidator to fail:

```
[ERROR] GRAPH VALIDATION ERROR: DISCONNECTED NODES FOUND
[ERROR] Found 1 unreachable nodes (14.3% of total)
[ERROR] net:request: 1 nodes
```

## Root Cause

FetchAnalyzer uses overly broad pattern matching for network operations. `console.log()` is not a network request and should not create `net:request` nodes.

## Impact

* Integration test for `grafema doctor` fails on simple test fixtures
* False positives in connectivity validation
* Misleading graph structure

## Expected Behavior

FetchAnalyzer should only create `net:request` nodes for actual network operations:

* `fetch()`, `axios`, `http.request()`, etc.
* NOT `console.log()`, `console.error()`, etc.

## Acceptance Criteria

- [ ] FetchAnalyzer distinguishes between network calls and console methods
- [ ] Simple code with `console.log()` passes connectivity validation
- [ ] Doctor integration test passes without fixture workaround

## Context

Discovered during REG-214 implementation. Test fixture workaround added temporarily. This issue tracks proper fix.

See: `packages/cli/test/doctor.test.ts` line 759
