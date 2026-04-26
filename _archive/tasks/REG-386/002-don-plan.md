# Don Melton -- Tech Lead Analysis: REG-386

## Problem Statement

While working on REG-384, the user had to open `HTTPConnectionEnricher.ts` and `FetchAnalyzer.ts` directly because Grafema cannot answer questions like:
- "What does HTTPConnectionEnricher do?"
- "What edges does FetchAnalyzer create?"
- "Which plugins depend on ExpressRouteAnalyzer?"

This directly contradicts the project vision: **"AI should query the graph, not read code."** Grafema analyzes user codebases but knows nothing about *itself* -- its own plugin pipeline is invisible to the graph.

## Current State of the Plugin System

### Plugin Registration and Resolution

Plugins are resolved by **string name** at startup. Both `cli/commands/analyze.ts` and `mcp/config.ts` maintain a `BUILTIN_PLUGINS` map:

```typescript
// packages/cli/src/commands/analyze.ts:78
const BUILTIN_PLUGINS: Record<string, () => Plugin> = {
  HTTPConnectionEnricher: () => new HTTPConnectionEnricher() as Plugin,
  FetchAnalyzer: () => new FetchAnalyzer() as Plugin,
  // ... 30+ entries
};
```

The `createPlugins()` function iterates config phase arrays and instantiates by name. Custom plugins are loaded from `.grafema/plugins/` directory at runtime.

### Plugin Metadata (Already Declared)

Every plugin already declares rich metadata via the `PluginMetadata` interface:

```typescript
// packages/types/src/plugins.ts:40
export interface PluginMetadata {
  name: string;
  phase: PluginPhase;          // DISCOVERY | INDEXING | ANALYSIS | ENRICHMENT | VALIDATION
  priority?: number;
  creates?: {
    nodes?: NodeType[];
    edges?: EdgeType[];
  };
  dependencies?: string[];
}
```

Concrete example -- `HTTPConnectionEnricher.ts`:
- **name:** `'HTTPConnectionEnricher'`
- **phase:** `'ENRICHMENT'`
- **priority:** `50`
- **creates.edges:** `['INTERACTS_WITH', 'HTTP_RECEIVES']`
- **dependencies:** `['ExpressRouteAnalyzer', 'FetchAnalyzer', 'ExpressResponseAnalyzer']`

This metadata is **already computed** but only lives as runtime JS objects -- it never enters the graph.

### Existing Node Types

There are ~30 node types defined in `packages/types/src/nodes.ts`. None represent plugins:
- Core: `FUNCTION`, `CLASS`, `METHOD`, `VARIABLE`, `CALL`, etc.
- Structural: `MODULE`, `FILE`, `SERVICE`, `PROJECT`, `SCOPE`
- Domain: `http:route`, `http:request`, `db:query`, `socketio:*`, etc.
- Meta: `guarantee:*`, `issue:*`

No `PLUGIN` or `grafema:plugin` type exists.

### Orchestrator Pipeline

The Orchestrator (`packages/core/src/Orchestrator.ts`) runs plugins through phases:
1. It filters `this.plugins` by `metadata.phase`
2. Sorts by `metadata.priority`
3. Calls `plugin.execute(context)` sequentially

Each plugin receives a `PluginContext` with graph access but **does not add anything about itself** to the graph.

### Query Infrastructure

`grafema query` already supports:
- Name-based search with type aliases (`function`, `route`, `variable`, etc.)
- Scope filtering (`"response in fetchData"`)
- Raw Datalog queries (`--raw`)
- `--type` flag for explicit node type filtering

Adding a new queryable node type just requires creating nodes with that type -- no query infrastructure changes needed.

## Analysis

### What We Need

The acceptance criteria require:
1. `grafema query` can locate a plugin by name and return source file + line
2. Plugin metadata (phase, creates, dependencies) is queryable as node attributes
3. Example queries documented

### Key Architectural Decision: When to Create Plugin Nodes

There are three possible moments to create plugin nodes:

| Option | When | Pros | Cons |
|--------|------|------|------|
| **A. At analyze time** | Orchestrator creates nodes as it runs plugins | Metadata is live, reflects actual loaded plugins | Happens every analysis run; tied to analysis state |
| **B. At build time** | Static extraction during npm build | Always available, no runtime cost | Gets stale; doesn't reflect custom plugins |
| **C. At startup, once** | When Orchestrator instantiates plugins | Exact set of configured plugins; includes custom | Runs once per analysis; minimal cost |

