# REG-410: `--auto-start` should check PATH for rfdb-server binary

## Problem

`grafema analyze --auto-start` only looks for the rfdb-server binary inside `node_modules/@grafema/rfdb/prebuilt/`. When rfdb-server is installed to `/usr/local/bin/` (e.g., in Docker containers or manual installs), `--auto-start` fails with "RFDB server binary not found".

## Proposed Solution

Add system PATH lookup to `findRfdbBinary()` in `packages/core/src/utils/findRfdbBinary.ts`.

New search order:
1. Explicit path (from config or flag)
2. GRAFEMA_RFDB_SERVER environment variable
3. Monorepo target/release (development)
4. Monorepo target/debug (development)
5. **System PATH lookup (`which rfdb-server`)** ← NEW
6. @grafema/rfdb npm package (prebuilt)
7. ~/.local/bin/rfdb-server (user-installed)

## Acceptance Criteria

- `--auto-start` finds rfdb-server from PATH
- Existing node_modules lookup still works as fallback
- Works in Docker containers where binary is in /usr/local/bin/
