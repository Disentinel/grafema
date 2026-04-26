# REG-524: Steve Jobs Review — Docker Demo Environment

**Reviewer:** Steve Jobs (Vision)
**Date:** 2026-02-20
**Status:** REJECT

---

## Verdict: REJECT

This implementation has the right architecture but makes a critical product decision that embarrasses us.

---

## Vision Alignment: PASS

The core vision is correct:

**"AI should query the graph, not read code"** — A browser-based demo removes installation friction and lets users experience Grafema instantly. This is the right move for early access.

The technical approach is sound:
- Multi-stage Docker build (clean separation)
- WebSocket transport (enables browser deployment)
- Self-analysis (dogfooding our own product)
- Pre-built graph (instant gratification)

No complaints about vision alignment. This is exactly what we need.

---

## Architecture Assessment: PASS

The implementation is architecturally correct:

**Multi-stage build** — Builder stage compiles everything with pnpm workspace resolution, runtime stage is lean. This is the standard pattern. Clean.

**Startup sequence** — rfdb-server health check before code-server starts. Explicit ordering, fail-fast on errors. This is how it should be done.

**Process management** — supervisord manages code-server, rfdb-server in background with health check. Simple, correct, debuggable.

**Dependencies** — Universal .vsix build works for code-server. Binary copied from prebuilt. No unnecessary rebuilds.

**Documentation** — README covers quick start, architecture table, configuration, troubleshooting. Clear and complete.

The Dockerfile is well-structured. The entrypoint script is correct. The test plan is reasonable for MVP scope.

---

## Critical Product Issue: DEMO PROJECT CHOICE

### The Problem

The implementation uses **Grafema source code** as the demo project.

From `demo/Dockerfile`:
```dockerfile
# Run self-analysis: grafema analyze on the Grafema source itself
# This creates .grafema/graph.rfdb with the full code graph
RUN node packages/cli/dist/cli.js analyze --root /build --clear

# Prepare a clean source tree for the demo workspace (no node_modules, dist)
RUN mkdir -p /demo-source && \
    cp package.json pnpm-workspace.yaml tsconfig.json /demo-source/ && \
    cp -r .grafema /demo-source/.grafema && \
    for pkg in packages/*/; do \
        mkdir -p "/demo-source/$pkg"; \
        cp "$pkg/package.json" "/demo-source/$pkg" 2>/dev/null || true; \
        [ -d "$pkg/src" ] && cp -r "$pkg/src" "/demo-source/$pkg/src"; \
    done
```

### Why This Is Wrong

**The demo project IS the product we're trying to sell.**

When a user opens the demo, they see:
- `packages/core/` — Grafema internals
- `packages/cli/` — Grafema CLI code
- `packages/mcp/` — Grafema MCP server
- `packages/vscode/` — Grafema VS Code extension

**This is circular and confusing.**

The user is supposed to understand how Grafema helps THEM analyze THEIR code. Instead, they're looking at:
- How Grafema analyzes Grafema
- Code they don't care about (our implementation details)
- A meta-example that requires them to understand what Grafema IS before they can evaluate it

### What Don Planned vs What Got Built

Don's original plan (002-don-plan.md):
```markdown
### Demo Project: galaxy-demo

**Decision:** Use `test/fixtures/galaxy-demo/` as demo project.

**Rationale:**
- Already has pre-built graph (`.rflow/graph.rfdb/`)
- Small enough for Docker image (724KB)
- Shows real Grafema features (multi-service, auth, notifications, payments)
- No sensitive data (test fixture)
```

Don's revised plan (004-don-plan-revision.md):
```markdown
# Prepare a clean source tree for the demo workspace (no node_modules, dist)
RUN mkdir -p /demo-source && \
    cp package.json pnpm-workspace.yaml tsconfig.json /demo-source/ && \
    cp -r .grafema /demo-source/.grafema && \
    ...
```

**Nowhere in the revision does it say "use Grafema source instead of galaxy-demo".**

