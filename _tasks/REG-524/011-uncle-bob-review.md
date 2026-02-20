# REG-524: Uncle Bob Code Quality Review

**Reviewer:** Robert Martin (Uncle Bob)
**Date:** 2026-02-20
**Verdict:** APPROVE

## Summary

Clean, professional implementation. All files demonstrate attention to clarity, best practices, and maintainability. The Docker demo environment is production-ready.

## File Sizes

```
     98 lines   demo/Dockerfile                      (3.5K)
     47 lines   demo/entrypoint.sh                   (1.6K)
     14 lines   demo/supervisord.conf                (357B)
    101 lines   demo/README.md                       (2.8K)
     69 lines   test/e2e/demo-smoke.spec.js          (3.0K)
     92 lines   .github/workflows/demo-test.yml      (2.4K)
     20 lines   .dockerignore                        (242B)
```

All files are appropriately sized. No bloat, no unnecessary complexity.

## Code Quality Analysis

### demo/Dockerfile (98 lines)

**EXCELLENT**

Strengths:
- **Multi-stage build pattern** — clean separation of builder and runtime stages
- **Layer caching optimization** — dependencies copied first (lines 25-32) before full source
- **Clear comments** — every stage and non-obvious step is documented
- **Explicit versions** — `node:22-bookworm`, `pnpm@9.15.0`, no "latest" anti-patterns
- **Minimal runtime image** — builder artifacts discarded, only runtime needs transferred
- **Security-conscious** — runs code-server as `coder` user (line 9), not root
- **Self-documenting** — usage instructions in header comment

Best practices followed:
- `--frozen-lockfile` (line 35) — reproducible builds
- `--no-dependencies` for vsce (line 44) — VSIX is self-contained
- Clean source tree preparation (lines 51-58) — no build artifacts in demo workspace
- `--no-install-recommends` (line 69) — minimal apt footprint
- Proper ownership fix (line 93) — `chown -R coder:coder`

No issues found.

### demo/entrypoint.sh (47 lines)

**EXCELLENT**

Strengths:
- **Proper bash safety** — `set -euo pipefail` (line 2)
- **Named constants** — all paths/ports at top, no magic numbers
- **Health check pattern** — waits for port AND checks process liveness (lines 29-41)
- **Error handling** — extension install allowed to fail with warning (lines 11-13)
- **Process monitoring** — `kill -0 $RFDB_PID` to detect early crash (lines 35-38)
- **Timeout protection** — 30s limit with clear error message (lines 30-32)
- **exec for proper signal handling** — `exec /usr/bin/supervisord` (line 47)

The health check is particularly well-designed:
```bash
while ! nc -z localhost "$WS_PORT" 2>/dev/null; do
    if [ "$elapsed" -ge "$HEALTH_TIMEOUT" ]; then
        echo "[grafema-demo] ERROR: rfdb-server did not start within ${HEALTH_TIMEOUT}s"
        exit 1
    fi
    if ! kill -0 "$RFDB_PID" 2>/dev/null; then
        echo "[grafema-demo] ERROR: rfdb-server process died unexpectedly"
        exit 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
done
```

This catches both "never started" and "crashed during startup" scenarios.

All paths are properly quoted. Variables use `"$VAR"` consistently. No word-splitting hazards.

No issues found.

### demo/supervisord.conf (14 lines)

**CLEAN**

Minimal, correct supervisord configuration:
- `nodaemon=true` — required for containerized use
- `autorestart=true` — resilience against code-server crashes
- Logs to stdout/stderr with `maxbytes=0` — container-friendly logging
- Runs code-server as `coder` user — proper privilege separation

No issues found.

### demo/README.md (101 lines)

**EXCELLENT DOCUMENTATION**

Structure:
1. Quick start (3 commands, no fluff)
2. What you get (components + architecture table)
3. Configuration examples (port mapping, detached mode, resource limits)
4. Troubleshooting (common failure modes with solutions)

Strengths:
- **Immediate value** — first code block gets user to working demo
- **Architecture table** — clear component responsibilities
- **Concrete examples** — not "you can configure ports" but `docker run -p 3000:8080`
- **Troubleshooting section** — addresses real failure modes (extension not showing, build fails, port conflicts)
- **Dogfooding note** — "The demo project is Grafema itself (self-analysis / dogfooding)" — establishes credibility

Writing quality:
- Active voice throughout
- No jargon where plain language works
- Commands are copy-pasteable
- No marketing fluff

No issues found.

### test/e2e/demo-smoke.spec.js (69 lines)

**GOOD**

