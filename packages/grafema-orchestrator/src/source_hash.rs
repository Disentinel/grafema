//! Source hash verification for detecting stale native binaries.
//!
//! Each native package (Haskell, Rust) can have a `.build-hash` sidecar file
//! containing the SHA-256 hash of all source files at build time. Before running
//! a binary, we recompute the hash and compare. If they differ, the binary is
//! stale and needs rebuilding.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Binary-to-source package mapping.
/// Maps a binary name to the package directory containing its source.
pub struct BinarySourceMap {
    entries: Vec<(String, &'static str)>,
}

impl BinarySourceMap {
    /// Create the default mapping of binary names to source package directories.
    pub fn default_map() -> Self {
        Self {
            entries: vec![
                ("grafema-analyzer".into(), "packages/js-analyzer"),
                ("grafema-resolve".into(), "packages/grafema-resolve"),
                ("haskell-resolve".into(), "packages/haskell-resolve"),
                ("haskell-analyzer".into(), "packages/haskell-analyzer"),
                ("grafema-rust-resolve".into(), "packages/rust-resolve"),
                ("grafema-java-analyzer".into(), "packages/java-analyzer"),
                ("java-resolve".into(), "packages/java-resolve"),
                ("java-parser".into(), "packages/java-parser"),
                ("grafema-kotlin-analyzer".into(), "packages/kotlin-analyzer"),
                ("kotlin-resolve".into(), "packages/kotlin-resolve"),
                ("kotlin-parser".into(), "packages/kotlin-parser"),
                ("jvm-cross-resolve".into(), "packages/jvm-cross-resolve"),
            ],
        }
    }

