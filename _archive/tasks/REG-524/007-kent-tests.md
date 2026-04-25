# REG-524: Kent Beck Test Report

**Author:** Kent Beck (Test Engineer)
**Date:** 2026-02-20
**Scope:** Playwright smoke tests + CI workflow for demo environment

---

## Deliverables

### 1. `test/e2e/demo-smoke.spec.js`

Three MVP smoke tests verifying the demo environment starts correctly:

| # | Test | What It Verifies | Key Selectors |
|---|------|-----------------|---------------|
| 1 | **code-server loads** | Monaco workbench renders, activity bar and status bar visible | `.monaco-workbench`, `.activitybar`, `.statusbar` |
| 2 | **Grafema extension is installed** | Extension appears in Extensions sidebar search results | `.extensions-viewlet input`, `getByText('Grafema Explore')` |
| 3 | **Demo project is open** | Explorer sidebar has files visible (workspace was opened correctly) | `.explorer-folders-view`, `.monaco-list-row` |

**Design decisions:**

- **60-second page load timeout:** code-server takes 10-30 seconds on first load in a fresh container. 60 seconds provides margin without making tests unreasonably slow.
- **`beforeEach` navigates and waits for workbench:** Each test is independent. If one fails, the others still provide diagnostic value.
- **`DEMO_URL` env var with fallback:** Tests default to `http://localhost:8080` for local development but CI can override via environment variable.
- **Fallback selectors for activity bar:** code-server's activity bar labels can vary between versions. Tests try `[aria-label="Extensions"]` first, then fall back to `[id*="extensions"]`.
- **No authentication:** Demo runs with `--auth none`, so no login flow is needed.

**What was intentionally excluded (per plan revision, GAP 3):**

- RFDB connection test (requires extension activation, async race conditions)
- Graph navigation test (Shadow DOM selectors, fragile and expensive to maintain)

Both are deferred to a follow-up task.

### 2. `.github/workflows/demo-test.yml`

CI workflow that builds and tests the demo container.

| Property | Value |
|----------|-------|
| **Triggers** | Push to `main` + PRs touching `demo/**`, `packages/vscode/**`, test file, or workflow file |
| **Timeout** | 15 minutes |
| **Runner** | `ubuntu-latest` |
| **Node version** | 22 |

**Pipeline steps:**

1. Checkout code
2. Build Docker image from `demo/Dockerfile`
3. Start container (ports 8080, 7432)
4. Wait for code-server readiness (curl poll, 120s timeout)
5. Install Playwright + Chromium
6. Run smoke tests
7. Upload HTML report on failure
8. Show container logs on failure
9. Cleanup (stop + remove container)

**Design decisions:**

- **Path filtering:** Workflow only runs when demo-related files change. Does not trigger on unrelated changes to `packages/core/`, `packages/cli/`, etc.
- **Readiness check before tests:** `curl -sf` polling loop ensures code-server is actually serving before Playwright connects. Without this, tests would fail with connection refused.
- **Container logs on failure:** If tests fail, `docker logs grafema-demo` dumps stdout/stderr from both entrypoint and supervisord, enabling fast root-cause analysis.
- **No docker-compose:** Per the revised plan, tests use `docker run` directly. Simpler, fewer moving parts.
- **Playwright installed fresh in CI:** Not added to project `package.json` since these are isolated demo tests, not part of the main test suite.

---

## Patterns Followed

From existing `test/e2e/gui.spec.js`:

- Import `{ test, expect }` from `@playwright/test`
- `test.describe` block for grouping
- `test.beforeEach` for shared page setup
- Explicit timeouts on `toBeVisible()` assertions
- Selector-based element location (not text-matching for structure, text-matching for content)

From existing `.github/workflows/ci.yml`:

- `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`
- `timeout-minutes` on job level
- `if: failure()` for diagnostic artifact upload
- `if: always()` for cleanup

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| code-server UI selectors change between versions | Selectors target stable CSS classes (`.monaco-workbench`, `.activitybar`), not version-specific markup |
| Extension search box not found | Fallback selector strategy; test will produce clear error message |
| Container takes too long to start in CI | 120-second readiness poll + 60-second Playwright timeout = 180 seconds total budget |
| Docker build fails in CI | Build step runs before any test setup; failure is fast and obvious |

---

## Test Execution (Local)

```bash
# 1. Build and start the demo container
docker build -t grafema-demo-test -f demo/Dockerfile .
docker run -d --name grafema-demo -p 8080:8080 -p 7432:7432 grafema-demo-test

# 2. Wait for it to be ready
timeout 120 bash -c 'until curl -sf http://localhost:8080 > /dev/null; do sleep 2; done'

# 3. Run tests
npx playwright test test/e2e/demo-smoke.spec.js

# 4. Cleanup
docker stop grafema-demo && docker rm grafema-demo
```

---

**Kent Beck** -- 2026-02-20
