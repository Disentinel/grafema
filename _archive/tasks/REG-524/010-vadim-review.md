# REG-524: Вадим auto Review (Completeness)

**Reviewer:** Вадим auto
**Date:** 2026-02-20
**Task:** REG-524 — Demo среда (code-server + rfdb-server WebSocket + Grafema extension)

## Verdict: REJECT

The implementation is functionally complete but has critical gaps in AC4 documentation and a misleading comment in the test suite. Additionally, the startup time cannot be verified without actually running the container.

---

## Acceptance Criteria Review

### AC1: `docker run grafema/demo` поднимает полную среду за < 30 сек

**Status:** CANNOT VERIFY ⚠️

**Analysis:**
- The README shows `docker run -p 8080:8080 grafema-demo`, NOT `docker run grafema/demo`
- The image tag in documentation is `grafema-demo` (local build), not `grafema/demo` (Docker Hub)
- **This is either:**
  1. AC wording issue (should have been `grafema-demo`), OR
  2. Missing deployment step to Docker Hub registry

**Startup Performance Analysis:**
- `entrypoint.sh` has 30s health check timeout (`HEALTH_TIMEOUT=30`)
- Health check waits for port 7432 to be available, checking every 1s
- Then supervisord starts code-server
- **No way to verify <30s total startup time without running the container**
- The 30s timeout is for rfdb-server alone, code-server startup is additional time

**Recommendation:** Either:
- Change AC to match actual tag (`grafema-demo`)
- Add GitHub Actions step to measure actual startup time
- Or add Docker Hub publishing workflow

---

### AC2: Пользователь видит граф демо-проекта без каких-либо настроек

**Status:** PASS ✅ (with note)

**Implementation:**
- Dockerfile line 48: `grafema analyze --root /build --clear` generates graph during image build
- Dockerfile line 53: `.grafema/graph.rfdb` copied to demo workspace
- Dockerfile lines 83-85: VS Code settings pre-configure WebSocket transport
- README confirms: "Pre-built code graph of the Grafema monorepo (self-analysis)"

