# Steve Jobs Implementation Review: REG-386

## Verdict: APPROVE

This is a clean, well-executed implementation that follows existing patterns precisely and delivers real value for the project's core thesis: "AI should query the graph, not read code."

---

## Vision Alignment

This feature is deeply aligned with Grafema's mission. Before this change, an agent had to read source files to understand the analysis pipeline -- what plugins exist, what they create, how they depend on each other. Now, all of this is queryable via the graph:

```
grafema query "plugin HTTPConnectionEnricher"
```

The output tells an agent exactly what edges and nodes a plugin creates, what it depends on, and what phase it runs in. That is the right answer to "how does this plugin work?" without reading a single line of source code.

The self-describing pipeline is a philosophical win: Grafema's graph now includes Grafema itself. The tool is eating its own dog food at the schema level.

---

## Code Quality

### Pattern Consistency: Excellent

The implementation follows `GuaranteeNode` and `IssueNode` patterns precisely:

- **PluginNode.ts**: Static class with `create()`, `validate()`, `parseId()`, `buildId()`, `isPluginType()` -- exact same contract API surface as `GuaranteeNode` and `IssueNode`.
- **NodeFactory.createPlugin()**: Uses `brandNode()` wrapper, same as every other factory method.
- **NodeFactory.validate()**: Dynamic type check with `PluginNode.isPluginType()`, same pattern as `IssueNode.isIssueType()`.
- **NodeKind.ts**: `isGrafemaType()` follows `isGuaranteeType()` pattern exactly.
- **Orchestrator registration**: Clean private method, called in both `run()` and `runMultiRoot()`.

### ID Format: Clean

`grafema:plugin#HTTPConnectionEnricher` -- follows the `namespace:type#identifier` convention used by guarantees and issues. Plugin names are unique within a pipeline (they are class names), so no hash is needed. This is the right call.

### Type System: Complete

- `PluginNodeRecord` interface defined in both `packages/core/src/core/nodes/PluginNode.ts` AND `packages/types/src/nodes.ts`
- Added to `NodeRecord` union type in `packages/types/src/nodes.ts`
- `GRAFEMA_PLUGIN` constant in both `NAMESPACED_TYPE` locations
- Proper re-exports through the index chain

---

## Complexity Check: PASS

- `registerPluginNodes()`: O(p + d) where p = number of plugins (20-35), d = dependency edges (~50). This is negligible.
- No O(n) graph iteration. Plugin registration iterates only the plugin list, not graph nodes.
- `findNodes()` in query.ts correctly does NOT add `grafema:plugin` to the default search types. Plugin nodes are only searched when explicitly requested via the `plugin` type alias. This avoids polluting normal queries with infrastructure metadata.
- DEPENDS_ON edge creation uses a name-to-ID map (O(p) build, O(1) lookup per dependency). Clean.

---

## Plugin Architecture: PASS

This is forward registration, not backward pattern scanning:

1. Orchestrator knows the plugin list at startup.
2. It creates nodes with metadata from `plugin.metadata`.
3. No graph traversal, no pattern matching, no scanning.

The only data source is the plugin's own declared metadata. This is the correct approach -- plugins describe themselves, the Orchestrator records it.

---

## Tests: Thorough

### PluginNode.test.ts (18 tests)
- Creates with required fields, all options
- Validates metadata in `.metadata.creates` for Datalog
- Error cases: missing name, missing phase, invalid phase
- All five valid phases tested
- Custom vs builtin distinction
- Validation: valid node, wrong type, missing name
- parseId: valid, invalid (three cases)
- generateId format
- isPluginType: true and false cases
- NodeFactory.createPlugin: branded node, options passthrough

### OrchestratorPluginNodes.test.ts (6 tests)
- Creates plugin nodes for each loaded plugin
- DEPENDS_ON edges between dependent plugins
- No dependencies case (zero edges)
- Missing dependency target (skip gracefully)
- Custom plugin marked non-builtin with sourceFile
- Builtin plugin marked correctly
- Plugins without metadata name are skipped

All 24 tests pass. The tests cover the happy path, edge cases, and error conditions. They test the contract (PluginNode), the factory (NodeFactory), and the integration (Orchestrator).

---

## Issues Found

### Minor: `buildId` is a duplicate of `generateId`

`PluginNode` has both `generateId(name)` and `buildId(name)` that do exactly the same thing. This follows GuaranteeNode's pattern (which also has both), so it is consistent. But it is unnecessary duplication. Not a blocker -- consistency with existing patterns takes priority.

### Minor: `PluginNodeOptions` has `line` field that is never meaningfully used

The `line` property in `PluginNodeOptions` is passed through to `BaseNodeRecord.line`, but plugin nodes represent pipeline concepts, not source code locations. The `file` field makes sense (for custom plugins), but `line` is questionable. Again, not a blocker -- it is a harmless optional field that follows `BaseNodeRecord` conventions.

### Minor: Metadata duplication

The `create()` method stores `createsNodes`/`createsEdges`/`dependencies` both as top-level fields AND inside `metadata.creates`/`metadata.dependencies`. This is by design (Joel's plan: "store creates info in metadata for Datalog queries") and tested explicitly. The duplication serves two access patterns: direct property access for TypeScript code, and metadata for Datalog `attr()` queries. Acceptable trade-off.

### Noted: Built-in plugins have empty `file` field

As documented in Joel's tech plan (Risk #4), built-in plugins get `file: ''` because they don't carry source paths at runtime. The plugin name + metadata is the critical queryable data. A follow-up could compute `packages/core/src/plugins/{phase}/{ClassName}.ts` for builtins. This is correctly identified as a known limitation and does not defeat the feature's purpose.

### Noted: Stale plugin nodes on non-clear runs

If a plugin is removed from config but the graph is not cleared, stale `grafema:plugin` nodes remain. As Joel notes, `--clear` solves this. For non-clear runs, stale nodes are harmless metadata. A future cleanup could delete all `grafema:plugin` nodes before re-registering. This is a reasonable MVP limitation.

---

## Query UX: Good

`grafema query "plugin HTTPConnectionEnricher"` produces:

```
[grafema:plugin] HTTPConnectionEnricher
  Phase: ENRICHMENT (priority: 50)
  Creates: edges: INTERACTS_WITH, HTTP_RECEIVES
  Dependencies: ExpressRouteAnalyzer, FetchAnalyzer, ExpressResponseAnalyzer
  Source: packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts
```

This is exactly the information an agent needs. The display format is clean and follows the same `[type] name` convention used by `http:route`, `socketio:emit`, etc.

The `plugin` alias in `parsePattern()` means agents can use natural language: `grafema query "plugin Fetch"`. The fact that `grafema:plugin` is NOT in the default search types is the right call -- you don't want infrastructure nodes mixed into normal code queries.

---

## Summary

This is a textbook implementation. It follows existing patterns precisely, adds no unnecessary complexity, solves a real product need, and has thorough test coverage. The known limitations are correctly identified and are genuine MVP-appropriate trade-offs (empty file for builtins, stale nodes on non-clear runs).

The implementation complexity is O(p) where p is the number of plugins (~30) -- no graph scanning, no backward pattern matching, pure forward registration. This is how Grafema features should be built.

**APPROVE.** Ship it.
