# Joel Spolsky Technical Spec: REG-317 Bundle rfdb-server into VS Code Extension

## Summary

This spec provides copy-paste ready implementation for bundling rfdb-server binary into platform-specific VS Code extension packages (VSIXs).

## Big-O Complexity Analysis

| Operation | Complexity | Notes |
|-----------|------------|-------|
| `findServerBinary()` | O(1) | Constant number of path checks (~6) |
| Extension activation | O(1) | No iteration, direct path lookup |
| Binary copy in CI | O(1) | Single file copy per platform |
| VSIX packaging | O(n) | n = number of extension files, handled by vsce |

**No algorithmic concerns** - this is primarily build tooling and file path resolution, not data processing.

---

## Part 1: Update `findServerBinary()` in `grafemaClient.ts`

### Current Code (lines 142-205)

The function currently checks in this order:
1. Explicit path from VS Code settings
2. `GRAFEMA_RFDB_SERVER` environment variable
3. Monorepo development paths
4. `@grafema/rfdb` npm package

### New Code

Replace the entire `findServerBinary()` method (lines 142-205) with:

```typescript
  /**
   * Find rfdb-server binary
   *
   * Search order:
   * 1. Explicit path from VS Code setting (user override)
   * 2. Bundled binary in extension (production)
   * 3. GRAFEMA_RFDB_SERVER environment variable
   * 4. Monorepo development paths
   * 5. @grafema/rfdb npm package (fallback)
   */
  private findServerBinary(): string | null {
    // 0. Check explicit path from VS Code setting
    if (this.explicitBinaryPath && existsSync(this.explicitBinaryPath)) {
      return this.explicitBinaryPath;
    }

    // 1. Check extension bundled binary (production)
    // After esbuild, __dirname is packages/vscode/dist
    // Binary is at packages/vscode/binaries/rfdb-server
    const extensionBinary = join(__dirname, '..', 'binaries', 'rfdb-server');
    if (existsSync(extensionBinary)) {
      return extensionBinary;
    }

    // 2. Check GRAFEMA_RFDB_SERVER environment variable
    const envBinary = process.env.GRAFEMA_RFDB_SERVER;
    if (envBinary && existsSync(envBinary)) {
      return envBinary;
    }

    // 3. Check packages/rfdb-server in monorepo (development)
    // Navigate up from dist to find monorepo root
    const possibleRoots = [
      // When running from extension host
      join(this.workspaceRoot, 'node_modules', '@grafema', 'rfdb-client'),
      // When in monorepo development
      join(__dirname, '..', '..', '..'),
      join(__dirname, '..', '..', '..', '..'),
      join(__dirname, '..', '..', '..', '..', '..'),
      // Known grafema monorepo location (development convenience)
      '/Users/vadimr/grafema',
    ];

    for (const root of possibleRoots) {
      const releaseBinary = join(root, 'packages', 'rfdb-server', 'target', 'release', 'rfdb-server');
      if (existsSync(releaseBinary)) {
        return releaseBinary;
      }

      const debugBinary = join(root, 'packages', 'rfdb-server', 'target', 'debug', 'rfdb-server');
      if (existsSync(debugBinary)) {
        return debugBinary;
      }
    }

    // 4. Check @grafema/rfdb npm package
    try {
      // Use require.resolve to find the package
      const rfdbPkg = require.resolve('@grafema/rfdb');
      const rfdbDir = dirname(rfdbPkg);
      const platform = process.platform;
      const arch = process.arch;

      let platformDir: string;
      if (platform === 'darwin') {
        platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
      } else if (platform === 'linux') {
        platformDir = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
      } else {
        platformDir = `${platform}-${arch}`;
      }

      const npmBinary = join(rfdbDir, 'prebuilt', platformDir, 'rfdb-server');
      if (existsSync(npmBinary)) {
        return npmBinary;
      }
    } catch {
      // @grafema/rfdb not installed
    }

    return null;
  }
```