This looks like Rob made an implementation decision without discussing it. Or Don changed the plan in the revision and didn't call out the change explicitly.

Either way: **Wrong call.**

### The Right Demo Project

The demo should show a REAL-WORLD use case, not our own codebase.

**galaxy-demo was the correct choice:**
- Multi-service architecture (auth, notifications, payments)
- Real business logic users can relate to
- Shows cross-service dependencies
- Demonstrates value immediately

A user opening the demo should think:
> "Oh, this is like MY codebase. I can see how this would help ME find dependencies in MY services."

NOT:
> "This is the Grafema source code. I guess... this is how they use their own tool? Is this relevant to me?"

### Why Self-Analysis Is Not a Demo

Self-analysis is GREAT for:
- Internal dogfooding (we do this in CI)
- Testing at scale (real monorepo complexity)
- Finding bugs in our own code

Self-analysis is TERRIBLE for:
- First-time user experience
- Sales/marketing demos
- Explaining value proposition

**Rule:** Never demo the tool with the tool's own source code unless your audience is developers building similar tools.

---

## Test Quality: ACCEPTABLE

The Playwright tests cover the basics:
1. code-server loads
2. Extension is installed
3. Demo project is open

Scope is appropriate for MVP. Tests are simple and fast.

The deferred tests (RFDB connection, graph navigation) are reasonable to defer. Shadow DOM tests are brittle.

No complaints about test quality for MVP scope.

---

## CI Configuration: ACCEPTABLE

`.github/workflows/demo-test.yml` is correct:
- Builds Docker image
- Starts container
- Waits for code-server readiness
- Runs Playwright tests
- Uploads artifacts on failure

Trigger conditions are appropriate (main branch, PRs touching demo/vscode).

15-minute timeout is generous but acceptable for CI.

---

## Documentation: GOOD

`demo/README.md` is clear and complete:
- Quick start (3 commands)
- Architecture table
- Configuration examples
- Update procedures
- Troubleshooting

No complaints.

---

## `.dockerignore`: GOOD

Excludes build artifacts, git history, task notes, AI prompts. Correct.

---

## What Needs to Change

### REQUIRED FIX: Use galaxy-demo

1. Change `demo/Dockerfile` builder stage:
   ```dockerfile
   # Analyze the demo project (galaxy-demo), not Grafema source
   COPY test/fixtures/galaxy-demo /demo-project
   RUN node packages/cli/dist/cli.js analyze --root /demo-project --clear
   ```

2. Change runtime stage to copy galaxy-demo:
   ```dockerfile
   # Copy demo project with pre-built graph
   COPY --from=builder /demo-project /home/coder/workspace/demo-project
   ```

3. Update paths in entrypoint.sh and supervisord.conf:
   - `/home/coder/workspace/demo-project/.grafema/graph.rfdb` (not `/home/coder/workspace/grafema`)
   - Workspace path: `/home/coder/workspace/demo-project`

### Test Fix (Related)

The test file references `demo-project` (correct) but the implementation uses `grafema/` (wrong). Fix the implementation to match the test expectations.

---

## Summary

| Area | Assessment | Issue |
|------|-----------|-------|
| **Vision** | ✅ PASS | Correct strategic direction |
| **Architecture** | ✅ PASS | Clean multi-stage build, proper ordering |
| **Demo Project** | ❌ **FAIL** | **Using Grafema source instead of galaxy-demo** |
| **Tests** | ✅ PASS | Appropriate scope for MVP |
| **CI** | ✅ PASS | Correct workflow |
| **Documentation** | ✅ PASS | Clear and complete |

---

## Final Verdict: REJECT

The architecture is solid. The code is clean. The documentation is good.

**But we're shipping a demo that shows our own source code instead of a relatable use case.**

This is a product decision, not a technical one. The fix is simple (use galaxy-demo), but this should have been caught in planning.

**Fix the demo project choice and re-submit for review.**

---

**Steve Jobs** — 2026-02-20
