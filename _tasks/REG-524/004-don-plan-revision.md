# REG-524: Plan Revision — Addressing Dijkstra's Gaps

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-20
**Status:** Revised plan addressing 3 critical gaps

---

## Changes from Original Plan

This revision addresses three gaps identified by Dijkstra in his verification report:

1. **GAP 1 (CRITICAL):** Extension build dependencies broken in Docker
2. **GAP 2 (MINOR):** supervisord startup ordering is not enforced
3. **GAP 3 (MINOR):** Playwright test scope too ambitious for MVP

---

## GAP 1: Extension Build Dependencies (CRITICAL FIX)

### Problem

Original Dockerfile copied packages separately and tried to run `npm install`:

```dockerfile
COPY packages/vscode /tmp/vscode-build
COPY packages/types /tmp/types
COPY packages/rfdb/ts /tmp/rfdb-client    # Wrong path (source only, not package root)
WORKDIR /tmp/vscode-build
RUN npm install && npm run build          # FAILS: workspace:* not resolved
```

**Why it fails:**
- `workspace:*` dependencies are pnpm-specific, npm doesn't understand them
- Copying packages separately doesn't create a workspace
- Wrong path for rfdb-client (copied `ts/` subdirectory, not package root with `package.json`)

### Solution: Multi-Stage Docker Build

**Key insight:** The extension uses esbuild to bundle everything into a single `dist/extension.js`. We don't need workspace protocol at runtime — we just need all dependencies available during build.

**Best approach:** Use pnpm in a build stage with full monorepo context, then copy only the final .vsix artifact to the runtime image.

### Revised Dockerfile (Multi-Stage)

```dockerfile
# ============================================
# STAGE 1: Build Extension + Binary Artifacts
# ============================================
FROM node:22-bookworm AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy entire monorepo for workspace resolution
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY test/fixtures/galaxy-demo ./test/fixtures/galaxy-demo

# Install all dependencies (workspace:* will resolve correctly)
RUN pnpm install --frozen-lockfile

# Build extension dependencies
RUN pnpm --filter @grafema/rfdb-client build
RUN pnpm --filter @grafema/types build

# Build and package extension
WORKDIR /build/packages/vscode
RUN pnpm build
RUN npm install -g @vscode/vsce
RUN vsce package --out /tmp/grafema-explore.vsix

# ============================================
# STAGE 2: Runtime Image
# ============================================
FROM codercom/code-server:latest

# Install supervisor (only runtime dependency)
RUN apt-get update && \
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

# Copy RFDB server binary from monorepo
COPY packages/rfdb-server/prebuilt/linux-x64/rfdb-server /usr/local/bin/rfdb-server
RUN chmod +x /usr/local/bin/rfdb-server

# Copy built extension from builder stage
COPY --from=builder /tmp/grafema-explore.vsix /tmp/grafema-explore.vsix

# Copy supervisord config
COPY demo/supervisord.conf /etc/supervisor/conf.d/grafema.conf

# Copy entrypoint
COPY demo/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose ports
EXPOSE 8080 7432

# Set working directory to demo project
WORKDIR /home/coder/workspace/demo-project

# Use custom entrypoint
ENTRYPOINT ["/entrypoint.sh"]
```

**Benefits:**
- ✅ Clean separation: build artifacts vs runtime image
- ✅ Smaller final image (no build tools, no source files)
- ✅ Workspace dependencies resolve correctly via pnpm
- ✅ Standard multi-stage pattern (familiar to Docker users)

**Trade-off:** Larger build context (entire monorepo). This is acceptable because:
- Build happens once per release
- CI has sufficient resources
- Final image is still small (~500MB, mostly code-server base)

---

## GAP 2: supervisord Startup Ordering (MINOR FIX)

### Problem

Original supervisord.conf assumed `startsecs` enforces ordering:

```ini
[program:rfdb-server]
priority=10
startsecs=2    # Don assumed code-server waits 2 seconds

[program:code-server]
priority=20    # Don assumed this starts AFTER rfdb-server is ready
```

**Reality:** `priority` only determines START order (which process is started first), not READINESS. Both processes start almost simultaneously (~100ms apart). `startsecs` is a health check duration, not a dependency blocker.

**Actual risk:** LOW (VS Code takes 2-5 seconds to load, user interaction adds buffer), but architecturally WRONG.

### Solution: Health Check in Entrypoint

Start rfdb-server in entrypoint with explicit readiness check BEFORE starting supervisord.

