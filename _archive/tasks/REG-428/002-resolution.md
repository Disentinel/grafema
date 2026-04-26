# REG-428: Resolution

## Finding

Auto-start is **already implemented** in the codebase:

1. `RFDBServerBackend` has `autoStart` defaulting to `true` (`packages/core/src/storage/backends/RFDBServerBackend.ts:111`)
2. `getOrCreateBackend()` in `packages/mcp/src/state.ts:233` creates backend without specifying `autoStart` → defaults to `true`
3. On first MCP tool call, `connect()` tries the socket, and if RFDB isn't running, spawns it via `_startServer()`
4. Server is spawned `detached: true` with `unref()` — survives MCP server exit
5. Binary found via `findRfdbBinary()`: monorepo build > PATH > `~/.local/bin`

## Root Cause

The issue was filed during dogfooding setup before realizing auto-start was already wired up. Documentation said "must be started manually" — code said otherwise.

## Changes Made

- **CLAUDE.md**: Added auto-start documentation to Dogfooding section; updated Don exploration model from Haiku to Sonnet
- **MEMORY.md**: Fixed incorrect "manual start" statements; removed resolved product gap
- **packages/mcp/README.md**: Added auto-start note for users

## Conclusion

No code changes needed. Documentation-only fix.
