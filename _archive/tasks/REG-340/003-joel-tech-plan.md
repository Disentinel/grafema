# REG-340: Technical Specification - GitHub Actions Matrix Build for rfdb-server

**Author:** Joel Spolsky (Implementation Planner)
**Date:** 2026-02-05
**Status:** Draft for Review
**Based on:** Don Melton's High-Level Plan (`002-don-plan.md`)

## Overview

This document expands Don's architectural plan into concrete implementation details. The goal: when we push a tag `rfdb-vX.Y.Z`, GitHub Actions automatically builds binaries for all 4 platforms and uploads them to a GitHub Release.

## Directory Structure

```
grafema/
├── .github/
│   └── workflows/
│       └── build-binaries.yml      # NEW: Matrix build workflow
├── scripts/
│   └── download-rfdb-binaries.sh   # NEW: Helper for release process
└── packages/
    └── rfdb-server/
        └── prebuilt/
            ├── darwin-x64/rfdb-server      # Existing
            ├── darwin-arm64/rfdb-server    # NEW (from CI)
            ├── linux-x64/rfdb-server       # NEW (from CI)
            └── linux-arm64/rfdb-server     # NEW (from CI)
```

---

## File 1: `.github/workflows/build-binaries.yml`

### Complete YAML Content

```yaml
# Build rfdb-server binaries for all supported platforms
#
# Triggered by: git tag rfdb-vX.Y.Z && git push --tags
# Outputs: GitHub Release with 4 binary assets
#
# Platforms:
#   - darwin-x64:  Native build on macos-13 (Intel)
#   - darwin-arm64: Native build on macos-14 (Apple Silicon)
#   - linux-x64:   Native build on ubuntu-latest
#   - linux-arm64: Cross-compile via actions-rust-cross

name: Build rfdb-server Binaries

on:
  push:
    tags:
      - 'rfdb-v*'

permissions:
  contents: write  # Required for uploading release assets

env:
  CARGO_TERM_COLOR: always
  RUST_BACKTRACE: 1

jobs:
  build:
    name: Build ${{ matrix.name }}
    runs-on: ${{ matrix.os }}

    strategy:
      fail-fast: false  # Continue other builds if one fails
      matrix:
        include:
          # macOS Intel (native)
          - name: darwin-x64
            os: macos-13
            target: x86_64-apple-darwin
            use_cross: false
            strip_cmd: strip

          # macOS Apple Silicon (native)
          - name: darwin-arm64
            os: macos-14
            target: aarch64-apple-darwin
            use_cross: false
            strip_cmd: strip

          # Linux x64 (native)
          - name: linux-x64
            os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
            use_cross: false
            strip_cmd: strip

          # Linux ARM64 (cross-compile)
          - name: linux-arm64
            os: ubuntu-22.04
            target: aarch64-unknown-linux-gnu
            use_cross: true
            strip_cmd: aarch64-linux-gnu-strip

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      # Native builds: Install Rust toolchain directly
      - name: Install Rust toolchain (native)
        if: ${{ !matrix.use_cross }}
        uses: dtolnay/rust-action@stable
        with:
          targets: ${{ matrix.target }}

      # Cross-compile: Use actions-rust-cross (includes toolchain)
      # This action handles Rust installation internally
      - name: Build with cross (linux-arm64)
        if: ${{ matrix.use_cross }}
        uses: houseabsolute/actions-rust-cross@v0
        with:
          command: build
          target: ${{ matrix.target }}
          args: --release --manifest-path packages/rfdb-server/Cargo.toml
          strip: true

      # Cargo cache for native builds
      - name: Cache cargo
        if: ${{ !matrix.use_cross }}
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: packages/rfdb-server -> target
          key: ${{ matrix.target }}

      # Native build
      - name: Build (native)
        if: ${{ !matrix.use_cross }}
        working-directory: packages/rfdb-server
        run: cargo build --release --target ${{ matrix.target }}

      # Strip binary (native builds only - cross already strips)
      - name: Strip binary (native)
        if: ${{ !matrix.use_cross }}
        run: |
          ${{ matrix.strip_cmd }} packages/rfdb-server/target/${{ matrix.target }}/release/rfdb-server

      # Prepare binary for upload with consistent naming
      - name: Prepare binary
        run: |
          mkdir -p dist
          if [ "${{ matrix.use_cross }}" = "true" ]; then
            cp packages/rfdb-server/target/${{ matrix.target }}/release/rfdb-server dist/rfdb-server-${{ matrix.name }}
          else
            cp packages/rfdb-server/target/${{ matrix.target }}/release/rfdb-server dist/rfdb-server-${{ matrix.name }}
          fi
          chmod +x dist/rfdb-server-${{ matrix.name }}
          ls -la dist/

      # Upload to GitHub Release
      - name: Upload to Release
        uses: softprops/action-gh-release@v2
        with:
          files: dist/rfdb-server-${{ matrix.name }}
          fail_on_unmatched_files: true
```

