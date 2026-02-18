# RFD-40: RFDB server coupling: simplify binary discovery, startup, and path handling

## Problem

RFDB server ↔ client coupling is fragile and painful, especially with multiple versions coexisting.

### Pain points

1. **Too many binary locations** — `~/.local/bin/rfdb-server`, monorepo `target/release/`, PATH, etc. `findRfdbBinary()` searches multiple places but it's unclear which version you're actually running. Does the server even print its version on startup?
2. **Auto-start is a hack** — `RFDBServerBackend` spawns the server on first connection attempt (detached process). This "works" but is fragile: no version validation, no lifecycle management, no way to know if it started the right binary.
3. **Absolute paths only** — Server requires absolute paths for `--socket`, `--data-dir`, graph file. Typing these manually and keeping them in sync across configs is error-prone. Relative paths (from workspace root) should just work.
4. **Documentation is stale/wrong** — CLAUDE.md dogfooding section has manual `rfdb-server` commands that may not match current reality. This context doesn't reliably reach agents or humans.
5. **Multi-version hell** — When developing RFDB alongside Grafema, old binaries linger. No clear way to know which version is running or force a specific one.

## Desired outcome

* **One command from workspace** — `pnpm rfdb:start` or similar that handles binary discovery, version matching, path resolution, and startup
* **Version printed on startup** — server logs its version, client validates compatibility
* **Relative path support** — resolve relative to CWD or workspace root
* **Single source of truth** for binary location (workspace-local build preferred over global install)
* **Clean lifecycle** — start, stop, restart, status commands
* **Documentation that stays correct** — ideally generated from actual config/code

## Context

Current workaround chain: `findRfdbBinary()` → `RFDBServerBackend` auto-start → detached process → hope for the best. Works 90% of the time, frustrating the other 10%.
