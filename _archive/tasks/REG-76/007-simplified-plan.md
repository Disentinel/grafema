# Simplified Multi-Repo Plan: REG-76

**Date:** 2026-02-06
**Author:** Don Melton (revised after Vadim's feedback)
**Status:** SIMPLIFIED APPROACH

---

## Vadim's Key Insight

> "Cross-repo deps будут через HTTP, не импорты файлов. Root приписывать в путь файла — тогда точно коллизий не будет."

This eliminates the entire collision problem and most of the complexity.

---

## The Simple Solution

### Config

```yaml
workspace:
  roots:
    - ./backend
    - ./frontend
    - ./shared
```

### Semantic ID Format

File path includes root prefix:
```
backend/src/api.js->global->FUNCTION->getUser
frontend/src/app.js->global->FUNCTION->render
shared/src/utils.js->global->FUNCTION->formatDate
```

**Collision impossible** — different roots = different paths = different IDs.

---

## What We DON'T Need

| Removed | Why |
|---------|-----|
| `storageKey` | Semantic ID = storage ID (no collision) |
| `repo` attribute | Not needed for queries |
| `packages[]` mapping | Cross-repo via HTTP, not file imports |
| `CrossRepoLinker` | No cross-file-import linking needed |
| Extend `ImportExportLinker` | Same reason |
| Forward registration | Same reason |

---

## What We DO Need

### 1. Config Schema Extension

**File:** `packages/core/src/config/ConfigLoader.ts`

```typescript
export interface WorkspaceConfig {
  roots: string[];  // Paths to workspace roots
}

export interface GrafemaConfig {
  // ... existing fields ...
  workspace?: WorkspaceConfig;
}
```

### 2. Orchestrator: Iterate Over Roots

**File:** `packages/core/src/Orchestrator.ts`

```typescript
async run(projectPath: string): Promise<DiscoveryManifest> {
  const config = loadConfig(projectPath);

  if (config.workspace?.roots?.length) {
    return this.runMultiRoot(projectPath, config.workspace.roots);
  }
  return this.runSingleRoot(projectPath);  // Existing logic
}

private async runMultiRoot(workspacePath: string, roots: string[]): Promise<DiscoveryManifest> {
  const allServices: ServiceInfo[] = [];

  for (const root of roots) {
    const rootPath = resolve(workspacePath, root);
    const rootName = basename(root);  // e.g., "backend"

    // Pass rootPrefix to context for file path construction
    const context = { rootPrefix: rootName };

    const manifest = await this.discoverRoot(rootPath, context);
    allServices.push(...manifest.services);
  }

  // Continue with unified indexing, analysis, enrichment
  return this.processUnifiedManifest(allServices);
}
```

### 3. File Path Construction

**File:** `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

When constructing file paths for semantic IDs:

```typescript
// Current (single-root):
const relativePath = relative(projectPath, absolutePath);
// Result: "src/api.js"

// New (multi-root):
const relativePath = context.rootPrefix
  ? `${context.rootPrefix}/${relative(rootPath, absolutePath)}`
  : relative(projectPath, absolutePath);
// Result: "backend/src/api.js"
```

### 4. Validation

```typescript
function validateWorkspace(config: GrafemaConfig, workspacePath: string): void {
  if (!config.workspace?.roots?.length) return;

  const rootNames = new Set<string>();

  for (const root of config.workspace.roots) {
    const absolutePath = resolve(workspacePath, root);

    // Check path exists
    if (!existsSync(absolutePath)) {
      throw new Error(`Workspace root "${root}" does not exist`);
    }

    // Check for duplicate names
    const name = basename(root);
    if (rootNames.has(name)) {
      throw new Error(`Duplicate workspace root name: "${name}"`);
    }
    rootNames.add(name);
  }
}
```

---

## Implementation Plan

| Phase | Task | Estimate |
|-------|------|----------|
| 1 | Add `workspace.roots[]` to config schema | 0.5 day |
| 2 | Orchestrator multi-root iteration | 0.5 day |
| 3 | Pass rootPrefix through PluginContext | 0.5 day |
| 4 | Update JSModuleIndexer file path construction | 0.5 day |
| 5 | Tests + CLI auto-detection | 0.5 day |

**Total: 2-3 days**

---

## Test Strategy

### Unit Tests

1. Config loading with `workspace.roots`
2. Validation: missing path, duplicate names
3. File path construction with rootPrefix

### Integration Test

```
test/fixtures/multi-root/
├── .grafema/config.yaml  (workspace.roots: [backend, frontend])
├── backend/
│   └── src/index.js
└── frontend/
    └── src/app.js
```

Expected semantic IDs:
- `backend/src/index.js->global->MODULE->index.js`
- `frontend/src/app.js->global->MODULE->app.js`

---

## Backward Compatibility

- No `workspace.roots` → single-root mode (unchanged behavior)
- Existing single-root configs work without modification

---

## Critical Files

1. `packages/core/src/config/ConfigLoader.ts` — Add WorkspaceConfig
2. `packages/core/src/Orchestrator.ts` — Multi-root iteration
3. `packages/core/src/plugins/indexing/JSModuleIndexer.ts` — rootPrefix in paths
4. `packages/types/src/plugins.ts` — Add rootPrefix to PluginContext

---

## Summary

| Metric | Original Plan | Simplified Plan |
|--------|---------------|-----------------|
| Estimate | 5-7 days | 2-3 days |
| New concepts | storageKey, repo attr, packages mapping | rootPrefix only |
| Files to modify | 5+ | 4 |
| Risk | Medium | Low |

**This is the minimal change that achieves the goal.**
