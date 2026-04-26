# Don Exploration: Plugin Architecture for REG-482

## Executive Summary

Grafema uses a phase-based plugin architecture with 5 distinct phases. Analysis plugins run in the ANALYSIS phase and are executed sequentially in topologically sorted order based on dependencies. Each plugin has access to the graph, manifest data, and can query for MODULE nodes to iterate over. There's currently no built-in filtering mechanism — all ANALYSIS plugins run for all services/modules regardless of applicability.

## 1. Plugin Interface & Base Class

### Interface Definition
**Location:** `/Users/vadimr/grafema-worker-1/packages/types/src/plugins.ts` (lines 330-336)

```typescript
export interface IPlugin {
  config: Record<string, unknown>;
  metadata: PluginMetadata;
  initialize?(context: PluginContext): Promise<void>;
  execute(context: PluginContext): Promise<PluginResult>;
  cleanup?(): Promise<void>;
}
```

### Base Class
**Location:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/Plugin.ts` (lines 30-116)

```typescript
export abstract class Plugin implements IPlugin {
  config: Record<string, unknown>;

  constructor(config: Record<string, unknown> = {}) {
    this.config = config;
  }

  abstract get metadata(): PluginMetadata;
  abstract execute(context: PluginContext): Promise<PluginResult>;

  // Optional lifecycle hooks
  async initialize(_context: PluginContext): Promise<void> {}
  async cleanup(): Promise<void> {}

  // Helper: Get all MODULE nodes from graph
  async getModules(graph: PluginContext['graph']): Promise<NodeRecord[]>

  // Helper: Get logger with console fallback
  protected log(context: PluginContext): Logger
}
```

### Plugin Metadata
**Location:** `/Users/vadimr/grafema-worker-1/packages/types/src/plugins.ts` (lines 45-65)

```typescript
export interface PluginMetadata {
  name: string;                      // Plugin identifier
  phase: PluginPhase;                // DISCOVERY | INDEXING | ANALYSIS | ENRICHMENT | VALIDATION
  creates?: {                        // What this plugin produces
    nodes?: NodeType[];
    edges?: EdgeType[];
  };
  dependencies?: string[];           // Plugin names this depends on
  fields?: FieldDeclaration[];       // Metadata fields for RFDB indexing
  covers?: string[];                 // Package names (e.g., ['express', 'lodash'])
  consumes?: EdgeType[];             // Edge types this plugin reads (for dependency inference)
  produces?: EdgeType[];             // Edge types this plugin creates (for dependency inference)
}
```

## 2. Plugin Registration & Discovery

### Built-in Plugin Registry
**Location:** `/Users/vadimr/grafema-worker-1/packages/cli/src/plugins/builtinPlugins.ts` (lines 60-108)

Plugins are registered in a static map:

```typescript
export const BUILTIN_PLUGINS: Record<string, () => Plugin> = {
  // Analysis plugins (lines 69-78)
  JSASTAnalyzer: () => new JSASTAnalyzer() as Plugin,
  ExpressRouteAnalyzer: () => new ExpressRouteAnalyzer() as Plugin,
  ExpressResponseAnalyzer: () => new ExpressResponseAnalyzer() as Plugin,
  NestJSRouteAnalyzer: () => new NestJSRouteAnalyzer() as Plugin,
  SocketIOAnalyzer: () => new SocketIOAnalyzer() as Plugin,
  DatabaseAnalyzer: () => new DatabaseAnalyzer() as Plugin,
  FetchAnalyzer: () => new FetchAnalyzer() as Plugin,
  ServiceLayerAnalyzer: () => new ServiceLayerAnalyzer() as Plugin,
  ReactAnalyzer: () => new ReactAnalyzer() as Plugin,
  RustAnalyzer: () => new RustAnalyzer() as Plugin,
  // ... enrichment and validation plugins
};
```

### Plugin Loading
**Location:** `/Users/vadimr/grafema-worker-1/packages/cli/src/plugins/pluginLoader.ts` (lines 100-123)

1. Config file (`.grafema/config.yaml`) specifies which plugins to load per phase
2. `createPlugins()` reads config and instantiates plugins from registry
3. Custom plugins can be added to `.grafema/plugins/` directory
4. Plugins are created fresh for each Orchestrator instance

## 3. Analysis Pipeline Execution

### Orchestrator Coordination
**Location:** `/Users/vadimr/grafema-worker-1/packages/core/src/Orchestrator.ts`

The pipeline runs in this order:

1. **DISCOVERY** (lines 190-203): Find services/entrypoints via discovery plugins
2. **INDEXING** (lines 225-228): Per-service indexing in batches, creates MODULE/FUNCTION nodes
3. **ANALYSIS** (lines 237-245): **This is where ANALYSIS plugins run** — either parallel (ParallelAnalysisRunner) or sequential (runBatchPhase)
4. **ENRICHMENT** (lines 415-418): Cross-file linking, resolution
5. **VALIDATION** (lines 440-444): Checks and issue reporting

### Phase Execution Logic
**Location:** `/Users/vadimr/grafema-worker-1/packages/core/src/PhaseRunner.ts` (lines 270-349)

For ANALYSIS phase:

1. **Filter plugins** by phase (line 274-276):
   ```typescript
   const phasePlugins = plugins.filter(plugin =>
     plugin.metadata.phase === phaseName
   );
   ```

2. **Topological sort** by dependencies (lines 278-302):
   - Uses `plugin.metadata.dependencies` to order execution
   - Example: `ExpressAnalyzer` depends on `JSASTAnalyzer`

3. **Sequential execution** (lines 317-349):
   - Loop through sorted plugins
   - Each plugin runs `execute(context)` wrapped in CommitBatch
   - Progress callbacks between plugins
   - No filtering logic — **all ANALYSIS plugins run for all services**

### Batch Phase Runner (for per-service phases like ANALYSIS)
**Location:** `/Users/vadimr/grafema-worker-1/packages/core/src/Orchestrator.ts` (lines 349-406)

```typescript
private async runBatchPhase(
  phaseName: string,
  units: IndexingUnit[],
  manifest: DiscoveryManifest,
  options?: { rootPrefix?: string },
): Promise<void>
```

For ANALYSIS phase:
- Batches services (BATCH_SIZE = workerCount, typically 10)
- For each service:
  - Creates UnitManifest with service info
  - Calls `runPhase('ANALYSIS', { manifest: unitManifest, graph, ... })`
  - This triggers PhaseRunner which executes ALL analysis plugins

**Critical observation:** The loop is `for (unit of units) { runPhase('ANALYSIS', ...) }` which means all plugins run for every unit. There's no per-plugin applicability check.

## 4. All ANALYSIS Phase Plugins

**Location:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/`