### Key Changes

1. **Added bundled binary check** at position #1 (after explicit setting)
2. **Path resolution**: `join(__dirname, '..', 'binaries', 'rfdb-server')`
   - `__dirname` = `packages/vscode/dist` (after esbuild bundle)
   - Goes up one level to `packages/vscode`
   - Then into `binaries/rfdb-server`
3. **Updated comments** to document the full search order

---

## Part 2: Update `package.json`

### Current Scripts (lines 140-145)

```json
"scripts": {
  "build": "node esbuild.config.mjs",
  "watch": "node esbuild.config.mjs --watch",
  "package": "vsce package",
  "clean": "rm -rf dist"
}
```

### New Scripts

Replace with:

```json
"scripts": {
  "build": "node esbuild.config.mjs",
  "watch": "node esbuild.config.mjs --watch",
  "clean": "rm -rf dist binaries",
  "vscode:prepublish": "npm run build",
  "package": "vsce package",
  "package:darwin-arm64": "vsce package --target darwin-arm64",
  "package:darwin-x64": "vsce package --target darwin-x64",
  "package:linux-x64": "vsce package --target linux-x64",
  "package:linux-arm64": "vsce package --target linux-arm64",
  "package:universal": "vsce package"
}
```

### Key Changes

1. **`vscode:prepublish`**: VS Code runs this automatically before packaging
2. **Platform-specific scripts**: `package:<platform>` for CI use
3. **`package:universal`**: For development/testing without binary
4. **Updated `clean`**: Also removes `binaries/` directory

---

## Part 3: Update `.vscodeignore`

### Current Content (lines 1-8)

```
.vscode/**
node_modules/**
src/**
tsconfig.json
esbuild.config.mjs
*.map
.gitignore
```

### New Content

Replace entire file with:

```
.vscode/**
node_modules/**
src/**
tsconfig.json
esbuild.config.mjs
*.map
.gitignore
!binaries/
!binaries/**
```

### Explanation

- By default, vsce excludes `binaries/` (not in package)
- `!binaries/` and `!binaries/**` explicitly include the directory and its contents
- The single `rfdb-server` binary will be included in the VSIX

---

## Part 4: Add `.gitignore` Entry

### File: `packages/vscode/.gitignore`

Check if exists, if not create. Add:

```
# Build output
dist/

# Bundled binaries (downloaded during CI, not committed)
binaries/
```

This ensures:
- Binaries are not committed to git
- They are downloaded fresh during CI packaging

---

## Part 5: Create GitHub Actions Workflow

### File: `.github/workflows/vscode-release.yml`

