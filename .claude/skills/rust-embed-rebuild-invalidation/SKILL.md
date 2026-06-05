---
name: rust-embed-rebuild-invalidation
description: |
  Force `rust-embed` to re-embed assets from `$GRAFEMA_UI_DIST` (or any env-driven path) when cargo's incremental compilation skips the macro re-expansion. Use when:
  (1) you rebuilt the GUI bundle but the rust-server binary still serves the OLD bundle,
  (2) `cargo build --release` finishes in seconds (incremental hit) and `strings target/release/binary | grep <new-hash>` finds nothing,
  (3) any rust-embed pipeline where assets live outside the cargo source tree and are picked up via env var or symlink.
  Cargo only re-runs the proc macro when the rust file declaring `#[derive(RustEmbed)]` changes — env var changes alone don't trigger it.
author: Claude Code
version: 1.0.0
date: 2026-04-25
---

# Rust-Embed Rebuild Invalidation

## Problem

`rfdb-server` embeds the GUI bundle via `rust-embed`:

```rust
#[derive(RustEmbed)]
#[folder = "$GRAFEMA_UI_DIST"]
pub struct UiAssets;
```

You rebuild the GUI:

```bash
pnpm --filter @grafema/gui build       # produces dist/assets/HexAtlas-NEW.js
GRAFEMA_UI_DIST=$(pwd)/packages/gui/dist cargo build --release -p rfdb
```

Cargo says "Finished in 6 seconds" — way too fast for a full re-embed. You start the server, hit the URL, and `curl http://localhost:51833/ui/default | grep HexAtlas` returns the **OLD hash**. Re-running the build doesn't help.

## Why this happens

`rust-embed` is a `proc_macro` evaluated at compile time. Cargo decides whether to re-run a proc-macro by hashing the source file that contains the `#[derive(RustEmbed)]`. **Changes to environment variables (like `GRAFEMA_UI_DIST`) or to the contents of the asset folder do not invalidate the proc-macro.** Cargo treats it as cache-hit, the previously expanded include-bytes! tree stays embedded, and your new asset never makes it into the binary.

## Fix — touch the host file

```bash
touch packages/rfdb-server/src/static_ui.rs
GRAFEMA_UI_DIST=$(pwd)/packages/gui/dist cargo build --release -p rfdb
```

`touch` updates the file's mtime, which forces cargo to re-run the proc-macro, which re-reads the env var, which re-embeds the new assets. Build will take longer (full rust-embed re-expansion).

Verify:

```bash
strings target/release/rfdb-server | grep -E "HexAtlas-[A-Za-z0-9]+\.js" | head -3
# Should print the NEW hash (matches dist/assets/HexAtlas-NEW.js)
```

## Why not `cargo clean`?

Works, but overkill — clears the entire target/, ~5 minute full rebuild. Touching one file is ~30 seconds and surgical.

## Detection — how to know you've been bitten

If after `cargo build --release`:

1. `ls -la target/release/<binary>` — is the mtime older than your last `pnpm build`?
2. `strings target/release/<binary> | grep <known-new-hash>` — empty? You hit this bug.

**Always verify embed freshness before debugging "the server returns old data".** It's the second-most-common false-trail (after stale process on the port — see `zombie-process-port-hunt`).

## Project script

For the Grafema build pipeline, the canonical recipe (from `scripts/build-gui-for-rfdb.sh`) should be:

```bash
pnpm --filter @grafema/gui build
touch packages/rfdb-server/src/static_ui.rs    # ← invalidate macro
GRAFEMA_UI_DIST=$(pwd)/packages/gui/dist \
  cargo build --release -p rfdb
```

Without the `touch`, the script's "rebuild rfdb-server with new bundle baked in" promise is silently broken on incremental builds.

## Generalization

This pattern applies to any cargo proc-macro that reads files or env vars at expansion time:

- `include_bytes!` / `include_str!` — same problem if the included path is outside cargo's tracked tree
- `serde_json::from_str(include_str!(...))` — same
- Custom build.rs that reads from `$ENV` and writes a generated source — usually OK if `cargo:rerun-if-env-changed=ENV` is declared, but easy to forget

If you see "fast cargo rebuild + stale embedded data" for any of these — the workaround (`touch` the host file) generalizes.
