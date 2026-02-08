# Don Melton Plan: REG-67 Release Workflow

**Date:** 2026-02-06

## 1. Research Findings (Key Insights)

### Industry Approaches for pnpm Monorepos

The dominant tools for monorepo release automation are:

1. **[Changesets](https://github.com/changesets/changesets)** — Popular with Vercel, focuses on explicit versioning via `.changeset/*.md` files. Generates changelogs automatically from commit-like messages.

2. **[semantic-release-monorepo](https://github.com/pmowrer/semantic-release-monorepo)** — Fully automated versioning based on conventional commits. Assigns commits to packages by which files changed.

3. **[multi-semantic-release](https://www.npmjs.com/package/multi-semantic-release)** — Similar to above, establishes versions atomically across all packages first.

4. **Manual scripting** — Simple shell scripts with `pnpm -r exec npm version`. Used by smaller projects or those with unique constraints.

**Key insight:** Most tools assume GitHub Actions CI/CD. Changesets shines with PRs and team collaboration; semantic-release shines with conventional commits.

### Sources
- [Complete Monorepo Guide: pnpm + Workspace + Changesets (2025)](https://jsdev.space/complete-monorepo-guide/)
- [Changesets for Versioning | Vercel Academy](https://vercel.com/academy/production-monorepos/changesets-versioning)
- [How a Monorepo, pnpm, and Changesets Transformed My Multi-Package Workflow](https://medium.com/@anandkumar.code/how-a-monorepo-pnpm-and-changesets-transformed-my-multi-package-workflow-7c1771bba898)

---

## 2. Current State Analysis

### Versioning Status

| Package | Current Version | Notes |
|---------|-----------------|-------|
| root | 0.2.1-beta | Private, not published |
| @grafema/types | 0.2.1-beta | Base package |
| @grafema/core | 0.2.3-beta | Depends on types |
| @grafema/cli | 0.2.3-beta | Depends on core, types |
| @grafema/mcp | 0.2.1-beta | Depends on core |
| @grafema/api | 0.1.0-beta | Depends on core |
| @grafema/rfdb-client | 0.2.1-beta | Depends on types |

**Observation:** Versions are NOT in sync. Some packages at 0.2.3-beta, some at 0.2.1-beta, one at 0.1.0-beta. This is a symptom of ad-hoc versioning.

### Existing Infrastructure

1. **`scripts/publish.sh`** — Simple script that:
   - Takes version as argument
   - Updates all packages with `pnpm -r exec npm version`
   - Builds all packages
   - Publishes with `pnpm -r publish`
   - Reminds to commit, tag, and push

2. **`/release` skill (`grafema-release`)** — Detailed manual procedure:
   - Pre-release checklist (tests, uncommitted changes, branch)
   - Binary download for @grafema/rfdb
   - Step-by-step version bump, changelog, build, publish
   - Package dependency order (types -> core -> cli -> mcp)
   - Common issues documentation

3. **CHANGELOG.md** — Well-structured, follows Keep a Changelog format:
   - Grouped by version with dates
   - Categories: Highlights, Features, Bug Fixes, Infrastructure, Known Issues
   - References Linear tickets (REG-XXX)

4. **Git Tags** — Only 3 tags exist: `v0.1.1-alpha`, `v0.2.0-beta`, `rfdb-v0.2.4-test`

5. **Branches** — No `stable` branch. Current workflow uses `task/REG-XXX` branches from `main`.

### What's Missing

1. **No `stable` branch** — main can be broken at any time
2. **No automated checks** — release relies on human discipline
3. **Version drift** — packages out of sync
4. **No dist-tag management** — beta/latest confusion
5. **No pre-release validation** — no automated test gate

---

## 3. High-Level Plan

### Philosophy: Simple Over Clever

Grafema is an AI-first tool with a solo developer. The release process should be:
- **Manual-first** — AI (Claude) will execute it via `/release` skill
- **Script-assisted** — Avoid complex tooling, use simple scripts
- **Well-documented** — The skill document IS the automation

**Why NOT Changesets?**
- Adds `.changeset/` directory management
- Designed for team collaboration (PR-based)
- Overkill for current project scale
- Would need to learn and debug another tool

**Why NOT semantic-release?**
- Requires conventional commits (not currently enforced)
- Fully automated = less control
- Harder to debug when things go wrong
- Black box behavior

**Why Manual + Scripts + Skill?**
- Already 80% done (`/release` skill exists)
- AI agent (Claude) executes the process
- Full visibility and control
- Easy to modify as needs evolve

### Proposed Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│                         RELEASE WORKFLOW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  main ────●────●────●────●────●────●────●───→                   │
│              \                       ↓                           │
│               \                  (release trigger)               │
│                \                     ↓                           │
│                 \         ┌─────────────────────┐                │
│                  \        │ 1. Run tests        │                │
│                   \       │ 2. Bump versions    │                │
│                    \      │ 3. Update changelog │                │
│                     \     │ 4. Build            │                │
│                      \    │ 5. Publish npm      │                │
│                       \   │ 6. Commit + tag     │                │
│                        \  └─────────────────────┘                │
│                         \            ↓                           │
│  stable ─────────────────────────────●───→                       │
│                                  merge + tag                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Key Decisions and Justification

### Decision 1: Create `stable` Branch

**Action:** Create `stable` from current main, update only on releases.

**Rationale:**
- Hooks and dogfooding need reliable version
- `stable` always points to last known-good release
- Simple to understand: `main` = development, `stable` = production

### Decision 2: Unified Package Versions

**Action:** All @grafema/* packages share the SAME version number.

**Rationale:**
- Simpler mental model
- No version drift between packages
- Easier to communicate ("use 0.2.4")
- Internal dependencies always consistent
- Industry precedent: Babel, Angular, Rush all do this

**Trade-off:** Version bump even for unchanged packages. Acceptable for current scale.

### Decision 3: Version Format

**Format:** `X.Y.Z` for stable, `X.Y.Z-beta.N` for pre-release

**Examples:**
- `0.2.0` — stable release
- `0.2.1-beta.1` — first beta after 0.2.0
- `0.2.1-beta.2` — second beta
- `0.2.1` — stable release

**Rationale:**
- Standard semver with pre-release suffix
- npm dist-tags handle `latest` vs `beta`
- Clear progression visible in version numbers

### Decision 4: Enhance Existing `/release` Skill (Not Replace)

**Action:** Extend `grafema-release` skill with:
1. Pre-flight checks (tests must pass)
2. Version sync verification
3. `stable` branch merge step
4. Explicit dist-tag management

**Rationale:**
- Skill already exists and is comprehensive
- AI (Claude) executes it — skill IS the automation
- Incremental improvement over big-bang replacement

### Decision 5: Single `scripts/release.sh` Script

**Action:** Create unified release script that:
1. Validates prerequisites (tests, clean git)
2. Accepts version type (patch/minor/major/prerelease)
3. Updates all package.json files
4. Builds all packages
5. Prompts for changelog update
6. Creates commit and tag
7. Optionally publishes to npm
8. Merges to stable

**Rationale:**
- Single entry point for releases
- Scriptable by AI or human
- Replaces fragmented publish.sh
- Enforces correct order of operations

### Decision 6: Document in RELEASING.md

**Action:** Create `RELEASING.md` with:
1. Version strategy explanation
2. Release checklist
3. Script usage
4. Rollback procedures
5. npm dist-tag management

**Rationale:**
- CONTRIBUTING.md is for contributors
- RELEASING.md is for maintainers (currently just AI + user)
- Separates concerns

---

## 5. Phase 1: Local Release Infrastructure

### Deliverables

1. **Create `stable` branch** from current main
2. **Update `scripts/release.sh`** — unified release script with validation
3. **Sync all package versions** to 0.2.4-beta (or next version)
4. **Update `grafema-release` skill** — add stable branch step, version sync check
5. **Create `RELEASING.md`** — document the full process
6. **Update CLAUDE.md** — reference new release workflow

---

## 6. Phase 2: CI/CD Release Validation

### Why CI/CD is Critical NOW (Not Later)

User feedback (Vadim):
> "CI/CD serves as Claude's checklist — it catches what Claude might forget due to context limits."

Key concerns:
1. All tests pass (none skipped)
2. Changelogs/READMEs/docs are in sync
3. All required binaries are built and uploaded
4. Nothing important is forgotten

**Claude's context is limited.** CI/CD is NOT automation for humans — it's a **safety net for AI agents** executing releases.

### Research Findings

Based on web search for GitHub Actions best practices:

**For pnpm monorepos:**
- Use `pnpm/action-setup@v3` with pnpm version 9
- Use `actions/setup-node@v4` with Node.js 22
- Authentication via `NODE_AUTH_TOKEN` secret

**For Rust cross-platform binaries:**
- Build matrix with target triples per platform
- Use `houseabsolute/actions-rust-cross@v0` for cross-compilation
- Use `softprops/action-gh-release@v2` for uploading artifacts

**For changelog validation:**
- `mikepenz/release-changelog-builder-action` for changelog checks
- Simple grep-based validation for version entries

### Sources
- [Building a cross platform Rust CI/CD pipeline with GitHub Actions](https://ahmedjama.com/blog/2025/12/cross-platform-rust-pipeline-github-actions/)
- [How to Deploy Rust Binaries with GitHub Actions](https://dzfrias.dev/blog/deploy-rust-cross-platform-github-actions/)
- [Automatically publish your Node package to NPM with pnpm and GitHub Actions](https://dev.to/receter/automatically-publish-your-node-package-to-npm-with-pnpm-and-github-actions-22eg)
- [GitHub Actions in 2026: The Complete Guide to Monorepo CI/CD](https://dev.to/pockit_tools/github-actions-in-2026-the-complete-guide-to-monorepo-cicd-and-self-hosted-runners-1jop)
- [Changelog Validator GitHub Action](https://github.com/marketplace/actions/changelog-validator)

### Existing Infrastructure Analysis

**Already exists:**
- `.github/workflows/build-binaries.yml` — Rust binary builds for 4 platforms (darwin-x64, darwin-arm64, linux-x64, linux-arm64)
- `.github/workflows/vscode-release.yml` — VS Code extension packaging

**Missing:**
- Pre-release validation workflow (tests, docs sync)
- npm publish workflow
- Post-publish verification

### CI/CD Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    RELEASE VALIDATION PIPELINE                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────┐     ┌──────────────────┐     ┌─────────────────┐  │
│  │  TRIGGER:        │     │  PRE-RELEASE     │     │  POST-RELEASE   │  │
│  │  push tag v*     │────▶│  VALIDATION      │────▶│  VERIFICATION   │  │
│  └──────────────────┘     └──────────────────┘     └─────────────────┘  │
│                                    │                        │            │
│                           ┌────────┴────────┐               │            │
│                           ▼                 ▼               ▼            │
│                    ┌────────────┐    ┌────────────┐  ┌────────────┐     │
│                    │ Unit Tests │    │ Doc Sync   │  │ npm verify │     │
│                    │ (no skip)  │    │ Check      │  │ install    │     │
│                    ├────────────┤    ├────────────┤  └────────────┘     │
│                    │ Typecheck  │    │ Changelog  │                      │
│                    ├────────────┤    │ Has Entry  │                      │
│                    │ Lint       │    ├────────────┤                      │
│                    ├────────────┤    │ Version    │                      │
│                    │ Build All  │    │ Sync Check │                      │
│                    └────────────┘    └────────────┘                      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Workflow 1: `release-validate.yml` (Pre-Release Checks)

**Trigger:** `push tag v*` OR manual dispatch

**Jobs:**

#### Job 1: `test` — All Tests Pass (None Skipped)
```yaml
- Run: npm test
- Assert: Exit code 0
- Assert: No ".skip" or ".only" in test files (grep check)
```

**What Claude might forget:** Running the full test suite, or leaving `.only()` from debugging.

#### Job 2: `typecheck-lint` — Static Analysis
```yaml
- Run: pnpm typecheck
- Run: pnpm lint
```

**What Claude might forget:** Type errors in files not touched by the change.

#### Job 3: `build` — All Packages Build
```yaml
- Run: pnpm -r build
- Assert: All packages in dist/
```

**What Claude might forget:** Build errors in dependent packages.

#### Job 4: `version-sync` — Unified Package Versions
```yaml
- Script: Check all package.json versions match
- Assert: All @grafema/* packages have same version
```

**What Claude might forget:** Updating all packages, not just the ones changed.

#### Job 5: `changelog-check` — CHANGELOG.md Has Entry
```yaml
- Script: grep -q "## \[${VERSION}\]" CHANGELOG.md
- Assert: Version entry exists with date
```

**What Claude might forget:** Updating CHANGELOG after code changes.

#### Job 6: `docs-sync` — READMEs Not Stale
```yaml
- Script: Check key documentation files modified recently OR have no TODOs
- Warning only (not blocking)
```

**What Claude might forget:** Updating package READMEs when API changes.

#### Job 7: `binary-check` (for @grafema/rfdb releases)
```yaml
- Condition: If rfdb-v* tag also exists for this version
- Assert: All 4 platform binaries present in prebuilt/
- Assert: Binary architecture matches expected (via file command)
```

**What Claude might forget:** Downloading binaries before publishing @grafema/rfdb.

### Workflow 2: `release-publish.yml` (npm Publish)

**Trigger:** Manual dispatch after validation passes

**Jobs:**

#### Job 1: `publish` — Publish to npm
```yaml
- Auth: NPM_TOKEN secret
- Run: pnpm -r publish --access public --tag beta --no-git-checks
- Order: types → core → cli → mcp → rfdb-client → rfdb
```

#### Job 2: `verify` — Post-Publish Verification
```yaml
- Wait: 60 seconds (npm registry propagation)
- Run: npx @grafema/cli@${VERSION} --version
- Assert: Version matches expected
```

**What Claude might forget:** Verifying the published package actually works.

### Workflow 3: `release-binaries.yml` (Already Exists)

**Location:** `.github/workflows/build-binaries.yml`
**Trigger:** `push tag rfdb-v*`
**Status:** Already implemented, builds all 4 platforms

### Deliverables for Phase 2

1. **`.github/workflows/release-validate.yml`**
   - Pre-release validation checks
   - Triggered by v* tag push
   - Blocks release if any check fails

2. **`.github/workflows/release-publish.yml`**
   - npm publish automation
   - Manual trigger only (after validation passes)
   - Post-publish verification

3. **Update `scripts/release.sh`**
   - Add: `--ci` flag to run local validation before tagging
   - Add: Link to GitHub Actions status page

4. **Update `grafema-release` skill**
   - Add: CI/CD status check step
   - Add: "Wait for green CI" instruction

### What Each Check Catches

| Check | Claude Context Limitation Mitigated |
|-------|-------------------------------------|
| Tests pass | Forgot to run tests after last change |
| No .skip/.only | Left debugging code in tests |
| Typecheck | Type errors in untouched files |
| Build | Broken imports after refactoring |
| Version sync | Only bumped some packages |
| Changelog entry | Forgot to document the release |
| Binary check | Forgot to download rfdb binaries |
| Post-publish verify | Published broken package |

### Implementation Notes

**Why manual publish trigger?**
- User reviews CI results before publish
- No automatic npm publish on tag (too risky)
- Gives opportunity to fix issues before publishing

**Why not use Changesets CI?**
- Changesets automates PR-based workflow
- We don't need PR automation (solo dev + AI)
- Our validation is simpler and more targeted

---

## 7. Scope Boundaries

**In Scope (Phase 1):**
- Branch strategy (stable)
- Version sync mechanism
- Release script
- Documentation

**In Scope (Phase 2):**
- GitHub Actions pre-release validation
- GitHub Actions post-publish verification
- CI status integration in release skill

**Out of Scope (v0.5+):**
- Conventional commits enforcement
- Automated changelog generation from commits
- Automated version bumping

### Risk Assessment

| Risk | Mitigation |
|------|------------|
| Version sync gets out of sync again | Script enforces + CI validates |
| stable branch diverges | Only updated via release script |
| npm publish fails mid-release | Script has atomic stages, can retry |
| User confusion about branches | Clear documentation |
| CI passes but release still broken | Post-publish verification step |
| Claude forgets step | CI/CD catches the gap |

---

## 8. Alignment with Project Vision

**"AI should query the graph, not read code"** — This release workflow is designed for AI execution:

1. `/release` skill provides clear instructions
2. Script has predictable behavior
3. Documentation explains WHY, not just HOW
4. No hidden state or complex tooling to debug
5. **CI/CD serves as Claude's memory** — catches what context limits might miss

**Dogfooding principle satisfied:**
- stable branch ensures Grafema can analyze Grafema
- Even if main is broken, stable provides working version for hooks

**AI-first design:**
- CI/CD is not automation for humans — it's a **safety net for AI agents**
- Each check corresponds to a specific Claude context limitation
- Manual publish trigger keeps human in the loop

---

## 9. Implementation Order

**Phase 1** (local infrastructure):
1. Create `stable` branch
2. Create `scripts/release.sh` with local validation
3. Sync package versions
4. Update `/release` skill
5. Create RELEASING.md

**Phase 2** (CI/CD):
1. Create `.github/workflows/release-validate.yml`
2. Create `.github/workflows/release-publish.yml`
3. Update release script to check CI status
4. Update `/release` skill with CI integration

**Recommendation:** Proceed with Joel Spolsky for detailed technical specification covering both phases.
