# Kent Beck Test Report: REG-541

## Tests Written

Three test files, 35 test cases total. All tests are TDD: they define the contract before implementation exists. They will fail on import until `EdgeFactory`, `GraphFactory`, and the new `NodeFactory` methods are implemented.

### File 1: `test/unit/EdgeFactory.test.js` (9 tests)

Tests `EdgeFactory.create(type, src, dst, options?)`:

| Test | What it verifies |
|------|-----------------|
| create edge with type, src, dst | Basic triple creation, correct field values |
| return EdgeRecord with correct shape | Fields are typed correctly; no index/metadata when absent |
| include index when provided | `options.index` propagates to returned EdgeRecord |
| include metadata when provided | `options.metadata` propagates to returned EdgeRecord |
| include both index and metadata | Both optional fields work together |
| throw on empty type | Validation: empty string type is rejected |
| throw on empty src | Validation: empty string src is rejected |
| throw on empty dst | Validation: empty string dst is rejected |
| preserve string values without mutation | No trimming or transformation of inputs |

### File 2: `test/unit/GraphFactory.test.js` (12 tests)

Tests `GraphFactory` instance class with a hand-rolled stub backend (no jest/sinon):

| Test | What it verifies |
|------|-----------------|
| **addNode()** | |
| call backend.addNode() with branded node | Delegation + correct branded node forwarded |
| not throw for valid branded node | Happy path, no error |
| **addEdge()** | |
| call backend.addEdge() with normalized InputEdge | Delegation + correct shape |
| forward metadata when provided | metadata field propagates through |
| forward index when provided | index field propagates through |
| **addEdges()** | |
| call backend.addEdges() with edge array | Batch delegation |
| forward skipValidation=true to backend | Critical for RejectionPropagationEnricher compatibility |
| **updateNode()** | |
| call backend.addNode() with branded version | Re-branding upsert for enrichment mutations |
| **read methods** | |
| getNode() delegates to backend | Transparent pass-through |
| queryNodes() delegates to backend | Transparent pass-through with async iteration |
| **debug mode** | |
| not throw when debug=true | Constructor accepts debug option |
| call addEdge correctly in debug mode | Debug mode does not break edge creation |

**Stub backend design:** Plain object with `calls` record arrays for each method. Methods are async functions that push arguments to the corresponding array. `storedNodes` Map enables getNode/queryNodes to return results. Follows the project's pattern of hand-rolled test doubles (no sinon/jest).

### File 3: `test/unit/NodeFactory.SystemDb.test.js` (14 tests)

Tests 4 new `NodeFactory` methods and their `validate()` coverage:

| Test | What it verifies |
|------|-----------------|
| **createSystemDbViewRegistration()** | |
| return node with type SYSTEM_DB_VIEW_REGISTRATION | Correct type field |
| include viewName, serverName, callType, file, line, column | All domain fields present |
| return branded node with correct id | ID matches the passed nodeId parameter |
| generate a descriptive name | Name field is present and non-empty |
| **createSystemDbSubscription()** | |
| return node with type SYSTEM_DB_SUBSCRIPTION | Correct type field |
| include servers array | servers array preserved |
| return branded node with correct file and line | Positional fields correct |
| **createGraphMeta()** | |
| return node with type GRAPH_META | Correct type field |
| include id and metadata fields | projectPath and analyzedAt preserved |
| return branded node with required BaseNodeRecord fields | id, type, name, file all present |
| **createGuarantee()** | |
| return node with type GUARANTEE | Correct type field |
| include rule, severity, governs | Datalog rule and governance config preserved |
| generate GUARANTEE: prefixed id | ID format matches GuaranteeManager convention |
| use default severity when not provided | Defaults to 'warning' |
| return branded node | Has id, type, name |
| **validate() — new types** | |
| NOT return errors for SYSTEM_DB_VIEW_REGISTRATION | validate() covers new type |
| NOT return errors for SYSTEM_DB_SUBSCRIPTION | validate() covers new type |
| NOT return errors for GRAPH_META | validate() covers new type |
| NOT return errors for GUARANTEE | validate() covers new type |

## Interface Assumptions

These assumptions are derived from the Don Melton Plan v2 (`004-don-plan-v2.md`) and verified against existing codebase patterns:

### EdgeFactory

- **Signature:** `EdgeFactory.create(type: EdgeType, src: string, dst: string, options?: { index?: number; metadata?: Record<string, unknown> }): EdgeRecord`
- **Exported from:** `@grafema/core`
- **Static class** (single method, no instantiation)
- Throws on empty `type`, `src`, or `dst`

### GraphFactory

- **Constructor:** `new GraphFactory(backend: GraphBackend, options?: { debug?: boolean; validate?: boolean })`
- **Exported from:** `@grafema/core`
- **Instance class** (holds backend reference)
- `addNode(node: BrandedNode)` delegates to `backend.addNode()`
- `addEdge(edge: InputEdge)` delegates to `backend.addEdge()` (interface-compatible overload per plan v2 section "Revised GraphFactory.addEdge signature")
- `addEdges(edges, skipValidation?)` forwards boolean to backend
- `updateNode(node: BaseNodeRecord)` re-brands via `brandNodeInternal` then calls `backend.addNode()` (upsert)
- `getNode()`, `queryNodes()` delegate transparently to backend

### New NodeFactory methods

- `NodeFactory.createSystemDbViewRegistration(nodeId: string, params: { viewName, serverName, callType, file, line, column })` — returns BrandedNode with type `'SYSTEM_DB_VIEW_REGISTRATION'`
- `NodeFactory.createSystemDbSubscription(nodeId: string, params: { servers: string[], file, line, column })` — returns BrandedNode with type `'SYSTEM_DB_SUBSCRIPTION'`
- `NodeFactory.createGraphMeta(params: { id, projectPath, analyzedAt, ... })` — returns BrandedNode with type `'GRAPH_META'`, name defaults to `'graph_metadata'`, file defaults to `''`
- `NodeFactory.createGuarantee(params: { id, rule, name?, severity?, governs? })` — returns BrandedNode with type `'GUARANTEE'`, id prefixed with `'GUARANTEE:'`, severity defaults to `'warning'`, governs defaults to `['**/*.js']`

### GUARANTEE node shape assumption

The `createGuarantee()` method returns a node matching the `GuaranteeNode` interface from `GuaranteeManager.ts` (Datalog-based guarantees), NOT the `GuaranteeNodeRecord` from `GuaranteeNode.ts` (contract-based guarantee:queue/api/permission nodes). These are two distinct concepts:

- **Datalog guarantees** (`type: 'GUARANTEE'`): created by `GuaranteeManager.create()`, have `rule`, `severity`, `governs` fields
- **Contract guarantees** (`type: 'guarantee:queue'` etc.): created by `GuaranteeNode.create()`, have `priority`, `status`, `schema` fields

The new `NodeFactory.createGuarantee()` is for the Datalog-based GUARANTEE type. `NodeFactory.validate()` already handles `guarantee:*` types via `GuaranteeNode.isGuaranteeType()` guard; the new `'GUARANTEE'` type needs a separate entry in the validator lookup table.
