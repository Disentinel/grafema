# Don Melton Plan v2 — REG-406: `grafema context <semanticId>`

## Feedback from Вадим

> getCallees только для функций работает, а нам контекст по любой ноде надо показывать. Все виды связей!

**Root cause of v1 mistake:** Thinking in terms of call graph (callers/callees) instead of graph neighborhood. The `context` command must show the **full graph neighborhood** for ANY node type — all incoming and outgoing edges, grouped by type.

## Revised Design: Generic Graph Neighborhood

For ANY node, the `context` command shows:

1. **Node info** — type, name, semantic ID, location
2. **Source code** — the code at this node's location
3. **Outgoing edges** — all edges FROM this node, grouped by type
4. **Incoming edges** — all edges TO this node, grouped by type
5. **Connected nodes** — for each edge, show the connected node's info + code context

### Why this is better

- Works for ALL node types: FUNCTION, VARIABLE, MODULE, http:route, CALL, etc.
- No special-casing per node type
- Shows the actual graph structure
- Edge type names are human-readable: CALLS, ASSIGNED_FROM, DEPENDS_ON, CONTAINS, etc.
- AI agents get the complete picture in one call

### Example outputs

**For a FUNCTION:**
```
[FUNCTION] invokeCleanup
  ID: hooks/src/index.js->global->FUNCTION->invokeCleanup
  Location: hooks/src/index.js:345

  Source (lines 343-358):
    343 |
    344 | // Clean up hook effects
  > 345 | function invokeCleanup(hook) {
    346 |   const cleanup = hook._cleanup;
    347 |   if (typeof cleanup === 'function') {
    348 |     hook._cleanup = undefined;
    349 |     cleanup();
    350 |   }
    351 | }

  Outgoing edges:
    HAS_SCOPE (1):
      -> hooks/src/index.js->invokeCleanup->SCOPE
    HAS_PARAMETER (1):
      -> [PARAMETER] hook  (hooks/src/index.js:345)

  Incoming edges:
    CALLS (4):
      <- [CALL] invokeCleanup  (hooks/src/index.js:37)
           35 |   if (hooks) {
         > 37 |     hooks._pendingEffects.forEach(invokeCleanup);
           38 |     hooks._pendingEffects.forEach(invokeEffect);
      <- [CALL] invokeCleanup  (hooks/src/index.js:56)
      <- [CALL] invokeCleanup  (hooks/src/index.js:78)
      <- [CALL] invokeCleanup  (hooks/src/index.js:291)
    CONTAINS (1):
      <- [MODULE] hooks/src/index.js
```

**For a VARIABLE:**
```
[VARIABLE] _cleanup
  ID: hooks/src/index.js->invokeCleanup->VARIABLE->_cleanup
  Location: hooks/src/index.js:346

  Source (lines 344-349):
    344 | // Clean up hook effects
    345 | function invokeCleanup(hook) {
  > 346 |   const cleanup = hook._cleanup;
    347 |   if (typeof cleanup === 'function') {
    348 |     hook._cleanup = undefined;

  Outgoing edges:
    ASSIGNED_FROM (1):
      -> [PROPERTY_ACCESS] hook._cleanup  (hooks/src/index.js:346)

  Incoming edges:
    DECLARES (1):
      <- [SCOPE] hooks/src/index.js->invokeCleanup->SCOPE
```

**For an http:route:**
```
[http:route] POST /api/users
  ID: http:route#POST#/api/users
  Location: src/routes/users.js:15

  Source (lines 13-20):
    13 | // Create new user
  > 15 | router.post('/api/users', authMiddleware, async (req, res) => {
    16 |   const { name, email } = req.body;
    ...

  Outgoing edges:
    HANDLED_BY (1):
      -> [FUNCTION] <anonymous>  (src/routes/users.js:15)
    ROUTES_TO (1):
      -> [FUNCTION] <anonymous>  (src/routes/users.js:15)

  Incoming edges:
    MAKES_REQUEST (2):
      <- [http:request] POST /api/users  (src/client/api.js:42)
           40 | async function createUser(data) {
         > 42 |   return fetch('/api/users', { method: 'POST', body: data });
           43 | }
      <- [http:request] POST /api/users  (src/admin/users.js:28)
```

