# REG-551: Fix CLASS node storing basename instead of relative file path

**Source:** Linear REG-551
**Priority:** Urgent
**Labels:** Bug, v0.2
**Date:** 2026-02-21

## Goal

Fix CLASS nodes storing `file = "Orchestrator.ts"` (basename only) instead of `"packages/core/src/Orchestrator.ts"` (relative path from workspace root).

## Impact

Two cascading failures:

1. `getAllNodes({ file: relPath })` doesn't return CLASS nodes → invisible in "Nodes in File" panel
2. `gotoLocation` fails with "Failed to open Orchestrator.ts" — tries to open `{workspace}/Orchestrator.ts` which doesn't exist

All other node types (FUNCTION, IMPORT, EXPORT, CALL) correctly store relative paths.

## Root Cause (hypothesis)

CLASS node creation passes `module.file` but at that point `module.file` is the basename for class nodes. Likely a different code path from other node types.

## Acceptance Criteria

- [ ] CLASS node `file` field = relative path from workspace root (same as FUNCTION nodes)
- [ ] CLASS node visible in "Nodes in File" panel
- [ ] `gotoLocation` navigates correctly to class declaration
- [ ] Unit test: CLASS node file matches module file
