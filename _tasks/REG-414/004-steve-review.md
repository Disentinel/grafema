# Steve Jobs Review: REG-414

## Verdict: REJECT (fixable)

## Required Fixes

### 1. Cross-Platform Reality
**Issue:** Each platform has its OWN skill directory:
- Claude Code: `.claude/skills/`
- Gemini CLI: `.gemini/skills/`
- Cursor: `.cursor/skills/` (likely)

The SKILL.md **format** is cross-platform, but the **install location** is not.

**Fix:** `setup-skill` must support multiple platforms via `--platform` flag or auto-detect.

### 2. Auto-Install vs Opt-In
**Issue:** `setup-skill` as separate command = friction = low adoption.

**Recommendation:** Auto-install during `grafema init`. Opt-out (delete file) is easier than opt-in (discover + run command).

### 3. Versioning Strategy
**Issue:** After Grafema update, skill in user's project becomes stale.

**Fix:** Include version in skill metadata. Warn during `grafema analyze` if skill is outdated. `setup-skill --update` to refresh.

### 4. Validation Plan
**Issue:** No plan to verify agents actually USE the skill correctly.

**Fix:** After implementation, test with real agent session. Document results.

### 5. More Inline Examples
**Issue:** References are good for progressive disclosure, but SKILL.md itself must have 10-15 micro-examples inline.

**Fix:** Already in plan (Essential Tools section has examples). Ensure sufficient density.