```yaml
# Build and publish platform-specific VS Code extension packages
#
# Triggered by: git tag vscode-vX.Y.Z && git push --tags
# Outputs: GitHub Release with platform-specific VSIXs
#
# Prerequisites:
#   - rfdb-server binaries must exist in a GitHub Release (from build-binaries.yml)
#
# Platforms:
#   - darwin-arm64: macOS Apple Silicon
#   - darwin-x64:   macOS Intel
#   - linux-x64:    Linux x64
#   - linux-arm64:  Linux ARM64

name: VS Code Extension Release

on:
  push:
    tags:
      - 'vscode-v*'
  workflow_dispatch:
    inputs:
      rfdb_version:
        description: 'RFDB version tag to use (e.g., rfdb-v0.1.0). Leave empty to use latest.'
        required: false
        type: string

permissions:
  contents: write

env:
  NODE_VERSION: '20'

jobs:
  # First, find the latest rfdb release
  find-rfdb-release:
    name: Find rfdb-server release
    runs-on: ubuntu-latest
    outputs:
      rfdb_tag: ${{ steps.find.outputs.tag }}
    steps:
      - name: Find latest rfdb release
        id: find
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          if [ -n "${{ inputs.rfdb_version }}" ]; then
            echo "tag=${{ inputs.rfdb_version }}" >> "$GITHUB_OUTPUT"
          else
            # Find latest rfdb-v* tag
            TAG=$(gh release list --repo ${{ github.repository }} --limit 100 | grep "rfdb-v" | head -1 | awk '{print $1}')
            if [ -z "$TAG" ]; then
              echo "ERROR: No rfdb-v* release found"
              exit 1
            fi
            echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          fi
          echo "Using rfdb release: $(cat $GITHUB_OUTPUT | grep tag)"

  # Build platform-specific VSIXs
  build:
    name: Package ${{ matrix.platform }}
    runs-on: ubuntu-latest
    needs: find-rfdb-release

    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: darwin-arm64
            binary_name: rfdb-server-darwin-arm64
          - platform: darwin-x64
            binary_name: rfdb-server-darwin-x64
          - platform: linux-x64
            binary_name: rfdb-server-linux-x64
          - platform: linux-arm64
            binary_name: rfdb-server-linux-arm64

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Install dependencies
        working-directory: packages/vscode
        run: pnpm install

      - name: Build extension
        working-directory: packages/vscode
        run: pnpm run build

      - name: Download rfdb-server binary
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          mkdir -p packages/vscode/binaries
          gh release download ${{ needs.find-rfdb-release.outputs.rfdb_tag }} \
            --pattern "${{ matrix.binary_name }}" \
            --dir packages/vscode/binaries
          # Rename to standard name (remove platform suffix)
          mv packages/vscode/binaries/${{ matrix.binary_name }} packages/vscode/binaries/rfdb-server
          chmod +x packages/vscode/binaries/rfdb-server
          ls -lh packages/vscode/binaries/

      - name: Verify binary
        run: |
          file packages/vscode/binaries/rfdb-server
          du -h packages/vscode/binaries/rfdb-server

      - name: Install vsce
        run: npm install -g @vscode/vsce

      - name: Package VSIX
        working-directory: packages/vscode
        run: |
          vsce package --target ${{ matrix.platform }} --no-dependencies
          ls -lh *.vsix

      - name: Upload VSIX artifact
        uses: actions/upload-artifact@v4
        with:
          name: vsix-${{ matrix.platform }}
          path: packages/vscode/*.vsix

  # Create GitHub release with all VSIXs
  release:
    name: Create Release
    runs-on: ubuntu-latest
    needs: build
    if: startsWith(github.ref, 'refs/tags/')

    steps:
      - name: Download all VSIXs
        uses: actions/download-artifact@v4
        with:
          pattern: vsix-*
          merge-multiple: true
          path: vsix/

      - name: List VSIXs
        run: ls -lh vsix/

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: vsix/*.vsix
          fail_on_unmatched_files: true
          body: |
            ## VS Code Extension Release

            Platform-specific packages for Grafema Explore VS Code extension.

            ### Installation

            1. Download the VSIX for your platform
            2. In VS Code: Extensions > ... > Install from VSIX
            3. Select the downloaded file

            ### Platforms

            | File | Platform |
            |------|----------|
            | `grafema-explore-*-darwin-arm64.vsix` | macOS Apple Silicon |
            | `grafema-explore-*-darwin-x64.vsix` | macOS Intel |
            | `grafema-explore-*-linux-x64.vsix` | Linux x64 |
            | `grafema-explore-*-linux-arm64.vsix` | Linux ARM64 |
```

### Workflow Explanation

1. **Trigger**: Tag `vscode-v*` or manual dispatch
2. **find-rfdb-release job**: Locates latest `rfdb-v*` release for binaries
3. **build job (matrix)**:
   - Downloads platform-specific binary from rfdb release
   - Renames to `rfdb-server` (removes platform suffix)
   - Sets executable permission
   - Packages with `vsce package --target <platform>`
4. **release job**: Uploads all VSIXs to GitHub Release

### Key Design Decisions

