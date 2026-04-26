# Steve Jobs Review: REG-67 Release Workflow

**Date:** 2026-02-06

---

## VERDICT: APPROVE

---

## Summary for Vadim

This plan is **good**. Don and Joel have created a thoughtful, pragmatic approach to release management that aligns with Grafema's philosophy: **simple over clever, designed for AI execution**.

### What's Right

1. **Serves the actual goal.** The user needs:
   - Working Navi version for Claude Code hooks even when main is broken
   - Dogfooding capability
   - Predictability

   The `stable` branch directly addresses all three. When main breaks, stable still points to last known-good release.

2. **Correct rejection of over-engineering.** Don explicitly rejected Changesets and semantic-release. Good. Those tools are designed for teams, PRs, and CI/CD pipelines. Grafema is a solo developer with AI assistance. A well-documented script + skill IS the automation.

3. **Unified versioning is the right call.** All packages sharing one version eliminates the "which version of core works with which version of cli?" confusion. The trade-off (bumping unchanged packages) is acceptable at current scale.

4. **The script is robust.** Joel's `release.sh` includes:
   - Pre-flight checks (uncommitted changes, tests)
   - Dry-run mode for safety
   - Rollback on build failure
   - Automatic dist-tag selection
   - Stable branch merge

5. **Documentation-first approach.** RELEASING.md + updated skill = the process is documented where both humans and AI can use it.

---

## Concerns (Not Blocking)

### 1. Stable Branch Merging Strategy

The script merges via tag (`git merge v$NEW_VERSION`), not via branch. This is correct behavior -- it merges the specific release commit. However, the documentation should clarify:

- **stable never diverges** -- it's always a subset of main
- **No direct commits to stable** -- all changes go through main first

**Recommendation:** Add this to RELEASING.md explicitly. Not a blocker.

### 2. Mid-Publish Failure Recovery

If npm publish fails after some packages are published (e.g., 3 of 7 succeed), the recovery is manual. The rollback plan exists but requires human judgment.

**Reality check:** This is acceptable. Atomic cross-package npm publish is impossible. The plan acknowledges this and provides recovery procedures. Better than pretending it won't happen.

### 3. No CI/CD Integration

The plan explicitly defers CI/CD automation. This is fine for now -- Claude executes `/release` manually. But as Grafema grows, consider:

- GitHub Actions workflow triggered on tag push
- Automated `stable` branch protection

**Recommendation:** Create a follow-up issue (v0.5+) for CI/CD integration. Not needed now.

### 4. Version 0.2.4-beta Choice

Joel proposes syncing all packages to 0.2.4-beta. This implies:
- Current highest version is 0.2.3-beta (core, cli)
- @grafema/api jumps from 0.1.0-beta to 0.2.4-beta

This is a **one-time version unification** -- acceptable. Users of @grafema/api who pinned to 0.1.x won't automatically get 0.2.4-beta. Document this in the release notes.

---

## Critical Checks Passed

### Does this serve the actual goal?

**YES.** Stable branch + predictable versioning directly enables:
- Reliable version for hooks (stable branch)
- Dogfooding (stable always works)
- Predictability (unified versions, clear process)

### Is the stable branch strategy correct?

**YES.**
- main broken? stable still works
- Fixes flow: fix on main -> release -> merge to stable
- Critical bug in stable? Fix on main, release new version, merge to stable
- No backporting complexity -- stable is always fast-forward from a release tag

### Is the versioning strategy sound?

**YES.**
- Unified versioning simplifies communication
- Beta suffix correctly triggers `beta` dist-tag
- npm latest/beta separation is industry standard
- Unchanged packages get version bump -- acceptable trade-off

### Is the script robust enough?

**YES.**
- Error handling: `set -e`, explicit checks, rollback on build failure
- Dry-run mode: `--dry-run` previews changes
- Mid-publish failure: documented recovery procedures
- Pre-flight validation: tests, clean git, branch check

---

## Alignment with Project Vision

> "AI should query the graph, not read code."

This release workflow is **AI-first**:
- `/release` skill provides clear instructions for Claude
- Script has predictable, deterministic behavior
- No hidden state or complex tooling to debug
- Documentation explains WHY, not just HOW

The stable branch enables dogfooding -- using Grafema to work on Grafema, even when main is unstable.

---

## Final Notes

This is a **solid, pragmatic plan** that solves the stated problem without over-engineering. The team correctly identified that Grafema doesn't need Changesets or semantic-release -- it needs a well-documented, AI-executable process.

**One request for implementation:** The first release after this workflow is established should be documented as a test run. Capture any issues encountered and update the skill/docs accordingly.

---

**APPROVED for implementation.**

Awaiting Vadim's confirmation.

---

## Revision Review (CI/CD Added)

**Date:** 2026-02-06

---

### VERDICT: APPROVE

---

### Context

Vadim's feedback on the original plan:

> "CI/CD serves as Claude's checklist — it catches what Claude might forget due to context limits."

This is a **critical insight**. Claude operates within context windows. Complex multi-step release processes can exceed that context, causing steps to be forgotten. CI/CD is not automation for humans — it's a **safety net for AI agents**.

Don and Joel have revised the plan to include CI/CD as Phase 2 (not deferred to v0.5+).

---

### What's Right About the CI/CD Addition

#### 1. Correct Framing of the Problem

The updated plan explicitly states:

