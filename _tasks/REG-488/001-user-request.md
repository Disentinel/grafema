# REG-488: Fix analysis progress line to show file count instead of service count

## Problem

During ANALYSIS phase, the progress line shows:

```
[3/5] Analysis... 746/746 services | discover-api | 45m31s | 203K nodes, 331.7K edges
```

This is misleading — it shows service count, not file count. Should show how many files have been analyzed out of total, accounting for parallel processing.

## Expected

```
[3/5] Analysis... 145/330 files | packages/core/src/Plugin.ts | 1m23s | 12.3K nodes, 18.5K edges
```

## Where to fix

* `packages/cli/src/utils/progressRenderer.ts` — renders progress line
* `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` — emits progress events via `context.onProgress()`
* `packages/core/src/PhaseRunner.ts` — passes progress info from plugins to CLI

## Acceptance Criteria

- [ ] Progress shows `N/M files` during analysis
- [ ] Current file being analyzed is shown
- [ ] Works correctly with parallel workers (multiple files in flight)