| Plugin | File | What It Analyzes | Current Behavior |
|--------|------|------------------|------------------|
| **JSASTAnalyzer** | JSASTAnalyzer.ts | JavaScript/TypeScript AST parsing, creates FUNCTION/SCOPE/IMPORT nodes | Runs for all JS/TS files |
| **ExpressRouteAnalyzer** | ExpressRouteAnalyzer.ts | Express.js HTTP routes (`app.get()`, `router.post()`) | Runs for all modules, silently skips non-Express |
| **ExpressResponseAnalyzer** | ExpressResponseAnalyzer.ts | Express response patterns (`res.json()`, `res.send()`) | Runs for all modules |
| **NestJSRouteAnalyzer** | NestJSRouteAnalyzer.ts | NestJS decorators (`@Get()`, `@Post()`, `@Controller()`) | Runs for all modules |
| **SocketIOAnalyzer** | SocketIOAnalyzer.ts | Socket.io events (`io.on()`, `socket.emit()`) | Runs for all modules |
| **DatabaseAnalyzer** | DatabaseAnalyzer.ts | Database query patterns (`db.query()`, `connection.query()`) | Runs for all modules |
| **FetchAnalyzer** | FetchAnalyzer.ts | HTTP client calls (`fetch()`, `axios.get()`) | Runs for all modules |
| **ServiceLayerAnalyzer** | ServiceLayerAnalyzer.ts | Service layer patterns (classes ending in `Service`) | Runs for all modules |
| **ReactAnalyzer** | ReactAnalyzer.ts | React components, hooks, JSX | Runs for all modules |
| **RustAnalyzer** | RustAnalyzer.ts | Rust functions, structs, impl blocks, NAPI bindings | Runs for Rust files only (uses `.rs` extension check) |

**Pattern:** Most JS/TS analyzers run for ALL modules and rely on "silent skip" pattern — parse AST, look for patterns, if not found return empty result. Only RustAnalyzer has file extension filtering.

## 5. Context & Data Available to Plugins

### PluginContext Structure
**Location:** `/Users/vadimr/grafema-worker-1/packages/types/src/plugins.ts` (lines 94-145)

