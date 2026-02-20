# REG-524: Re-Verification Report — Don's Plan Revision

**Verifier:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-20
**Status:** APPROVED ✅

---

## Executive Summary

All three gaps have been properly addressed with architecturally sound solutions. The revised plan is ready for implementation.

---

## Gap-by-Gap Verification

### GAP 1 (CRITICAL): Extension Build Dependencies — FIXED ✅

**Original problem:** `workspace:*` dependencies break in Docker when copying packages individually.

**Solution verification:**

✅ **Multi-stage build approach is correct:**
- Build stage: Full monorepo context with pnpm (workspace:* resolves)
- Runtime stage: Only final .vsix artifact (no workspace protocol needed)

✅ **Correct sequence in builder stage:**
```dockerfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @grafema/rfdb-client build
RUN pnpm --filter @grafema/types build
RUN pnpm build && vsce package
```

✅ **Artifact transfer is clean:**
```dockerfile
COPY --from=builder /tmp/grafema-explore.vsix /tmp/grafema-explore.vsix
```

**New issues:** None. This is the standard solution for monorepo extensions.

**Trade-off acknowledged:** Larger build context (entire monorepo). Don's justification is valid — CI builds happen once per release, final image stays small.

---

### GAP 2 (MINOR): supervisord Startup Ordering — FIXED ✅

**Original problem:** `priority` doesn't enforce readiness, only start order.

**Solution verification:**

✅ **Health check is explicit and robust:**
```bash
su coder -c "/usr/local/bin/rfdb-server ... &"
timeout 30 bash -c 'until nc -z localhost 7432; do sleep 0.5; done' || {
    echo "ERROR: rfdb-server failed to start within 30 seconds"
    exit 1
}
```

✅ **Proper error handling:**
- `timeout 30` prevents infinite wait
- Exit 1 on failure (container fails fast)
- `nc -z` checks WebSocket port 7432 (the actual readiness signal)

✅ **Simplified supervisord.conf:**
- Now manages only code-server (one process)
- rfdb-server runs in background, no supervisor overhead

**New issues:** None. The "no auto-restart for rfdb-server" trade-off is acceptable for demo use case.

**Architecture improvement:** Explicit dependency graph (entrypoint → rfdb-server ready → supervisord → code-server) is clearer than implicit priority ordering.

---

### GAP 3 (MINOR): Playwright Test Scope — FIXED ✅

**Original problem:** Test #5 (graph navigation) requires Shadow DOM, async activation, tree interaction — too brittle for MVP.

**Solution verification:**

✅ **Reduced scope is appropriate:**
- Test 1: code-server loads (`.monaco-workbench` visible)
- Test 2: Extension installed (Extensions view search)
- Test 3: Demo project open (`.explorer-folders-view` contains "demo-project")

✅ **MVP goal alignment:**
> "Verify demo environment STARTS correctly (image builds, services run, extension installs)"

This is the correct scope for a Docker image smoke test.

✅ **Deferred work is documented:**
- Test #4 (RFDB connection) — requires panel interaction, async activation
- Test #5 (Graph navigation) — Shadow DOM, brittle selectors

**New issues:** None. The deferred tests belong in the extension's own test suite (webview integration tests), not in the Docker demo smoke tests.

**CI impact:** Tests run in ~15 seconds (fast feedback). This is a strength, not a weakness.

---

## New Issues Introduced by Revision

**None detected.**

The revision addresses all gaps without creating new architectural problems. The trade-offs are documented and justified.

---

## Implementation Risk Assessment

**Low risk:**
- Multi-stage Docker builds: Standard pattern, well-understood
- Health check with `nc`: Reliable, used in production by many projects
- Reduced Playwright scope: Less surface area for flakiness

**Potential pitfall for Rob:**
- **CRITICAL:** The builder stage copies `test/fixtures/galaxy-demo` but it's NOT used in the build — it's only needed in the runtime stage. This is wasteful but harmless. Consider removing from builder stage COPY to reduce build context size.

**Recommendation for Rob:** Check if `galaxy-demo` is actually needed during extension build. If not, remove it from line 59 of builder stage.

---

## Final Verdict

**APPROVED ✅**

Don's revision fixes all three gaps with architecturally sound solutions. The plan is ready for Uncle Bob (preparation) and Kent (test implementation).

**Next step:** Uncle Bob checks if `test/fixtures/galaxy-demo` needs cleanup before Docker image inclusion.

---

**Edsger Dijkstra** — 2026-02-20