### Key Design Decisions Explained

1. **`fail-fast: false`**: If linux-arm64 cross-compile fails, we still get the 3 other binaries. Better than losing everything.

2. **`ubuntu-22.04` explicitly**: Don't use `ubuntu-latest` which can change. Ubuntu 22.04 has glibc 2.35, reasonable baseline.

3. **`dtolnay/rust-action@stable`** for native builds: Official Rust action, simpler than rustup manual setup.

4. **`houseabsolute/actions-rust-cross@v0`** for linux-arm64: This action:
   - Installs Rust automatically
   - Uses `cross` tool with pre-configured Docker images
   - Handles the aarch64-unknown-linux-gnu target seamlessly
   - Has built-in `strip: true` option

5. **Separate strip step for native builds**: `actions-rust-cross` has built-in stripping, but native builds need explicit `strip` command.

6. **`Swatinem/rust-cache@v2`**: Industry-standard Rust caching. The `workspaces` config points to our package directory.

7. **`softprops/action-gh-release@v2`**: Latest version (v2), handles concurrent uploads from matrix jobs gracefully.

---

## File 2: `scripts/download-rfdb-binaries.sh`

### Complete Script Content

```bash
#!/bin/bash
#
# Download rfdb-server binaries from GitHub Release
#
# Usage: ./scripts/download-rfdb-binaries.sh [tag]
#
# If no tag provided, uses latest rfdb-v* release.
# Places binaries in packages/rfdb-server/prebuilt/{platform}/rfdb-server
#
# Prerequisites:
#   - gh CLI installed and authenticated
#   - Internet connection
#
# Example:
#   ./scripts/download-rfdb-binaries.sh rfdb-v0.2.3
#   ./scripts/download-rfdb-binaries.sh  # uses latest

set -e

cd "$(dirname "$0")/.."

REPO="Disentinel/grafema"
TAG=${1:-}

# If no tag provided, find latest rfdb-v* release
if [ -z "$TAG" ]; then
  echo "Finding latest rfdb-v* release..."
  TAG=$(gh release list --repo "$REPO" --limit 20 | grep '^rfdb-v' | head -1 | awk '{print $1}')
  if [ -z "$TAG" ]; then
    echo "Error: No rfdb-v* releases found"
    exit 1
  fi
  echo "Using latest: $TAG"
fi

# Verify release exists
if ! gh release view "$TAG" --repo "$REPO" > /dev/null 2>&1; then
  echo "Error: Release $TAG not found"
  exit 1
fi

echo ""
echo "Downloading binaries from release: $TAG"
echo ""

PREBUILT_DIR="packages/rfdb-server/prebuilt"

# Platforms to download
PLATFORMS=("darwin-x64" "darwin-arm64" "linux-x64" "linux-arm64")

for PLATFORM in "${PLATFORMS[@]}"; do
  BINARY_NAME="rfdb-server-$PLATFORM"
  TARGET_DIR="$PREBUILT_DIR/$PLATFORM"
  TARGET_FILE="$TARGET_DIR/rfdb-server"

  echo "Downloading $PLATFORM..."

  # Create directory if needed
  mkdir -p "$TARGET_DIR"

  # Download binary
  if gh release download "$TAG" --repo "$REPO" --pattern "$BINARY_NAME" --dir "$TARGET_DIR" --clobber; then
    # Rename to rfdb-server (remove platform suffix)
    mv "$TARGET_DIR/$BINARY_NAME" "$TARGET_FILE"
    chmod +x "$TARGET_FILE"

    # Show size
    SIZE=$(ls -lh "$TARGET_FILE" | awk '{print $5}')
    echo "  ✓ $PLATFORM ($SIZE)"
  else
    echo "  ✗ $PLATFORM (not found in release)"
  fi
done

echo ""
echo "Done! Binaries are in $PREBUILT_DIR/"
echo ""
echo "Verify with:"
echo "  ls -la packages/rfdb-server/prebuilt/*/rfdb-server"
```

