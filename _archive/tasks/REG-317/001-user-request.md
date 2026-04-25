# REG-317: Bundle rfdb-server binary into VS Code extension

## Goal

Bundle pre-built `rfdb-server` binaries into the VS Code extension so it works out of the box without requiring grafema CLI installation.

## Current State

Extension looks for rfdb-server binary in:

1. `GRAFEMA_RFDB_SERVER` env variable
2. Monorepo paths relative to extension
3. Hardcoded `/Users/vadimr/grafema` (dev convenience)
4. `@grafema/rfdb` npm package

This works for development but not for end users.

## Implementation

1. Add platform-specific binaries to extension package:
   * `binaries/darwin-arm64/rfdb-server`
   * `binaries/darwin-x64/rfdb-server`
   * `binaries/linux-x64/rfdb-server`
2. Update `findServerBinary()` in `grafemaClient.ts` to check extension's bundled binaries first
3. Update build script to:
   * Download/copy pre-built binaries during packaging
   * Or build from source for each platform

## Considerations

* Extension size will increase to ~15-20MB
* May need separate `.vsix` files per platform, or universal package with all binaries
* vsce supports platform-specific packaging: `vsce package --target darwin-arm64`

## Acceptance Criteria

- [ ] Extension works on fresh VS Code install without grafema CLI
- [ ] Binaries included for darwin-arm64, darwin-x64, linux-x64
- [ ] Build/package script handles binary bundling
