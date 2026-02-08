# Don Plan — REG-378 (Revision)

## Context
CLI `grafema analyze` hangs after analysis completes on large repos (ToolJet). User requests adding `process.exit(0)` because something likely keeps the DB connection alive.

## Constraints / Reality Check
- **Grafema-first workflow blocked:** Node.js is not available in this environment (`node`/`npx` missing), so I cannot run `grafema analyze` or query the graph here. This remains a product gap for AI workflows.

## Hypotheses (Root Cause)
1. **Event loop kept alive** by lingering timers or open sockets (RFDB client/server connection).
2. **Heavy stats polling** repeatedly calls `getStats()` (counts by type) every 500ms and again at the end, which can stall on large graphs.

## Plan (Root-Focused, User-Requested)
- **Force process exit** after analysis completes (success and failure), with `process.exit(exitCode)` to guarantee no lingering handles can keep the CLI alive.
- **Reduce stats polling cost** to `nodeCount` + `edgeCount` only, avoiding `getStats()` in `analyze`.
- **Harden interval lifecycle** (clear + `unref()` in finally).

## Tests
- Add CLI unit test to ensure analyze’s stats polling does **not** call `getStats()`.
- Add CLI unit test to ensure `process.exit(exitCode)` is invoked on success path (use process stub or child process test).

## Risks
- `process.exit` is blunt; must ensure `backend.flush()` and `backend.close()` are awaited before exit.
- Minor reduction in progress detail (nodes/edges only) is acceptable.

## Decision
Proceed with explicit `process.exit(exitCode)` after clean shutdown, plus lighter stats polling.
