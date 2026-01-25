# REG-225: Rob Pike - Implementation Report

## Summary

Implemented `FunctionCallResolver` enrichment plugin following Joel's technical specification and Kent's tests.

## Files Created

**Main Plugin:**
- `/packages/core/src/plugins/enrichment/FunctionCallResolver.ts` (183 lines)

## Files Modified

**Export from core:**
- `/packages/core/src/index.ts` - Added export for FunctionCallResolver

**CLI Registration:**
- `/packages/cli/src/commands/analyze.ts` - Added import and BUILTIN_PLUGINS registration

## Implementation Details

### Plugin Metadata
```typescript
{
  name: 'FunctionCallResolver',
  phase: 'ENRICHMENT',
  priority: 80,  // After ImportExportLinker (90)
  creates: { nodes: [], edges: ['CALLS'] },
  dependencies: ['ImportExportLinker']
}
```

### Algorithm

1. **Build Import Index** (`Map<file:local, ImportNode>`)
   - Index all IMPORT nodes by `file:local` key
   - Skip external imports (non-relative paths)

2. **Build Function Index** (`Map<file, Map<name, FunctionNode>>`)
   - Index all FUNCTION nodes by file and name

3. **Collect Unresolved Call Sites**
   - Query all CALL nodes
   - Skip method calls (have `object` attribute)
   - Skip already resolved (have CALLS edge)

4. **Resolution Loop**
   - For each call site, find matching import via `file:calledName`
   - Follow IMPORTS_FROM edge to EXPORT
   - Skip re-exports (EXPORT with `source` field) - v1 limitation
   - Find target FUNCTION via `EXPORT.local`
   - Create CALLS edge from CALL to FUNCTION

### Skip Cases Handled

| Case | Detection |
|------|-----------|
| Method calls | `call.object` exists |
| Already resolved | Has CALLS edge |
| External imports | Non-relative source (`lodash`, `@tanstack/react-query`) |
| Missing IMPORTS_FROM | No edge from IMPORT |
| Re-exports | EXPORT has `source` field |

### Type Safety

Fixed initial TypeScript error by not re-declaring `name` as optional in interfaces that extend `BaseNodeRecord` (which has `name: string` as required).

## Test Results

All 13 test suites pass:

1. Named imports - resolves `import { foo } from './utils'; foo();`
2. Default imports - resolves `import fmt from './utils'; fmt();`
3. Aliased named imports - resolves `import { foo as bar } from './utils'; bar();`
4. Namespace imports (skip) - skips `import * as utils from './utils'; utils.foo();`
5. Already resolved (skip) - doesn't duplicate existing CALLS edges
6. External imports (skip) - skips `lodash`, `@tanstack/react-query`, etc.
7. Missing IMPORTS_FROM (graceful) - handles unlinked imports
8. Re-exports (skip for v1) - skips `export { foo } from './other';`
9. Arrow function exports - resolves arrow function calls
10. Multiple calls to same function - creates edge for each call
11. Multiple imports from same file - resolves all imports
12. Call to non-imported function - doesn't resolve local/global calls
13. Plugin metadata - validates correct configuration

## Build Status

- TypeScript compilation: PASS
- Tests: 13/13 PASS

## Patterns Followed

- Matched `ImportExportLinker.ts` for index building pattern
- Matched `MethodCallResolver.ts` for CALL node handling
- Used same logging pattern (`this.log(context)`)
- Same result structure (`createSuccessResult`)

## Out of Scope (as documented in spec)

- Re-export chains (`export { foo } from './other'`)
- Namespace imports (`import * as utils`)
- CommonJS (`require()`)
- Dynamic imports (`await import()`)
