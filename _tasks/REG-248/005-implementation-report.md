# REG-248 Implementation Report

## Problem

HTTPConnectionEnricher wasn't matching frontend HTTP requests to backend routes when Express routers were mounted with prefixes (e.g., `app.use('/api', router)`).

**Root cause:** Two issues:
1. MountPointResolver looked for `IMPORTS` edges but JSModuleIndexer creates `DEPENDS_ON` edges
2. MountPointResolver's module lookup wasn't working because the edge type was wrong

## Solution

### Files Modified

1. **`packages/core/src/plugins/enrichment/MountPointResolver.ts`**
   - Changed edge type lookup from `IMPORTS` to `DEPENDS_ON` (line 131-134)
   - Added debug logging for MODULE node indexing
   - Updated comments to document the correct edge type

2. **`packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts`**
   - Already had the fix: uses `route.fullPath || route.path` (line 106)
   - Added `fullPath` to HTTPRouteNode interface

### New Test File

- **`test/unit/plugins/enrichment/HTTPConnectionEnricher.test.js`**
  - 10 tests covering mount prefix support
  - Tests: basic matching, fallback, nested mounts, parametric routes, method matching, edge cases

## Verification

### Test Fixture Results

Before fix:
```
[INFO] Updated routes with mount prefixes {"routes":0,"mountPoints":0}
[INFO] Connections found {"count":0}
```

After fix:
```
[INFO] Updated routes with mount prefixes {"routes":2,"mountPoints":1}
[INFO] Connections found {"count":1,"examples":["GET /api/users/${...} → GET /api/users/:id"]}
```

### Unit Tests

All 10 tests pass:
- should match request to route using fullPath
- should NOT match when using only path (without fullPath)
- should use path when fullPath not set (unmounted route)
- should match through nested mounts (/api/v1/users)
- should match parametric route with fullPath
- should NOT match different methods
- should be case insensitive
- should skip dynamic URLs
- should skip requests without url
- should skip routes without path

## Technical Details

### Edge Type Discovery

JSModuleIndexer (used by default) creates:
- `MODULE` nodes for each file
- `DEPENDS_ON` edges between modules (src imports dst)

IncrementalModuleIndexer creates:
- `MODULE` nodes
- `IMPORTS` edges (different naming)

MountPointResolver now correctly uses `DEPENDS_ON` to match the default indexer.

### Data Flow

1. JSModuleIndexer creates MODULE nodes and DEPENDS_ON edges
2. ExpressRouteAnalyzer creates `express:middleware` nodes with `mountPath`
3. MountPointResolver:
   - Finds mount points (express:middleware with mountPath)
   - Builds MODULE file lookup
   - Uses DEPENDS_ON edges to find which modules import what
   - Updates http:route nodes with `fullPath = mountPath + route.path`
4. HTTPConnectionEnricher matches requests using `fullPath || path`
