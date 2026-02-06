# Don Melton's Revised Analysis: REG-76 Multi-Repo Workspace

**Date:** 2026-02-06
**Context:** Revision after Steve Jobs REJECT + Vadim's constraints

---

## New Constraints from Vadim

1. **Do NOT rely on package.json** — Grafema supports Go, Rust, C, Kotlin, not just JS
2. **Git URL support is nice-to-have** — User has CVS, not git. Local paths = PRIMARY
3. **CRITICAL: Semantic ID collision problem** — Must solve this properly

---

## The Collision Problem - Deep Analysis

**Steve's suggestion** (from `004-steve-review.md`):
> "Graph layer stays repo-agnostic... Semantic IDs unchanged... Store `repo_id` as node attribute"

**But Steve missed the REAL collision**:

```
Repo A: src/utils.js->global->FUNCTION->formatDate
Repo B: src/utils.js->global->FUNCTION->formatDate  (identical copy)
```

Both produce **the same semantic ID string**. When hashed in RFDB, they collide to **the same u128**. The second node **overwrites** the first.

This is NOT about query filtering. It's about **storage key collision**.

### Options to Solve the Collision

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Prefixed semantic ID `backend::file->...` | Simple | Breaks ID stability when repos change |
| B | Compound key `(repo_id, semantic_id)` in RFDB | Clean separation | RFDB schema changes, complex queries |
| **C** | Storage key prefix, semantic ID unchanged | Best of both | Track two IDs separately |
| D | Separate databases per repo | No collision | Can't do cross-repo queries |

---

## Recommended Architecture: Option C - Storage Key Prefix

### Core Principle

**Semantic IDs are stable. Storage keys include repo context.**

The semantic ID is the "meaning" of a node. This should NOT change when a repo is added to workspace.

The storage key is how RFDB uniquely identifies a node. This MUST include repo context.

### Implementation

```typescript
interface NodeRecord {
  id: string;           // Semantic ID: "src/utils.js->global->FUNCTION->formatDate"
  storageKey: string;   // RFDB key: "backend|src/utils.js->global->FUNCTION->formatDate"
  repo?: string;        // Attribute: "backend"
  // ... other fields
}
```

### Why This Works

| Scenario | Behavior |
|----------|----------|
| Same file in repo A and B | Different storage keys: `A\|file...`, `B\|file...` |
| Single-repo mode | storageKey = id (no prefix needed) |
| User adds repo C | Existing nodes in A, B unchanged |
| Cross-repo query | `node_attr(Id, "repo", X)` works |

---

## Addressing Steve's Valid Concerns

### 1. O(R²) Complexity - FIXED

**DO NOT create CrossRepoLinker.** Extend `ImportExportLinker`:

```typescript
// ImportExportLinker.execute() - modified
for (const imp of imports) {
  if (isRelativeImport(imp.source)) {
    await linkRelativeImport(imp);  // Existing logic
  } else if (isWorkspacePackage(imp.source)) {
    // NEW: Cross-repo import - O(1) lookup
    const providerRepo = packageToRepo.get(imp.source);
    const targetExport = findExportInRepo(providerRepo, imp.imported);
    if (targetExport) {
      await createCrossRepoEdge(imp, targetExport);
    }
  }
}
```

**Complexity**: O(i + e) — same as before, no R² blowup.

### 2. Forward Registration Pattern

**During INDEXING** (JSModuleIndexer):
```typescript
if (isWorkspacePackage(source)) {
  node.metadata.pendingCrossRepoImport = {
    package: source,
    imported: 'foo',
  };
}
```

**During ENRICHMENT** (ImportExportLinker):
```typescript
// Process ONLY imports with pendingCrossRepoImport
for (const imp of imports) {
  if (imp.metadata?.pendingCrossRepoImport) {
    // O(1) lookup, no scan
    const target = packageExports.get(imp.metadata.pendingCrossRepoImport.package);
  }
}
```

---

## Configuration Schema - Minimal

```yaml
workspace:
  repos:
    - path: ./backend
    - path: ./frontend
    - path: ./shared
      packages: ["@company/shared-lib"]  # Optional: what packages this repo provides
```

**That's it.** No `name` field (derive from directory name). No `config` overrides. No `git:` URLs for MVP.

### Validation Rules

1. `path` must exist and be a directory
2. `packages` is optional array of strings
3. Repo names derived from basename of path
4. Duplicate repo names = error
5. Duplicate package names = error

---

## Robert Tarjan Consultation (Graph Theory)

**Question**: Is compound key `(repo_id, semantic_id)` the right abstraction?

**Analysis**: Multi-repo workspace creates a **partitioned graph**. Standard approaches:
1. **Prefix vertices with partition ID** — what we're doing with storageKey
2. **Separate partition vertex** — requires extra edges

Option 1 is more efficient: O(1) lookup by full key, no extra edges.

**Conclusion**: Storage key prefix is graph-theoretically sound.

---

## How Other Tools Handle This

### Bazel Labels
Uses `@repo//pkg:target` syntax. Repo name is prefix, targets are repo-relative.

### Graph Database Multi-Tenancy
Standard approaches:
- **Namespace-based isolation**: Each tenant gets logical namespace
- **Compound keys**: `(tenant_id, entity_id)`

Our storage key prefix is equivalent to namespace-based isolation.

---

## Revised Implementation Plan

### Phase 1: Storage Key Separation (1-2 days)
- Add `repo` attribute to node records
- Introduce `storageKey` concept (repo-prefixed ID for RFDB)
- Update RFDBServerBackend to use storageKey
- Semantic ID (`id`) remains unchanged

### Phase 2: Workspace Configuration (1 day)
- Add `workspace.repos[]` to GrafemaConfig
- Minimal schema: path, optional packages[]
- WorkspaceLoader validates and resolves paths

### Phase 3: Multi-Repo Orchestration (1-2 days)
- Orchestrator iterates repos in workspace
- Pass repoId through PluginContext
- Build packageToRepo mapping from config

### Phase 4: ImportExportLinker Extension (1 day)
- Add cross-repo import handling
- Forward registration pattern
- O(1) lookups via package export index

### Phase 5: Datalog + CLI (1 day)
- Add `repo` to queryable attributes
- Built-in queries: `cross_repo_imports`, `repo_depends`
- CLI auto-detects workspace mode

**Total**: 5-7 days (down from 8-12)

---

## Critical Files for Implementation

1. **`packages/core/src/core/SemanticId.ts`** — Add storageKey generation function (not modify semantic ID)
2. **`packages/core/src/storage/backends/RFDBServerBackend.ts`** — Use storageKey for RFDB ID
3. **`packages/core/src/plugins/enrichment/ImportExportLinker.ts`** — Extend for cross-repo imports
4. **`packages/core/src/config/ConfigLoader.ts`** — Add workspace.repos[] schema
5. **`packages/rfdb-server/src/graph/id_gen.rs`** — Verify BLAKE3 hashing (no changes needed)

---

## Summary

| Issue from Steve | Resolution |
|------------------|------------|
| Node ID pollution | Use storageKey for RFDB, keep semantic ID clean |
| O(R²) complexity | Extend ImportExportLinker, forward registration |
| Manual package mappings | Keep minimal config, language-specific discovery in v0.3 |
| CrossRepoLinker plugin | Don't create it, extend ImportExportLinker |
| MVP limitations | Local paths only is acceptable per Vadim |