### Script Design Notes

1. **Uses `gh` CLI**: Standard GitHub CLI, widely available, handles authentication.

2. **Auto-detect latest**: If no tag provided, finds the most recent `rfdb-v*` release.

3. **Rename on download**: The release has `rfdb-server-darwin-x64`, but we need `rfdb-server` in the directory. Script handles the rename.

4. **Idempotent**: `--clobber` flag overwrites existing files. Safe to run multiple times.

5. **Graceful failures**: If one platform is missing, continues with others and shows which failed.

---

## File 3: Updates to Release Skill

The existing `grafema-release` skill needs a new step. Add this section after "Pre-Release Checklist" and before "Step 1":

```markdown
### Step 0: Download rfdb-server Binaries (if releasing @grafema/rfdb)

Before publishing `@grafema/rfdb`, download the latest binaries:

\`\`\`bash
# Ensure rfdb-vX.Y.Z tag exists and CI completed
./scripts/download-rfdb-binaries.sh rfdb-v0.2.3

# Or use latest release
./scripts/download-rfdb-binaries.sh

# Verify all 4 platforms
ls -la packages/rfdb-server/prebuilt/*/rfdb-server
\`\`\`

Wait for the build workflow to complete before running this script.
Check workflow status at: https://github.com/Disentinel/grafema/actions
```

---

## Step-by-Step Implementation Checklist

### Phase 1: Create Workflow Directory

```bash
# 1.1 Create .github/workflows directory
mkdir -p grafema/.github/workflows

# 1.2 Create the workflow file
# (Content from File 1 above)
# grafema/.github/workflows/build-binaries.yml
```

### Phase 2: Create Download Script

```bash
# 2.1 Create the download script
# (Content from File 2 above)
# grafema/scripts/download-rfdb-binaries.sh

# 2.2 Make executable
chmod +x grafema/scripts/download-rfdb-binaries.sh
```

### Phase 3: Update Release Skill

```bash
# 3.1 Edit the release skill to include binary download step
# grafema/.claude/skills/grafema-release/SKILL.md
```

### Phase 4: Test Workflow (First Run)

```bash
# 4.1 Commit the workflow file
git add grafema/.github/workflows/build-binaries.yml
git add grafema/scripts/download-rfdb-binaries.sh
git commit -m "feat(ci): Add GitHub Actions matrix build for rfdb-server

- Build binaries for darwin-x64, darwin-arm64, linux-x64, linux-arm64
- Use native runners for macOS and linux-x64
- Use cross-compilation for linux-arm64
- Upload binaries to GitHub Release on tag push"

# 4.2 Push to enable workflow
git push origin main

# 4.3 Create a test tag
git tag rfdb-v0.2.0-test
git push origin rfdb-v0.2.0-test

# 4.4 Monitor workflow at:
# https://github.com/Disentinel/grafema/actions
```

### Phase 5: Verify Results

```bash
# 5.1 Check release was created
gh release view rfdb-v0.2.0-test --repo Disentinel/grafema

# 5.2 List release assets
gh release view rfdb-v0.2.0-test --repo Disentinel/grafema --json assets

# 5.3 Test download script
./scripts/download-rfdb-binaries.sh rfdb-v0.2.0-test

# 5.4 Verify binaries
ls -la packages/rfdb-server/prebuilt/*/rfdb-server
file packages/rfdb-server/prebuilt/*/rfdb-server
```

### Phase 6: Clean Up Test Release

```bash
# 6.1 Delete test release and tag (optional)
gh release delete rfdb-v0.2.0-test --repo Disentinel/grafema --yes
git push origin --delete rfdb-v0.2.0-test
git tag -d rfdb-v0.2.0-test
```

---

## Big-O Complexity Analysis

This task involves CI/CD infrastructure rather than algorithms. However, for completeness:

