# Joel Spolsky's Technical Plan: REG-76 Multi-Repo Workspace Implementation

## Executive Summary

This document expands Don Melton's high-level analysis into a detailed technical specification for implementing multi-repository workspace support in Grafema. The implementation follows a 5-phase approach with specific code changes, complexity analysis, and risk mitigation strategies.

**Total Estimated Effort:** 8-12 days (depending on scope decisions)

---

## Answers to Don's Critical Questions

### 1. Backward Compatibility: Should we support mixed mode?

**Answer: YES, with "default" repo fallback.**

**Rationale:**
- Single-repo users should NOT need to update their config
- When `workspace.repos` is absent, all nodes use `repoId = "default"`
- This makes the feature fully backward-compatible with zero migration effort
- Existing graphs remain valid (semantic IDs unchanged when single repo)

**Implementation:**
```typescript
// If no workspace config, everything gets repoId = 'default'
const repoId = context.repoId ?? 'default';
```

### 2. Git Integration: Support git: URLs?

**Answer: NO for v0.2, YES for future.**

**Rationale:**
- Git cloning adds significant complexity (auth, caching, network)
- Local paths cover 80% of use cases (monorepos, local clones)
- Defer to v0.3+ with explicit issue for planning

**v0.2 scope:** Local filesystem paths only
**v0.3+ issue:** REG-XXX "Git URL support for workspace repos"

### 3. Version Pinning: Support @version refs?

**Answer: NO for v0.2.**

**Rationale:**
- Version pinning requires git integration (see #2)
- Local paths point to current working tree (implicit "HEAD")
- Defer until git URL support is implemented

### 4. Per-Repo Overrides: Config override rules?

**Answer: YES, workspace overrides repo-level config.**

**Override precedence (highest to lowest):**
1. Workspace-level config for specific repo
2. Repo's own `.grafema/config.yaml`
3. DEFAULT_CONFIG

**Implementation:**
```yaml
workspace:
  repos:
    - name: backend
      path: ./repos/backend
      config:  # Per-repo overrides (optional)
        plugins:
          analysis: [JSASTAnalyzer]  # Override just analysis plugins
```

The `config` section is merged with the repo's own config using deep merge.

### 5. RFDB Performance: Query concerns?

**Answer: Acceptable for typical workspaces, monitor for large ones.**

**Complexity Analysis:**

| Query Type | Current | Multi-Repo (5 repos) | Scaling Factor |
|------------|---------|---------------------|----------------|
| `queryNodes({type: X})` | O(n) | O(5n) | Linear |
| Datalog path queries | O(n*m) | O(5n * 5m) | 25x worst case |
| `node_attr(Id, "repo", R)` | N/A | O(1) lookup | Constant |

**Mitigations:**
1. Add `repo` index to RFDB for O(1) repo-filtered queries
2. Datalog queries can filter by repo early: `node(X, _, RepoId), RepoId = "backend", ...`
3. Large workspace warning in CLI: `"Processing 500k+ nodes across 10 repos..."`

---

## Phase 1: Core Infrastructure (Node ID Namespacing)

**Goal:** All nodes carry repo context, backward compatible with single-repo.

**Estimated Effort:** 2-3 days

### 1.1 Extend ScopeContext Interface

**File:** `packages/core/src/core/SemanticId.ts`

```typescript
// BEFORE
export interface ScopeContext {
  file: string;
  scopePath: string[];
}

// AFTER
export interface ScopeContext {
  file: string;
  scopePath: string[];
  /** Repository ID for multi-repo workspaces. Defaults to 'default' for single-repo. */
  repoId?: string;
}
```

**Complexity:** O(1) - Adding optional field to interface.

### 1.2 Update computeSemanticId()

**File:** `packages/core/src/core/SemanticId.ts`

```typescript
export function computeSemanticId(
  type: string,
  name: string,
  context: ScopeContext,
  options?: SemanticIdOptions
): string {
  const { file, scopePath, repoId } = context;
  const scope = scopePath.length > 0 ? scopePath.join('->') : 'global';

  // Prefix with repo if not 'default' (backward compatible)
  const repoPrefix = repoId && repoId !== 'default' ? `${repoId}::` : '';

  let id = `${repoPrefix}${file}->${scope}->${type}->${name}`;

  if (options?.discriminator !== undefined) {
    id += `#${options.discriminator}`;
  } else if (options?.context) {
    id += `[${options.context}]`;
  }

  return id;
}
```

**Example IDs:**
- Single repo: `src/app.js->global->FUNCTION->main` (unchanged)
- Multi repo: `backend::src/app.js->global->FUNCTION->main`

**Complexity:** O(1) - String concatenation.

### 1.3 Update parseSemanticId()

**File:** `packages/core/src/core/SemanticId.ts`

```typescript
export interface ParsedSemanticId {
  repoId?: string;  // NEW
  file: string;
  scopePath: string[];
  type: string;
  name: string;
  discriminator?: number;
  context?: string;
}

