# Don Plan — REG-378

## Context
CLI `grafema analyze` hangs after analysis completes on large repos (ToolJet). Expectation: finish, show summary, return to shell.

## Constraints / Reality Check
- **Grafema-first workflow blocked:** Node.js is not available in this environment (`node`/`npx` missing), so I cannot run `grafema analyze` or query the graph here. This is a product gap for AI workflows in this environment.
- Will proceed by code inspection + targeted changes; recommend verifying with ToolJet fixture on a Node-enabled machine.

## Prior Art (WebSearch)
- Node timers/intervals keep the event loop alive unless cleared or `unref()`’d. Pending timers are a common cause of CLI “hangs.”
- Ink apps use explicit `exit()` from `useApp()` to end CLI apps, but `analyze` does not use Ink.
- Node docs confirm unref’ing timers prevents them from keeping the process alive.

## Hypotheses (Root Cause)
1. **Heavy stats polling**: `analyze` polls `backend.getStats()` every 500ms, which triggers **countNodesByType + countEdgesByType**. On large graphs this is expensive and can stall completion. After analysis, `backend.getStats()` is called again for final output, which may appear as a hang.
2. **Timer/interval leak**: If an error path bypasses clearing the stats interval, the interval keeps the process alive.
3. **Pending RFDB requests**: Long-running stats RPCs can leave timers active and prevent exit until timeout.

## Plan (Minimal, Root-Focused)
- **Reduce stats cost** in `analyze` by polling **only nodeCount/edgeCount** (no per-type counts). This cuts repeated heavy operations and avoids post-analysis stalls. Keep detailed stats for `overview` and `stats` commands.
- **Harden interval lifecycle**: ensure stats interval is cleared in a `finally` block and `unref()` it to avoid blocking exit in edge paths.
- **Tests first**: add a unit test to ensure the analyze path uses `nodeCount/edgeCount` and does not call `getStats`.
- **Validate** on ToolJet fixture once Node is available: `npx @grafema/cli init` + `npx @grafema/cli analyze --auto-start` should exit without manual interrupt.

## Non-Goals
- No changes to RFDB server lifecycle or core graph architecture.
- No new plugins or enrichers.

## Risks
- Minor change in progress stats detail (node/edge only) — acceptable for `analyze`.

## Decision
Proceed with lightweight stats polling + interval hardening, and verify on ToolJet.
