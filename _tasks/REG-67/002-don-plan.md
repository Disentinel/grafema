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

## 5. Implementation Summary

### Deliverables

1. **Create `stable` branch** from current main
2. **Update `scripts/release.sh`** — unified release script with validation
3. **Sync all package versions** to 0.2.4-beta (or next version)
4. **Update `grafema-release` skill** — add stable branch step, version sync check
5. **Create `RELEASING.md`** — document the full process
6. **Update CLAUDE.md** — reference new release workflow

### Scope Boundaries

**In Scope:**
- Branch strategy (stable)
- Version sync mechanism
- Release script
- Documentation

**Out of Scope:**
- CI/CD automation (future enhancement)
- Conventional commits enforcement
- Automated changelog generation
- GitHub Actions release workflow

### Risk Assessment

| Risk | Mitigation |
|------|------------|
| Version sync gets out of sync again | Script enforces unified versions |
| stable branch diverges | Only updated via release script |
| npm publish fails mid-release | Script has atomic stages, can retry |
| User confusion about branches | Clear documentation |

---

## 6. Alignment with Project Vision

**"AI should query the graph, not read code"** — This release workflow is designed for AI execution:

1. `/release` skill provides clear instructions
2. Script has predictable behavior
3. Documentation explains WHY, not just HOW
4. No hidden state or complex tooling to debug

**Dogfooding principle satisfied:**
- stable branch ensures Grafema can analyze Grafema
- Even if main is broken, stable provides working version for hooks

---

**Recommendation:** Proceed with Joel Spolsky for detailed technical specification.