| Operation | Complexity | Notes |
|-----------|------------|-------|
| Workflow trigger detection | O(1) | GitHub compares tag pattern |
| Matrix job scheduling | O(n) | n = number of platforms (4) |
| Cargo build | O(f) | f = number of source files, depends on project size |
| Release asset upload | O(n) | n = number of platforms, concurrent |
| Binary download | O(n * b) | n = platforms, b = binary size (~1MB each) |

**Total download time**: ~4 binaries * ~1MB = ~4MB total, negligible on modern connections.

---

## Testing Strategy

### Manual Testing Checklist

After creating the workflow:

1. **Trigger test**: Push `rfdb-v0.2.0-test` tag
2. **Monitor all 4 matrix jobs**: Each should complete in 5-10 minutes
3. **Check Release page**: All 4 assets present with correct names
4. **Download test**: Run `download-rfdb-binaries.sh rfdb-v0.2.0-test`
5. **Verify each binary**:
   ```bash
   file packages/rfdb-server/prebuilt/darwin-x64/rfdb-server
   # Expected: Mach-O 64-bit executable x86_64

   file packages/rfdb-server/prebuilt/darwin-arm64/rfdb-server
   # Expected: Mach-O 64-bit executable arm64

   file packages/rfdb-server/prebuilt/linux-x64/rfdb-server
   # Expected: ELF 64-bit LSB pie executable, x86-64

   file packages/rfdb-server/prebuilt/linux-arm64/rfdb-server
   # Expected: ELF 64-bit LSB pie executable, ARM aarch64
   ```

### Platform-Specific Testing

If access to target platforms is available:

```bash
# On each platform, test the binary actually runs
./rfdb-server --help
# Should show usage without errors
```

### Regression Testing After Publish

After publishing npm package with new binaries:

```bash
# Clean install on each platform
npm cache clean --force
npm install @grafema/rfdb@latest
npx grafema --version  # Should work without Rust
```

---

## Error Handling and Recovery

### If a matrix job fails:

1. Check the specific job logs in GitHub Actions
2. Common issues:
   - **linux-arm64**: Docker pull timeout (retry usually fixes)
   - **Cargo.lock mismatch**: Commit `Cargo.lock` to repo
   - **Dependency download**: Network issues, retry

### If cross-compile fails repeatedly:

Fallback option: Use QEMU-based runner instead of cross:
```yaml
# Alternative for linux-arm64
- name: linux-arm64
  os: ubuntu-22.04
  target: aarch64-unknown-linux-gnu
  use_cross: false  # Change to native
  # Requires: runs-on: buildjet-4vcpu-ubuntu-2204-arm (paid runner)
```

### If release upload fails:

The workflow uses concurrent uploads. If race condition occurs:
1. Delete the partial release: `gh release delete rfdb-vX.Y.Z`
2. Delete and recreate the tag
3. Re-push to trigger fresh run

---

## Estimated Build Times

Based on similar Rust projects:

| Platform | Expected Time | Notes |
|----------|---------------|-------|
| darwin-x64 | 5-8 min | LTO is slow |
| darwin-arm64 | 4-6 min | ARM runners are fast |
| linux-x64 | 5-8 min | LTO is slow |
| linux-arm64 | 8-12 min | Cross-compile overhead |

**Total wall-clock time**: ~12 minutes (jobs run in parallel)

---

## Dependencies and Prerequisites

### GitHub Repository Settings

1. **Enable Actions**: Settings > Actions > General > "Allow all actions"
2. **Workflow permissions**: Settings > Actions > General > "Read and write permissions"

### No secrets required

The workflow uses `GITHUB_TOKEN` which is automatically provided. No manual secret configuration needed.

---

## Success Criteria (from Don's Plan)

1. `git tag rfdb-v0.2.3 && git push --tags` triggers build workflow
2. All 4 platform builds complete successfully
3. GitHub Release contains 4 binary assets
4. Binaries work on their respective platforms
5. npm package with all 4 binaries passes `postinstall.js` checks on all platforms

---

## References

- Don's high-level plan: `_tasks/REG-340/002-don-plan.md`
- Existing platform detection: `packages/rfdb-server/scripts/postinstall.js`
- Binary path resolution: `packages/rfdb-server/index.js`
- Cargo configuration: `packages/rfdb-server/Cargo.toml`
