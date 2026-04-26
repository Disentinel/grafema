# REG-340: High-Level Plan - GitHub Actions Matrix Build for rfdb-server

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-05
**Status:** Draft for Review

## Executive Summary

This task establishes automated CI/CD for building rfdb-server binaries across all supported platforms. The solution uses a two-workflow pattern: one for building binaries on tag push, another for incorporating those binaries into npm publish. This is foundational infrastructure that enables Grafema to be truly cross-platform without requiring users to have Rust installed.

## Current State Analysis

### What Exists
- Single `darwin-x64` prebuilt binary at `packages/rfdb-server/prebuilt/darwin-x64/rfdb-server`
- Platform detection in `postinstall.js` already handles all 4 platforms (darwin-x64, darwin-arm64, linux-x64, linux-arm64)
- `index.js` with `getBinaryPath()` correctly maps platform/arch combinations
- Rust build uses `lto = "fat"` and `codegen-units = 1` for optimized release builds
- Manual release process via Claude skill (no CI/CD automation yet)
- No `.github/` directory exists

### What's Missing
- GitHub Actions workflows for automated builds
- Binaries for darwin-arm64, linux-x64, linux-arm64
- Automated integration with npm publish process

## Research Findings

Based on web research of current best practices:

1. **Cross-compilation approach**: The [`cross`](https://github.com/cross-rs/cross) tool with [`actions-rust-cross`](https://github.com/houseabsolute/actions-rust-cross) is the recommended approach for linux-arm64, as it uses Docker containers with pre-configured toolchains.

2. **Native runners for macOS**: Both `macos-13` (Intel) and `macos-14` (Apple Silicon) runners are available natively in GitHub Actions, eliminating need for cross-compilation on macOS.

3. **Two-workflow pattern**: Build workflow triggered on tags uploads artifacts to GitHub Releases; publish workflow downloads from releases before npm publish.

4. **Artifact management**: Use `softprops/action-gh-release` for uploading to GitHub Releases, and `actions/download-artifact` or direct release download for retrieval.

## Architectural Decision: Native vs Cross-Compilation

**Decision: Use native runners where available, cross-compile only for linux-arm64**

| Platform | Approach | Runner | Rationale |
|----------|----------|--------|-----------|
| darwin-x64 | Native | `macos-13` | Intel runner available |
| darwin-arm64 | Native | `macos-14` | ARM runner available |
| linux-x64 | Native | `ubuntu-latest` | Standard runner |
| linux-arm64 | Cross-compile | `ubuntu-latest` + `cross` | No native ARM Linux runner |

**Why not cross-compile everything?**
- Native builds are simpler and more reliable
- macOS code signing (if needed later) requires native runner
- Cross-compilation adds Docker overhead and complexity
- Only linux-arm64 actually requires it

## High-Level Design

### Workflow 1: `build-binaries.yml`

**Trigger:** Tag push matching `rfdb-v*` pattern

**Purpose:** Build and upload binaries to GitHub Releases

```
Tag push (rfdb-v0.2.3)
    → Matrix build (4 jobs in parallel)
    → Upload to GitHub Release as assets
```

**Matrix Structure:**
```yaml
strategy:
  matrix:
    include:
      - name: darwin-x64
        os: macos-13
        target: x86_64-apple-darwin
        use_cross: false
      - name: darwin-arm64
        os: macos-14
        target: aarch64-apple-darwin
        use_cross: false
      - name: linux-x64
        os: ubuntu-latest
        target: x86_64-unknown-linux-gnu
        use_cross: false
      - name: linux-arm64
        os: ubuntu-latest
        target: aarch64-unknown-linux-gnu
        use_cross: true
```

**Job Steps:**
1. Checkout code
2. Install Rust toolchain (with target)
3. Cache cargo dependencies
4. Build binary (cargo or cross based on `use_cross`)
5. Strip binary (reduce size)
6. Upload to GitHub Release

### Workflow 2: `publish-rfdb.yml` (or update existing release skill)

**Trigger:** Manual dispatch or after successful build workflow

**Purpose:** Download binaries and publish to npm

```
Download binaries from latest release
    → Place in prebuilt/ directories
    → Run npm/pnpm publish
```

**Key consideration:** This may remain manual (following current skill-based approach) with instructions to download binaries before publish, OR could be fully automated.

## Artifact Naming Convention

```
rfdb-server-{platform}-{arch}
```

Examples:
- `rfdb-server-darwin-x64`
- `rfdb-server-darwin-arm64`
- `rfdb-server-linux-x64`
- `rfdb-server-linux-arm64`

Binary is uploaded without extension (matches current `prebuilt/` structure).

## Tag Strategy

**Format:** `rfdb-v{semver}` (e.g., `rfdb-v0.2.3`)

**Why separate from main version tag?**
- rfdb-server version can advance independently
- Allows rebuilding binaries without main release
- Clear separation: `v0.2.3-beta` (npm release) vs `rfdb-v0.2.3` (binary build)

## Key Implementation Considerations

### 1. glibc Compatibility for Linux

Linux binaries built against glibc require compatible glibc version at runtime. Options:
- **Option A:** Use `ubuntu-20.04` runner for older glibc (2.31)
- **Option B:** Build with musl for static linking (target: `*-unknown-linux-musl`)

**Recommendation:** Start with glibc builds on `ubuntu-22.04`. Most users have recent distros. If compatibility issues arise, add musl variants as separate targets.

### 2. Binary Stripping

Strip debug symbols to reduce binary size:
```bash
strip target/release/rfdb-server
```
Current darwin-x64 binary is ~1.1MB. With LTO and stripping, expect similar sizes across platforms.

### 3. Release Asset Upload

Use `softprops/action-gh-release@v1`:
```yaml
- uses: softprops/action-gh-release@v1
  with:
    files: rfdb-server-${{ matrix.name }}
```

### 4. Workflow Permissions

Requires `contents: write` permission for uploading release assets.

### 5. Integration with npm Publish

Two options:
- **Option A (Recommended):** Manual download step before publish
  - Update release skill to include: "Download binaries from latest GitHub release before publish"
  - Script: `scripts/download-rfdb-binaries.sh`

- **Option B:** Automated publish workflow
  - Triggered after build completes
  - More complex, requires npm token as secret
  - Consider for future automation

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| cross-compile fails for linux-arm64 | Medium | High | Test thoroughly; fallback to QEMU runner |
| glibc incompatibility on old Linux | Low | Medium | Document minimum requirements; consider musl |
| Binary too large | Low | Low | Already using LTO; can add UPX compression |
| Release upload race condition | Low | Medium | Matrix jobs upload independently to same release |

## Scope Boundaries

### In Scope
- Build workflow for all 4 platforms
- Tag-based triggering
- GitHub Release asset upload
- Documentation updates

### Out of Scope (Future Work)
- Automated npm publish workflow
- Windows support
- musl static builds
- Code signing for macOS
- Binary caching between runs

## Estimated Effort

| Phase | Effort |
|-------|--------|
| Workflow creation | 2-3 hours |
| Testing all platforms | 2-3 hours |
| Documentation updates | 1 hour |
| Review and iteration | 1-2 hours |
| **Total** | **6-9 hours** |

## Success Criteria

1. `git tag rfdb-v0.2.3 && git push --tags` triggers build workflow
2. All 4 platform builds complete successfully
3. GitHub Release contains 4 binary assets
4. Binaries work on their respective platforms
5. npm package with all 4 binaries passes `postinstall.js` checks on all platforms

## Next Steps

1. **Joel:** Expand into detailed technical specification with exact file contents
2. **Kent:** Write tests for verifying binary functionality (if applicable)
3. **Rob:** Implement workflows and test

## References

- [actions-rust-cross](https://github.com/houseabsolute/actions-rust-cross) - GitHub Action for Rust cross-compilation
- [Cross-Platform Rust CI/CD Pipeline](https://ahmedjama.com/blog/2025/12/cross-platform-rust-pipeline-github-actions/) - Comprehensive guide
- [Cross Compiling Rust in GitHub Actions](https://blog.urth.org/2023/03/05/cross-compiling-rust-projects-in-github-actions/) - Practical walkthrough
- [GitHub Actions Matrix Strategy](https://www.lucavall.in/blog/how-to-create-a-release-with-multiple-artifacts-from-a-github-actions-workflow-using-the-matrix-strategy) - Multi-artifact releases
- [softprops/action-gh-release](https://github.com/softprops/action-gh-release) - Release asset upload action

---

### Critical Files for Implementation

- `packages/rfdb-server/Cargo.toml` - Rust build configuration, defines binary name and release profile
- `packages/rfdb-server/scripts/postinstall.js` - Platform detection logic that must match workflow artifact naming
- `packages/rfdb-server/index.js` - Binary path resolution, must align with prebuilt directory structure
- `.claude/skills/grafema-release/SKILL.md` - Release skill to update with binary download instructions
- `.github/workflows/build-binaries.yml` (to be created) - Main workflow file