export function parseSemanticId(id: string): ParsedSemanticId | null {
  // Check for repo prefix
  let repoId: string | undefined;
  let rest = id;

  const repoMatch = id.match(/^([^:]+)::/);
  if (repoMatch) {
    repoId = repoMatch[1];
    rest = id.substring(repoMatch[0].length);
  }

  // ... existing parsing logic on `rest` ...

  return { repoId, file, scopePath, type, name, discriminator, context };
}
```

**Complexity:** O(n) where n = ID string length.

### 1.4 Add repo Attribute to All Nodes

**Files to modify:**
- `packages/core/src/core/NodeFactory.ts`
- `packages/core/src/core/nodes/*.ts` (all node types)

**Strategy:** Add optional `repo?: string` to `BaseNodeRecord`:

**File:** `packages/types/src/nodes.ts`

```typescript
export interface BaseNodeRecord {
  id: string;
  type: NodeType;
  name: string;
  file: string;
  repo?: string;  // NEW: Repository ID for multi-repo
  exported?: boolean;
  line?: number;
  column?: number;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}
```

**Complexity:** O(n) where n = number of node creation calls. Mechanical refactoring.

### 1.5 Update ServiceNode ID Format

**File:** `packages/core/src/core/nodes/ServiceNode.ts`

```typescript
// BEFORE
id: `SERVICE:${name}`,

// AFTER
static create(name: string, projectPath: string, options: ServiceNodeOptions = {}): ServiceNodeRecord {
  const repoId = options.repoId ?? 'default';
  const id = repoId === 'default'
    ? `SERVICE:${name}`
    : `SERVICE:${repoId}:${name}`;

  return {
    id,
    type: this.TYPE,
    repo: repoId,  // NEW
    // ... rest unchanged
  };
}
```

**Complexity:** O(1) - String formatting.

### 1.6 Test Requirements

**New test file:** `test/unit/MultiRepoSemanticId.test.js`

Tests needed:
1. `computeSemanticId()` with repoId produces correct prefix
2. `computeSemanticId()` without repoId (backward compatible)
3. `parseSemanticId()` extracts repoId correctly
4. Service node IDs with/without repo prefix
5. Round-trip: compute -> parse -> compute = identical

**Estimated:** 50 lines of test code.

---

## Phase 2: Workspace Configuration

**Goal:** Support `workspace.repos[]` in config.

**Estimated Effort:** 1-2 days

### 2.1 Extend GrafemaConfig Interface

**File:** `packages/core/src/config/ConfigLoader.ts`

```typescript
/**
 * Repository definition for multi-repo workspaces.
 */
export interface RepoDefinition {
  /** Unique repository identifier (used in node IDs) */
  name: string;

  /** Path to repository root (relative to workspace root) */
  path: string;

  /**
   * NPM package names this repo provides.
   * Used for cross-repo import resolution.
   * Example: ["@company/shared-lib", "@company/utils"]
   */
  packages?: string[];

  /**
   * Per-repo config overrides (merged with repo's .grafema/config.yaml).
   */
  config?: Partial<GrafemaConfig>;
}

/**
 * Workspace-level configuration for multi-repo analysis.
 */
export interface WorkspaceConfig {
  repos: RepoDefinition[];
}

export interface GrafemaConfig {
  plugins: { /* unchanged */ };
  services: ServiceDefinition[];
  include?: string[];
  exclude?: string[];
  strict?: boolean;

  /** NEW: Multi-repo workspace configuration */
  workspace?: WorkspaceConfig;
}
```

### 2.2 Create WorkspaceLoader

**New file:** `packages/core/src/config/WorkspaceLoader.ts`

```typescript
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse as parseYAML } from 'yaml';
import { loadConfig, GrafemaConfig, RepoDefinition } from './ConfigLoader.js';

export interface LoadedRepo {
  name: string;
  path: string;
  packages: string[];
  config: GrafemaConfig;
}

