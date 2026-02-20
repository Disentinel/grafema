# PREPARE Phase Review — REG-524

**Reviewer:** Robert Martin (Uncle Bob)
**Date:** 2026-02-20
**Task:** Docker-based demo environment for Grafema

## Executive Summary

**No refactoring needed.** Proceed with implementation.

This task creates new files in `demo/` and `test/e2e/`. No existing production code is modified. The repository has minimal existing infrastructure to build upon, and what exists is well-structured.

## Infrastructure Audit

### 1. Docker Infrastructure: NONE

**Findings:**
- No Dockerfile or docker-compose files exist in the repository
- Clean slate for Docker implementation

**Recommendation:** Proceed with new Docker infrastructure as planned.

### 2. Demo Directory: MINIMAL

**Current state:**
```
demo/
└── onboarding-tests/
    └── tooljet/
        └── 2026-02-07_19-46-23/
            └── [report.md]
```

**Analysis:**
- Existing `demo/onboarding-tests/` contains manual onboarding reports
- Different purpose than automated Docker demo
- No conflicts with REG-524 goals

**Recommendation:** Create `demo/docker-demo/` as a sibling directory. Keep existing onboarding-tests intact.

### 3. E2E Test Infrastructure: PLAYWRIGHT READY

**Current state:**
- `test/e2e/gui.spec.js` exists with comprehensive Playwright tests
- Tests target GUI at `http://localhost:3000`
- Uses `@playwright/test` framework
- Covers: page load, analysis, filtering, node interaction, zoom/pan

**Analysis:**
- Solid test patterns to follow
- No Playwright config file found (likely uses defaults)
- Tests assume GUI server running on port 3000

**Recommendation:**
- Follow existing test patterns in `test/e2e/gui.spec.js`
- Create `playwright.config.js` at root for Docker-specific test configuration
- Keep GUI tests as reference; create new `test/e2e/docker-demo.spec.js` for CLI/extension verification

### 4. VSCode Extension Build: PRODUCTION READY

**Current state:**
```
packages/vscode/
├── package.json (v0.2.0, platform-specific packaging)
├── esbuild.config.mjs (builds src/extension.ts → dist/extension.js)
├── scripts/install-local.sh (full build + package + install workflow)
└── .vscodeignore (defines package contents)
```

**GitHub workflow:** `.github/workflows/vscode-release.yml`
- Downloads platform-specific rfdb-server binaries
- Runs `pnpm build` in vscode package
- Uses `vsce package --target <platform>` for .vsix creation

**Analysis:**
- VSCode extension build process is mature and well-documented
- No refactoring needed — build works in CI
- Docker will need to mirror the CI approach: `pnpm install → pnpm build → vsce package`

**Recommendation:**
```dockerfile
# In Dockerfile, for vscode .vsix build:
WORKDIR /workspace/packages/vscode
RUN pnpm install
RUN pnpm run build
RUN npx @vscode/vsce package --no-dependencies
```

This matches the CI workflow without platform-specific binary bundling (Docker demo runs local rfdb-server via CLI).

### 5. CI Infrastructure: COMPREHENSIVE

**Relevant workflows:**
- `.github/workflows/ci.yml` — Tests, typecheck, build, version sync (Node 22, pnpm)
- `.github/workflows/vscode-release.yml` — VSCode extension packaging

**Analysis:**
- Node 22 is standard
- pnpm workspace architecture
- Tests require `pnpm build` before running (dist/ artifacts)

**Recommendation:** Docker should use Node 22 LTS, install pnpm 9.15.0 (from package.json), follow same build order.

## Clean Code Violations: NONE

Reviewed relevant files for code smells:
- No TODOs or FIXMEs in infrastructure
- No commented-out code
- Build scripts are clean and purposeful
- Test patterns are consistent

## Action Items

**ZERO refactoring required.** Implementation can proceed immediately with:

1. Create `demo/docker-demo/` directory structure
2. Create root `Dockerfile` based on CI patterns (Node 22, pnpm 9.15.0)
3. Create `test/e2e/docker-demo.spec.js` following patterns from `gui.spec.js`
4. Add `playwright.config.js` at root if needed for custom config

## Risk Assessment

**LOW RISK.**

- No coupling to existing code
- No architectural debt to resolve
- Build infrastructure is stable
- Extension packaging is proven in CI

The only dependency is the VSCode extension build process, which is production-ready and tested in GitHub Actions. Docker implementation can safely mirror that approach.

---

**DECISION: PROCEED WITH IMPLEMENTATION (STEP 3)**