```typescript
export interface PluginContext {
  manifest?: unknown;              // UnitManifest for ANALYSIS phase
  graph: GraphBackend;             // Graph access for queries/writes
  config?: OrchestratorConfig;     // Project config including services, routing
  phase?: PluginPhase;             // Current phase
  projectPath?: string;            // Project root path
  onProgress?: (info: Record<string, unknown>) => void;
  forceAnalysis?: boolean;
  workerCount?: number;
  touchedFiles?: Set<string>;      // For idempotent re-analysis
  logger?: Logger;                 // Structured logging
  reportIssue?(issue: IssueSpec): Promise<string>; // VALIDATION phase only
  strictMode?: boolean;
  rootPrefix?: string;             // Multi-root workspace prefix
  resources?: ResourceRegistry;    // Inter-plugin shared data
}
```

### UnitManifest (ANALYSIS phase)
**Location:** `/Users/vadimr/grafema-worker-1/packages/core/src/OrchestratorTypes.ts` (lines 111-122)

```typescript
export interface UnitManifest {
  projectPath: string;             // Project root
  service: {
    id: string;                    // Service node ID
    name: string;                  // Service name (e.g., "backend")
    path: string;                  // Entry point path
    [key: string]: unknown;        // Additional metadata
  };
  modules: unknown[];              // Empty for ANALYSIS (populated in INDEXING)
  rootPrefix?: string;             // Multi-root workspace prefix
}
```

### ServiceInfo (from Discovery)
**Location:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/discovery/SimpleProjectDiscovery.ts` (lines 19-28)

Discovery plugins provide:

```typescript
interface ServiceInfo {
  id: string;
  name: string;
  path: string;
  type: string;                    // 'simple-project', 'monorepo', etc.
  metadata: {
    entrypoint: string;
    packageJson: PackageJson;      // Has dependencies!
  };
}
```

**Critical insight:** `packageJson.dependencies` is available in service metadata! This contains the list of npm packages used by the service.

### What Plugins Can Access

During ANALYSIS phase execution:

1. **Graph queries:**
   - `graph.queryNodes({ type: 'MODULE' })` — get all indexed modules
   - `graph.queryNodes({ type: 'FUNCTION' })` — get all functions
   - `graph.getNode(id)` — get specific node
   - Can read file content via `readFileSync(resolveNodeFile(module.file, projectPath))`

2. **Service metadata:**
   - Service name, path, entry point
   - **Package.json data** including `dependencies` list (via manifest → service → metadata)
   - Service type (monorepo, simple project, etc.)

3. **Config data:**
   - `context.config.services` — explicit service definitions
   - `context.config.routing` — routing rules (REG-256)
   - `context.config.projectPath` — project root

4. **Resource registry (REG-256):**
   - Shared data between plugins
   - Example: PackageCoverageValidator uses this to get covered packages

## 6. Example: How ServiceLayerAnalyzer Works

**Location:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ServiceLayerAnalyzer.ts`

```typescript
async execute(context: PluginContext): Promise<PluginResult> {
  const { graph } = context;
  const projectPath = (context.manifest as { projectPath?: string })?.projectPath ?? '';

  // Get all MODULE nodes from graph (helper from Plugin base class)
  const modules = await this.getModules(graph);

  // Iterate over every module
  for (const module of modules) {
    // Read and parse file
    const code = readFileSync(resolveNodeFile(module.file!, projectPath), 'utf-8');
    const ast = parse(code, { ... });

    // Detect patterns (classes ending in 'Service')
    traverse(ast, {
      ClassDeclaration: (path) => {
        if (className.endsWith('Service')) {
          // Create SERVICE_CLASS node
        }
      }
    });
  }
}
```

**Pattern:** Iterate ALL modules, parse AST, detect patterns, create nodes. No filtering.

## 7. Problem: No Applicability Filtering

### Current State

All ANALYSIS plugins run for all services, regardless of whether they're relevant:

- ExpressAnalyzer runs on Rust-only services (wastes time parsing JS files that don't exist)
- RustAnalyzer is the ONLY plugin with file extension filtering (`.rs` check)
- Most plugins use "silent skip" — parse files, look for patterns, return empty if not found
- Wasted CPU time on irrelevant analysis

### Example Scenario

Service `rust-worker`:
- No package.json dependencies
- Only `.rs` files
- Still runs: ExpressRouteAnalyzer, NestJSRouteAnalyzer, DatabaseAnalyzer, etc.
- All parse 0 files, return empty results
- PhaseRunner reports "✓ ExpressRouteAnalyzer complete" even though it did nothing

### Why This Happens

**Location:** `/Users/vadimr/grafema-worker-1/packages/core/src/PhaseRunner.ts` (lines 274-276)

```typescript
const phasePlugins = plugins.filter(plugin =>
  plugin.metadata.phase === phaseName
);
```

The ONLY filter is by phase. No checks for:
- Does this service use the packages this plugin analyzes?
- Does this service have files matching this plugin's language?
- Is this plugin even applicable to this type of service?

## 8. Potential Solution Directions

### Option A: Pre-Filter at PhaseRunner Level

Modify `PhaseRunner.runPhase()` to check `plugin.metadata.covers` against service dependencies before executing.

**Pros:**
- Central filtering logic
- All plugins benefit automatically
- No per-plugin changes needed

**Cons:**
- Requires accurate `covers` metadata on all plugins
- Currently only PackageCoverageValidator uses `covers`

### Option B: Per-Plugin Applicability Check

Add `isApplicable(context): boolean` method to Plugin interface:

```typescript
interface IPlugin {
  // ... existing
  isApplicable?(context: PluginContext): Promise<boolean>;
}
```

PhaseRunner calls this before `execute()`.

**Pros:**
- Fine-grained control per plugin
- Can check more than just dependencies (file types, config, etc.)

**Cons:**
- Requires changes to every plugin
- Backward compatibility concerns

### Option C: Dependency-Based Auto-Skip (REG-482 approach)

Use `plugin.metadata.covers` to auto-skip plugins whose packages aren't in service dependencies.

**Pros:**
- Backward compatible (plugins without `covers` always run)
- Minimal code changes
- Leverages existing metadata field

**Cons:**
- Not all plugins are package-based (e.g., RustAnalyzer analyzes `.rs` files, not npm packages)
- Need to handle "always run" plugins (JSASTAnalyzer)

## 9. Key Findings for REG-482

1. **Dependencies are accessible:** Service `packageJson.dependencies` is available via manifest metadata
2. **Covers field exists:** `plugin.metadata.covers` is defined but only used by PackageCoverageValidator
3. **No filtering currently:** All ANALYSIS plugins run for all services
4. **Silent skip pattern:** Most plugins parse files and return empty results if patterns not found
5. **PhaseRunner is the chokepoint:** Lines 274-349 in PhaseRunner.ts is where filtering should happen
6. **10 ANALYSIS plugins:** 9 JS/TS-based, 1 Rust-based (only one with language filtering)

## 10. Recommended Approach for REG-482

Based on this exploration, the cleanest solution is:

1. **Populate `covers` field** on all framework/package-specific plugins:
   - ExpressRouteAnalyzer: `covers: ['express']`
   - NestJSRouteAnalyzer: `covers: ['@nestjs/common']`
   - SocketIOAnalyzer: `covers: ['socket.io']`
   - DatabaseAnalyzer: `covers: ['pg', 'mysql', 'mysql2', 'sqlite3']`
   - etc.

2. **Add filtering logic in PhaseRunner** (before line 317):
   ```typescript
   // Skip if plugin covers specific packages and none are in service deps
   if (plugin.metadata.covers && plugin.metadata.covers.length > 0) {
     const serviceDeps = extractDependencies(context.manifest);
     if (!hasOverlap(plugin.metadata.covers, serviceDeps)) {
       logger.debug(`[SKIP] ${plugin.metadata.name} — no covered packages in service`);
       continue;
     }
   }
   ```

3. **Special cases:**
   - JSASTAnalyzer: No `covers` → always runs (correct, it's base JS/TS parsing)
   - RustAnalyzer: Needs different check (file extensions, not packages)

## Next Steps

1. Verify dependencies extraction path (where is packageJson in context?)
2. Decide: Should this be ANALYSIS-only or all phases?
3. Handle non-package analyzers (Rust, future languages)
4. Test coverage: ensure skipped plugins don't break downstream enrichers

---

**Files Referenced:**

- `/Users/vadimr/grafema-worker-1/packages/types/src/plugins.ts` (Plugin interface, metadata)
- `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/Plugin.ts` (Base class)
- `/Users/vadimr/grafema-worker-1/packages/core/src/Orchestrator.ts` (Pipeline coordination)
- `/Users/vadimr/grafema-worker-1/packages/core/src/PhaseRunner.ts` (Phase execution)
- `/Users/vadimr/grafema-worker-1/packages/cli/src/plugins/builtinPlugins.ts` (Plugin registry)
- `/Users/vadimr/grafema-worker-1/packages/core/src/OrchestratorTypes.ts` (Manifest types)
- `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/discovery/SimpleProjectDiscovery.ts` (Discovery example)
- All 10 ANALYSIS plugins in `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/`

**Key Line Numbers:**

- PhaseRunner filtering: `PhaseRunner.ts:274-349`
- Batch phase execution: `Orchestrator.ts:349-406`
- Plugin metadata: `plugins.ts:45-65`
- Built-in registry: `builtinPlugins.ts:60-108`