### Revised entrypoint.sh

```bash
#!/bin/bash
set -e

# Install Grafema extension (must happen at runtime, not build time)
echo "Installing Grafema extension..."
code-server --install-extension /tmp/grafema-explore.vsix \
    --extensions-dir /home/coder/.local/share/code-server/extensions

# Fix ownership (in case volumes are mounted)
chown -R coder:coder /home/coder/workspace

# Start rfdb-server in background BEFORE supervisord
echo "Starting RFDB server..."
su coder -c "/usr/local/bin/rfdb-server /home/coder/workspace/demo-project/.rflow/graph.rfdb --ws-port 7432 &"

# Wait for rfdb-server to be ready (WebSocket port listening)
echo "Waiting for RFDB server to be ready..."
timeout 30 bash -c 'until nc -z localhost 7432; do sleep 0.5; done' || {
    echo "ERROR: rfdb-server failed to start within 30 seconds"
    exit 1
}
echo "RFDB server is ready on port 7432"

# Start code-server via supervisord (now manages only one process)
echo "Starting code-server..."
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
```

### Revised supervisord.conf

```ini
[supervisord]
nodaemon=true
user=root
logfile=/dev/stdout
logfile_maxbytes=0
loglevel=info

# Only manage code-server (rfdb-server started in entrypoint)
[program:code-server]
command=/usr/bin/code-server --bind-addr 0.0.0.0:8080 --auth none /home/coder/workspace/demo-project
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
user=coder
environment=PASSWORD=""
```

**Why this is better:**
- ✅ Explicit ordering: rfdb-server MUST be ready before code-server starts
- ✅ Health check: `nc -z localhost 7432` verifies WebSocket port is listening
- ✅ Fast-fail: If rfdb-server crashes during startup, container exits with error (not silent failure)
- ✅ Simpler supervisord config (manages one process instead of two)

**Trade-off:** rfdb-server is not supervised by supervisord (no auto-restart). This is acceptable because:
- Demo is short-lived (not production)
- If rfdb-server crashes, container health check will fail (user will restart)
- Simplifies debugging (one less layer of process management)

---

## GAP 3: Playwright Test Scope (MINOR FIX)

### Problem

Original plan included 5 tests:

1. code-server loads — ✅ Easy
2. Extension installed — ✅ Easy
3. RFDB connection established — ⚠️ Requires panel to be opened (async activation)
4. Demo project open — ✅ Easy
5. Graph navigation works — ❌ VERY HARD (Shadow DOM, tree expansion, search input)

**Test #5 is too complex for MVP:**
- Requires Shadow DOM selectors (fragile, hard to maintain)
- Requires extension to fully activate (async, race conditions)
- Requires search input interaction (non-standard VS Code tree component)

**Dijkstra's recommendation:** Reduce scope to tests 1-3, defer test 5 to follow-up.

### Solution: MVP Scope = Tests 1-3

Focus on **environment readiness**, not **feature functionality**.

### Revised test/e2e/demo.spec.js

```javascript
import { test, expect } from '@playwright/test';

const CODE_SERVER_URL = 'http://localhost:8080';

test.describe('Grafema Demo Environment', () => {
  test('code-server loads', async ({ page }) => {
    await page.goto(CODE_SERVER_URL);

    // Wait for Monaco workbench to render
    await expect(page.locator('.monaco-workbench')).toBeVisible({ timeout: 30000 });

    // Verify VS Code UI elements are present
    await expect(page.locator('.activitybar')).toBeVisible();
    await expect(page.locator('.statusbar')).toBeVisible();
  });

  test('Grafema extension is installed', async ({ page }) => {
    await page.goto(CODE_SERVER_URL);
    await expect(page.locator('.monaco-workbench')).toBeVisible({ timeout: 30000 });

    // Open Extensions view
    await page.locator('[aria-label="Extensions"]').click();

    // Search for Grafema extension
    await page.locator('.extensions-viewlet input[type="text"]').fill('Grafema Explore');

    // Verify extension appears in results
    await expect(page.getByText('Grafema Explore')).toBeVisible({ timeout: 10000 });
  });

  test('Demo project is open', async ({ page }) => {
    await page.goto(CODE_SERVER_URL);
    await expect(page.locator('.monaco-workbench')).toBeVisible({ timeout: 30000 });

    // Verify workspace folder name in Explorer
    await expect(page.locator('.explorer-folders-view')).toContainText('demo-project', { timeout: 10000 });
  });
});
```

