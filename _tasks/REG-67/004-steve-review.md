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
