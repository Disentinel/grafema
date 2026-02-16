# REG-479: Scope ExpressResponseAnalyzer queries by file/name

## Problem
`findIdentifierInScope()` makes 5 unscoped `queryNodes` calls per response call per route:
- `queryNodes({ type: 'VARIABLE' })` — returns ALL variables in graph
- `queryNodes({ type: 'CONSTANT' })` — returns ALL constants
- `queryNodes({ type: 'PARAMETER' })` — returns ALL parameters
- `queryNodes({ type: 'VARIABLE' })` — again, for module-level
- `queryNodes({ type: 'CONSTANT' })` — again, for module-level

Each returns the ENTIRE type index and filters client-side.

## Impact (user's project, 745 services)
- 1,117,500 IPC calls
- Each scanning 80,000-160,000 nodes
- ~179 BILLION node scans total

## Fix
Add `file` and `name` filters to queryNodes calls. Context is available from `routeNode.file`.

Also consider collapsing the 5 sequential queries into a single parameterized loop (Knuth CC analysis recommendation).

## Expected
80,000x reduction per query. Combined with Fix A → catastrophic waste eliminated.