    /// Look up the source package directory for a binary name.
    pub fn find_package(&self, binary_name: &str) -> Option<&str> {
        // Extract just the binary name from a full path
        let name = Path::new(binary_name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(binary_name);

        self.entries
            .iter()
            .find(|(bin, _)| bin == name)
            .map(|(_, pkg)| *pkg)
    }
}

/// Compute SHA-256 hash of all source files in a directory.
///
/// Scans for `*.hs` and `*.rs` files under `<dir>/src/`, sorts them by path,
/// then computes SHA-256 of each file's content concatenated with its relative path.
/// Returns the final hash as a hex string, matching the shell script's output.
pub fn compute_source_hash(pkg_dir: &Path) -> Option<String> {
    let src_dir = pkg_dir.join("src");
    if !src_dir.is_dir() {
        return None;
    }

    // Collect all source files (BTreeSet de-duplicates).
    let mut file_set = BTreeSet::new();
    collect_source_files(&src_dir, &mut file_set);

    if file_set.is_empty() {
        return None;
    }

    // Order files exactly like the shell pipeline in build-native.sh:
    //   find src -type f ... | LC_ALL=C sort
    // which byte-sorts the relative-path STRINGS ("src/Walker.hs" < "src/Walker/Types.hs"
    // because '.' 0x2E < '/' 0x2F). A BTreeSet<PathBuf> iterates in PathBuf *component*
    // order, which orders "src/Walker/Types.hs" before "src/Walker.hs" — a different
    // sequence (hence a different final hash) whenever a file shares a name prefix with
    // a sibling directory (the idiomatic nested-module layout, e.g. a `Walker` module
    // with `Walker/` submodules). Re-sort by the same string `find | sort` produces so
    // the recomputed hash equals the `.build-hash` sidecar and verify_binary doesn't
    // falsely abort a fresh build with "Stale binary detected".
    let mut files: Vec<PathBuf> = file_set.into_iter().collect();
    files.sort_by(|a, b| {
        let ra = a.strip_prefix(pkg_dir).unwrap_or(a).to_string_lossy();
        let rb = b.strip_prefix(pkg_dir).unwrap_or(b).to_string_lossy();
        ra.cmp(&rb)
    });

    // Replicate the shell script's approach:
    // find src/ -type f \( -name '*.hs' -o -name '*.rs' \) | sort | xargs shasum -a 256 | shasum -a 256
    //
    // Step 1: For each file, compute "sha256(content)  relative_path\n"
    // Step 2: Concatenate all those lines
    // Step 3: sha256 the concatenation
    use std::fmt::Write;

    let mut all_hashes = String::new();
    for file_path in &files {
        let mut content = Vec::new();
        if let Ok(mut f) = std::fs::File::open(file_path) {
            if f.read_to_end(&mut content).is_err() {
                continue;
            }
        } else {
            continue;
        }

        // Compute sha256 of file content
        let file_hash = sha256_hex(&content);

        // Get path relative to pkg_dir (to match `find src/` output)
        let rel_path = file_path
            .strip_prefix(pkg_dir)
            .unwrap_or(file_path)
            .display();

        // Format like shasum output: "hash  path\n"
        let _ = writeln!(all_hashes, "{}  {}", file_hash, rel_path);
    }

    // Final hash of all the per-file hashes
    let final_hash = sha256_hex(all_hashes.as_bytes());
    Some(final_hash)
}

/// Read the `.build-hash` sidecar file from a package directory.
pub fn read_build_hash(pkg_dir: &Path) -> Option<String> {
    let hash_file = pkg_dir.join(".build-hash");
    std::fs::read_to_string(&hash_file)
        .ok()
        .map(|s| s.trim().to_string())
}

/// Verify that a binary's source hasn't changed since it was last built.
///
/// Returns `Ok(())` if hash matches or verification is not possible (no src dir, no .build-hash).
/// Returns `Err(message)` if hash mismatch detected (stale binary).
pub fn verify_binary(binary_name: &str, project_root: &Path) -> Result<(), String> {
    let source_map = BinarySourceMap::default_map();

    let pkg_rel = match source_map.find_package(binary_name) {
        Some(p) => p,
        None => return Ok(()), // Unknown binary, skip verification
    };

    let pkg_dir = project_root.join(pkg_rel);
    if !pkg_dir.is_dir() {
        return Ok(()); // Package not present (e.g., not all languages installed)
    }

    let build_hash = match read_build_hash(&pkg_dir) {
        Some(h) => h,
        None => {
            // No .build-hash file — warn but don't block
            tracing::warn!(
                binary = binary_name,
                package = pkg_rel,
                "No .build-hash found — cannot verify binary freshness. \
                 Run: scripts/build-native.sh {pkg_rel} <build-command>"
            );
            return Ok(());
        }
    };

    let current_hash = match compute_source_hash(&pkg_dir) {
        Some(h) => h,
        None => return Ok(()), // No source files, skip
    };

    if build_hash == current_hash {
        tracing::debug!(
            binary = binary_name,
            hash = %current_hash,
            "Binary source hash verified"
        );
        Ok(())
    } else {
        Err(format!(
            "Stale binary detected: {binary_name}\n\
             Source in {pkg_rel} has changed since last build.\n\
             Build hash:   {build_hash}\n\
             Current hash: {current_hash}\n\n\
             Rebuild with:\n  cd {pkg_rel} && <build-command>\n\
             Or use: scripts/build-native.sh {pkg_rel} <build-command>"
        ))
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Recursively collect `.hs` and `.rs` files into a sorted set.
fn collect_source_files(dir: &Path, files: &mut BTreeSet<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_source_files(&path, files);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if ext == "hs" || ext == "rs" {
                files.insert(path);
            }
        }
    }
}

/// Compute SHA-256 hex digest of a byte slice.
fn sha256_hex(data: &[u8]) -> String {
    // Inline SHA-256 to avoid adding a dependency — we only need it for
    // short hash chains (not crypto-critical). Use the system's shasum
    // algorithm compatibility.
    //
    // Since the orchestrator already has blake3, we could use that instead,
    // but we need SHA-256 to match the shell script's `shasum -a 256` output.
    // Using a minimal implementation.
    sha256_impl(data)
}

/// Minimal SHA-256 implementation (no external crate needed).
/// This is only used for source hash verification, not security-critical.
fn sha256_impl(data: &[u8]) -> String {
    // Rather than implementing SHA-256 from scratch or adding a crate,
    // shell out to shasum which is available on macOS and Linux.
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = match Command::new("shasum")
        .args(["-a", "256"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => {
            // Try sha256sum (Linux)
            match Command::new("sha256sum")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(c) => c,
                Err(_) => return String::new(),
            }
        }
    };

    if let Some(ref mut stdin) = child.stdin {
        let _ = stdin.write_all(data);
    }
    drop(child.stdin.take());

    match child.wait_with_output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout.split_whitespace().next().unwrap_or("").to_string()
        }
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_compute_source_hash_deterministic() {
        let tmp = std::env::temp_dir().join("grafema-hash-test");
        let src = tmp.join("src");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&src).unwrap();

