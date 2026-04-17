//! Build-time preparation of the embedded UI dist tree.
//!
//! When the `ui` feature is enabled (default), we copy the Grafema GUI dist
//! (typically `packages/gui/dist/`) into `OUT_DIR/ui-dist/` so that
//! `rust-embed` can embed it at compile time. The source is chosen as follows:
//!
//! 1. If the env var `GRAFEMA_UI_DIST` is set, copy from that path.
//! 2. Otherwise write a loud placeholder `index.html` and print a warning.
//!
//! Without the `ui` feature this file is a no-op.
//!
//! C14b will consume `OUT_DIR/ui-dist/` via `RustEmbed` and the marker file
//! `OUT_DIR/ui-dist-path.txt` (just a text file with the absolute path).

use std::env;
#[cfg(feature = "ui")]
use std::fs;
#[cfg(feature = "ui")]
use std::path::PathBuf;

fn main() {
    // Re-run when the env var flips on/off or changes value. Cheap, and works
    // both with and without the `ui` feature.
    println!("cargo:rerun-if-env-changed=GRAFEMA_UI_DIST");

    #[cfg(feature = "ui")]
    prepare_ui_dist();

    // Without the `ui` feature, `build.rs` is effectively a no-op aside from
    // the rerun-if-env-changed directive above.
    let _ = env::var("OUT_DIR"); // touch to silence unused_imports on no-ui builds
}

#[cfg(feature = "ui")]
fn prepare_ui_dist() {
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");
    let target_dir = PathBuf::from(&out_dir).join("ui-dist");

    // Always start from a clean tree so stale files from a previous build
    // don't linger.
    if target_dir.exists() {
        fs::remove_dir_all(&target_dir).expect("failed to clear stale ui-dist");
    }
    fs::create_dir_all(&target_dir).expect("failed to create ui-dist");

    match env::var("GRAFEMA_UI_DIST") {
        Ok(src) => {
            let src_path = PathBuf::from(&src);
            if !src_path.exists() {
                panic!(
                    "GRAFEMA_UI_DIST={} does not exist. Build the GUI first \
                     (`pnpm --filter @grafema/gui build`) or unset the variable \
                     to fall back to the placeholder.",
                    src
                );
            }
            if !src_path.is_dir() {
                panic!("GRAFEMA_UI_DIST={} is not a directory", src);
            }
            copy_dir(&src_path, &target_dir).expect("failed to copy ui dist");
            watch_dir(&src_path);
            println!("cargo:warning=UI dist embedded from {}", src);
        }
        Err(_) => {
            // No source — write a loud placeholder so mis-configured builds
            // are obvious at runtime.
            let placeholder = target_dir.join("index.html");
            fs::write(&placeholder, PLACEHOLDER_HTML)
                .expect("failed to write placeholder index.html");
            println!("cargo:warning=╔═══════════════════════════════════════════════════════╗");
            println!("cargo:warning=║  UI BUNDLE NOT BUILT                                  ║");
            println!("cargo:warning=║  Run: scripts/build-gui-for-rfdb.sh                   ║");
            println!("cargo:warning=║  Or set GRAFEMA_UI_DIST=/path/to/packages/gui/dist    ║");
            println!("cargo:warning=║  Otherwise /ui/* will serve a placeholder page        ║");
            println!("cargo:warning=╚═══════════════════════════════════════════════════════╝");
        }
    }

    // Emit a small marker file used by C14b's RustEmbed wiring to locate the
    // staged dist tree without duplicating env-var logic.
    let ui_dist_marker = PathBuf::from(&out_dir).join("ui-dist-path.txt");
    fs::write(&ui_dist_marker, target_dir.to_string_lossy().as_bytes())
        .expect("failed to write ui-dist-path.txt marker");
}

#[cfg(feature = "ui")]
const PLACEHOLDER_HTML: &str = r#"<!doctype html>
<html><head><title>Grafema UI not built</title></head>
<body style="font-family:sans-serif;background:#fff0f0;color:#800;padding:40px">
  <h1>⚠ UI bundle not built</h1>
  <p>The rfdb-server was compiled with <code>--features=ui</code> but <code>GRAFEMA_UI_DIST</code> was not set.</p>
  <p>To fix: run <code>scripts/build-gui-for-rfdb.sh</code> or set the env var and rebuild.</p>
</body></html>
"#;

#[cfg(feature = "ui")]
fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir(&entry.path(), &dst_path)?;
        } else {
            fs::copy(entry.path(), dst_path)?;
        }
    }
    Ok(())
}

/// Emit `cargo:rerun-if-changed` directives for every entry under `dir`,
/// recursively. This keeps builds incremental when the GUI dist changes.
///
/// Note: cargo tracks mtimes of these paths and re-runs `build.rs` when any
/// of them change. Directory entries alone are enough to pick up added/removed
/// files inside, but we also list files individually for added robustness on
/// platforms whose dir mtimes don't always propagate.
#[cfg(feature = "ui")]
fn watch_dir(dir: &std::path::Path) {
    if dir.is_dir() {
        println!("cargo:rerun-if-changed={}", dir.display());
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                println!("cargo:rerun-if-changed={}", path.display());
                if path.is_dir() {
                    watch_dir(&path);
                }
            }
        }
    }
}
