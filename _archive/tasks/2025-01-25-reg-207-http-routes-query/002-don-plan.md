# REG-207: HTTP Routes Not Searchable via Query

**Author:** Don Melton (Tech Lead)
**Date:** 2025-01-25

## Current State Analysis

### Problem Statement
- `grafema overview` correctly shows "HTTP routes: 64"
- `grafema query "POST"` and `grafema query "GET /api"` return nothing
- Users cannot search for HTTP endpoints despite them being in the graph

### How HTTP Routes Are Stored

HTTP routes are stored as nodes with:
- **Type:** `http:route` (namespaced type)
- **Properties:** `method` (GET/POST/etc), `path` (/api/users), `handler`, `file`, `line`
- **Node ID format:** `http:route#GET:/api/users#/path/to/file.js#42`
- **Name field:** Currently set from the node ID (the semantic ID format)

Example node structure:
```typescript
{
  id: "http:route#POST:/api/users#src/routes/users.js#15",
  type: "http:route",
  method: "POST",
  path: "/api/users",
  file: "src/routes/users.js",
  line: 15,
  name: "http:route#POST:/api/users#src/routes/users.js#15"  // <-- Problem here
}
```

### How Query Command Works

The `query` command in `/packages/cli/src/commands/query.ts`:

1. **Parses pattern** via `parsePattern()`:
   - `"POST"` -> `{ type: null, name: "POST" }`
   - `"POST /api/users"` -> `{ type: null, name: "POST /api/users" }`

2. **Hardcoded type list** in `findNodes()`:
   ```typescript
   const searchTypes = type
     ? [type]
     : ['FUNCTION', 'CLASS', 'MODULE', 'VARIABLE', 'CONSTANT'];
   ```

3. **Searches only the `name` field**:
   ```typescript
   if (nodeName.toLowerCase().includes(name.toLowerCase())) {
     results.push(node);
   }
   ```

## Root Cause

**Two fundamental issues:**

### Issue 1: `http:route` Not In Search Types

The query command only searches these base types:
- FUNCTION, CLASS, MODULE, VARIABLE, CONSTANT

Namespaced types like `http:route`, `db:query`, `socketio:emit` are **completely invisible** to the query command.

### Issue 2: Search Only Looks at `name` Field

Even if we added `http:route` to the search types, searching for "POST" or "/api/users" would fail because:
- The `name` field contains the full semantic ID
- The `method` and `path` fields are stored in metadata, not searched

The current search is text-based on `name` field only. HTTP routes store their meaningful data (`method`, `path`) in separate properties that are never queried.

## Proposed Solution (High-Level)

### Option A: Extend Query Command (Minimum Viable)

1. **Add namespaced types to search list:**
   ```typescript
   const searchTypes = type
     ? [type]
     : ['FUNCTION', 'CLASS', 'MODULE', 'VARIABLE', 'CONSTANT',
        'http:route', 'db:query', 'socketio:emit', 'socketio:on'];
   ```

2. **Add type aliases for user convenience:**
   ```typescript
   const typeMap = {
     // existing...
     route: 'http:route',
     endpoint: 'http:route',
     http: 'http:route',
     post: 'http:route',  // with method filter
     get: 'http:route',   // with method filter
   };
   ```

3. **Extend search to node properties:**
   - For `http:route`: search `method` and `path` fields
   - For `db:query`: search `query` and `operation` fields

### Option B: Smart Search with Node-Type Aware Matching (Recommended)

The query command should understand that different node types have different searchable fields:

```typescript
interface SearchableFields {
  'http:route': ['method', 'path', 'handler'];
  'db:query': ['query', 'operation'];
  'FUNCTION': ['name'];
  // etc.
}
```

When searching for "POST /api/users":
1. If it matches HTTP pattern (METHOD PATH) -> search `http:route` nodes
2. Compare `method` and `path` fields, not just `name`

This aligns with project vision: **AI should query the graph, not read code.** If searching for "POST /api" requires reading code because Grafema can't find it - that's exactly the gap we need to close.

### Option C: DSL-Based Query Syntax

Support structured queries:
```bash
grafema query "method:POST"           # All POST endpoints
grafema query "path:/api/*"           # All /api routes
grafema query "method:POST path:/api" # Combined
```

This is more powerful but requires parsing a mini query language.

## Recommendation

**Phase 1 (This Issue):** Implement Option A with elements of Option B
- Add namespaced types to default search list
- Add type-specific field matching for `http:route`
- Support `grafema query "route /api"` and `grafema query "POST /api"`

**Phase 2 (Future):** Implement Option C
- Full DSL with field-based queries
- Create separate issue for this enhancement

## Risks/Considerations

1. **Performance:** Adding more types to search increases query time. Mitigation: Use indexed queries on `nodeType` first, then filter.

2. **User Expectations:** Users might expect "POST" to only match HTTP methods, not functions named "postMessage". Mitigation: When pattern matches HTTP method, prioritize `http:route` results.

3. **Backward Compatibility:** Current behavior returns empty for HTTP patterns. New behavior will return results. This is a fix, not a breaking change.

4. **Consistency:** Once we add HTTP route search, users will expect same for db:query, socketio, etc. Plan for extensibility.

## Acceptance Criteria

- [ ] `grafema query "POST"` returns all POST endpoints
- [ ] `grafema query "GET /api"` returns matching GET endpoints
- [ ] `grafema query "route /api"` works as alternative syntax
- [ ] `grafema query "/api/users"` finds routes matching that path pattern
- [ ] Results display method and path prominently (not just semantic ID)

## Dependencies

- ExpressAnalyzer creates `http:route` nodes correctly (verified)
- RFDBServerBackend supports `queryNodes({ type: 'http:route' })` (verified)
- No changes needed to storage layer

## Effort Estimate

- Query command changes: ~2 hours
- Display formatting for routes: ~30 minutes
- Tests: ~1 hour
- Total: ~3.5 hours

---

This is a product gap that directly impacts Grafema's core value proposition. Fixing this makes the graph actually queryable for HTTP routes, which is essential for any web application analysis.
