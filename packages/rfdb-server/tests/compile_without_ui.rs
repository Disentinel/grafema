//! Verifies that the crate compiles cleanly with `--no-default-features`,
//! i.e. without the `ui` feature. This is the compile-time contract for
//! downstream consumers (e.g. CI images without a GUI toolchain).
//!
//! The test spawns a nested `cargo build` against an isolated `--target-dir`
//! so it doesn't stomp on the parent invocation's incremental state nor
//! re-enter recursively.

use std::path::PathBuf;
use std::process::Command;

/// Locate `packages/rfdb-server/Cargo.toml` starting from the crate this
/// integration test is compiled against. Independent of cwd so the test is
/// robust to how cargo launches it.
fn manifest_path() -> PathBuf {
    // CARGO_MANIFEST_DIR = `.../packages/rfdb-server` at build time of this test
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    crate_root.join("Cargo.toml")
}

fn isolated_target_dir() -> PathBuf {
    // Use a path under the system temp dir so it's writable on CI runners and
    // can be cleaned up by the OS.
    let mut p = std::env::temp_dir();
    p.push("rfdb-compile-without-ui-target");
    p
}

#[test]
fn compiles_without_ui_feature() {
    // `env!("CARGO")` is set by cargo when invoking test binaries; using it
    // keeps us aligned with the same toolchain that compiled this test.
    let cargo = env!("CARGO");
    let manifest = manifest_path();
    let target_dir = isolated_target_dir();

    let output = Command::new(cargo)
        .args([
            "build",
            "--manifest-path",
        ])
        .arg(&manifest)
        .args([
            "--no-default-features",
            "--lib",
            "--target-dir",
        ])
        .arg(&target_dir)
        .output()
        .expect("failed to spawn nested cargo build");

    if !output.status.success() {
        panic!(
            "cargo build --no-default-features failed.\n--- stdout ---\n{}\n--- stderr ---\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}
