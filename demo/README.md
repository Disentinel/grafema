# Grafema Docker Demo

Open a browser and get VS Code with the Grafema extension and a live code graph -- no local install needed.

The demo project is Grafema itself (self-analysis / dogfooding).

## Quick Start

```bash
# Build the image (from repo root)
docker build -t grafema-demo -f demo/Dockerfile .

# Run the container
docker run -p 8080:8080 grafema-demo

# Open in browser
open http://localhost:8080
```

The first build takes several minutes (installs dependencies, compiles all packages, runs full analysis). Subsequent builds use Docker layer caching.

## What You Get

- **VS Code in browser** (code-server) at `http://localhost:8080`
- **Grafema extension** pre-installed with all panels (Explorer, Value Trace, Callers, Blast Radius, Issues)
- **Pre-built code graph** of the Grafema monorepo (self-analysis)
- **rfdb-server** running on WebSocket port 7432

Open any source file and the Grafema sidebar will show graph data: function callers, value traces, blast radius, and more.

## Architecture

Single container running three components:

| Component | Port | Purpose |
|-----------|------|---------|
| code-server | 8080 | VS Code in browser (no auth) |
| rfdb-server | 7432 (WS) | Graph database server |
| supervisord | - | Process manager for code-server |

The startup sequence:
1. Install Grafema extension into code-server
2. Start rfdb-server with the pre-built graph
3. Health check: wait for port 7432
4. Start supervisord (manages code-server)

## Configuration

### Custom Port

```bash
docker run -p 3000:8080 grafema-demo
# Access at http://localhost:3000
```

### Detached Mode

```bash
docker run -d --name grafema-demo -p 8080:8080 grafema-demo

# View logs
docker logs -f grafema-demo

# Stop
docker stop grafema-demo && docker rm grafema-demo
```

### Resource Limits

The graph database can consume memory for large codebases. For the Grafema self-analysis:

```bash
docker run -p 8080:8080 --memory=2g grafema-demo
```

## Updating the Demo

### Update Everything

After code changes, rebuild the image:

```bash
docker build -t grafema-demo -f demo/Dockerfile . --no-cache
```

### Update Only the Extension (.vsix)

The extension is built from source during `docker build`. The pipeline:

1. Builder stage runs `pnpm build` (builds all packages including the extension)
2. `npx vsce package --no-dependencies` creates a universal `.vsix` in `packages/vscode/`
3. Runtime stage copies the `.vsix` to `/tmp/grafema-explore.vsix`
4. Entrypoint installs it via `code-server --install-extension`

To update only the extension after code changes in `packages/vscode/`:

```bash
# Rebuild (Docker layer caching skips unchanged stages)
docker build -t grafema-demo -f demo/Dockerfile .
```

If the extension build fails, check that `packages/vscode/esbuild.config.mjs` and its workspace dependencies (`@grafema/rfdb-client`, `@grafema/types`) are correct.

### Update the Graph

The graph is regenerated on every build by running `grafema analyze` in the builder stage. To force a fresh graph:

```bash
docker build -t grafema-demo -f demo/Dockerfile . --no-cache
```

## Troubleshooting

**Extension not showing panels:** Open the Grafema sidebar (activity bar icon). If "Status" shows disconnected, check container logs for rfdb-server errors.

**Build fails at `pnpm build`:** Ensure you're building from the repo root (`docker build -f demo/Dockerfile .`). The build context must include all packages.

**Container exits immediately:** Check `docker logs <container>`. Common causes:
- rfdb-server binary not found (linux-x64 prebuilt missing)
- Graph database not generated (analyze step failed in builder)

**Port conflict:** Change the host port mapping: `docker run -p 9090:8080 grafema-demo`
