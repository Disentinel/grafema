# REG-185: Implement glob-based file filtering with include/exclude patterns

## Background

Discovered during REG-170 investigation: the `config.yaml` template included `include`/`exclude` glob patterns, but **nothing in the codebase implements or respects them**.

Grafema currently uses **entrypoint-based discovery** (follows imports from package.json main field), not glob-based file matching.

## Problem

Users expect to control which files are analyzed via patterns:

```yaml
include:
  - "src/**/*.{ts,js,tsx,jsx}"
exclude:
  - "**/*.test.ts"
  - "node_modules/**"
```

But this doesn't work because:

1. File discovery is DFS from entrypoint
2. No glob pattern matching exists in codebase
3. `JSModuleIndexer` uses hardcoded test patterns, not config

## Proposed Solution

Design options identified by Don Melton:

**Option A: Keep Entrypoint-based (current)**

* Pro: Finds only code that's actually used
* Pro: Follows real module graph
* Con: Can't analyze dead code or standalone scripts

**Option B: Glob-based Discovery**

* Pro: Can analyze any file matching patterns
* Pro: More control for users
* Con: Will index unused files
* Con: Major architectural change

**Option C: Hybrid**

* Use `include` patterns as initial file set
* Follow imports from there
* `exclude` patterns filter results

## Acceptance Criteria

1. Design discussion: choose discovery model
2. Implement chosen model
3. Add `include`/`exclude` support to config schema
4. Update `init` to generate patterns for detected project structure
5. Update documentation

## Context

* Blocked by: REG-170 (config format unification) - now Done
* Related analysis: `_tasks/2025-01-24-reg-170-config-yaml-json-incompatibility/002-don-plan.md`
