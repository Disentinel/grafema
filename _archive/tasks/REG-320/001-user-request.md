# REG-320: Extract resolveModulePath to shared utility

## Context

REG-318 introduced `resolveImportSource()` in MountPointResolver that duplicates logic from JSModuleIndexer's `resolveModulePath()`.

## Task

Extract module path resolution to a shared utility:

* Create `packages/core/src/utils/moduleResolution.ts`
* Move resolution logic there
* Update JSModuleIndexer and MountPointResolver to use shared utility
* Ensure consistent behavior across all plugins

## Why

Duplicated logic will diverge over time. Centralizing it:

* Single source of truth
* Easier to maintain and extend
* Consistent behavior across plugins

## Acceptance Criteria

- [ ] Shared utility created
- [ ] JSModuleIndexer uses shared utility
- [ ] MountPointResolver uses shared utility
- [ ] All existing tests pass