> "Claude's context is limited. CI/CD is NOT automation for humans — it's a **safety net for AI agents** executing releases."

This is the right mental model. Each CI check corresponds to a specific Claude context limitation:

| Check | What Claude Might Forget |
|-------|--------------------------|
| Tests pass | Running tests after the last change |
| No .skip/.only | Removing debugging code from tests |
| TypeScript | Type errors in files not touched during session |
| Build | Broken imports after refactoring |
| Version sync | Only bumping some packages |
| Changelog entry | Documenting the release |
| Binary check | Downloading rfdb binaries before publish |
| Post-publish verify | Confirming the published package works |

This is **exhaustive and correct**.

#### 2. Correct Trigger Strategy

**CI workflow (`ci.yml`):**
- Triggers on every push to main and PRs
- Catches issues early, before release
- This is standard CI — good

**Release validation (`release-validate.yml`):**
- Triggers on `v*` tag push
- Runs all CI checks PLUS release-specific checks (changelog, version sync)
- This is the **gate before publish** — correct

**Release publish (`release-publish.yml`):**
- Manual trigger only
- Requires human confirmation before npm publish
- Includes post-publish verification

**Why manual publish is correct:**
- npm publish is irreversible (72-hour unpublish window)
- Gives Claude (or human) a chance to review validation results
- No accidental publishes from typo'd tags

#### 3. Correct Scope — Not Over-Engineered

The CI/CD plan does NOT include:
- Automated version bumping (would require conventional commits)
- Automated changelog generation (would require conventional commits)
- Release train complexity
- Approval workflows

What it DOES include:
- Validation checks (things can fail)
- Manual publish trigger (human in the loop)
- Post-publish verification (confirm it worked)

This is **minimal viable CI/CD** that solves the stated problem.

#### 4. Reuses Existing Patterns

The workflow files match patterns from existing `.github/workflows/`:
- Same pnpm/action-setup@v4
- Same Node.js 22, pnpm 9
- Same structure and conventions

No new tools or frameworks introduced.

---

### Concerns (Not Blocking)

#### 1. Changelog Format Validation

The `changelog-check` job uses:
```bash
grep -qE "^\#\#\s*\[$VERSION\]\s*-\s*[0-9]{4}-[0-9]{2}-[0-9]{2}" CHANGELOG.md
```

This validates format: `## [0.2.5] - 2026-02-06`

It does NOT validate:
- Content exists under the header
- Content is meaningful

**Reality check:** This is acceptable. Automated content validation is impossible. The format check ensures Claude at least added an entry. Content quality is a human review concern.

#### 2. Binary Check is Warning-Only

The `binary-check` job for rfdb binaries issues a warning, not a failure:
```yaml
# Warning only, not failure - binaries might be downloaded separately
```

This is intentional because:
- rfdb binaries might be added in a separate step
- Not all releases include rfdb changes

**Recommendation:** Consider making this a failure for stable releases (non-prerelease) if @grafema/rfdb is being published. The current approach is defensible but could let a broken rfdb release through.

**Not blocking** because rfdb publish is explicitly optional in the workflow.

#### 3. NPM_TOKEN Secret Setup

The plan mentions configuring NPM_TOKEN but doesn't verify it exists before attempting publish.

**In practice:** The workflow will fail clearly if the secret is missing ("NODE_AUTH_TOKEN is not set"). Good enough.

---

### Critical Checks Passed

#### Does this address Vadim's concern?

**YES.** The CI/CD pipeline catches exactly what Claude might forget:

1. **All tests pass (none skipped)** — `test` job + `.only/.skip` grep check
2. **Changelogs/docs in sync** — `changelog-check` job
3. **All required binaries built** — `binary-check` job (for rfdb)
4. **Nothing forgotten** — Each check is a memory extension for Claude

#### Is the CI/CD scope right?

**YES.** Not over-engineered (no automated versioning, no release trains), not under-done (covers all critical validation points).

#### Is the workflow trigger strategy correct?

**YES.**

| Event | Workflow | Behavior |
|-------|----------|----------|
| Push to main/PR | `ci.yml` | Validate continuously |
| Push tag `v*` | `release-validate.yml` | Gate before publish |
| Manual trigger | `release-publish.yml` | Human-approved publish |

This is the correct separation of concerns.

---

### Alignment with Project Vision

> "AI should query the graph, not read code."

The CI/CD addition aligns with this vision by **extending Claude's effective memory**. The GitHub Actions workflows are:
- Deterministic (same input = same output)
- Documented (comments explain why each check exists)
- AI-executable (Claude can trigger via gh CLI)

The `/release` skill update includes CI integration instructions, making the process end-to-end AI-executable.

---

### Final Notes

The revised plan with CI/CD as Phase 2 is **stronger than the original**. Vadim's insight that CI/CD serves as Claude's checklist is correct and well-implemented.

The total estimated effort (9-13 hours) is reasonable for what's being delivered:
- Phase 1: Local infrastructure (scripts, branches, docs)
- Phase 2: CI/CD safety net (3 workflows, integration)

**One observation:** The plan could have deferred CI/CD to a separate ticket (REG-XXX) if time was constrained. By including it in the same task, the team ensures it ships together. This is the right call — a release workflow without validation is incomplete.

---

### APPROVED

The revised plan with CI/CD is complete, correctly scoped, and directly addresses Vadim's concerns about Claude's context limitations.

Awaiting Vadim's confirmation.
