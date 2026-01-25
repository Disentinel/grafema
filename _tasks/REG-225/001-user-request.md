# REG-225: FunctionCallResolver: Resolve cross-file imported function calls

## Summary

Create enrichment plugin to resolve CALL_SITE -> FUNCTION edges for imported functions.

## Background

Currently, GraphBuilder only creates CALLS edges for same-file function calls. When a function is imported from another file, the call site has no CALLS edge even though the target function exists in the graph.

This is a **bug**, not a policy question. ~40-50% of "unresolved calls" are actually internal calls that should resolve.

See REG-206 design doc for full analysis.

## Implementation

FunctionCallResolver should:

1. Run after ImportExportLinker (priority 80)
2. Find CALL_SITE nodes without CALLS edges
3. For each, look for IMPORT with matching local name
4. Follow IMPORTS_FROM -> EXPORT -> DEFINES chain
5. Create CALLS edge to target FUNCTION

## Test Cases (from Linus review)

- [ ] Named imports: `import { foo } from './utils'; foo();`
- [ ] Default imports: `import foo from './utils'; foo();`
- [ ] Namespace imports: `import * as utils from './utils'; utils.foo();`
- [ ] Re-exports: `export { foo } from './other';`

## Acceptance Criteria

- [ ] Plugin runs in ENRICHMENT phase at priority 80
- [ ] All calls to imported internal functions get CALLS edges
- [ ] Performance: <100ms for 1000 imports on typical codebase

## Out of Scope

* CommonJS `require()` (document if needed later)
* Dynamic imports `await import()`