Strengths:
- **Clear test names** — `code-server loads`, `Grafema extension is installed`, `Demo project is open`
- **Generous timeouts** — 60s for initial load (line 6), accounts for cold starts
- **Fallback selectors** — tries both `aria-label` and `id*` patterns (lines 24-26, 50-52)
- **Resilient assertions** — uses `toBeVisible` with timeouts, not brittle DOM queries
- **Shared setup** — `beforeEach` navigates and waits for workbench (lines 9-14)

Observations:

**Minor: Comment-code mismatch at line 61**
```javascript
// The workspace is opened at /home/coder/workspace/demo-project,
// so the folder label should contain "demo-project" or similar.
```

The comment says "demo-project" but the actual workspace path (from Dockerfile line 80) is `/home/coder/workspace/grafema/`. The test passes because it only checks for "at least one file/folder entry" (lines 65-67), not the folder name.

This doesn't break anything, but the comment is misleading.

**Recommendation:** Update comment to match actual path:
```javascript
// The workspace is opened at /home/coder/workspace/grafema,
// so the folder tree should show Grafema source files.
```

**Test coverage is appropriate** — smoke tests verify:
1. Code-server renders
2. Extension is installed
3. Project files are accessible

This is the right scope for smoke tests. Not integration tests, not exhaustive UI tests.

### .github/workflows/demo-test.yml (92 lines)

**EXCELLENT CI CONFIGURATION**

Strengths:
- **Selective triggers** — only runs when demo/ or vscode/ changes (lines 11-23)
- **Generous timeout** — 15 minutes (line 29), accounts for Docker build time
- **Health check before tests** — waits for code-server with 120s timeout (lines 46-59)
- **Error diagnostics** — uploads Playwright report on failure (lines 76-82)
- **Container logs on failure** — `docker logs grafema-demo` (lines 84-86)
- **Cleanup in `always()` block** — no container leaks (lines 88-92)

The health check pattern is solid:
```bash
timeout 120 bash -c '
  until curl -sf http://localhost:8080 > /dev/null 2>&1; do
    sleep 2
    echo "  still waiting..."
  done
' || {
  echo "::error::code-server did not become ready within 120 seconds"
  docker logs grafema-demo
  exit 1
}
```

This fails fast with diagnostics if code-server doesn't start.

**Port exposure (line 43)** — container exposes both 8080 and 7432. Tests only use 8080. The 7432 exposure is harmless but unused. This is fine — explicit is better than implicit.

No issues found.

### .dockerignore (20 lines)

**COMPLETE**

Excludes:
- Build artifacts (`node_modules`, `dist`, `*.tsbuildinfo`)
- Development files (`.git`, `_tasks`, `_ai`, `.claude`)
- Secrets (`.env`, `.npmrc.local`)
- Platform cruft (`.DS_Store`)

Good addition: `demo/onboarding-tests` (line 20) — prevents recursive Docker-in-Docker scenarios.

No issues found.

## Patterns & Architecture

### Naming Clarity

All names are self-documenting:
- `HEALTH_TIMEOUT` not `MAX_WAIT`
- `demo-smoke.spec.js` not `test.js`
- `PAGE_LOAD_TIMEOUT` not `BIG_TIMEOUT`

### Error Handling

Defensive at boundaries:
- Extension install can fail (entrypoint.sh line 12)
- rfdb-server startup is health-checked (entrypoint.sh lines 27-41)
- CI waits for code-server before tests (workflow lines 46-59)

No silent failures. All error paths print diagnostics and exit non-zero.

### Shell Script Quality

`entrypoint.sh` demonstrates professional bash:
- `set -euo pipefail` at top
- All variables quoted
- Arithmetic with `$((expr))` not `expr` or `let`
- Process management with `kill -0` health checks
- `exec` for final command to become PID 1

This is textbook Docker entrypoint scripting.

### Dockerfile Layer Caching

The Dockerfile is optimized for iteration speed:
1. Copy dependency manifests first (lines 25-32)
2. Install dependencies (line 35)
3. Copy full source (line 38)
4. Build (line 41)

This means code changes only re-run from line 38 onwards. Dependency install is cached.

### Test Philosophy

The e2e tests verify "does the demo boot and show the basics" — not "does every Grafema feature work in the demo."

This is correct scoping. Smoke tests are not integration tests.

## Issues Found

1. **Minor documentation mismatch** in `test/e2e/demo-smoke.spec.js` line 61 — comment says `demo-project` but actual path is `grafema`. Does not affect functionality.

## Verdict: APPROVE

This is clean, production-ready code. The implementation demonstrates:
- Deep understanding of Docker best practices
- Defensive programming with proper error handling
- Clear documentation for users and maintainers
- Appropriate test coverage

The only issue is a comment that doesn't match reality. This is trivial and doesn't warrant rejection.

**Recommendation:** Ship as-is. The comment fix can happen in a future cleanup if desired.

---

**Robert Martin (Uncle Bob)**
Code Quality Reviewer
