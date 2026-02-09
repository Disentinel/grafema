# REG-362: Implementation Report

## Changes Made

### `scripts/release.sh`

**Before:** CHANGELOG validation was a 2-step interactive process:
- STEP 5: Blocked on user pressing Enter ("please update CHANGELOG")
- STEP 6: Only warned if CHANGELOG missing version entry (could be skipped with y/N)

**After:** Single enforced check (STEP 5) that:
1. **Fails hard** if CHANGELOG.md doesn't contain `[NEW_VERSION]` entry
2. Shows clear error message with expected format and bypass instructions
3. Respects `--skip-changelog` flag for hotfix scenarios
4. Also checks during `--dry-run` (informational, non-blocking)

### Specific Changes

1. Added `SKIP_CHANGELOG=false` variable and `--skip-changelog` flag parsing
2. Updated help text to include the new flag
3. Removed interactive `read -r` prompt (STEP 5 old)
4. Replaced soft warning with hard `exit 1` on missing CHANGELOG entry
5. Added CHANGELOG check to `--dry-run` output
6. Renumbered remaining steps (7→6, 8→7, 9→8)

### Acceptance Criteria Status

- [x] Pre-release hook checks if CHANGELOG.md was updated
- [x] Hook runs before `pnpm publish` or release script (runs as part of release.sh, after build but before commit/publish)
- [x] Clear error message when CHANGELOG is not updated
- [x] Option to bypass for hotfixes (with explicit `--skip-changelog` flag)
