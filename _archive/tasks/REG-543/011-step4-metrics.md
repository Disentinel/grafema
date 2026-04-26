# STEP 4: Metrics — REG-543

## Summary
`grafema impact` now finds callers of methods called via abstract/interface typed receivers.

## Acceptance Criteria — Status
- [x] `grafema impact addNode` finds `useGraph` even when receiver is typed as `GraphBackend` (abstract)  
- [x] Graph traversal via DERIVES_FROM, IMPLEMENTS, CONTAINS edges (not flat name search)
- [x] findByAttr fallback for truly unresolved calls (with warning to stderr)
- [x] CLASS targets: aggregate callers from all methods + findByAttr per method
- [x] Zero regression on existing impact-class tests (15/15)
- [x] New tests: 11/11 in impact-polymorphic-callers.test.ts

## Changes

### Production code
- `packages/cli/src/commands/impact.ts`:
  - `findMethodInClass`: find FUNCTION child in CLASS via CONTAINS
  - `findInterfaceMethodProxy`: find method in INTERFACE.properties, return proxy ID
  - `collectAncestors`: recursive ancestor walk (unchanged)
  - `collectDescendants`: now recursive (was one level only)
  - `expandTargetSet`: full CHA expansion up+down the hierarchy
  - `resolveTargetSet`: CLASS/non-CLASS branching, returns {targetIds, targetMethodNames}
  - `collectCallersBFS`: extracted BFS from analyzeImpact, all errors logged to stderr
  - `analyzeImpact`: 5-line orchestrator
  - `getClassMethods`: returns {id, name} pairs (was string[] IDs only)
  - `findCallsToNode`: findByAttr fallback with stderr warning when fired
- `packages/core/src/utils/startRfdbServer.ts`: TTY detection for stderr to fix spawnSync hang
- `packages/core/src/storage/backends/RFDBServerBackend.ts`: log() → console.error

### Tests
- `packages/cli/test/impact-polymorphic-callers.test.ts`: new, 11 tests, 6 scenarios
- `packages/cli/test/impact-class.test.ts`: fixed prefix + fixture entry points + assertion

## 3-Review Round 1
- Steve: REJECT (collectDescendants not recursive, no fallback warning, silent catches)
- Vadim auto: APPROVE
- Uncle Bob: REJECT (SRP, silent catches, analyzeImpact aliasing, findMethodInNode proxy)

## 3-Review Round 2 (after fixes)
- Steve: APPROVE
- Vadim auto: APPROVE (already approved)
- Uncle Bob: APPROVE

## Tests
26/26 pass (impact-class: 15, impact-polymorphic-callers: 11)