- **`--no-dependencies`**: Avoids bundling workspace dependencies (they're already bundled by esbuild)
- **Binary naming**: CI downloads `rfdb-server-darwin-arm64` and renames to `rfdb-server` - extension code expects just `rfdb-server`
- **Artifact upload**: Temporary storage between jobs for release creation

---

## Part 6: Create `binaries/` Directory Structure

The `binaries/` directory does not exist in git (ignored). It's created during CI only.

For local development testing, developers can manually create:

```bash
mkdir -p packages/vscode/binaries
cp path/to/rfdb-server packages/vscode/binaries/rfdb-server
chmod +x packages/vscode/binaries/rfdb-server
```

---

## Implementation Checklist

### Files to Modify

| File | Change |
|------|--------|
| `packages/vscode/src/grafemaClient.ts` | Replace `findServerBinary()` method |
| `packages/vscode/package.json` | Update scripts section |
| `packages/vscode/.vscodeignore` | Add binary inclusion rules |
| `packages/vscode/.gitignore` | Create/update with binaries exclusion |

### Files to Create

| File | Purpose |
|------|---------|
| `.github/workflows/vscode-release.yml` | Platform-specific VSIX packaging |

### No Changes Required

| File | Reason |
|------|--------|
| `packages/vscode/esbuild.config.mjs` | Binary is outside dist/, no build changes needed |
| `.github/workflows/build-binaries.yml` | Already produces needed artifacts |

---

## Testing Checklist

### Local Development Testing

1. **Without bundled binary** (existing behavior):
   ```bash
   cd packages/vscode
   pnpm build
   # Test that extension still works via monorepo/env var paths
   ```

2. **With bundled binary**:
   ```bash
   cd packages/vscode
   mkdir -p binaries
   cp ../../packages/rfdb-server/target/release/rfdb-server binaries/
   pnpm build
   # Launch Extension Development Host
   # Verify binary is found from extension path
   ```

3. **Universal package** (no binary):
   ```bash
   pnpm run package:universal
   # Creates grafema-explore-0.2.0.vsix (~200KB)
   ```

### CI Testing

1. **Trigger test build**:
   ```bash
   # Use workflow_dispatch for testing
   gh workflow run vscode-release.yml
   ```

2. **Verify release**:
   - Check all 4 VSIXs are created
   - Each VSIX should be ~5-6MB
   - Binary should be executable inside VSIX

### Post-Install Testing

1. Install VSIX in clean VS Code profile
2. Open workspace with `.grafema/graph.rfdb`
3. Verify extension auto-starts server without external binary

---

## Error Messages Update

The error message in `startServer()` (line 213-217) should be updated to reflect new priority:

```typescript
throw new Error(
  'RFDB server binary not found.\n' +
  'The extension package may be missing the bundled binary.\n' +
  'Reinstall the extension, or set grafema.rfdbServerPath in settings.'
);
```

This is a minor UX improvement but not critical for MVP.

---

## Summary of Changes

| Component | Lines Changed | Complexity |
|-----------|---------------|------------|
| `grafemaClient.ts` | ~15 lines added | Simple path check |
| `package.json` | ~8 lines added | Script additions |
| `.vscodeignore` | ~2 lines added | Include rules |
| `.gitignore` | ~3 lines added | Exclusion rule |
| `vscode-release.yml` | ~140 lines new | Matrix workflow |

**Total estimated implementation time**: 2-3 hours (including testing)

---

## Dependencies

- Requires `build-binaries.yml` workflow (REG-340) to have produced at least one `rfdb-v*` release
- `@vscode/vsce` CLI tool (installed in CI)
- pnpm for dependency management

---

## Future Considerations (Out of Scope)

1. **Marketplace publishing**: Separate task to set up VS Code Marketplace account and publish workflow
2. **Windows support**: Would need additional matrix entries and rust cross-compilation setup
3. **Auto-update**: VS Code handles this automatically once on marketplace
