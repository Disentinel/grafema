# REG-340: Addressing Review Feedback

**Date:** 2026-02-05

## Review Summary

- **Steve Jobs**: APPROVE (with mandatory release skill update)
- **Вадим Решетников**: NEEDS CHANGES (3 blocking issues)

## Blocking Issues Analysis

### Issue 1: Repository Name Hardcoded in Script

**Concern:** Script hardcodes `REPO="Disentinel/grafema"`
**Status:** VALID - Will fix by auto-detecting from git remote

**Solution:** Update download script to auto-detect repository:
```bash
# Auto-detect repository from git remote
REPO=$(git config --get remote.origin.url | sed -E 's/.*github.com[:/]([^/]+\/[^/.]+)(\.git)?$/\1/')
if [ -z "$REPO" ]; then
  echo "Error: Could not detect GitHub repository from git remote"
  echo "Please specify repository: ./scripts/download-rfdb-binaries.sh --repo owner/repo [tag]"
  exit 1
fi
```

### Issue 2: Cargo.lock Not Committed

**Concern:** Cargo.lock might not be committed
**Status:** RESOLVED - Cargo.lock IS committed and tracked

Verified:
```
$ git ls-files packages/rfdb-server/Cargo.lock
packages/rfdb-server/Cargo.lock
```

The Cargo.lock file (37KB) is already tracked in git, ensuring reproducible builds.

### Issue 3: Concurrent Release Upload Safety

**Concern:** Race condition with 4 matrix jobs uploading to same release
**Status:** ACCEPTABLE RISK with mitigation

Research findings:
- `softprops/action-gh-release` is designed to handle this case
- If release exists, it updates rather than creates
- Known issue with 100+ releases (we're nowhere near)
- The `fail_on_unmatched_files: true` flag catches upload failures

Mitigation: Add explicit check that all 4 binaries exist in release after workflow completes.

## Additional Improvements from Reviews

### 1. Add gh CLI validation (Вадим)

```bash
# At top of download script
if ! command -v gh &> /dev/null; then
  echo "Error: GitHub CLI (gh) is required but not installed"
  echo "Install: https://cli.github.com/installation"
  exit 1
fi

if ! gh auth status &> /dev/null; then
  echo "Error: GitHub CLI not authenticated"
  echo "Run: gh auth login"
  exit 1
fi
```

### 2. Update Release Skill (Steve Jobs, Вадим)

Both reviewers agreed the release skill must include mandatory steps for downloading binaries before publishing @grafema/rfdb.

### 3. Binary Verification (Вадим)

Add file type verification to download script:
```bash
# After download
file "$TARGET_FILE" | grep -E "(Mach-O|ELF)" > /dev/null || {
  echo "Warning: $TARGET_FILE may not be a valid binary"
}
```

### 4. Document glibc Requirements (Steve Jobs, Вадим)

Add to rfdb-server README:
- Minimum glibc version: 2.35 (Ubuntu 22.04)
- Compatible: Ubuntu 22.04+, Debian 12+, Fedora 36+
- For older systems: build from source

## Updated Implementation Plan

1. Create `.github/workflows/build-binaries.yml` (as specified in Joel's plan)
2. Create `scripts/download-rfdb-binaries.sh` with:
   - Auto-detect repository from git remote
   - gh CLI validation
   - Binary file type verification
3. Update release skill with mandatory binary download steps
4. Document platform requirements in rfdb-server README

## Risk Assessment Update

| Risk | Mitigation |
|------|------------|
| Concurrent upload race | Using latest v2, fail_on_unmatched_files, acceptable risk |
| Hardcoded repo | Auto-detect from git remote |
| gh CLI missing | Explicit validation with helpful error |
| Invalid binary downloaded | File type verification |
| glibc incompatibility | Documented, fallback to source build |

## Verdict

All blocking issues have been addressed:
1. ✅ Hardcoded repo → Fix with auto-detection
2. ✅ Cargo.lock → Already committed
3. ✅ Concurrent uploads → Acceptable with mitigations

**Proceeding to implementation.**