### Edge filtering for readability

Some edge types are structural noise (CONTAINS, HAS_SCOPE, DECLARES). For text output, we'll separate edges into two groups:

**Primary edges** (shown by default, with code context):
- CALLS, ASSIGNED_FROM, DEPENDS_ON, IMPORTS_FROM, EXPORTS
- ROUTES_TO, HANDLED_BY, MAKES_REQUEST, HTTP_RECEIVES
- EXTENDS, IMPLEMENTS, INSTANCE_OF
- PASSES_ARGUMENT, RECEIVES_ARGUMENT, RETURNS
- THROWS, REJECTS, EMITS_EVENT, LISTENS_TO
- FLOWS_INTO, READS_FROM, WRITES_TO, MODIFIES
- CAPTURES, ITERATES_OVER
- HAS_CALLBACK, RESPONDS_WITH

**Structural edges** (shown in compact form, no code context):
- CONTAINS, HAS_SCOPE, DECLARES, DEFINES
- HAS_PROPERTY, HAS_ELEMENT, USES
- HAS_PARAMETER, HAS_CONDITION, HAS_CASE, HAS_DEFAULT
- HAS_CONSEQUENT, HAS_ALTERNATE, HAS_BODY
- HAS_CATCH, HAS_FINALLY
- GOVERNS, VIOLATES, AFFECTS

In `--json` mode, ALL edges are included.

### Options

- `--project <path>` — project path (default: `.`)
- `--json` — JSON output (includes all edges, all details)
- `--lines <n>` — context lines around each code reference (default: 3)
- `--all-edges` — show structural edges with code context too

## Implementation

### Core logic: `getNodeContext()`

Shared function (can be called from both CLI and MCP):

```typescript
interface NodeContext {
  node: NodeInfo;
  source: CodePreviewResult | null;
  outgoing: EdgeGroup[];  // grouped by edge type
  incoming: EdgeGroup[];  // grouped by edge type
}

interface EdgeGroup {
  edgeType: string;
  edges: EdgeWithNode[];
}

interface EdgeWithNode {
  edge: EdgeRecord;
  node: NodeInfo;
  source: CodePreviewResult | null;  // code context at connected node
}
```

**Algorithm:**
1. `backend.getNode(semanticId)` — O(1)
2. `getCodePreview(node.file, node.line)` — O(1) file read
3. `backend.getOutgoingEdges(id)` — O(k) where k = outgoing edges
4. `backend.getIncomingEdges(id)` — O(k) where k = incoming edges
5. For each edge, `backend.getNode(connectedId)` — O(1) per edge
6. For primary edges, `getCodePreview(connectedNode.file, connectedNode.line)` — O(1) per edge

Total: O(k) where k = total edges, each with O(1) node lookup + file read.

### Capping

- Max 10 edges per edge type (with "...and N more" indicator)
- Code context only for first 5 edges per type (to keep output under ~100 lines)
- `--json` has no caps

### Files to create/modify

1. **NEW:** `packages/cli/src/commands/context.ts` — CLI command
2. **MODIFY:** `packages/cli/src/cli.ts` — register command
3. **NEW:** `packages/mcp/src/handlers/context.ts` — MCP handler (or add to existing handlers.ts)
4. **MODIFY:** `packages/mcp/src/definitions.ts` — tool definition
5. **MODIFY:** `packages/mcp/src/server.ts` — wire handler
6. **MODIFY:** `packages/mcp/src/types.ts` — args type
7. **NEW:** `test/unit/context.test.js` — tests

### Complexity

- O(1) node lookup
- O(k) edge traversal where k = number of edges on this node (typically <30)
- O(k) node lookups for connected nodes
- O(min(k,5)) file reads for code context
- No full graph scans, no O(n) operations