export interface LoadedWorkspace {
  root: string;
  repos: LoadedRepo[];
  packageToRepo: Map<string, string>;  // @company/lib -> 'shared'
}

/**
 * Load workspace configuration and resolve all repo configs.
 *
 * @param workspacePath - Path to workspace root or workspace.yaml
 * @returns Loaded workspace with resolved repo configs
 */
export function loadWorkspace(workspacePath: string): LoadedWorkspace {
  const workspaceRoot = existsSync(join(workspacePath, '.grafema'))
    ? workspacePath
    : dirname(workspacePath);

  const rootConfig = loadConfig(workspaceRoot);

  if (!rootConfig.workspace?.repos?.length) {
    // Single-repo mode (backward compatible)
    return {
      root: workspaceRoot,
      repos: [{
        name: 'default',
        path: workspaceRoot,
        packages: [],
        config: rootConfig,
      }],
      packageToRepo: new Map(),
    };
  }

  const repos: LoadedRepo[] = [];
  const packageToRepo = new Map<string, string>();

  for (const repoDef of rootConfig.workspace.repos) {
    validateRepoDef(repoDef, workspaceRoot);

    const repoPath = resolve(workspaceRoot, repoDef.path);
    const repoConfig = loadRepoConfig(repoPath, repoDef.config);

    repos.push({
      name: repoDef.name,
      path: repoPath,
      packages: repoDef.packages ?? [],
      config: repoConfig,
    });

    // Build package -> repo lookup
    for (const pkg of repoDef.packages ?? []) {
      if (packageToRepo.has(pkg)) {
        throw new Error(`Duplicate package "${pkg}" in repos: ${packageToRepo.get(pkg)}, ${repoDef.name}`);
      }
      packageToRepo.set(pkg, repoDef.name);
    }
  }

  return { root: workspaceRoot, repos, packageToRepo };
}

function loadRepoConfig(repoPath: string, overrides?: Partial<GrafemaConfig>): GrafemaConfig {
  const baseConfig = loadConfig(repoPath);

  if (!overrides) return baseConfig;

  // Deep merge overrides
  return deepMerge(baseConfig, overrides);
}

function validateRepoDef(def: RepoDefinition, workspaceRoot: string): void {
  if (!def.name?.trim()) {
    throw new Error('Config error: workspace.repos[].name is required');
  }
  if (!def.path?.trim()) {
    throw new Error(`Config error: workspace.repos[${def.name}].path is required`);
  }

  const absolutePath = resolve(workspaceRoot, def.path);
  if (!existsSync(absolutePath)) {
    throw new Error(`Config error: workspace.repos[${def.name}].path "${def.path}" does not exist`);
  }
}
```

**Complexity:** O(r) where r = number of repos.

### 2.3 CLI Extension

**File:** `packages/cli/src/commands/analyze.ts`

Add `--workspace` flag:

```typescript
program
  .option('-w, --workspace <path>', 'Workspace root or config file')
```

When `--workspace` is provided, use `loadWorkspace()` instead of `loadConfig()`.

### 2.4 Test Requirements

**New test file:** `test/unit/WorkspaceLoader.test.js`

Tests needed:
1. Load workspace with multiple repos
2. Package-to-repo mapping
3. Per-repo config overrides
4. Validation: missing repo path
5. Validation: duplicate package names
6. Backward compatible: no workspace config

---

## Phase 3: Multi-Repo Discovery and Orchestration

**Goal:** Orchestrator iterates over repos, preserving boundaries.

**Estimated Effort:** 2-3 days

### 3.1 Extend Orchestrator to Accept WorkspaceConfig

**File:** `packages/core/src/Orchestrator.ts`

```typescript
export interface OrchestratorOptions {
  // ... existing options ...

  /** Loaded workspace (multi-repo mode) */
  workspace?: LoadedWorkspace;
}

export class Orchestrator {
  private workspace?: LoadedWorkspace;

  constructor(options: OrchestratorOptions = {}) {
    // ... existing init ...
    this.workspace = options.workspace;
  }

  async run(projectPath: string): Promise<DiscoveryManifest> {
    if (this.workspace && this.workspace.repos.length > 1) {
      return this.runMultiRepo();
    }
    return this.runSingleRepo(projectPath);  // Existing logic
  }

