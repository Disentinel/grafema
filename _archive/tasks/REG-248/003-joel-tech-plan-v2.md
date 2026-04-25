# Joel Spolsky Technical Plan v2: REG-248

## Problem Summary

HTTPConnectionEnricher can't match requests to mounted routes because:
1. MountPointResolver never updates `fullPath` (type mismatch - looks for wrong node types)
2. HTTPConnectionEnricher only uses `path` (which is local, not full)

## Required Changes

### Change 1: Fix MountPointResolver Type Checks

**File:** `packages/core/src/plugins/enrichment/MountPointResolver.ts`

**Current Code (line 62):**
```typescript
const mountPoints = allNodes.filter(node => node.type === 'MOUNT_POINT') as MountPointNode[];
```

**Change To:**
```typescript
const mountPoints = allNodes.filter(node =>
  node.type === 'express:mount' ||
  (node.type === 'express:middleware' && node.mountPath && node.mountPath !== '/')
) as MountPointNode[];
```

**Current Code (line 100):**
```typescript
if (endpoint && endpoint.type === 'ENDPOINT') {
```

**Change To:**
```typescript
if (endpoint && endpoint.type === 'http:route') {
```

**Current Code (line 186):**
```typescript
if (endpoint && endpoint.type === 'ENDPOINT') {
```

**Change To:**
```typescript
if (endpoint && endpoint.type === 'http:route') {
```

### Change 2: Fix MountPointResolver Edge Traversal

The current logic relies on MOUNTS and EXPOSES edges that ExpressRouteAnalyzer doesn't create.

**New approach:** Instead of traversing edges, directly match:
1. Find `express:middleware` nodes with `mountPath` (these are the mounts)
2. The `name` field is the imported router variable name
3. Use IMPORTS_FROM edges to find which module the router comes from
4. Find `http:route` nodes in that module
5. Update routes with `fullPath = mountPath + route.path`

This is a significant refactor of MountPointResolver.

### Change 3: HTTPConnectionEnricher Use fullPath

**File:** `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts`

**Current Code (line 104):**
```typescript
const routePath = route.path;
```

**Change To:**
```typescript
const routePath = route.fullPath || route.path;
```

## Simplified Alternative

Given the complexity of fixing MountPointResolver's edge traversal, consider a simpler approach:

### Alternative: Direct Route Resolution in HTTPConnectionEnricher

Instead of relying on MountPointResolver to pre-compute `fullPath`, HTTPConnectionEnricher could resolve mounts directly:

1. Query all `express:middleware` nodes with `mountPath`
2. Build a map: `routerVarName → mountPath`
3. When matching routes, if route's module has an import that's mounted, prepend the mountPath
4. Compare against request URL

**Pros:**
- Self-contained fix in one file
- No need to fix MountPointResolver

**Cons:**
- Duplicates mount resolution logic
- Doesn't populate `fullPath` for other uses

## Recommended Approach

Given the time constraints and complexity, I recommend a **phased approach:**

### Phase 1: Minimal Fix (This Task)
1. Change HTTPConnectionEnricher line 104: `route.fullPath || route.path`
2. Add inline mount resolution in HTTPConnectionEnricher:
   - Query `express:middleware` nodes with `mountPath`
   - Build mount prefix map
   - Try both `route.path` and `mountPath + route.path` when matching

### Phase 2: Proper Fix (Follow-up Task)
- Refactor MountPointResolver to work with actual node types
- Populate `fullPath` correctly for all routes
- Remove inline resolution from HTTPConnectionEnricher

## Phase 1 Implementation

### File: HTTPConnectionEnricher.ts

```typescript
async execute(context: PluginContext): Promise<PluginResult> {
  const { graph } = context;
  const logger = this.log(context);

  try {
    // Collect all http:route (backend endpoints)
    const routes: HTTPRouteNode[] = [];
    for await (const node of graph.queryNodes({ type: 'http:route' })) {
      routes.push(node as HTTPRouteNode);
    }

    // Collect all http:request (frontend requests)
    const requests: HTTPRequestNode[] = [];
    for await (const node of graph.queryNodes({ type: 'http:request' })) {
      requests.push(node as HTTPRequestNode);
    }

    // NEW: Collect mount points to build prefix map
    const mountPrefixes = new Map<string, string>(); // moduleFile → mountPath
    for await (const node of graph.queryNodes({ type: 'express:middleware' })) {
      const mw = node as { mountPath?: string; name?: string; file?: string };
      if (mw.mountPath && mw.mountPath !== '/' && mw.name) {
        // TODO: Resolve import to find target module
        // For now, store the mount info
      }
    }

    // ... rest of matching logic, using route.fullPath || route.path
  }
}
```

## Testing Plan

1. Create test fixture with:
   - Backend: `app.use('/api', router)` where router defines routes
   - Frontend: `fetch('/api/users')` calls

2. Verify:
   - INTERACTS_WITH edges are created between requests and routes

## Files to Change

1. `packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts` - use fullPath, add mount resolution
2. Optional: `packages/core/src/plugins/enrichment/MountPointResolver.ts` - fix type checks (if Phase 2 is included)

## Effort Estimate

- Phase 1 (minimal fix): ~2-3 hours
- Phase 2 (proper fix): ~4-6 hours

## Questions for Team

1. Should we do Phase 1 only (quick fix) or both phases (proper fix)?
2. Is there a reason ExpressRouteAnalyzer doesn't create MOUNTS edges like ExpressAnalyzer does?
3. Should we consider merging ExpressAnalyzer and ExpressRouteAnalyzer?