**Recommendation: Option C** -- the Orchestrator already instantiates all plugins in its constructor and runs them through phases. We add a single pass that writes plugin metadata to the graph **before** the first phase runs. This:
- Captures the **exact set of active plugins** (builtin + custom)
- Includes custom plugins from `.grafema/plugins/`
- Costs O(p) where p = number of plugins (typically 20-35), not O(n) over graph nodes
- Runs once, not per-module

### Node Type Design

Use namespaced type `grafema:plugin` following existing conventions:

```
ID pattern: grafema:plugin#HTTPConnectionEnricher
Type: grafema:plugin
```

Attributes:
- `name`: plugin class name (e.g., `'HTTPConnectionEnricher'`)
- `phase`: `'ENRICHMENT'` (queryable)
- `priority`: `50`
- `file`: source file path of the plugin implementation
- `line`: line number of the class definition (1 for builtins where we know the file)
- `metadata.creates.nodes`: `['INTERACTS_WITH', 'HTTP_RECEIVES']` (stored in metadata)
- `metadata.creates.edges`: `[]`
- `metadata.dependencies`: `['ExpressRouteAnalyzer', 'FetchAnalyzer', 'ExpressResponseAnalyzer']`
- `metadata.builtin`: boolean (true for built-in plugins, false for custom)

### Source File Resolution

For **built-in plugins**, we already know the exact file path: the BUILTIN_PLUGINS map in `analyze.ts` and `config.ts` maps names to constructor calls. We can derive the file path from the import. Alternatively, since all built-in plugins live in a predictable directory structure (`packages/core/src/plugins/{phase}/{ClassName}.ts`), the Orchestrator can compute the path.

For **custom plugins**, the file path is known at load time in `loadCustomPlugins()` -- we already have `pluginPath`.

### Edge Design

Plugin dependency relationships should use edges:

- `grafema:plugin#HTTPConnectionEnricher` --`DEPENDS_ON`--> `grafema:plugin#ExpressRouteAnalyzer`
- `grafema:plugin#HTTPConnectionEnricher` --`DEPENDS_ON`--> `grafema:plugin#FetchAnalyzer`

The `DEPENDS_ON` edge type already exists and is semantically correct.

Additionally:
- `grafema:plugin#FetchAnalyzer` --`CREATES`--> (no target needed, stored as attribute)

We do NOT need a new edge type for "creates" because the creation info is node-type level, not graph-entity level. Storing `creates.nodes` and `creates.edges` as metadata attributes is sufficient and avoids creating phantom target nodes.

## High-Level Plan

### Step 1: Add `grafema:plugin` to NAMESPACED_TYPE

In `packages/types/src/nodes.ts`, add:

```typescript
GRAFEMA_PLUGIN: 'grafema:plugin',
```

This is one line. It follows the existing namespace convention.

### Step 2: Create PluginNode contract class

In `packages/core/src/core/nodes/PluginNode.ts`, create a branded node factory (following `IssueNode.ts`, `GuaranteeNode.ts` patterns) that:
- Takes: `name`, `phase`, `priority`, `sourceFile`, `sourceLine`, `creates`, `dependencies`, `builtin`
- Generates ID: `grafema:plugin#${name}`
- Returns a `BrandedNode`

### Step 3: Add `NodeFactory.createPlugin()` method

In `packages/core/src/core/NodeFactory.ts`, add a factory method that delegates to the PluginNode contract.

### Step 4: Register plugin nodes in Orchestrator

In `packages/core/src/Orchestrator.ts`, after plugin instantiation (in constructor or at the start of `run()`), iterate all plugins and create `grafema:plugin` nodes + `DEPENDS_ON` edges.

Implementation approach:
- For each plugin in `this.plugins`:
  - Read `plugin.metadata`
  - Determine source file (built-in: derive from phase + name; custom: pass through from loader)
  - Call `NodeFactory.createPlugin(...)` and `graph.addNode(...)`
  - For each dependency, create `DEPENDS_ON` edge

Source file resolution for built-in plugins: use a static map derived from the existing `BUILTIN_PLUGINS` import structure. The `BUILTIN_PLUGINS` map in both CLI and MCP already names every plugin class. We can add a parallel `BUILTIN_PLUGIN_SOURCES` map or compute paths from the known directory convention (`plugins/{phase}/{ClassName}.ts`).

### Step 5: Pass source file info through plugin creation chain