  private async runMultiRepo(): Promise<DiscoveryManifest> {
    const allServices: ServiceInfo[] = [];
    const allEntrypoints: EntrypointInfo[] = [];

    // Phase 0: DISCOVERY per repo
    for (const repo of this.workspace!.repos) {
      this.logger.info('Discovering repo', { name: repo.name });

      // Create context with repoId
      const repoContext = { repoId: repo.name };

      const repoManifest = await this.discover(repo.path, repoContext);

      // Tag services with repo
      for (const svc of repoManifest.services) {
        allServices.push({ ...svc, repoId: repo.name });
      }
      for (const ep of repoManifest.entrypoints) {
        allEntrypoints.push({ ...ep, repoId: repo.name });
      }
    }

    const unifiedManifest: DiscoveryManifest = {
      services: allServices,
      entrypoints: allEntrypoints,
      projectPath: this.workspace!.root,
    };

    // Phase 1: INDEXING per repo (parallel possible)
    await this.indexAllRepos(unifiedManifest);

    // Phase 2: ANALYSIS per repo
    await this.analyzeAllRepos(unifiedManifest);

    // Phase 3: ENRICHMENT (global - cross-repo linking)
    await this.runPhase('ENRICHMENT', {
      manifest: unifiedManifest,
      graph: this.graph,
      workspace: this.workspace,  // Pass workspace for cross-repo resolution
    });

    // Phase 4: VALIDATION (global)
    await this.runPhase('VALIDATION', {
      manifest: unifiedManifest,
      graph: this.graph,
    });

    return unifiedManifest;
  }
}
```

### 3.2 Pass repoId Through Plugin Context

**File:** `packages/types/src/plugins.ts`

```typescript
export interface PluginContext {
  // ... existing fields ...

  /** Repository ID for multi-repo workspaces */
  repoId?: string;

  /** Package-to-repo mapping for cross-repo import resolution */
  packageToRepo?: Map<string, string>;
}
```

### 3.3 Update JSModuleIndexer to Include repo Attribute

**File:** `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

```typescript
async execute(context: PluginContext): Promise<PluginResult> {
  const repoId = context.repoId ?? 'default';

  // ... existing code ...

  // When creating MODULE node:
  const moduleNode = {
    id: semanticId,  // Already includes repoId via computeSemanticId
    type: 'MODULE' as const,
    name: relativePath,
    file: currentFile,
    repo: repoId,  // NEW
    line: 0,
    contentHash: fileHash || '',
    isTest
  };
```

**Complexity:** O(1) per node - adding attribute.

### 3.4 Complexity Analysis for Multi-Repo Processing

| Operation | Single Repo | Multi-Repo (R repos) | Notes |
|-----------|-------------|---------------------|-------|
| DISCOVERY | O(d) | O(R * d) | d = discovery time per repo |
| INDEXING | O(n) | O(R * n) | Can parallelize across repos |
| ANALYSIS | O(n * p) | O(R * n * p) | p = plugins per file |
| ENRICHMENT | O(n + e) | O(R*n + R^2*e) | Cross-repo edges |
| VALIDATION | O(n) | O(R * n) | Linear scan |

**Key insight:** ENRICHMENT is the bottleneck for cross-repo due to potential R^2 cross-repo edges. Mitigation: Use package-to-repo mapping for O(1) lookups.

---

## Phase 4: Cross-Repo Import Resolution

**Goal:** Resolve `@company/shared-lib` imports to workspace repos.

**Estimated Effort:** 1-2 days

### 4.1 Extend JSModuleIndexer for Package Resolution

**File:** `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

```typescript
private packageToRepo?: Map<string, string>;

