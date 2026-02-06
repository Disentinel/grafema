# Don Melton Analysis: REG-317 Bundle rfdb-server into VS Code Extension

## Executive Summary

This task is straightforward and well-aligned with VS Code's native platform-specific packaging capabilities. The key architectural decision is **platform-specific VSIXs** (not a universal package with all binaries) because:

1. VS Code marketplace natively supports platform-specific extensions since v1.61.0
2. Keeps each package ~5MB instead of ~20MB
3. Users only download binaries for their platform
4. Matches how mature extensions like ESLint, Rust Analyzer handle native binaries

## Research Findings

### VS Code Platform-Specific Packaging (Official)

From [VS Code Publishing Documentation](https://code.visualstudio.com/api/working-with-extensions/publishing-extension):

- `vsce package --target darwin-arm64` creates platform-specific VSIX
- Supported targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`
- VS Code auto-selects correct package for user's platform from marketplace

From [Microsoft's platform-specific sample](https://github.com/microsoft/vscode-platform-specific-sample):

- Recommended pattern: CI builds separate VSIXs per platform
- Binary goes directly in extension root or subdirectory
- No special directory structure required

### Existing Infrastructure We Can Leverage

REG-340 already created GitHub Actions matrix build that:
- Builds rfdb-server for darwin-x64, darwin-arm64, linux-x64, linux-arm64
- Uploads binaries to GitHub Release on tag `rfdb-vX.Y.Z`
- Produces named binaries: `rfdb-server-darwin-arm64`, `rfdb-server-darwin-x64`, etc.

## Architectural Decision: Platform-Specific VSIXs

### Why NOT Universal Package

A universal package bundling all 4 binaries (~20MB total) would:
- Violate VS Code best practices
- Waste bandwidth for users who only need one platform
- Complicate binary selection at runtime
- Not leverage VS Code's native platform detection

### Why Platform-Specific VSIXs

| Aspect | Platform-Specific |
|--------|------------------|
| Package size | ~5MB per platform |
| Binary selection | Build time (correct by construction) |
| Marketplace UX | Automatic platform detection |
| CI complexity | Minimal (matrix build pattern) |
| Runtime logic | None needed |

## High-Level Implementation Plan

### Phase 1: Update Extension Build

1. **Add binary location in extension**
   - Path: `binaries/rfdb-server` (single binary per platform package)
   - No platform subdirectories needed (one binary per VSIX)

2. **Update `findServerBinary()` in `grafemaClient.ts`**
   - Check extension's bundled binary FIRST (before env vars, monorepo paths)
   - Use VS Code's `extensionPath` to locate binary
   - Fallback chain remains for development scenarios

3. **Update package.json scripts**
   - Add `vscode:prepublish` script that handles pre-packaging
   - Add platform-specific packaging scripts

### Phase 2: GitHub Actions Workflow

Create workflow that:
1. Triggers on extension version tag (e.g., `vscode-v0.2.1`)
2. Downloads pre-built binaries from latest `rfdb-vX.Y.Z` release
3. For each target platform:
   - Copy correct binary to `binaries/rfdb-server`
   - Run `vsce package --target <platform>`
4. Upload all VSIXs as release artifacts

### Phase 3: `.vscodeignore` Update

Ensure only the single binary is included:
```
!binaries/
!binaries/rfdb-server
```

## Changes Required

### File: `packages/vscode/src/grafemaClient.ts`

```typescript
// Current order:
// 1. Explicit path from settings
// 2. GRAFEMA_RFDB_SERVER env
// 3. Monorepo paths (development)
// 4. @grafema/rfdb npm package

// New order:
// 1. Explicit path from settings (user override)
// 2. Extension bundled binary <-- NEW, priority
// 3. GRAFEMA_RFDB_SERVER env
// 4. Monorepo paths (development)
// 5. @grafema/rfdb npm package (fallback)
```

Need to add:
```typescript
// Check extension bundled binary
const extensionBinary = join(__dirname, '..', 'binaries', 'rfdb-server');
if (existsSync(extensionBinary)) {
  return extensionBinary;
}
```

### File: `packages/vscode/package.json`

Add scripts:
```json
{
  "scripts": {
    "package": "vsce package",
    "package:darwin-arm64": "vsce package --target darwin-arm64",
    "package:darwin-x64": "vsce package --target darwin-x64",
    "package:linux-x64": "vsce package --target linux-x64",
    "package:linux-arm64": "vsce package --target linux-arm64"
  }
}
```

### File: `packages/vscode/.vscodeignore`

Add:
```
!binaries/
```

### New File: `.github/workflows/vscode-release.yml`

Matrix workflow that:
1. Downloads rfdb-server binaries from GitHub Release
2. Packages platform-specific VSIXs
3. Uploads to GitHub Release

## Scope & Complexity

| Item | Estimate |
|------|----------|
| Update `findServerBinary()` | 30 min |
| Update package.json/vscodeignore | 15 min |
| Create GitHub Actions workflow | 1-2 hours |
| Testing | 1 hour |
| **Total** | ~3-4 hours |

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Binary permissions after packaging | Use `chmod +x` in workflow |
| Binary not found after install | Test with fresh VS Code profile |
| __dirname resolution in bundled code | Test esbuild output structure |

## Alignment with Project Vision

This task is well-aligned:

1. **Zero-friction UX**: Extension works immediately after install
2. **Platform-native approach**: Uses VS Code's built-in platform packaging
3. **Builds on existing infrastructure**: REG-340's matrix build
4. **Minimal complexity**: No over-engineering, follows established patterns

## Recommendation

**Proceed with platform-specific VSIX approach.**

This is the right architectural choice, not just a working solution. It matches VS Code's native capabilities and how professional extensions handle native binaries.

## Open Questions for User

1. **Linux ARM64 support**: Current issue mentions darwin-arm64, darwin-x64, linux-x64. REG-340 also builds linux-arm64. Should we include it? (Recommend: yes, it's free)

2. **Windows support**: Not mentioned in issue. Should we add Windows targets? (Recommend: defer, add separate issue if needed)

3. **Marketplace publishing**: This task creates VSIXs but doesn't publish. Separate task for marketplace setup?

---

## Sources

- [VS Code Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [VS Code Bundling Extensions](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)
- [Microsoft vscode-platform-specific-sample](https://github.com/microsoft/vscode-platform-specific-sample)
- [vsce GitHub Repository](https://github.com/microsoft/vscode-vsce)
