# REG-357: Pass suppressedCount from MethodCallResolver to StrictModeFailure via Orchestrator

## Context

REG-332 implemented grafema-ignore escape hatch for strict mode. The suppression works correctly - errors with `grafema-ignore` comments are skipped. However, the suppression count is not displayed in CLI output.

## Problem

`MethodCallResolver` correctly counts `suppressedByIgnore` and returns it in `result.metadata.summary.suppressedByIgnore`. However, `Orchestrator` does not extract this value when creating `StrictModeFailure`.

## Expected Behavior

CLI shows "N error(s) suppressed by grafema-ignore comments"

## Solution

1. In Orchestrator, collect `suppressedByIgnore` from plugin results
2. Pass to `StrictModeFailure` constructor
3. CLI already handles this via `error.suppressedCount`