Modify `createPlugins()` in `cli/commands/analyze.ts` and `mcp/config.ts` to attach source file info to plugin instances. Options:
- Add optional `sourceFile` property to `Plugin` base class
- Or store it as `plugin.config.sourceFile` (config is already `Record<string, unknown>`)

For built-in plugins, the source file is deterministic:
```
packages/core/src/plugins/{phase}/{ClassName}.ts
```
Where phase directory matches the plugin's metadata phase (lowercase).

For custom plugins, `loadCustomPlugins()` already knows `pluginPath`.

### Step 6: Enable query support

No changes needed in query infrastructure. Once `grafema:plugin` nodes are in the graph:

```bash
# Find a plugin by name
grafema query --type grafema:plugin "HTTPConnectionEnricher"

# Find all enrichment plugins
grafema query --raw 'type(X, "grafema:plugin"), attr(X, "phase", "ENRICHMENT")'

# Find plugins that create http:request nodes
grafema query --raw 'type(X, "grafema:plugin"), attr(X, "creates_nodes", Y)'
```

Optional enhancement: add `"plugin"` as a type alias in `parsePattern()` so users can write:
```bash
grafema query "plugin HTTPConnectionEnricher"
```

### Step 7: Documentation snippet

Add a short section to `docs/plugin-development.md` or create a `docs/querying-plugins.md` with example queries.

## Scope and Complexity

| Component | Changes | Complexity |
|-----------|---------|------------|
| `types/src/nodes.ts` | Add `GRAFEMA_PLUGIN` to `NAMESPACED_TYPE` | Trivial |
| `core/src/core/nodes/PluginNode.ts` | New file (~50 lines) | Low |
| `core/src/core/nodes/index.ts` | Export new node | Trivial |
| `core/src/core/NodeFactory.ts` | Add `createPlugin()` method | Low |
| `core/src/Orchestrator.ts` | Add plugin registration pass (~30 lines) | Low |
| `cli/src/commands/analyze.ts` | Pass source file info | Low |
| `mcp/src/config.ts` | Pass source file info | Low |
| `cli/src/commands/query.ts` | Add "plugin" type alias (optional) | Trivial |
| `docs/` | Example queries snippet | Trivial |
| Tests | Unit tests for PluginNode, integration for query | Medium |

**Estimated total: ~200-250 lines of production code**, plus tests.

**No O(n) iterations over graph nodes.** This is O(p) where p = number of plugins (20-35). Perfect alignment with Steve's complexity checklist: small targeted set, forward registration, extends existing abstractions.

## What This Enables

After implementation, an agent can:

```bash
# "What does HTTPConnectionEnricher do?"
grafema query --type grafema:plugin "HTTPConnectionEnricher" --json
# Returns: phase, creates (edges: INTERACTS_WITH, HTTP_RECEIVES), dependencies, source file

# "What plugins create http:request nodes?"
grafema query --raw 'type(P, "grafema:plugin"), attr(P, "name", N)' | grep request
# Better with metadata query support

# "Show me the enrichment pipeline order"
grafema query --raw 'type(P, "grafema:plugin"), attr(P, "phase", "ENRICHMENT"), attr(P, "priority", Prio), attr(P, "name", N)'

# "What depends on ExpressRouteAnalyzer?"
# Via DEPENDS_ON edges from plugin nodes
```

This is the first step toward Grafema being fully self-describing. The graph knows about the code it analyzes AND about the tools doing the analyzing.

## Risks

1. **Source file paths for built-in plugins**: At runtime, we don't have the TypeScript source paths directly -- the code runs as compiled JS. We need to either:
   - Store paths relative to the package (e.g., `@grafema/core/plugins/enrichment/HTTPConnectionEnricher.ts`) -- useful for agents who can locate the source
   - Or derive from `import.meta.url` of the plugin module (gives the compiled JS path, from which TS path can be inferred)

   **Recommendation**: Store the logical path relative to the monorepo root (`packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts`). This is what agents need to open the file. For custom plugins, store the absolute path from `loadCustomPlugins()`.

2. **Plugin nodes persist across analysis runs**: If a plugin is removed from config, its node remains in the graph. This is acceptable for MVP -- `grafema analyze --clear` rebuilds everything. A future enhancement could clean stale plugin nodes.

3. **Metadata storage format**: The `creates.nodes` and `creates.edges` arrays need to be stored in the node's metadata field as JSON. RFDB stores metadata as a JSON string, so this works naturally.
