# REG-435: Refactor analyze.ts — extract BUILTIN_PLUGINS and command action

## Problem

`packages/cli/src/commands/analyze.ts` is 517 lines — exceeds the 500-line CRITICAL threshold.

**Uncle Bob review (REG-432):**

* Command action (lines 288-516): 228 lines — unacceptable
* BUILTIN_PLUGINS registry (lines 1-133): growing with each new analyzer

## Proposed Solution

1. Extract `BUILTIN_PLUGINS` registry to `packages/cli/src/config/builtinPlugins.ts`
2. Extract command action to `packages/cli/src/commands/analyze/runAnalyze.ts`
3. Target: bring analyze.ts under 200 lines

## Acceptance Criteria

- [ ] analyze.ts < 200 lines
- [ ] BUILTIN_PLUGINS in separate file
- [ ] Command action extracted
- [ ] All existing tests pass
- [ ] No behavioral changes
