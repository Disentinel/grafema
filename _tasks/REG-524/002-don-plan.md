# REG-524: Demo Environment Plan — code-server + RFDB WebSocket + Grafema Extension

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-20
**Status:** APPROVED for implementation

---

## 1. Request Quality Assessment

### Linear Issue Summary
- **Goal:** Deploy browser-based demo environment where users can immediately try Grafema without local installation
- **Architecture:** Docker container with code-server (VS Code in browser) + rfdb-server WebSocket + pre-installed Grafema extension + pre-built demo graph
- **Acceptance Criteria:**
  - `docker run grafema/demo` starts full environment in <30 seconds
  - User sees demo project graph without any configuration
  - Playwright smoke tests pass in CI
  - Process for updating .vsix in demo image is documented

### Quality Gate: PASS ✅

**Strengths:**
- Well-defined acceptance criteria
- Clear architectural vision (WebSocket transport enables browser-based deployment)
- REG-523 (WebSocket transport) is merged, unblocking this work
- Addresses real user need (early access demo without installation friction)

**Potential Concerns:**
- None significant. This is a straightforward deployment task building on existing infrastructure.

**Verdict:** Proceed with implementation.

---

## 2. Codebase Exploration Findings

### Existing Infrastructure

**RFDB Server Binary:**
- Pre-built binaries exist in `/Users/vadimr/grafema-worker-2/packages/rfdb-server/prebuilt/` for:
  - `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`
- Built via `.github/workflows/build-binaries.yml` (triggered by `rfdb-v*` tags)
- WebSocket support: `--ws-port <port>` CLI flag (localhost-only binding)
- Default port mentioned in docs: `7474`

**VS Code Extension:**
- Package: `grafema-explore` (version 0.2.0)
- Pre-built .vsix exists: `/packages/vscode/grafema-explore-0.0.1.vsix` (stale version)
- Built via `vsce package --target <platform>`
- Configuration settings:
  - `grafema.rfdbTransport`: `"unix"` (default) or `"websocket"`
  - `grafema.rfdbWebSocketUrl`: `"ws://localhost:7474"` (default)
- Build script: `pnpm run build` in `packages/vscode/`
- Platform-specific builds via `.github/workflows/vscode-release.yml`

**Demo Project:**
- `test/fixtures/galaxy-demo/` — 724KB, ~1446 LOC
- Pre-built graph at `.rflow/graph.rfdb/`
- Reasonable size for demo (not too large, shows real features)

**CI/Playwright:**
- Existing e2e test: `test/e2e/gui.spec.js` (tests old Navi GUI, not VS Code extension)
- Playwright already in use, but not for code-server testing yet
- Pattern: `playwright.config.js` + `@playwright/test`

**Current State:**
- No existing Dockerfile or docker-compose
- `demo/` directory exists with only `onboarding-tests/tooljet/` (unrelated)
- No code-server setup yet

---

## 3. Architecture Decisions

### Container Strategy: Single Container

**Decision:** Use single Docker container with supervisord to run both rfdb-server and code-server.

**Rationale:**
- Simpler deployment model (`docker run` single command)
- No networking complexity between containers
- Matches AC: "docker run grafema/demo starts full environment"
- Both processes are lightweight, no resource contention concerns

**Alternative Considered:** docker-compose with separate containers
- **Rejected:** Adds complexity for minimal benefit. User would need docker-compose CLI, volumes for IPC, etc.

### Base Image: codercom/code-server:latest

**Decision:** Use official `codercom/code-server` image as base.

**Rationale:**
- Official, maintained image
- Latest version includes VS Code 1.95+ features
- Debian-based (easy to install dependencies)
- Pre-configured with correct user permissions

