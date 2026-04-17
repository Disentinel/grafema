---
name: rust-cargo-fast-iteration-profile
description: |
  Speed up Rust development iteration when `cargo build --release` takes
  10+ minutes even for one-line edits. Use when: (1) every release rebuild
  takes minutes despite tiny edits, (2) Cargo.toml has `lto = "fat"` and/or
  `codegen-units = 1` in `[profile.release]`, (3) you want a production-
  shaped build for testing without paying the LTO cost on every iteration,
  (4) you suspect cargo is re-linking the whole binary instead of doing
  incremental work, (5) developing rfdb/grafema-orchestrator/large Rust
  binaries where full LTO is enabled for shipped builds. Adds a `fast`
  profile that inherits release but disables LTO, raises codegen-units,
  enables incremental compilation — first build still slow because it
  populates a fresh `target/fast/` dep cache, but every subsequent
  rebuild drops from ~13 min to ~13 s (≈60×).
author: Claude Code
version: 1.0.0
date: 2026-04-07
---

# Rust Cargo Fast Iteration Profile

## Problem

`cargo build --release` takes **12–15 minutes** for a single-line edit in
a Rust project. Hours of development time get burned waiting for a
binary that should rebuild in seconds.

The cause is almost always two settings in `Cargo.toml`:

```toml
[profile.release]
lto = "fat"          # Full link-time optimization across all crates
codegen-units = 1    # Single-threaded codegen, no parallelism
```

These are **correct for shipping**: they produce the smallest, fastest
binary. They are **disastrous for iteration** because every edit
triggers:

1. Re-codegen of the affected crate(s)
2. Re-link of the entire dependency graph through fat LTO
3. No parallel codegen (codegen-units=1)
4. No incremental compilation (release profile disables it)

The result: a one-character change in one source file forces ~minutes
of work even though the cached dependency `.rlib`s are still valid.

## Context / Trigger Conditions

- `cargo build --release` consistently takes >5 minutes for tiny edits.
- `Cargo.toml` contains `lto = "fat"` and/or `codegen-units = 1` under
  `[profile.release]`.
- Your dev loop is `edit → build → run rfdb-server / grafema-orchestrator
  → curl test → repeat`, and the build dominates wall-clock.
- You're afraid to make experimental changes because each iteration
  costs ~15 minutes.
- `target/release/incremental/` is empty or doesn't exist (release
  profile leaves it disabled by default).
- You see `Compiling rfdb v0.3.24` followed by a long pause every time
  even though only one file changed.

## Solution

### 1. Add a `fast` profile to `Cargo.toml`

Append a new profile that inherits release but flips the slow knobs:

```toml
# Fast iteration profile: ~30s rebuilds vs ~15min for full release.
# Use during development with `cargo build --profile fast`. Binary is
# slightly slower at runtime (no LTO, more codegen units) but the
# trade-off is enormous for the edit/test cycle.
[profile.fast]
inherits = "release"
opt-level = 2          # Drop from 3 → 2; 90 % of perf, way faster
lto = "off"            # Skip the multi-minute fat LTO link step
codegen-units = 16     # Parallel codegen across cores
incremental = true     # Reuse per-function compilation artifacts
debug = false          # Keep binary lean
```

`inherits = "release"` is required: it picks up everything from
`[profile.release]` and overrides only the listed keys.

### 2. Use it for development

```bash
# First build is still slow — populates target/fast/ from scratch
cargo build --profile fast --bin <your-bin>      # ~12 min

# Every subsequent rebuild is incremental
touch src/foo.rs
cargo build --profile fast --bin <your-bin>      # ~13 s
```

The binary lives at `target/fast/<bin>` (NOT `target/release/<bin>`).

### 3. Keep `--release` for shipping

Production builds, CI release artifacts, benchmarks etc. continue to
use `cargo build --release`. You're not changing what gets shipped —
just what you build during the edit/test loop.

## Verification

Measure both the cold and hot builds:

```bash
# Cold build (clean target/fast/)
cargo clean -p <pkg>
time cargo build --profile fast --bin <bin>
# → ~10–15 min on first run, similar to release

# Hot incremental rebuild
touch src/<changed-file>.rs
time cargo build --profile fast --bin <bin>
# → ~10–30 s for a single-file change
```

If the second build is still minutes:

- Confirm `inherits = "release"` is present and `incremental = true`
- Run with `CARGO_LOG=cargo::core::compiler::fingerprint=info` to see
  which fingerprints are dirty
- Check that you're not running `cargo build --release` and
  `cargo build --profile fast` interchangeably (each maintains its
  own target dir, so they invalidate each other's incremental cache)

## Example

In the grafema RFDB server (`packages/rfdb-server/Cargo.toml`),
release profile was:

```toml
[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
```

A one-line edit in `src/http_server.rs` was rebuilding the binary in
**12–15 minutes**. After adding `[profile.fast]`:

```bash
$ touch src/http_server.rs
$ time cargo build --profile fast --bin rfdb-server
   Compiling rfdb v0.3.24
    Finished `fast` profile [optimized] target(s) in 13.00s
```

**13 seconds**. ~60× faster iteration. Run from
`target/fast/rfdb-server`.

## Notes

- **Disk cost**: `target/fast/` lives next to `target/release/` and is
  comparable in size (hundreds of MB to a few GB). Worth it.
- **Don't ship from `target/fast/`** — runtime perf is 10–20% slower
  than full release on hot paths because LTO is off and opt-level is 2.
- **Switching profiles invalidates the other's incremental cache**. If
  you alternate `--release` and `--profile fast`, both will be slow.
  Pick one for the dev loop and stick with it.
- **Linking time**: macOS `ld64` and Linux `ld.lld` benefit most from
  `lto = "off"`. The fat LTO link is the dominant time on a single-file
  change, not codegen.
- **`opt-level = 2` vs `0`**: `0` would be faster to build but the
  binary becomes painfully slow for any non-trivial workload (RFDB
  with `opt-level = 0` is roughly 10× slower than release). `2` is
  the sweet spot for "production-shaped but builds fast".
- **`debug = false`**: Without this, you also pay debug-info generation
  cost on each rebuild. Skip it unless you actually need symbols.
- **Alternative name**: some projects call this profile `dev-release`,
  `quick`, or `iter`. The name is arbitrary; only the keys matter.
- **Combine with `mold` or `lld`** linker for further linking
  speedups on Linux. macOS users get the system linker which is
  already reasonable.

## Related Files

- `packages/rfdb-server/Cargo.toml` — has the `fast` profile applied
- `packages/grafema-orchestrator/Cargo.toml` — has the same problem
  (lto=fat + codegen-units=1), apply the same fix when iterating on it

## References

- [Cargo Profiles documentation](https://doc.rust-lang.org/cargo/reference/profiles.html)
- [Profile inheritance via `inherits`](https://doc.rust-lang.org/cargo/reference/profiles.html#custom-profiles)
- [Incremental compilation](https://doc.rust-lang.org/cargo/reference/profiles.html#incremental)
