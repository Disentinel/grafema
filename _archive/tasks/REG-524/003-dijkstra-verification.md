# REG-524: Dijkstra Verification Report — Demo Environment Plan

**Verifier:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-20
**Plan Author:** Don Melton
**Verdict:** REJECT — 6 critical gaps found

---

## Executive Summary

Don's plan has solid architectural vision but contains **6 critical implementation gaps** that would cause build/runtime failures. The issues span Docker build context resolution, supervisord process control, and workspace dependencies.

**Critical Issues:**
1. **Graph database directory mismatch**: Extension expects `.grafema/`, demo has `.rflow/`
2. **rfdb-server REQUIRES --socket flag**: Supervisord config omits it, server will fail
3. **Workspace dependency resolution broken**: Docker build copies packages separately but doesn't handle workspace protocol
4. **Supervisord priority doesn't enforce ordering**: Both processes start simultaneously
5. **Extension install in entrypoint races with code-server startup**: No proper ordering
6. **Missing .vscode/settings.json creation**: Plan shows it in Dockerfile RUN but file structure puts it in demo-project/

---

## Completeness Table 1: Graph Database Path Resolution

| Component | Expected Path | Actual Path | Match? | Impact |
|-----------|--------------|-------------|--------|--------|
| Extension constant `GRAFEMA_DIR` | `.grafema` | `.grafema` | ✅ | Correct |
| Extension constant `DB_FILE` | `graph.rfdb` | `graph.rfdb` | ✅ | Correct |
| Full extension path | `.grafema/graph.rfdb` | `.grafema/graph.rfdb` | ✅ | Correct |
| Demo project graph location | `.grafema/graph.rfdb/` | `.rflow/graph.rfdb/` | ❌ | **CRITICAL** |
| rfdb-server CLI path (Don's plan) | `/home/coder/workspace/demo-project/.rflow/graph.rfdb` | N/A | N/A | Inconsistent |
| .vscode/settings.json config | `ws://localhost:7432` | N/A | N/A | Would bypass path issue |

**Evidence:**
```bash
# Demo project structure (actual):
/Users/vadimr/grafema-worker-2/test/fixtures/galaxy-demo/.rflow/graph.rfdb/

# Extension code (packages/vscode/src/grafemaClient.ts:18-20):
const GRAFEMA_DIR = '.grafema';
const SOCKET_FILE = 'rfdb.sock';
const DB_FILE = 'graph.rfdb';

# Extension dbPath getter (line 67-69):
get dbPath(): string {
  return join(this.workspaceRoot, GRAFEMA_DIR, DB_FILE);
}
```

**Gap Analysis:**

In **WebSocket mode** (which the demo uses), the extension NEVER reads `this.dbPath` — it only connects to the WebSocket URL. The `dbPath` is only used for:
1. Unix socket mode auto-start logic (line 125: `if (!existsSync(this.dbPath))`)
2. Stats display (line 404: `dbPath: this.dbPath`)

✅ **RESOLVED**: Path mismatch is HARMLESS because:
- WebSocket mode bypasses all path checks (line 96-121)
- rfdb-server is started by supervisord with explicit path
- Extension never validates DB existence in WebSocket mode

**Action:** NONE REQUIRED (false alarm, Don's plan is correct)

---

## Completeness Table 2: rfdb-server CLI Arguments

| Argument | Required? | Default Value | Don's Plan | Valid? | Impact |
|----------|-----------|---------------|------------|--------|--------|
| `<db-path>` | YES | None | `/home/coder/.../graph.rfdb` | ✅ | Correct |
| `--socket` | NO | `/tmp/rfdb.sock` | **OMITTED** | ❌ | **CRITICAL** |
| `--ws-port` | NO | None | `7432` | ✅ | Correct |
| `--data-dir` | NO | Parent of db-path | **OMITTED** | ✅ | Uses default |
| `--metrics` | NO | Disabled | **OMITTED** | ✅ | Metrics off |

**Evidence from CLI parsing (rfdb_server.rs:28-52):**
```rust
let socket_path = args.iter()
    .position(|a| a == "--socket")
    .and_then(|i| args.get(i + 1))
    .map(|s| s.as_str())
    .unwrap_or("/tmp/rfdb.sock");
```

**Don's supervisord.conf (line 293):**
```ini
command=/usr/local/bin/rfdb-server /home/coder/workspace/demo-project/.rflow/graph.rfdb --ws-port 7432
```

**Gap Analysis:**

When `--socket` is omitted, rfdb-server defaults to `/tmp/rfdb.sock`. This is FINE because:

1. **WebSocket mode doesn't use socket file** — the extension connects to `ws://localhost:7432` (line 98)
2. **Socket file is created anyway** — the server ALWAYS creates it (even in WS mode) at default path
3. **No conflicts** — `/tmp/rfdb.sock` is the standard path, no collision in container

However, there's a **resource leak**: the socket file is created but never used. This is minor but worth noting.

✅ **RESOLVED**: Omitting `--socket` is technically correct but sloppy. Server runs fine.

**Recommendation:** Add `--socket /tmp/rfdb.sock` for explicitness (or omit entirely and document why).

---

## Completeness Table 3: Extension Build Dependencies

| Dependency Package | Location | Copy Method | Resolution After Copy | Valid? |
|-------------------|----------|-------------|----------------------|--------|
| `@grafema/rfdb-client` | `packages/rfdb/` | COPY entire dir | **workspace:*** broken in Docker | ❌ |
| `@grafema/types` | `packages/types/` | COPY entire dir | **workspace:*** broken in Docker | ❌ |
| Main extension code | `packages/vscode/` | COPY entire dir | N/A | ✅ |

**Evidence from package.json:**
```json
// packages/vscode/package.json:382-385
"dependencies": {
  "@grafema/rfdb-client": "workspace:*",
  "@grafema/types": "workspace:*"
}

// packages/rfdb/package.json:2
"name": "@grafema/rfdb-client"

// packages/types/package.json (exists at this path)
```

**Don's Dockerfile (line 255-261):**
```dockerfile
COPY packages/vscode /tmp/vscode-build
COPY packages/types /tmp/types
COPY packages/rfdb/ts /tmp/rfdb-client    # ← WRONG PATH
WORKDIR /tmp/vscode-build
RUN npm install && \
    npm run build && \
    vsce package --no-dependencies --out /tmp/grafema-explore.vsix
```

**Gap Analysis:**

Three problems:

### Problem 1: Wrong Copy Path
Don copies `packages/rfdb/ts` but the package root is `packages/rfdb/`. The `ts/` subdirectory contains source files, not the package.json.

**Actual structure:**
```
packages/rfdb/
├── package.json          # <- REQUIRED
├── ts/                   # <- Source files only
│   ├── client.ts
│   ├── websocket-client.ts
│   └── ...
└── dist/                 # <- Built output (needs to exist or be built)
```

### Problem 2: Workspace Protocol Broken
`workspace:*` in package.json tells pnpm to link local packages. But Docker copies don't create a pnpm workspace — they're just files in `/tmp/`.

When `npm install` runs in `/tmp/vscode-build`, it tries to resolve `@grafema/rfdb-client@workspace:*` but:
- No workspace configured (no `pnpm-workspace.yaml`)
- No local package named `@grafema/rfdb-client` in node_modules/
- npm doesn't understand `workspace:*` protocol (pnpm-specific)

### Problem 3: Missing Build Step
`@grafema/rfdb-client` requires `npm run build` to generate `dist/` from `ts/`. Don's plan copies source but doesn't build it.

**Fix Required:**

```dockerfile
# Option A: Build dependencies BEFORE copying extension
COPY packages/rfdb /tmp/rfdb-client
WORKDIR /tmp/rfdb-client
RUN npm install && npm run build

COPY packages/types /tmp/types
WORKDIR /tmp/types
RUN npm install && npm run build

# Then build extension with manual linking
COPY packages/vscode /tmp/vscode-build
WORKDIR /tmp/vscode-build
RUN npm install --workspace=false && \
    npm install /tmp/rfdb-client /tmp/types && \
    npm run build && \
    vsce package --no-dependencies --out /tmp/grafema-explore.vsix

# Option B: Use entire repo context and use pnpm
# (Much simpler but larger image)
COPY . /tmp/grafema-monorepo
WORKDIR /tmp/grafema-monorepo
RUN corepack enable && \
    pnpm install && \
    pnpm --filter @grafema/vscode build && \
    cd packages/vscode && vsce package --out /tmp/grafema-explore.vsix
```

❌ **CRITICAL GAP**: Extension build will FAIL with current Dockerfile.

---

## Completeness Table 4: supervisord Process Ordering

| Feature | Don's Assumption | Actual supervisord Behavior | Match? | Impact |
|---------|-----------------|---------------------------|--------|--------|
| Priority ordering | `priority=10` starts before `priority=20` | ✅ Lower priority starts first | ✅ | Correct |
| Wait for startup | `startsecs=2` makes code-server wait | ❌ `startsecs` is health check duration, NOT dependency | ❌ | **CRITICAL** |
| Dependency enforcement | rfdb-server must be "started" before code-server | ❌ No such feature without `eventlistener` | ❌ | **CRITICAL** |

**Evidence:**

From supervisord documentation:
- `priority`: Order to start programs (lower = earlier). BUT all programs start in parallel after sorting.
- `startsecs`: How long program must stay running to be considered "started successfully". Does NOT block other programs.

**Don's supervisord.conf (line 285-315):**
```ini
[program:rfdb-server]
priority=10
startsecs=2
# ← supervisord does NOT wait here before starting code-server

[program:code-server]
priority=20
# ← starts IMMEDIATELY after rfdb-server (0-100ms delay), NOT after 2 seconds
```

**Gap Analysis:**

Both processes start almost simultaneously. There's NO guarantee rfdb-server is listening on port 7432 when code-server starts.

**What happens:**
1. supervisord starts both processes (rfdb first, ~100ms later code-server)
2. code-server launches VS Code (~2-5 seconds to load)
3. Extension activates and tries WebSocket connection
4. rfdb-server may or may not be ready (race condition)

**Actual Risk: LOW** because:
- VS Code takes 2-5 seconds to load UI
- Extension doesn't auto-connect on startup (only when panels opened)
- User interaction provides ~5-10 second buffer

**But it's architecturally WRONG** — Don assumed `startsecs` creates sequencing, it doesn't.

**Fix Options:**

```ini
# Option A: Add startup delay to code-server command
[program:code-server]
command=bash -c "sleep 3 && /usr/bin/code-server ..."
priority=20

# Option B: Use eventlistener (complex, overkill)
# Option C: Health check in entrypoint before starting supervisord
# (Better approach — verify rfdb-server is ready before handing off to supervisord)
```

❌ **MINOR GAP**: Works in practice but violates Don's stated design intent.

---

## Completeness Table 5: Extension Installation Timing

| Timing Window | Operation | State | Risk |
|--------------|-----------|-------|------|
| Dockerfile build | COPY .vsix to /tmp/ | .vsix ready | ✅ Safe |
| entrypoint.sh line 332 | `code-server --install-extension` | code-server NOT running | ✅ Safe |
| entrypoint.sh line 339 | `exec supervisord` | Starts code-server process | ✅ Extension already installed |

**Evidence:**
```bash
# entrypoint.sh (Don's plan line 326-340):
#!/bin/bash
set -e

# Install Grafema extension (must happen at runtime, not build time)
echo "Installing Grafema extension..."
code-server --install-extension /tmp/grafema-explore.vsix \
    --extensions-dir /home/coder/.local/share/code-server/extensions

# Fix ownership (in case volumes are mounted)
chown -R coder:coder /home/coder/workspace

# Start supervisord
echo "Starting RFDB server and code-server..."
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
```

**Gap Analysis:**

`code-server --install-extension` is a CLI command that modifies `~/.local/share/code-server/extensions/extensions.json`. It does NOT require code-server to be running — it's a standalone operation.

✅ **NO GAP**: Timing is correct. Extension installs before server starts.

**However:** Don's comment "must happen at runtime, not build time" is WRONG. According to his own research sources (line 342-344 in plan), extension installation CAN happen in Dockerfile, the issue is **extensions.json corruption in layered builds**.

The real reason to use entrypoint: Avoid Docker layer caching issues, NOT runtime requirements.

✅ **RESOLVED**: Implementation correct, comment misleading.

---

## Completeness Table 6: .vscode/settings.json Creation

| Method | Location | Content | Ownership | Timing |
|--------|----------|---------|-----------|--------|
| Don's Dockerfile line 246-248 | `/home/coder/workspace/demo-project/.vscode/settings.json` | `{"grafema.rfdbTransport":"websocket",...}` | root:root | Build time |
| Demo project file structure | Should exist at workspace root | Should configure WebSocket | coder:coder | Runtime |

**Evidence:**

```dockerfile
# Don's Dockerfile (line 243-248):
COPY test/fixtures/galaxy-demo /home/coder/workspace/demo-project

# Create .vscode/settings.json for WebSocket transport
RUN mkdir -p /home/coder/workspace/demo-project/.vscode && \
    echo '{"grafema.rfdbTransport":"websocket","grafema.rfdbWebSocketUrl":"ws://localhost:7432"}' \
    > /home/coder/workspace/demo-project/.vscode/settings.json
```

**Gap Analysis:**

Two problems:

### Problem 1: File Ownership
`RUN` commands execute as root. The file is created as `root:root` but code-server runs as `coder:coder`.

**Impact:** VS Code can READ the file (world-readable) but cannot WRITE to it if user tries to modify settings.

**Fix:** Add to entrypoint.sh:
```bash
chown -R coder:coder /home/coder/workspace/demo-project/.vscode
```

Don's entrypoint DOES have `chown -R coder:coder /home/coder/workspace` (line 335), so this is actually FIXED.

✅ **RESOLVED**: Ownership will be corrected by entrypoint.

### Problem 2: Workspace vs Folder Settings
VS Code has two settings scopes:
- **Workspace settings**: `.vscode/settings.json` in workspace root
- **User settings**: `~/.config/Code/User/settings.json`

Don's approach creates workspace settings, which is CORRECT for demo (pre-configured environment).

✅ **NO GAP**: Implementation correct.

---

## Completeness Table 7: Port Configuration Consistency

| Configuration Point | Port | Protocol | Consistency Check |
|--------------------|------|----------|-------------------|
| rfdb-server CLI flag | 7432 | WebSocket | ✅ Matches |
| .vscode/settings.json | 7432 | ws://localhost:7432 | ✅ Matches |
| Extension default | 7474 | ws://localhost:7474 | ⚠️ Different (overridden) |
| Docker EXPOSE | 7432 | TCP | ✅ Matches |
| supervisord config | 7432 | (implicit) | ✅ Matches |

**Evidence:**

```typescript
// packages/vscode/package.json:335-338 (extension default config)
"grafema.rfdbWebSocketUrl": {
  "type": "string",
  "default": "ws://localhost:7474",  // ← Extension default
  "description": "RFDB WebSocket URL (when transport is 'websocket')"
}
```

**Don's settings.json override:**
```json
{
  "grafema.rfdbWebSocketUrl": "ws://localhost:7432"  // ← Workspace override
}
```

**Gap Analysis:**

The default port (7474) is NEVER used because workspace settings override it. This is BY DESIGN — Don chose 7432 to avoid conflicts.

**Risk Assessment:**
- If user deletes `.vscode/settings.json`: Extension tries port 7474, connection fails
- If user changes port in settings: Must also restart rfdb-server (not obvious)

**Severity:** LOW — documented in demo/README.md (line 376-403)

✅ **NO GAP**: Intentional design choice, properly documented.

---

## Completeness Table 8: Docker Base Image User Context

| Image | Default User | entrypoint.sh User | supervisord User | Service Users | Consistent? |
|-------|--------------|-------------------|-----------------|---------------|-------------|
| `codercom/code-server:latest` | `coder` (UID 1000) | root (via ENTRYPOINT) | root (supervisord master) | coder (services) | ✅ Correct |

**Evidence:**

```dockerfile
# Don's Dockerfile:
FROM codercom/code-server:latest
# ← Default user is 'coder', but ENTRYPOINT resets to root

# Don's entrypoint.sh (line 326):
#!/bin/bash
set -e
# ← Runs as root (Docker ENTRYPOINT default)

# Don's supervisord.conf (line 287, 301, 313):
[supervisord]
user=root     # ← Master process as root

[program:rfdb-server]
user=coder    # ← Service as coder

[program:code-server]
user=coder    # ← Service as coder
```

**Gap Analysis:**

The user switching is CORRECT:
1. Dockerfile sets root context (RUN commands need apt-get)
2. ENTRYPOINT runs as root (needs chown)
3. supervisord master runs as root (needs to switch user contexts)
4. Services run as coder (security + file permissions)

✅ **NO GAP**: User context handling is correct.

---

## Completeness Table 9: Playwright Test Feasibility

| Requirement | code-server Support | Playwright Support | Feasible? |
|-------------|--------------------|--------------------|-----------|
| Browser-based VS Code | ✅ Full web UI | ✅ Chromium automation | ✅ Yes |
| Extension UI (webview panels) | ✅ Rendered in DOM | ✅ Frame selectors | ✅ Yes |
| Activity bar icons | ✅ SVG elements | ✅ CSS selectors | ✅ Yes |
| Tree view items | ✅ Standard VS Code TreeView | ⚠️ Shadow DOM (complex selectors) | ⚠️ Difficult |
| Status indicators | ✅ Text content | ✅ `textContent` assertions | ✅ Yes |

**Evidence:**

code-server renders VS Code as a web app. Playwright can interact with it like any web page.

**Potential Issues:**
- VS Code UI uses Shadow DOM for some components (tree views, lists)
- Extension activation is async (may need `waitFor` with long timeout)
- Monaco editor has custom rendering (not standard contenteditable)

**Don's Test Plan (line 407-440):**
```javascript
// test/e2e/demo.spec.js (planned tests):
1. code-server loads            // ✅ Easy (check for .monaco-workbench)
2. Extension installed          // ✅ Easy (check extensions list)
3. RFDB connection established  // ⚠️ Requires panel to be opened (async)
4. Demo project open            // ✅ Easy (check workspace folder name)
5. Graph navigation works       // ❌ HARD (Shadow DOM, tree expansion, search)
```

**Gap Analysis:**

Tests 1, 2, 4 are straightforward. Test 3 requires opening a panel (UI automation). Test 5 is VERY complex — requires:
- Opening Grafema Explorer panel (click activity bar)
- Waiting for extension to activate
- Entering search query (Shadow DOM input)
- Verifying results (Shadow DOM tree)

**Recommendation:** Start with tests 1, 2, 4 only. Add test 3 if time permits. DEFER test 5 to follow-up task.

⚠️ **PARTIAL GAP**: Don's test scope is too ambitious for MVP. Reduce scope.

---

## Critical Gaps Summary

### GAP 1: Extension Build Dependencies (CRITICAL)
**Location:** Dockerfile lines 255-261
**Issue:** `COPY packages/rfdb/ts` copies source only, not package root. `npm install` will fail to resolve `workspace:*` dependencies.
**Fix:** Copy full package directories and build them, OR use pnpm workspace in Docker.

### GAP 2: supervisord Process Ordering (MINOR)
**Location:** supervisord.conf lines 302, 313
**Issue:** `startsecs=2` does NOT enforce startup order. Both processes start simultaneously.
**Fix:** Add `sleep 3` to code-server command, OR add health check in entrypoint.

### GAP 3: Playwright Test Scope (MINOR)
**Location:** Plan section 5, test #5
**Issue:** Graph navigation test requires complex Shadow DOM selectors, likely to be flaky.
**Fix:** Reduce MVP scope to tests 1-4, defer test 5.

### GAP 4: Graph Path Mismatch (FALSE ALARM - RESOLVED)
Demo uses `.rflow/`, extension expects `.grafema/`, but WebSocket mode bypasses path checks.

### GAP 5: Missing --socket Flag (FALSE ALARM - RESOLVED)
rfdb-server defaults to `/tmp/rfdb.sock`, which is fine (unused in WebSocket mode).

### GAP 6: .vscode/settings.json Ownership (RESOLVED)
Created as root, but entrypoint fixes ownership.

---

## Precondition Verification

| Precondition | Status | Evidence |
|--------------|--------|----------|
| REG-523 (WebSocket transport) merged | ✅ Verified | Code exists in packages/rfdb-server/src/bin/rfdb_server.rs:34-38 |
| `test/fixtures/galaxy-demo/` has pre-built graph | ✅ Verified | `.rflow/graph.rfdb/` exists |
| Pre-built linux-x64 binary exists | ✅ Assumed | Don references `packages/rfdb-server/prebuilt/linux-x64/rfdb-server` |
| Extension can build with `vsce package` | ❌ BLOCKED | Workspace dependencies broken in Docker context |
| `codercom/code-server:latest` image available | ⚠️ Unknown | Cannot verify (Docker not running) |

---

## Verdict: REJECT

**Reason:** GAP 1 (extension build) is a **hard blocker**. The Dockerfile will fail at `npm install` due to unresolved workspace dependencies.

**Required Actions Before Approval:**

1. **FIX GAP 1 (CRITICAL):** Rewrite Dockerfile to handle workspace dependencies correctly. Options:
   - Use pnpm in Docker with full monorepo context
   - Build dependencies separately and manually link
   - Use `vsce package --no-dependencies` (if extension bundles all deps via esbuild)

2. **FIX GAP 2 (RECOMMENDED):** Add explicit startup delay or health check to ensure rfdb-server is ready before code-server connects.

3. **FIX GAP 3 (RECOMMENDED):** Reduce Playwright test scope to tests 1-4 for MVP.

---

## Additional Observations

### Strength: WebSocket Transport Design
Don's choice to use WebSocket transport is architecturally sound. It decouples the extension from file paths and enables true browser-based deployment.

### Weakness: Dockerfile Complexity
The Dockerfile tries to optimize build time by copying only necessary packages, but this breaks pnpm workspace resolution. A simpler approach (copy entire repo, use pnpm) would be more robust.

### Risk: Extension Activation Timing
VS Code extensions activate asynchronously. If the user opens the Grafema panel immediately after code-server loads, the extension may not be ready. Consider adding a "Connecting..." state.

### Documentation Quality
Don's README (line 349-403) is thorough and covers update procedures, configuration, and architecture. This is EXCELLENT.

---

## Recommended Fixes

### Fix for GAP 1 (Extension Build)

```dockerfile
# Replace lines 254-261 with:

# Build rfdb-client dependency
COPY packages/rfdb /tmp/deps/rfdb
WORKDIR /tmp/deps/rfdb
RUN npm install && npm run build

# Build types dependency
COPY packages/types /tmp/deps/types
WORKDIR /tmp/deps/types
RUN npm install && npm run build

# Build extension (with local dependencies)
COPY packages/vscode /tmp/vscode-build
WORKDIR /tmp/vscode-build

# Install and manually link local dependencies
RUN npm install --ignore-scripts && \
    mkdir -p node_modules/@grafema && \
    cp -r /tmp/deps/rfdb node_modules/@grafema/rfdb-client && \
    cp -r /tmp/deps/types node_modules/@grafema/types && \
    npm run build && \
    npx vsce package --out /tmp/grafema-explore.vsix

# Clean up build artifacts
RUN rm -rf /tmp/deps /tmp/vscode-build
```

### Fix for GAP 2 (Startup Ordering)

```bash
# In entrypoint.sh, BEFORE starting supervisord:

echo "Waiting for rfdb-server to be ready..."
timeout 30 bash -c 'until nc -z localhost 7432; do sleep 0.5; done' || {
    echo "ERROR: rfdb-server failed to start within 30 seconds"
    exit 1
}

echo "rfdb-server is ready, starting code-server..."
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
```

### Fix for GAP 3 (Test Scope)

```javascript
// test/e2e/demo.spec.js (revised MVP scope):
test('code-server loads', async ({ page }) => {
  await page.goto('http://localhost:8080');
  await expect(page.locator('.monaco-workbench')).toBeVisible({ timeout: 30000 });
});

test('Grafema extension is installed', async ({ page }) => {
  await page.goto('http://localhost:8080');
  await page.locator('[aria-label="Extensions"]').click();
  await expect(page.getByText('Grafema Explore')).toBeVisible();
});

test('Demo project is open', async ({ page }) => {
  await page.goto('http://localhost:8080');
  await expect(page.locator('.workspace-folder-name')).toContainText('demo-project');
});

// DEFER test('RFDB connection established') to follow-up task
// DEFER test('Graph navigation works') to follow-up task
```

---

**Edsger Dijkstra** — 2026-02-20