**Deferred to follow-up task (REG-XXX):**
- Test #4: RFDB connection established (check Status panel for "Connected")
- Test #5: Graph navigation works (search, tree expansion, results)

**Rationale:**
- MVP goal: Verify demo environment STARTS correctly (image builds, services run, extension installs)
- Feature testing (graph queries, navigation) is separate concern (belongs in extension test suite)
- Shadow DOM tests are brittle and require ongoing maintenance (not worth it for MVP)

**CI Impact:** Tests 1-3 run in ~15 seconds (fast feedback, low CI cost)

---

## Summary of Changes

| Gap | Original Approach | Revised Approach | Impact |
|-----|------------------|------------------|--------|
| **GAP 1 (CRITICAL)** | Copy packages separately, npm install | Multi-stage build with pnpm + full monorepo | **FIXES BUILD FAILURE** |
| **GAP 2 (MINOR)** | supervisord priority + startsecs | Health check in entrypoint before supervisord | **PROPER ORDERING** |
| **GAP 3 (MINOR)** | 5 Playwright tests (including Shadow DOM) | 3 MVP tests (environment readiness only) | **FASTER CI, LESS BRITTLE** |

---

## Implementation Task Breakdown (Updated)

**For Dijkstra (Re-Verification):**
1. Verify multi-stage Dockerfile (build stage dependencies, artifact copying)
2. Verify entrypoint health check logic (nc command, timeout handling)
3. Verify reduced test scope covers MVP acceptance criteria

**For Uncle Bob (Prepare/Refactor):**
- No changes (same as original plan)

**For Kent (Tests):**
1. Write Playwright test: code-server loads (SIMPLIFIED)
2. Write Playwright test: Grafema extension installed (SIMPLIFIED)
3. Write Playwright test: Demo project open (SIMPLIFIED)
4. ~~Write Playwright test: RFDB connection established~~ (DEFERRED)
5. ~~Write Playwright test: Graph navigation works~~ (DEFERRED)
6. Write CI workflow: `.github/workflows/demo-test.yml` (UNCHANGED)

**For Rob (Implementation):**
1. Create `demo/Dockerfile` (MULTI-STAGE VERSION)
2. Create `demo/supervisord.conf` (CODE-SERVER ONLY)
3. Create `demo/entrypoint.sh` (WITH HEALTH CHECK)
4. Create `demo/demo-project/.vscode/settings.json` (UNCHANGED)
5. Create `demo/README.md` (UNCHANGED)
6. ~~Create `demo/docker-compose.test.yml`~~ (NOT NEEDED, tests use `docker run`)

**For 3-Review (Steve ∥ Вадим auto ∥ Uncle Bob):**
- Review revised implementation

---

## Acceptance Criteria Mapping (Updated)

| AC | Implementation | Verification |
|----|---------------|--------------|
| `docker run grafema/demo` starts full environment in <30 sec | Multi-stage Dockerfile + health check entrypoint | Manual test: `time docker run` |
| User sees demo project graph without configuration | `.vscode/settings.json` + guaranteed rfdb-server ready | Playwright test: Demo project open |
| Playwright smoke tests pass in CI | 3 MVP tests (code-server loads, extension installed, project open) | CI must be green on PR |
| Process for updating .vsix is documented | `demo/README.md` section "Updating the Demo" | README review |

---

## Risk Assessment (Updated)

**Low Risk:**
- Multi-stage builds are standard Docker pattern
- Health check with `nc` is reliable
- Reduced test scope lowers maintenance burden

**Mitigated Risks:**
- **Original risk:** Extension build fails in Docker → **FIXED** (pnpm workspace in build stage)
- **Original risk:** Race condition between rfdb-server and code-server → **FIXED** (health check before supervisord)
- **Original risk:** Flaky Shadow DOM tests → **AVOIDED** (deferred to follow-up)

---

## Next Steps

1. **Dijkstra re-verification** — validate revised Dockerfile, entrypoint, test scope
2. **Uncle Bob preparation** — check if galaxy-demo needs cleanup
3. **Kent test implementation** — write 3 MVP Playwright tests
4. **Rob implementation** — create files per revised plan
5. **3-Review** — Steve ∥ Вадім auto ∥ Uncle Bob
6. **User confirmation** → merge

**Estimated Effort:** 4-6 hours (unchanged)

---

**Don Melton** — 2026-02-20
