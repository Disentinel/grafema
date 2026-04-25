# Don Melton — Exploration Report: RFD-41

**Date:** 2026-02-18
**Task:** Unify RFDB version numbering (Cargo 0.1.0 vs npm 0.2.11)

---

## 1. Current State of Versions

### Cargo.toml (`packages/rfdb-server/Cargo.toml`)
```toml
[package]
name = "rfdb"
version = "0.1.0"
edition = "2021"
```

### package.json (`packages/rfdb-server/package.json`)
```json
{
  "name": "@grafema/rfdb",
  "version": "0.2.11",
  ...
}
```

**Gap:** Cargo says `0.1.0`, npm says `0.2.11`. These versions have diverged significantly and were never cross-validated.

---

## 2. Where CARGO_PKG_VERSION Is Used

`env!("CARGO_PKG_VERSION")` appears in `packages/rfdb-server/src/bin/rfdb_server.rs` at 5 call sites:

- **Line 791** — `Response::HelloOk { server_version: ... }` — returned on every `hello` protocol handshake
- **Line 1100** — `Response::Pong { version: ... }` — returned on every `ping`
- **Line 2063** — `println!("rfdb-server {}", ...)` — `--version` flag output
- **Line 2069** — `println!("rfdb-server {}", ...)` — `--help` header output
- **Line 2112** — `eprintln!("[rfdb-server] Starting rfdb-server v{}", ...)` — startup log

The version string from Cargo propagates into the server's wire protocol. Clients receive "0.1.0" while the npm package is "0.2.11".

### How The CLI Consumes This

`packages/cli/src/commands/server.ts` reads the ping/hello response and displays it:
```typescript
// Line 156-157
if (status.version) {
  console.log(`  Version: ${status.version}`);
}
```

The CLI shows `Version: 0.1.0` when the server is running, while the npm package is `0.2.11`. This is the visible symptom of the bug.

---

## 3. How Versioning Currently Works

### Release Script (`scripts/release.sh`)

The release script (STEP 3 in the release workflow) does:
1. Reads current version from **root `package.json`** (`version = "0.2.11"`)
2. Calculates new version (patch/minor/major bump)
3. Runs `npm version $NEW_VERSION --no-git-tag-version` on root and all packages including `packages/rfdb-server`
4. Does NOT touch `Cargo.toml` at all — Rust versioning is completely absent

The list of packages updated:
```bash
PACKAGES=(
    "packages/types"
    "packages/rfdb"
    "packages/core"
    "packages/mcp"
    "packages/api"
    "packages/cli"
    "packages/rfdb-server"
)
```

**`packages/rfdb-server` is in this list**, so its `package.json` does get updated. But its `Cargo.toml` is never touched.

### CI Version Check (`.github/workflows/ci.yml`)

Job 4 "Version Sync" checks that all npm `package.json` versions match the root version. It explicitly does NOT check `Cargo.toml`. The RFDB package is in the check list, so `packages/rfdb-server/package.json` is verified against root — but `Cargo.toml` is silently ignored.

---

## 4. The build-binaries Workflow

`.github/workflows/build-binaries.yml` triggers on `rfdb-v*` tags (a separate tag scheme from the main `v*` release tags). The binary build uses whatever is in `Cargo.toml`. No version validation happens here.

**Note:** The rfdb binary release uses a different tag convention than the npm release. This is a related but separate concern — for this task, we focus on making Cargo version match npm version.

---

## 5. build.rs — Currently Not Useful for Versioning

`packages/rfdb-server/build.rs` only handles N-API linking flags. It does not inject any version information. However, `build.rs` can read environment variables and emit `cargo:rustc-env=...` directives, which could be used to override `CARGO_PKG_VERSION` — but that approach is not recommended (explained in the plan).

---

## 6. Other Packages' Versioning Strategy

All other packages (`packages/types`, `packages/core`, `packages/cli`, etc.) have only `package.json` — they are pure TypeScript/Node packages. The monorepo uses npm/pnpm unified versioning for all of these. `packages/rfdb-server` is the only package that also has a `Cargo.toml`, which makes it unique in this monorepo.

The root `package.json` version (currently `0.2.11`) is the canonical version for the entire monorepo.

---

## 7. Prior Art Research

**Tauri** (the most analogous Rust+npm hybrid project at scale) handles this as follows:
- `tauri.conf.json` can reference `package.json` for version (making npm the source of truth)
- No automatic Cargo.toml sync — they acknowledge it as a limitation and have an open feature request: [tauri-apps/tauri#8265](https://github.com/tauri-apps/tauri/issues/8265)
- Manual sync is the common approach in the community

**cargo-edit** (`cargo set-version`) is the canonical Rust tool for programmatic Cargo.toml version updates. It safely parses TOML (no regex hacks).

**wasm-pack / napi-rs** do not provide cross-manifest version sync — they expect users to manage versions manually or via CI scripts.

**The `version-sync` crate** can verify in tests that a crate's version matches other files — but it's a Rust test, not a CI shell check.

**Simplest widely-used pattern:** A shell script that reads from the single source of truth and writes to the other manifest before building. This is what Tauri users typically do.

---

## 8. Summary of Findings

| Finding | Detail |
|---------|--------|
| Cargo version | `0.1.0` — never updated since project start |
| npm version | `0.2.11` — updated by release script |
| Release script | Updates npm packages only, ignores Cargo.toml |
| CI check | Verifies npm versions only, ignores Cargo.toml |
| Source of truth | npm (root package.json) — used by release script |
| Consumer of Cargo version | Wire protocol (ping, hello responses), `--version` flag, startup log |
| Build tooling | No existing mechanism for Cargo version injection |
| Risk of drift | HIGH — every release bumps npm but not Cargo |

---

## 9. Key Decision: Which Is the Source of Truth?

**npm `package.json` is the source of truth.** Reasons:
1. The release script already manages npm versions as canonical
2. CI already validates npm versions
3. The monorepo is npm-first — all other packages are npm-only
4. npm version has tracked actual releases (0.2.11); Cargo has been static at 0.1.0 since forever
5. Users consume this via `npm install @grafema/rfdb` — the npm version is what they see

Therefore: when releasing, update `Cargo.toml` to match the npm version.
