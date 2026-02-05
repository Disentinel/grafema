# REG-340: GitHub Actions matrix build for prebuilt rfdb-server binaries

## Problem

Currently only `darwin-x64` prebuilt binary is included in `@grafema/rfdb` npm package. Users on other platforms (darwin-arm64, linux-x64, linux-arm64) must build from source.

## Solution

Set up GitHub Actions workflow with matrix build:

```yaml
strategy:
  matrix:
    include:
      - os: macos-latest
        target: x86_64-apple-darwin
        artifact: darwin-x64
      - os: macos-latest
        target: aarch64-apple-darwin
        artifact: darwin-arm64
      - os: ubuntu-latest
        target: x86_64-unknown-linux-gnu
        artifact: linux-x64
      - os: ubuntu-latest
        target: aarch64-unknown-linux-gnu
        artifact: linux-arm64
```

## Tasks

- [ ] Create `.github/workflows/build-binaries.yml`
- [ ] Build on tag push (e.g., `rfdb-v*`)
- [ ] Upload artifacts to GitHub Releases
- [ ] Update publish workflow to download binaries before npm publish
- [ ] Test on all 4 platforms

## Acceptance Criteria

* `npm install @grafema/rfdb` works out of the box on:
  * macOS Intel (darwin-x64)
  * macOS Apple Silicon (darwin-arm64)
  * Linux x64 (linux-x64)
  * Linux ARM64 (linux-arm64)

## Notes

* linux-arm64 requires cross-compilation or QEMU runner
* Consider using `cross` for easier cross-compilation
* May need to handle glibc vs musl for Linux