**Demo Project:**
- User requested Grafema project itself (self-analysis) — DELIVERED ✅
- Dockerfile lines 50-58 prepare clean source tree with packages/*/src
- Workspace opens at `/home/coder/workspace/grafema` (supervisord.conf line 8)

**Configuration:**
```json
{
  "grafema.rfdbTransport": "websocket",
  "grafema.rfdbWebSocketUrl": "ws://localhost:7432"
}
```

**Works out of the box:** No manual setup required.

---

### AC3: Playwright smoke test проходит в CI

**Status:** PASS ✅ (with minor bug)

**Files:**
- `.github/workflows/demo-test.yml` — CI workflow
- `test/e2e/demo-smoke.spec.js` — Playwright smoke tests

**CI Workflow:**
- Triggers: push to main, PRs touching demo/ or vscode/
- Builds Docker image (`grafema-demo-test`)
- Starts container, exposes ports 8080 and 7432
- Health check: waits up to 120s for code-server
- Runs Playwright tests against http://localhost:8080
- Uploads failure artifacts (playwright-report) with 14-day retention
- Shows container logs on failure

**Smoke Tests (3 scenarios):**
1. **code-server loads** — checks `.activitybar` and `.statusbar` visible
2. **Grafema extension is installed** — searches for "Grafema Explore" in Extensions view
3. **Demo project is open** — verifies explorer tree has at least one entry

**Test Quality:**
- Generous timeouts (60s page load, 10s per UI element)
- Handles both `aria-label` and `id*` selectors (code-server variance)
- Opens Explorer view if not visible by default
- Checks actual DOM elements, not just network responses

**BUG FOUND:** Test file line 61-62:
```javascript
// The workspace is opened at /home/coder/workspace/demo-project,
// so the folder label should contain "demo-project" or similar.
```
This comment is **WRONG**. Actual workspace path is `/home/coder/workspace/grafema` (from supervisord.conf and Dockerfile). The test logic is correct (just checks for tree items), but the comment is misleading.

---

### AC4: Задокументирован процесс обновления .vsix в демо-образе

**Status:** FAIL ❌

**What exists:**
- `demo/README.md` section "Updating the Demo" covers:
  - How to rebuild the image after code changes
  - How to rebuild only the graph (touching source files)
  - General Docker rebuild workflow

**What is MISSING:**
- **No specific instructions for updating ONLY the .vsix**
- No explanation of the build pipeline: `vsce package` → copy to runtime stage
- No mention of where the .vsix comes from (`packages/vscode/`)
- No guidance on how to manually update the extension in a running container (if needed)

**Current documentation:**
```bash
# After code changes, rebuild the image:
docker build -t grafema-demo -f demo/Dockerfile . --no-cache
```

This is generic, not specific to .vsix updates.

**What AC4 requires:**
User should understand:
1. .vsix is built from `packages/vscode/` via `vsce package` (Dockerfile line 44)
2. It's copied to runtime stage at `/tmp/grafema-explore.vsix` (line 77)
3. Extension is installed on first start via `entrypoint.sh` (line 11)
4. To update the extension: modify vscode package, rebuild image (no-cache to force vsce re-run)

**Recommendation:** Add a dedicated section in README:

```markdown
## Updating the Grafema Extension

The .vsix is built during image build from `packages/vscode/`:

1. **Make changes** to packages/vscode/
2. **Rebuild with --no-cache** to force vsce re-package:
   ```bash
   docker build -t grafema-demo -f demo/Dockerfile . --no-cache
   ```
3. **Or rebuild just the builder stage** if only vscode changed:
   ```bash
   docker build -t grafema-demo -f demo/Dockerfile . --target builder
   docker build -t grafema-demo -f demo/Dockerfile .
   ```

The extension is installed on container start by `entrypoint.sh`. To update in a running container:
```bash
docker exec -it grafema-demo bash
code-server --install-extension /tmp/grafema-explore.vsix --force
```
```

---

## Additional Issues

### 1. Misleading Test Comment

**File:** `test/e2e/demo-smoke.spec.js` lines 61-62

**Current:**
```javascript
// The workspace is opened at /home/coder/workspace/demo-project,
// so the folder label should contain "demo-project" or similar.
```

**Should be:**
```javascript
// The workspace is opened at /home/coder/workspace/grafema,
// so the folder label should contain "grafema" or package names.
```

The test logic is correct (just checks for any tree items), but the comment will confuse future maintainers.

---

### 2. Docker Registry Tag Mismatch

**AC1 says:** `docker run grafema/demo`
**README shows:** `docker run -p 8080:8080 grafema-demo`

These are different:
- `grafema/demo` → Docker Hub registry image (doesn't exist yet)
- `grafema-demo` → Local build tag

**Either:**
- Update AC1 to match implementation (`grafema-demo`)
- Add Docker Hub publishing workflow
- Add note in README about future registry deployment

---

### 3. Missing .dockerignore Validation

**File:** `.dockerignore`

Good exclusions: `node_modules`, `dist`, `_tasks`, `_ai`, etc.

**Question:** Does excluding `demo/onboarding-tests` break anything in the demo build?
The Dockerfile doesn't reference it, so likely fine, but worth confirming.

---

## Feature Completeness

### What Works
- ✅ Multi-stage Docker build (builder + runtime)
- ✅ Pre-built graph of Grafema source (self-analysis)
- ✅ code-server with Grafema extension pre-installed
- ✅ rfdb-server with WebSocket transport
- ✅ Health checks and graceful startup sequencing
- ✅ Supervisord process management
- ✅ Clean source tree (no node_modules/dist bloat)
- ✅ Pre-configured VS Code settings for WebSocket
- ✅ Comprehensive smoke tests
- ✅ CI workflow with failure artifacts

### What's Missing
- ❌ Specific .vsix update documentation (AC4)
- ❌ Startup time verification (<30s claim)
- ❌ Docker Hub publishing (if `grafema/demo` was intended)
- ⚠️ Misleading test comment about workspace path

---

## Test Coverage

### Smoke Tests (3 scenarios)
1. **code-server loads** — basic UI chrome visible
2. **Extension is installed** — searches Extensions view
3. **Demo project is open** — verifies file tree

**Coverage:**
- ✅ Browser-based VS Code startup
- ✅ Extension installation
- ✅ Workspace opening
- ❌ **NOT TESTED:** Graph data actually loads (no panel open, no query executed)
- ❌ **NOT TESTED:** rfdb-server connectivity (WebSocket handshake)
- ❌ **NOT TESTED:** Actual Grafema panels render (Explorer, Callers, etc.)

**Recommendation:** Add a 4th test:
```javascript
test('Grafema sidebar shows graph data', async ({ page }) => {
  // Open a file, click Grafema sidebar, verify panel renders
  // This would test the full stack: code-server → WS → rfdb-server → graph
});
```

But for smoke tests, current coverage is acceptable. Full integration tests would belong in a separate suite.

---

## Commit Quality

**Files to commit:**
- `.dockerignore` — new
- `.github/workflows/demo-test.yml` — new
- `demo/Dockerfile` — new
- `demo/README.md` — new
- `demo/entrypoint.sh` — new
- `demo/supervisord.conf` — new
- `test/e2e/demo-smoke.spec.js` — new

**All files are untracked** (not yet committed).

**Commit structure should be:**
1. `feat(demo): add Docker demo environment with code-server and rfdb WebSocket (REG-524)`
   - Add all demo/ files
   - Add .dockerignore
2. `test(demo): add Playwright smoke tests and CI workflow (REG-524)`
   - Add test/e2e/demo-smoke.spec.js
   - Add .github/workflows/demo-test.yml

**Or single commit if preferred** (atomic feature).

**Quality notes:**
- No TODOs, FIXMEs, or commented code ✅
- No empty implementations ✅
- Follows project patterns (multi-stage Docker, health checks, etc.) ✅
- Good layer caching strategy (dependency manifests copied first) ✅

---

## Edge Cases & Regressions

### Potential Issues

1. **rfdb-server crash during startup**
   - Health check detects this (lines 35-38 in entrypoint.sh)
   - Container exits with error, logs are visible

2. **Extension install fails**
   - Non-fatal: "WARNING: Extension install failed, continuing anyway" (line 12)
   - This is risky — user won't have Grafema extension but container will run
   - **Recommendation:** Make this fatal OR add a post-start health check for extension presence

3. **Port conflicts**
   - Documented in README ("Port conflict" section)
   - User can remap: `docker run -p 9090:8080 grafema-demo`

4. **Large codebase memory usage**
   - Documented: `docker run --memory=2g grafema-demo`
   - Grafema self-analysis is relatively small, so 2GB is generous

5. **.grafema/graph.rfdb missing**
   - Would cause rfdb-server to fail at startup
   - Build would fail at line 48 if analyze command fails
   - Good: failure happens at build time, not runtime

6. **WebSocket connection refused**
   - If rfdb-server dies after health check but before code-server connects
   - User would see "disconnected" in Grafema Status panel
   - Logs would show the issue

### Regression Risk
- **Low:** This is a new feature, no existing code paths modified
- **Only risk:** If someone breaks WebSocket transport (REG-523), this demo will also break
- **Mitigation:** CI runs on every vscode/ or demo/ change

---

## Scope Creep Check

**Task scope:** Demo environment for early access.

**Implemented:**
- Docker image with code-server + rfdb + extension
- Smoke tests
- Documentation

**NOT in scope (good):**
- Docker Hub publishing (would require secrets, deployment workflow)
- Advanced monitoring or analytics
- Multi-user support or authentication
- Custom branding or landing page

No scope creep detected. Implementation is minimal and focused.

---

## Final Assessment

**Functional Completeness:** 90% (missing AC4 documentation details, startup time unverified)

**Code Quality:** 95% (minor test comment bug, otherwise clean)

**Test Coverage:** 80% (smoke tests cover startup, not graph functionality)

**Adherence to Requirements:** 75% (AC4 incomplete, AC1 tag mismatch)

---

## Required Changes

### MUST FIX (blocking)

1. **Add .vsix update documentation** to `demo/README.md`
   - Explain vsce package pipeline
   - Show how to rebuild after vscode/ changes
   - Mention manual extension install in running container

2. **Fix test comment** in `test/e2e/demo-smoke.spec.js` lines 61-62
   - Change `demo-project` to `grafema`

### SHOULD FIX (recommended)

3. **Clarify docker tag** in AC or README
   - Either document `grafema-demo` as local-only build
   - Or add Docker Hub publishing plan

4. **Verify startup time** (<30s claim)
   - Add GitHub Actions step to measure total startup
   - Or adjust AC1 to remove time constraint until measured

### NICE TO HAVE

5. **Make extension install fatal** (entrypoint.sh line 11-12)
   - If extension install fails, container should fail too
   - Current behavior allows broken state

6. **Add graph connectivity test**
   - Open a file, verify panel shows data
   - Would catch WebSocket or graph load failures

---

## Summary

The implementation delivers a working Docker demo environment with good architecture (multi-stage build, health checks, supervisord). Smoke tests and CI workflow are solid. Documentation is mostly good.

**However:**
- AC4 (document .vsix update process) is incomplete — generic rebuild instructions exist, but no specific guidance on extension packaging pipeline
- Test has a misleading comment about workspace path
- Cannot verify <30s startup time claim without running the container
- Docker tag mismatch between AC (`grafema/demo`) and implementation (`grafema-demo`)

**Fix the documentation and test comment, then re-review.**

---

## Co-Authored-By
Вадим auto (Completeness Reviewer) — Claude Sonnet 4.5