async execute(context: PluginContext): Promise<PluginResult> {
  this.packageToRepo = context.packageToRepo;

  // ... existing code ...

  // In processFile(), when handling npm packages:
  for (const dep of deps) {
    if (dep.startsWith('package::')) {
      const pkgName = dep.substring('package::'.length);

      // Check if this package is provided by a workspace repo
      const providerRepo = this.packageToRepo?.get(pkgName);

      if (providerRepo) {
        // Mark for cross-repo linking in ENRICHMENT phase
        pendingCrossRepoImports.push({
          fromModule: moduleId,
          packageName: pkgName,
          providerRepo,
        });
      } else {
        // True external package
        logger.debug('Skipping external npm package', { package: pkgName });
      }
      continue;
    }
```

### 4.2 Create CrossRepoLinker Enrichment Plugin

**New file:** `packages/core/src/plugins/enrichment/CrossRepoLinker.ts`

```typescript
/**
 * CrossRepoLinker - creates IMPORTS edges between modules in different repos
 *
 * Works AFTER ImportExportLinker to handle cross-repo package imports.
 *
 * Algorithm:
 * 1. Build index of all EXPORT nodes by package name
 * 2. For each IMPORT with source matching workspace package:
 *    - Find provider repo from packageToRepo mapping
 *    - Find matching EXPORT in that repo
 *    - Create IMPORTS_FROM edge
 *
 * Complexity: O(i + e) where i = imports, e = exports (one-time indexing)
 */

export class CrossRepoLinker extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'CrossRepoLinker',
      phase: 'ENRICHMENT',
      priority: 85,  // After ImportExportLinker (90)
      creates: {
        nodes: [],
        edges: ['IMPORTS_FROM', 'CROSS_REPO_DEPENDS']
      },
      dependencies: ['ImportExportLinker']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, workspace } = context as PluginContext & { workspace?: LoadedWorkspace };
    const logger = this.log(context);

    if (!workspace || workspace.repos.length <= 1) {
      logger.debug('Skipping CrossRepoLinker (single repo mode)');
      return createSuccessResult();
    }

    // Step 1: Build package export index
    // Map<packageName, Map<exportKey, exportNode>>
    const packageExports = await this.buildPackageExportIndex(graph, workspace);

    // Step 2: Find all imports referencing workspace packages
    let edgesCreated = 0;

    for await (const node of graph.queryNodes({ nodeType: 'IMPORT' })) {
      const imp = node as ImportNode;
      const source = imp.source;

      if (!source || source.startsWith('./') || source.startsWith('../')) {
        continue;  // Skip relative imports (handled by ImportExportLinker)
      }

      // Check if source matches a workspace package
      const providerRepo = workspace.packageToRepo.get(source);
      if (!providerRepo) continue;

      const exports = packageExports.get(source);
      if (!exports) {
        logger.warn('Package registered but no exports found', {
          package: source,
          repo: providerRepo
        });
        continue;
      }

      // Find matching export
      const exportKey = imp.importType === 'default' ? 'default' : `named:${imp.imported}`;
      const targetExport = exports.get(exportKey);

      if (targetExport) {
        await graph.addEdge({
          type: 'IMPORTS_FROM',
          src: imp.id,
          dst: targetExport.id,
          crossRepo: true,  // Mark as cross-repo edge
        });
        edgesCreated++;
      }
    }

    logger.info('Cross-repo linking complete', { edgesCreated });
    return createSuccessResult({ nodes: 0, edges: edgesCreated });
  }

  private async buildPackageExportIndex(
    graph: GraphBackend,
    workspace: LoadedWorkspace
  ): Promise<Map<string, Map<string, ExportNode>>> {
    // ... index building logic ...
  }
}
```

### 4.3 Complexity Analysis

| Step | Complexity | Notes |
|------|------------|-------|
| Build export index | O(e) | e = total exports across all repos |
| Process imports | O(i) | i = total imports |
| Package lookup | O(1) | Map lookup |
| Export lookup | O(1) | Map lookup |
| **Total** | **O(i + e)** | Linear in graph size |

This is acceptable - no quadratic blowup.

---

## Phase 5: Datalog Queries for Boundaries

**Goal:** Query cross-repo dependencies via Datalog.

**Estimated Effort:** 1 day

### 5.1 Add node_attr Support for repo

The RFDB already supports `node_attr(Id, AttrName, Value)` predicates. Since we're adding `repo` as a standard field to all nodes, it will be automatically queryable:

```datalog
# Find all cross-repo imports
?- edge(Src, Dst, "IMPORTS_FROM"),
   node_attr(Src, "repo", RepoA),
   node_attr(Dst, "repo", RepoB),
   RepoA \= RepoB.

# Find which repos depend on "shared" repo
?- edge(Src, Dst, "IMPORTS_FROM"),
   node_attr(Src, "repo", Consumer),
   node_attr(Dst, "repo", "shared"),
   Consumer \= "shared".

# Count cross-repo edges per repo pair
?- cross_repo_count(RepoA, RepoB, Count) :-
   findall((Src, Dst), (
     edge(Src, Dst, "IMPORTS_FROM"),
     node_attr(Src, "repo", RepoA),
     node_attr(Dst, "repo", RepoB),
     RepoA \= RepoB
   ), Edges),
   length(Edges, Count).
