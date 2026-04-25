# REG-552: Class Property Declarations — Kent Beck Test Report

**Date:** 2026-02-22
**Author:** Kent Beck (Test Engineer)
**Status:** All tests passing

---

## Test File

`test/unit/plugins/analysis/ast/class-property-declarations.test.ts`

## Test Structure

8 `describe` groups, 10 individual test assertions. All passing.

### Test 1: Basic accessibility modifiers
**Input:** Class with `private graph: GraphBackend`, `protected config: OrchestratorOptions`, `public name: string`
**Verifies:** 3 VARIABLE nodes created, each with correct `accessibility` value (`'private'`, `'protected'`, `'public'`).

### Test 2: Default accessibility (no modifier)
**Input:** Class with `name: string` (no explicit modifier)
**Verifies:** `accessibility === 'public'` — implicit public when no modifier specified.

### Test 3: readonly modifier (two subtests)
**Input:** (a) `private readonly db: Database`, (b) `readonly maxRetries: number`
**Verifies:**
- (a) `accessibility === 'private'` AND `readonly === true` — both stored independently
- (b) `accessibility === 'public'` (default) AND `readonly === true`

This test directly addresses the Dijkstra-identified defect in the original plan (single `modifier` field could not represent `private readonly`). The revised implementation uses separate `accessibility` and `readonly` fields.

### Test 4: TypeScript type annotation
**Input:** `private graph: GraphBackend`
**Verifies:** The TypeScript type annotation string `'GraphBackend'` is stored in RFDB wire metadata.

**Known limitation:** The implementation stores the type annotation as `metadata.type`, but the `TestRFDB._parseNode()` helper strips `type` from metadata (it is a reserved key that conflicts with the node's `nodeType` field). The test works around this by accessing the raw RFDB wire format via `backend._client.getAllNodes()` and parsing the metadata JSON directly.

### Test 5: Line and column position
**Input:** Class with fields on lines 2 and 3
**Verifies:** Each VARIABLE node has the correct `line` number and a numeric `column`.

### Test 6: HAS_PROPERTY edge (two subtests)
**Input:** (a) Single field class, (b) Three-field class
**Verifies:**
- (a) `CLASS -> HAS_PROPERTY -> VARIABLE` edge exists between the class node and field node
- (b) At least 3 HAS_PROPERTY edges from the class node

### Test 7: declare field skipped
**Input:** Class with `declare name: string` and `private realField: number`
**Verifies:** Only 1 VARIABLE node created (for `realField`). The `declare` field is correctly skipped.

This test addresses the Dijkstra-identified defect: `declare` fields have no runtime presence and should not create graph nodes.

### Test 8: Function-valued field stays FUNCTION
**Input:** Class with `private handler = () => {}` and `private value: string`
**Verifies:**
- `handler` creates a FUNCTION node, not a VARIABLE
- `value` creates a VARIABLE node
- Only 1 class property VARIABLE node total (not 2)

---

## Pattern

Tests follow the established pattern from `property-access.test.ts` and `function-metadata.test.ts`:
- `createTestDatabase()` + `createTestOrchestrator()` in `beforeEach`
- `cleanupAllTestDatabases()` in `after`
- `setupTest(backend, files)` helper for project creation and analysis
- `backend.getAllNodes()` with type filters for node assertions
- `backend.getAllEdges()` for edge assertions
- `assert.strictEqual` and `assert.ok` from Node.js `assert`

## Observation: metadata.type key collision

The implementation stores the TypeScript type annotation as `metadata.type` in the RFDB wire format. However, `_parseNode()` in `TestRFDB.js` strips `type` from metadata to prevent overwriting the node's primary `type` field (which holds the node type like `'VARIABLE'`). This means:

- Through `backend.getAllNodes()`, the type annotation is NOT accessible (stripped)
- Through `backend._client.getAllNodes()` (raw wire), it IS accessible in the `metadata` JSON string

This is not a test bug — it is a real limitation. If downstream consumers (MCP, CLI, Grafema queries) use the same parse logic, they will also lose the type annotation. Consider renaming the metadata key from `type` to `tsType` to avoid the collision.

## Test Results

```
# tests 10
# suites 9
# pass 10
# fail 0
```

All tests green. Duration: ~8 seconds total (dominated by RFDB I/O per test).