**Research Sources:**
- [code-server FAQ](https://coder.com/docs/code-server/FAQ)
- [code-server Docker discussion](https://github.com/coder/code-server/discussions/4778)

### RFDB Server Binary Strategy: Pre-built Linux x64

**Decision:** Copy pre-built `rfdb-server` binary from `packages/rfdb-server/prebuilt/linux-x64/` during Docker build.

**Rationale:**
- Avoid Rust toolchain in Docker build (faster builds, smaller image)
- Binary already exists in repo (no GitHub API dependencies)
- CI workflow already validates these binaries

**Alternative Considered:** Build from source in Dockerfile
- **Rejected:** Adds 10+ minutes to build time, requires Rust toolchain, increases image size

**Alternative Considered:** Download from GitHub releases
- **Deferred:** Requires version coordination, adds network dependency. Use local binary for v1.

### VS Code Extension Strategy: Build Fresh .vsix

**Decision:** Build universal .vsix from source during Docker build (not platform-specific).

**Rationale:**
- Ensures latest extension code (existing .vsix at 0.0.1 is stale)
- Universal .vsix works for web-based code-server (no native code)
- Simple: `cd packages/vscode && vsce package --no-dependencies`

**Extension Installation Method:**
- Install .vsix in entrypoint script: `code-server --install-extension /tmp/grafema-explore.vsix`
- **NOT** via `--extensions-dir` copy (layering issues per research)

**Research Sources:**
- [code-server extension installation](https://github.com/coder/code-server/discussions/4778)
- [extension install issues](https://github.com/coder/code-server/issues/7326)

### Demo Project: galaxy-demo

**Decision:** Use `test/fixtures/galaxy-demo/` as demo project.

**Rationale:**
- Already has pre-built graph (`.rflow/graph.rfdb/`)
- Small enough for Docker image (724KB)
- Shows real Grafema features (multi-service, auth, notifications, payments)
- No sensitive data (test fixture)

### VS Code Workspace Configuration

**Decision:** Create `.vscode/settings.json` in demo project to configure WebSocket transport.

**Config:**
```json
{
  "grafema.rfdbTransport": "websocket",
  "grafema.rfdbWebSocketUrl": "ws://localhost:7432"
}
```

**Port:** Use `7432` (not `7474`) to avoid conflicts with common dev setups.

**Workspace Auto-Open:**
- Code-server CLI: `code-server --open /workspace/demo-project`
- Alternative: Pass workspace path as final argument

**Research Sources:**
- [code-server workspace settings](https://code.visualstudio.com/docs/configure/settings)
- [code-server auto-open discussion](https://github.com/coder/code-server/discussions/2154)

### Startup Sequence: Supervisord

**Decision:** Use `supervisord` to manage both processes.

**Rationale:**
- Standard tool for multi-process containers
- Simple config (`/etc/supervisor/conf.d/grafema.conf`)
- Automatic restart on failure
- Both processes run as foreground services (proper Docker behavior)

**Startup Order:**
1. Start rfdb-server first (`priority=10`, auto-start)
2. Wait 2 seconds (supervisord `startsecs`)
3. Start code-server (`priority=20`, auto-start)

**Why not custom entrypoint script?**
- Rejected: Requires manual backgrounding, PID tracking, signal handling. Supervisord handles this.

### Port Mapping

**External Ports:**
- `8080`: code-server (VS Code UI)
- `7432`: rfdb-server WebSocket (for external clients, optional)

**Internal Communication:**
- Code-server extension connects to `ws://localhost:7432` (same container)

### Password/Auth Strategy

**Decision:** Disable password for demo (environment variable: `PASSWORD=`).

**Rationale:**
- Simplifies demo experience
- Users can add `--env PASSWORD=secret` if deploying publicly
- Document in README

**Security Note:** Demo is for local testing. Production deployment guide TBD.

---

## 4. Implementation Plan

### File Structure

```
demo/
├── Dockerfile
├── supervisord.conf
├── entrypoint.sh
├── demo-project/               # Copied from test/fixtures/galaxy-demo
│   ├── .vscode/
│   │   └── settings.json       # WebSocket transport config
│   ├── .rflow/                 # Pre-built graph
│   │   └── graph.rfdb/
│   ├── auth/
│   ├── notifications/
│   └── payments/
└── README.md                   # Usage and update instructions
```

### Dockerfile

```dockerfile
FROM codercom/code-server:latest

# Install Node.js 22 (for vsce)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g @vscode/vsce && \
    apt-get install -y supervisor && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create workspace directory
WORKDIR /home/coder/workspace

# Copy demo project with pre-built graph
COPY test/fixtures/galaxy-demo /home/coder/workspace/demo-project

# Create .vscode/settings.json for WebSocket transport
RUN mkdir -p /home/coder/workspace/demo-project/.vscode && \
    echo '{"grafema.rfdbTransport":"websocket","grafema.rfdbWebSocketUrl":"ws://localhost:7432"}' \
    > /home/coder/workspace/demo-project/.vscode/settings.json

# Copy RFDB server binary
COPY packages/rfdb-server/prebuilt/linux-x64/rfdb-server /usr/local/bin/rfdb-server
RUN chmod +x /usr/local/bin/rfdb-server

# Build VS Code extension
COPY packages/vscode /tmp/vscode-build
COPY packages/types /tmp/types
COPY packages/rfdb/ts /tmp/rfdb-client
WORKDIR /tmp/vscode-build
RUN npm install && \
    npm run build && \
    vsce package --no-dependencies --out /tmp/grafema-explore.vsix

# Copy supervisord config
COPY demo/supervisord.conf /etc/supervisor/conf.d/grafema.conf

# Copy entrypoint
COPY demo/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose ports
EXPOSE 8080 7432

# Set working directory back to workspace
WORKDIR /home/coder/workspace/demo-project

# Use custom entrypoint
ENTRYPOINT ["/entrypoint.sh"]
```

**Build Context:** Root of repo (allows COPY from `packages/`, `test/fixtures/`)

### supervisord.conf

```ini
[supervisord]
nodaemon=true
user=root
logfile=/dev/stdout
logfile_maxbytes=0
loglevel=info

[program:rfdb-server]
command=/usr/local/bin/rfdb-server /home/coder/workspace/demo-project/.rflow/graph.rfdb --ws-port 7432
autostart=true
autorestart=true
priority=10
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
user=coder
startsecs=2

[program:code-server]
command=/usr/bin/code-server --bind-addr 0.0.0.0:8080 --auth none /home/coder/workspace/demo-project
autostart=true
autorestart=true
priority=20
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
user=coder
environment=PASSWORD=""
```

**Key Points:**
- `nodaemon=true`: Keeps supervisord in foreground (proper Docker behavior)
- `priority`: rfdb-server starts first
- `startsecs=2`: rfdb-server must stay alive 2s before code-server starts
- `user=coder`: Run as non-root user (code-server default user)
- Logs to stdout/stderr (Docker best practice)

### entrypoint.sh

```bash
#!/bin/bash
set -e

# Install Grafema extension (must happen at runtime, not build time)
echo "Installing Grafema extension..."
code-server --install-extension /tmp/grafema-explore.vsix --extensions-dir /home/coder/.local/share/code-server/extensions

# Fix ownership (in case volumes are mounted)
chown -R coder:coder /home/coder/workspace

# Start supervisord
echo "Starting RFDB server and code-server..."
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
```

**Why install extension in entrypoint, not Dockerfile?**
- Per research, `--install-extension` in Dockerfile layers can cause extensions.json corruption
- Entrypoint runs once per container start (predictable state)

### demo/README.md

```markdown
# Grafema Demo Environment

Browser-based VS Code with Grafema extension and live graph database.

## Quick Start

```bash
docker build -t grafema/demo -f demo/Dockerfile .
docker run -p 8080:8080 -p 7432:7432 grafema/demo
```

Open http://localhost:8080 in your browser.

## Updating the Demo

### Update Extension

1. Make changes in `packages/vscode/`
2. Rebuild image: `docker build -t grafema/demo -f demo/Dockerfile .`
3. Extension is built fresh from source during build

### Update RFDB Server

1. Build new binary: `cd packages/rfdb-server && cargo build --release --target x86_64-unknown-linux-gnu`
2. Copy to prebuilt: `cp target/x86_64-unknown-linux-gnu/release/rfdb-server prebuilt/linux-x64/`
3. Rebuild image

### Update Demo Project

1. Replace `test/fixtures/galaxy-demo/` with new demo project
2. Ensure `.rflow/graph.rfdb/` exists (pre-built graph)
3. Rebuild image

## Configuration

### Password Protection

```bash
docker run -p 8080:8080 -e PASSWORD=secret grafema/demo
```

### Custom Port

```bash
docker run -p 9000:8080 grafema/demo
```

## Architecture

- **code-server**: VS Code in browser (port 8080)
- **rfdb-server**: Graph database with WebSocket transport (port 7432)
- **supervisord**: Process manager (starts rfdb-server, then code-server)
- **Demo project**: `test/fixtures/galaxy-demo` with pre-built graph
```

---

## 5. Playwright Testing Plan

### Test File: `test/e2e/demo.spec.js`

**Scope:** Smoke tests to verify demo environment loads correctly.

**Tests:**

1. **code-server loads**
   - Navigate to `http://localhost:8080`
   - Wait for VS Code UI to render
   - Check for Monaco editor, activity bar, status bar

2. **Grafema extension is installed**
   - Check Extensions view for "Grafema Explore"
   - Verify extension is enabled (not disabled/errored)

3. **RFDB connection established**
   - Open Grafema Status panel
   - Check for "Connected" status indicator
   - Verify graph stats are displayed (node count, edge count)

4. **Demo project is open**
   - Check that workspace folder is `demo-project`
   - Verify files are visible in Explorer (auth/, notifications/, payments/)

5. **Basic graph navigation works**
   - Open Grafema Explorer panel
   - Search for a node (e.g., "auth")
   - Verify search results appear

**Headless Mode:** Run with `--headless=new` (Chromium)

**Timeout:** 60 seconds for initial load (extension activation can be slow)

### Test Setup: docker-compose.test.yml

```yaml
version: '3.8'
services:
  demo:
    build:
      context: .
      dockerfile: demo/Dockerfile
    ports:
      - "8080:8080"
      - "7432:7432"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080"]
      interval: 5s
      timeout: 3s
      retries: 10
```

**Test Execution:**
```bash
docker-compose -f demo/docker-compose.test.yml up -d
npx playwright test test/e2e/demo.spec.js
docker-compose -f demo/docker-compose.test.yml down
```

### CI Integration: `.github/workflows/demo-test.yml`

```yaml
name: Demo Environment Tests

on:
  push:
    branches: [main]
  pull_request:
    paths:
      - 'demo/**'
      - 'packages/vscode/**'
      - 'packages/rfdb-server/**'

jobs:
  test-demo:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Install Playwright
        run: |
          pnpm add -D @playwright/test
          npx playwright install chromium

      - name: Build demo image
        run: docker build -t grafema/demo -f demo/Dockerfile .

      - name: Start demo container
        run: |
          docker run -d -p 8080:8080 -p 7432:7432 --name grafema-demo grafema/demo
          # Wait for code-server to be ready
          timeout 60 bash -c 'until curl -f http://localhost:8080 > /dev/null 2>&1; do sleep 2; done'

      - name: Run Playwright tests
        run: npx playwright test test/e2e/demo.spec.js

      - name: Stop demo container
        if: always()
        run: docker rm -f grafema-demo

      - name: Upload test artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
```

**Trigger Conditions:**
- Push to `main`
- PR that touches `demo/`, `packages/vscode/`, or `packages/rfdb-server/`

**Why not run on every PR?**
- Docker build is slow (~5 min)
- Only test when demo-related code changes

---

## 6. Acceptance Criteria Mapping

| AC | Implementation | Verification |
|----|---------------|--------------|
| `docker run grafema/demo` starts full environment in <30 sec | Dockerfile with pre-built binary + cached layers | Manual test: `time docker run` |
| User sees demo project graph without configuration | `.vscode/settings.json` with WebSocket transport pre-configured | Playwright test: check Status panel shows "Connected" |
| Playwright smoke tests pass in CI | `.github/workflows/demo-test.yml` | CI must be green on PR |
| Process for updating .vsix is documented | `demo/README.md` section "Updating the Demo" | README review |

---

## 7. Open Questions / Decisions Needed

**Q1:** Should demo be published to Docker Hub (`docker.io/grafema/demo`) or GitHub Container Registry (`ghcr.io/grafema/demo`)?

**Answer:** DEFER to finalization phase. For MVP, local build only. Publishing requires CI workflow + credentials.

**Q2:** What version tag strategy for demo image?

**Answer:** Tag with Grafema version (e.g., `grafema/demo:0.2.12-beta`). Rebuild on each release.

**Q3:** Should we add demo to main CI workflow or separate workflow?

**Answer:** Separate workflow (`.github/workflows/demo-test.yml`) to avoid slowing down main CI on unrelated PRs.

**Q4:** Should rfdb-server WebSocket port (7432) be exposed externally?

**Answer:** YES. Allows external clients (e.g., Grafema CLI on host) to connect to demo graph for testing.

---

## 8. Implementation Task Breakdown

**For Dijkstra (Verification):**

1. Verify Dockerfile syntax and best practices
2. Verify supervisord config (process priorities, signal handling)
3. Verify entrypoint script (error handling, idempotency)
4. Verify workspace settings.json matches extension config schema
5. Verify demo-project structure (pre-built graph exists, no sensitive data)

**For Uncle Bob (Prepare/Refactor):**

1. Check if any refactoring needed in `packages/vscode/` for universal .vsix build
2. Verify `test/fixtures/galaxy-demo/` is suitable for demo (no tech debt, clean code)
3. Check if supervisord is best choice vs. alternatives (tini, dumb-init)

**For Kent (Tests):**

1. Write Playwright test: code-server loads
2. Write Playwright test: Grafema extension installed
3. Write Playwright test: RFDB connection established
4. Write Playwright test: Demo project open
5. Write Playwright test: Graph navigation works
6. Write CI workflow: `.github/workflows/demo-test.yml`

**For Rob (Implementation):**

1. Create `demo/Dockerfile`
2. Create `demo/supervisord.conf`
3. Create `demo/entrypoint.sh`
4. Create `demo/demo-project/.vscode/settings.json`
5. Create `demo/README.md`
6. Create `demo/docker-compose.test.yml` (for Playwright tests)

**For 3-Review (Steve ∥ Вадим auto ∥ Uncle Bob):**
- Review final implementation for production readiness

---

## 9. Research Sources

- [code-server FAQ](https://coder.com/docs/code-server/FAQ) — Extension installation, configuration
- [Pre-install extensions discussion](https://github.com/coder/code-server/discussions/4778) — Docker extension installation patterns
- [Extension install issues](https://github.com/coder/code-server/issues/7326) — Layering problems with `--install-extension`
- [code-server auto-open workspace](https://github.com/coder/code-server/discussions/2154) — Workspace CLI arguments
- [VS Code workspace settings](https://code.visualstudio.com/docs/configure/settings) — settings.json structure

---

## 10. Risk Assessment

**Low Risk:**
- All components already exist (rfdb-server, extension, demo project)
- Docker is standard deployment tool
- WebSocket transport is tested and merged (REG-523)

**Medium Risk:**
- code-server extension installation quirks (mitigated by entrypoint script approach)
- Supervisord complexity (mitigated by simple 2-process config)

**Mitigation:**
- Playwright tests catch integration issues early
- README documents troubleshooting steps

---

## Conclusion

This plan provides a complete, production-ready demo environment with:
- Single-command deployment (`docker run`)
- Pre-configured workspace (no user setup)
- Automated testing (Playwright + CI)
- Clear update documentation

**Next Steps:**
1. Dijkstra verification (architecture validation)
2. Uncle Bob preparation (refactoring if needed)
3. Kent test implementation
4. Rob implementation
5. 3-Review
6. User confirmation → merge

**Estimated Effort:** 4-6 hours (2h implementation, 2h testing, 2h review/iteration)

---

**Don Melton** — 2026-02-20
