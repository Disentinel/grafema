# REG-524: Rob Implementation Report

## Files Created

### 1. `demo/Dockerfile`
Multi-stage Docker build:

**Stage 1 (builder)** — `node:22-bookworm`:
- Enables corepack/pnpm, installs vsce globally
- Copies package manifests first for layer caching, then `pnpm install --frozen-lockfile`
- `COPY . .` then `pnpm build` to compile all packages
- `vsce package --no-dependencies` to produce universal .vsix
- `node packages/cli/dist/cli.js analyze --root /build --clear` to self-analyze
- Prepares a clean `/demo-source/` tree with only `src/` dirs and `package.json` per package (no `node_modules/`, no `dist/`)

**Stage 2 (runtime)** — `codercom/code-server:latest`:
- Installs `supervisor` + `netcat-openbsd` via apt
- Copies rfdb-server linux-x64 binary from build context (prebuilt)
- Copies .vsix from builder stage
- Copies clean source tree + pre-built graph from builder
- Creates `.vscode/settings.json` with websocket transport config
- Copies entrypoint.sh and supervisord.conf
- Fixes file ownership to `coder:coder`

### 2. `demo/supervisord.conf`
Manages code-server only. Runs as `coder` user, binds to `0.0.0.0:8080`, no auth. Logs to stdout/stderr for `docker logs` visibility.

### 3. `demo/entrypoint.sh`
Startup sequence:
1. Install Grafema extension via `code-server --install-extension`
2. Start rfdb-server as background process with `--socket /tmp/rfdb.sock --ws-port 7432`
3. Health check: poll port 7432 with `nc -z` (30s timeout, checks process liveness)
4. `exec supervisord` to manage code-server

### 4. `demo/README.md`
Quick start instructions, architecture table, configuration options (custom port, detached mode, memory limits), update procedures, troubleshooting.

### 5. `.dockerignore` (bonus)
Excludes `.git`, `node_modules`, `dist`, `_tasks`, `_ai`, `.claude`, etc. from build context. Keeps the context small so `docker build` sends only source files.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Port 7432 for WS | Per plan, avoids Neo4j default 7474 conflicts |
| Universal .vsix (no `--target`) | code-server is not a standard VS Code target; universal build works |
| rfdb-server binary from build context, not builder | The prebuilt binary is already committed; no need to rebuild from Rust source |
| Clean source tree via `/demo-source/` | Avoids copying ~200MB of `node_modules` and `dist` into the runtime image |
| `printf` not `echo` for JSON settings | `echo` with `\n` requires `-e` flag which varies by shell; `printf` is portable |
| rfdb-server started by entrypoint, not supervisord | Need health check before code-server starts; supervisord only manages long-running code-server |
| `.dockerignore` at repo root | Docker reads `.dockerignore` from build context root, not Dockerfile location |

## CLI Entry Point

The plan referenced `packages/cli/dist/index.js` but the actual entry point is `packages/cli/dist/cli.js` (confirmed from `package.json` bin field: `"grafema": "./dist/cli.js"`). Used the correct path.

## Verification Checklist

- [x] Dockerfile builds in two stages
- [x] Builder: pnpm install, build, vsce package, grafema analyze
- [x] Runtime: code-server base image
- [x] rfdb-server binary copied from prebuilt/linux-x64
- [x] .vsix copied from builder
- [x] Clean source tree (no node_modules/dist)
- [x] .grafema/graph.rfdb copied (pre-built graph)
- [x] VS Code settings: websocket transport, ws://localhost:7432
- [x] supervisord.conf: code-server only, nodaemon, coder user
- [x] entrypoint.sh: install extension, start rfdb-server, health check, exec supervisord
- [x] entrypoint.sh is executable (chmod +x)
- [x] Port 7432 for rfdb-server WebSocket
- [x] Port 8080 for code-server (EXPOSE)
- [x] No auth on code-server (`--auth none`)
- [x] .dockerignore to reduce build context