        fs::write(src.join("Main.hs"), "module Main where\nmain = putStrLn \"hello\"\n").unwrap();
        fs::write(src.join("Lib.hs"), "module Lib where\nfoo = 42\n").unwrap();

        let hash1 = compute_source_hash(&tmp).unwrap();
        let hash2 = compute_source_hash(&tmp).unwrap();
        assert_eq!(hash1, hash2, "Hash should be deterministic");
        assert_eq!(hash1.len(), 64, "SHA-256 hex should be 64 chars");

        // Modify a file — hash should change
        fs::write(src.join("Lib.hs"), "module Lib where\nfoo = 43\n").unwrap();
        let hash3 = compute_source_hash(&tmp).unwrap();
        assert_ne!(hash1, hash3, "Hash should change when source changes");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_nested_module_matches_string_sort_order() {
        // Regression: a `Foo.hs` file sitting beside a `Foo/` directory is the
        // idiomatic nested-module layout (e.g. `src/Walker.hs` + `src/Walker/Types.hs`).
        // The `.build-hash` sidecar is written by build-native.sh, which orders files
        // with `find src ... | sort` — a byte-wise sort of the path STRINGS, so
        // "src/Walker.hs" precedes "src/Walker/Types.hs" ('.' 0x2E < '/' 0x2F).
        // `compute_source_hash` must reproduce that exact order, otherwise the
        // recomputed hash differs from `.build-hash` and `verify_binary` falsely
        // aborts analysis with "Stale binary detected" on a perfectly fresh build.
        let tmp = std::env::temp_dir().join(format!("grafema-hash-nested-{}", std::process::id()));
        let src = tmp.join("src");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(src.join("Walker")).unwrap();

        fs::write(src.join("Main.hs"), "module Main where\n").unwrap();
        fs::write(src.join("Walker.hs"), "module Walker where\n").unwrap();
        fs::write(src.join("Walker").join("Types.hs"), "module Walker.Types where\n").unwrap();

        // Oracle: replicate the shell pipeline's ordering independently — sort the
        // relative-path strings (byte order, == `LC_ALL=C sort`), then for each file
        // emit "sha256(content)  relpath\n" and hash the concatenation.
        use std::fmt::Write;
        let mut rels: Vec<(String, PathBuf)> = vec![
            ("src/Main.hs".to_string(), src.join("Main.hs")),
            ("src/Walker.hs".to_string(), src.join("Walker.hs")),
            ("src/Walker/Types.hs".to_string(), src.join("Walker").join("Types.hs")),
        ];
        rels.sort_by(|a, b| a.0.cmp(&b.0));
        let mut expected_concat = String::new();
        for (rel, path) in &rels {
            let content = fs::read(path).unwrap();
            let _ = writeln!(expected_concat, "{}  {}", sha256_hex(&content), rel);
        }
        let expected = sha256_hex(expected_concat.as_bytes());

        let actual = compute_source_hash(&tmp).unwrap();
        assert_eq!(
            actual, expected,
            "compute_source_hash must order files by path STRING (matching \
             `find src | sort`), not by PathBuf component order"
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_binary_source_map() {
        let map = BinarySourceMap::default_map();
        assert_eq!(map.find_package("grafema-analyzer"), Some("packages/js-analyzer"));
        assert_eq!(map.find_package("grafema-resolve"), Some("packages/grafema-resolve"));
        assert_eq!(
            map.find_package("/Users/foo/.cabal/bin/grafema-analyzer"),
            Some("packages/js-analyzer")
        );
        assert_eq!(map.find_package("unknown-binary"), None);
    }
}
