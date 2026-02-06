# Don Melton's Analysis: REG-76 Multi-Repo Workspace Implementation

## Prior Art Research

From my web search, I found several relevant approaches:

1. **[TypeScript Project References](https://nx.dev/blog/typescript-project-references)**: TypeScript's approach lets you break a large project into smaller units with explicit dependencies declared in `tsconfig.json`. Each project maintains its own type checking while preserving relationships. This is the model for monorepos with multiple packages.

2. **[Nx Workspaces](https://nx.dev/docs/concepts/typescript-project-linking)**: Nx uses a project graph that automatically syncs TypeScript project references based on dependencies it detects. Key insight: Nx maintains a single dependency graph across all packages.

3. **[Bazel External Dependencies](https://bazel.build/external/overview)**: Bazel's module system treats external repos as first-class citizens. Key patterns:
   - Repos are fetched on-demand
   - Dependencies form a DAG with version resolution
   - Labels namespace targets by repo (`@repo//pkg:target`)

**Key Takeaways:**
- All successful tools use **namespace prefixes** to disambiguate cross-repo references
- A **unified graph** is essential for cross-repo queries (this is Grafema's strength)
- The configuration should be **declarative** and support both explicit paths and version-pinned references

---

## Current Architecture Analysis

### 1. Workspace Configuration (ConfigLoader.ts)

Current config structure:
```typescript
interface GrafemaConfig {
  plugins: { indexing, analysis, enrichment, validation };
  services: ServiceDefinition[];  // { name, path, entryPoint }
  include?: string[];
  exclude?: string[];
}
```

**Key observation:** The current `services[]` already supports multiple services, but assumes all paths are **relative to a single project root**. For multi-repo, we need to support:
- Multiple independent repo roots
- Each repo having its own `.grafema/config.yaml` (optional)
- Cross-repo service references

### 2. Node ID Scheme (SemanticId.ts, NodeId.ts)

Current semantic ID format:
```
{file}->{scope_path}->{type}->{name}[#discriminator]
```

Example: `src/app.js->global->FUNCTION->processData`

**Critical Issue:** File paths are relative to project root, but in multi-repo there's no single root. Current scheme does NOT include repo namespace.

**Solution needed:** Prefix with repo identifier:
```
{repo}::{file}->{scope}->{type}->{name}
```

Example: `backend::src/app.js->global->FUNCTION->processData`

### 3. File Path Handling

From `JSModuleIndexer.ts`:
```typescript
const relativePath = relative(projectPath, absolutePath);
```

The `projectPath` is assumed singular. Module resolution (line 245) uses filesystem-relative paths. Cross-repo imports would need:
- Repo-aware path resolution
- Explicit cross-repo dependency declarations (npm packages, git submodules, or explicit config)

### 4. Service Node Structure (ServiceNode.ts)

```typescript
{
  id: `SERVICE:${name}`,
  type: 'SERVICE',
  file: projectPath,  // Repo root
  filePath: projectPath,
}
```

**Missing:** No repo namespace in SERVICE ID. Need `SERVICE:{repo}:{name}`.

### 5. RFDB Storage (rfdb-server)

From `database_manager.rs` and storage modules - RFDB operates on a single database file. For multi-repo:
- **Option A:** Single unified database (preferred - enables cross-repo queries)
- **Option B:** Federation of per-repo databases (complex, loses unified graph benefit)

**Recommendation:** Keep single RFDB, use namespace prefixes in node IDs.

### 6. Orchestrator Discovery (Orchestrator.ts)

Current flow:
```
projectPath -> DISCOVERY plugins -> services[] -> INDEXING per service
```

For multi-repo:
```
workspacePath -> load repos[] -> per-repo DISCOVERY -> unified services[] -> INDEXING
```

---

## Architectural Concerns

### A. Node ID Namespacing Strategy

**Question:** How to namespace nodes by repo?

**Recommendation:** Introduce `RepoId` prefix:
```
{repoId}::{relativePath}->{scope}->{type}->{name}
```

This requires changes to:
- `SemanticId.ts` - Add repo parameter
- `NodeId.ts` - Add repo to computeNodeId params
- `NodeFactory.ts` - All create methods need repoId
- All analyzers/enrichers that create nodes

**Complexity:** O(many files) but mechanical refactoring.

### B. Cross-Repo Import Resolution

**Question:** How to handle `import { foo } from '@company/shared-lib'`?

**Current behavior:** External packages are tagged as `package::@company/shared-lib` and skipped.

**Multi-repo enhancement:**
1. Config declares repo-to-package mapping:
   ```yaml
   repos:
     - name: backend
       path: /path/to/backend
     - name: shared
       path: /path/to/shared-lib
       packages: ["@company/shared-lib"]  # npm package names this repo provides
   ```

2. During INDEXING, when `package::@company/shared-lib` is encountered:
   - Check if any repo declares this package
   - If yes, resolve to that repo's export instead of treating as external

**Complexity:** Medium - requires package mapping registry.

### C. Ownership/Boundaries Preservation

**Question:** How to preserve repo boundaries in the unified graph?

**Solution:**
1. Every node gets `repo: repoId` attribute
2. CODEOWNERS parsing per repo (future feature - GUI spec mentions `ownership` lens)
3. Cross-repo edges are explicit (`IMPORTS` edge between modules in different repos)

**Datalog query example:**
```datalog
?- edge(Src, Dst, "IMPORTS"),
   node_attr(Src, "repo", RepoA),
   node_attr(Dst, "repo", RepoB),
   RepoA != RepoB.
```

This finds all cross-repo dependencies.

### D. Configuration Schema

**Proposed `config.yaml` extension:**
```yaml
# Workspace-level config (in root or dedicated workspace location)
workspace:
  repos:
    - name: backend
      path: ./repos/backend        # Relative to workspace root
      # or: git: https://github.com/company/backend.git
      # or: ref: git::https://...@v1.2.3

    - name: frontend
      path: ./repos/frontend

    - name: shared
      path: ./repos/shared-lib
      packages: ["@company/shared-lib"]  # Package registry mapping

# Per-repo configs remain in each repo's .grafema/config.yaml
# Workspace config merges them with repo-specific overrides
```

---

## High-Level Implementation Plan

### Phase 1: Core Infrastructure (Node ID Namespacing)
**Goal:** All nodes carry repo context, backward compatible with single-repo.

1. Add `repoId?: string` to `ScopeContext` in `SemanticId.ts`
2. Update `computeSemanticId()` to prefix with repoId when present
3. Add `repoId` parameter to `NodeFactory.create*()` methods
4. Update `ServiceNode.create()` to include repo in ID
5. Add `repo` attribute to all created nodes

**Risk:** Breaking change to node IDs - requires full re-index.
**Mitigation:** Default `repoId = 'default'` for backward compatibility.

### Phase 2: Workspace Configuration
**Goal:** Support `repos[]` in config.

1. Extend `GrafemaConfig` with `workspace.repos[]`
2. Create `WorkspaceLoader` that reads workspace config
3. Update `ConfigLoader` to handle both workspace-level and repo-level configs
4. CLI: `grafema analyze --workspace ./workspace.yaml`

### Phase 3: Multi-Repo Discovery
**Goal:** Orchestrator iterates over repos.

1. Create `MultiRepoOrchestrator` or extend existing `Orchestrator`
2. For each repo in `workspace.repos`:
   - Set `context.repoId`
   - Run DISCOVERY, INDEXING phases with repo scope
   - Merge results into unified graph
3. ENRICHMENT and VALIDATION run on unified graph (global)

### Phase 4: Cross-Repo Import Resolution
**Goal:** Resolve package imports to workspace repos.

1. Build package registry from `repos[].packages`
2. Update `JSModuleIndexer` to check registry before treating as external
3. Create cross-repo `IMPORTS` edges when resolution succeeds
4. `ImportExportLinker` unchanged (works on unified graph)

### Phase 5: Datalog Queries for Boundaries
**Goal:** Query cross-repo dependencies.

1. Add `node_attr(Id, "repo", Repo)` to Datalog schema
2. Create builtin queries:
   - `cross_repo_imports(Src, Dst)` - cross-repo dependencies
   - `repo_boundary_violations(Issue)` - based on CODEOWNERS (future)

---

## Alignment with Grafema Vision

**"AI should query the graph, not read code."**

Multi-repo support directly enables this vision:
1. AI can query "what repos depend on shared-lib?"
2. AI can find "all cross-repo function calls"
3. Ownership boundaries are queryable ("who owns this code path?")

Without multi-repo, AI would need to:
- Open multiple repos manually
- Track cross-repo relationships mentally
- Lose the unified graph benefit

**This feature is essential for Grafema's target environment: massive legacy codebases that span multiple repositories.**

---

## Critical Questions for Joel (Implementation Planner)

1. **Backward Compatibility:** Should we support mixed mode (some services in workspace, some standalone)?
2. **Git Integration:** Should repos support `git:` URLs for automatic cloning?
3. **Version Pinning:** Support for ref pinning (`@v1.2.3`) like Bazel modules?
4. **Per-Repo Overrides:** Can workspace config override repo-level config (e.g., add plugins)?
5. **RFDB Performance:** With significantly more nodes from multiple repos, any concerns about query performance?

---

## Critical Files for Implementation

- `packages/core/src/config/ConfigLoader.ts` - Extend with workspace.repos[] schema
- `packages/core/src/core/SemanticId.ts` - Add repoId parameter for namespace prefixing
- `packages/core/src/Orchestrator.ts` - Multi-repo iteration and unified graph assembly
- `packages/core/src/plugins/indexing/JSModuleIndexer.ts` - Cross-repo import resolution via package registry
- `packages/types/src/plugins.ts` - Add RepoDefinition type and extend ServiceDefinition

---

**Sources:**
- [Setting up a monorepo using npm workspaces and TypeScript Project References](https://medium.com/@cecylia.borek/setting-up-a-monorepo-using-npm-workspaces-and-typescript-project-references-307841e0ba4a)
- [Managing TypeScript Packages in Monorepos - Nx Blog](https://nx.dev/blog/managing-ts-packages-in-monorepos)
- [TypeScript Project Linking - Nx](https://nx.dev/docs/concepts/typescript-project-linking)
- [External dependencies overview - Bazel](https://bazel.build/external/overview)
- [Repositories, workspaces, packages, and targets - Bazel](https://bazel.build/concepts/build-ref)