```

### 5.2 Built-in Query: cross_repo_imports

**File:** `packages/core/src/queries/builtins.ts` (new or extend existing)

```typescript
export const BUILTIN_QUERIES = {
  cross_repo_imports: `
    ?- edge(Src, Dst, "IMPORTS_FROM"),
       node_attr(Src, "repo", SrcRepo),
       node_attr(Dst, "repo", DstRepo),
       SrcRepo \\= DstRepo.
  `,

  repo_dependency_graph: `
    ?- repo_depends(SrcRepo, DstRepo) :-
       edge(_, _, "IMPORTS_FROM"),
       node_attr(Src, "repo", SrcRepo),
       node_attr(Dst, "repo", DstRepo),
       SrcRepo \\= DstRepo.
  `,
};
```

### 5.3 CLI Integration

```bash
# Query cross-repo dependencies
grafema query "cross_repo_imports()" --workspace ./

# List repos that depend on 'shared'
grafema query "repo_depends(Consumer, 'shared')" --workspace ./
```

---

## Risk Mitigation

### Risk 1: Node ID Migration

**Risk:** Existing graphs become invalid when repoId is added.

**Mitigation:**
- Default repoId = 'default' produces unchanged IDs for single-repo
- Migration tool: `grafema migrate --add-repo-ids` for existing multi-repo setups
- Graph version field to detect schema changes

### Risk 2: Performance Degradation

**Risk:** Large multi-repo workspaces could slow down queries.

**Mitigation:**
- Add RFDB index on `repo` attribute
- Early filtering in Datalog queries
- Progress reporting for long operations
- `--repo <name>` filter flag for scoped queries

### Risk 3: Circular Dependencies Between Repos

**Risk:** Repo A imports from B, B imports from A - infinite loop during indexing.

**Mitigation:**
- Each repo is indexed independently (no recursion across repos)
- Cross-repo edges created only in ENRICHMENT phase (after all indexing)
- Datalog can detect cycles: `?- path(A, A, _).`

---

## Test Strategy

### Unit Tests

| Test File | Coverage |
|-----------|----------|
| `MultiRepoSemanticId.test.js` | Phase 1: ID namespacing |
| `WorkspaceLoader.test.js` | Phase 2: Config loading |
| `MultiRepoOrchestrator.test.js` | Phase 3: Orchestration |
| `CrossRepoLinker.test.js` | Phase 4: Import resolution |
| `CrossRepoDatalog.test.js` | Phase 5: Datalog queries |

### Integration Tests

**New file:** `test/integration/multi-repo-workspace.test.ts`

Test fixtures:
```
test/fixtures/multi-repo/
├── workspace.yaml
├── backend/
│   ├── .grafema/config.yaml
│   └── src/index.js (imports @company/shared)
├── frontend/
│   └── src/index.js (imports @company/shared)
└── shared/
    ├── package.json (name: @company/shared)
    └── src/index.js (exports utilities)
```

Test cases:
1. Workspace loads all repos
2. Cross-repo import resolution works
3. Datalog queries find cross-repo edges
4. Per-repo filtering works
5. Mixed mode (one repo with config, one without)

---

## Implementation Order

| Day | Task | Dependencies |
|-----|------|--------------|
| 1 | Phase 1.1-1.3: SemanticId changes | None |
| 2 | Phase 1.4-1.6: Node attributes + tests | Day 1 |
| 3 | Phase 2: WorkspaceLoader | Day 2 |
| 4 | Phase 3.1-3.2: Orchestrator changes | Day 3 |
| 5 | Phase 3.3-3.4: Plugin context propagation | Day 4 |
| 6 | Phase 4.1-4.2: CrossRepoLinker | Day 5 |
| 7 | Phase 5: Datalog queries | Day 6 |
| 8 | Integration tests + polish | Day 7 |

**Total:** 8 days minimum, 12 days with buffer for complexity.

---

## Critical Files for Implementation

1. **`packages/core/src/core/SemanticId.ts`** - Core ID format change with repoId prefix. Foundation for all multi-repo functionality.

2. **`packages/core/src/config/ConfigLoader.ts`** - Extend GrafemaConfig interface with workspace.repos[]. Entry point for configuration.

3. **`packages/core/src/Orchestrator.ts`** - Multi-repo orchestration logic. Central coordinator that iterates repos and passes context.

4. **`packages/core/src/plugins/indexing/JSModuleIndexer.ts`** - Cross-repo import detection. Where `package::@company/lib` gets flagged for later resolution.

5. **`packages/types/src/plugins.ts`** - Add RepoDefinition type and extend PluginContext with repoId. Type definitions used throughout.
