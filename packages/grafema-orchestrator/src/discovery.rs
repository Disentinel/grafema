//! File discovery: walk project root, match include/exclude patterns.
//!
//! Uses the `ignore` crate's `OverrideBuilder` for glob matching, which
//! properly supports `**` for recursive directory matching (unlike `glob::Pattern`
//! whose `matches()` method treats `**` as two consecutive `*` wildcards).

use crate::config::AnalyzerConfig;
use anyhow::{Context, Result};
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use std::path::{Path, PathBuf};

/// Discover source files matching the config's include/exclude patterns.
///
/// Walks `config.root`, respecting `.gitignore` and hidden-file defaults.
/// Files are returned sorted by path for deterministic ordering.
pub fn discover(config: &AnalyzerConfig) -> Result<Vec<PathBuf>> {
    discover_files(&config.root, &config.include, &config.exclude)
}

/// Lower-level discovery: walk `root` matching `include` globs, skipping `exclude` globs.
///
/// Include patterns are added as plain whitelist overrides.
/// Exclude patterns are prefixed with `!` to become ignore overrides.
/// The `ignore` crate's override system handles `**` correctly via `globset` internally.
fn discover_files(root: &Path, include: &[String], exclude: &[String]) -> Result<Vec<PathBuf>> {
    let mut builder = OverrideBuilder::new(root);

    // In the override system, a plain glob is a *whitelist* (include),
    // and a `!`-prefixed glob is an *ignore* (exclude).
    // Unmatched files are automatically ignored when any whitelist exists.
    for pattern in include {
        builder
            .add(pattern)
            .with_context(|| format!("Invalid include pattern: {pattern}"))?;
    }

    for pattern in exclude {
        builder
            .add(&format!("!{pattern}"))
            .with_context(|| format!("Invalid exclude pattern: {pattern}"))?;
    }

    let overrides = builder.build().context("Failed to build glob override set")?;

    let walker = WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .overrides(overrides)
        .build();

    let mut files = Vec::new();

    for entry in walker {
        let entry = entry?;
        if !entry.file_type().map_or(false, |ft| ft.is_file()) {
            continue;
        }
        files.push(entry.into_path());
    }

    if files.is_empty() {
        tracing::warn!(
            root = %root.display(),
            include = ?include,
            exclude = ?exclude,
            "No files matched discovery patterns"
        );
    }

    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// Create a unique temp directory and populate it with the given file paths.
    fn create_test_tree(files: &[&str]) -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join("grafema-discovery-tests")
            .join(format!("{}_{}", std::process::id(), id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        for file in files {
            let path = dir.join(file);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, "// test content").unwrap();
        }
        dir
    }

    /// Best-effort cleanup.
    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn discover_js_files_flat() {
        let dir = create_test_tree(&["a.js", "b.js", "c.txt"]);
        let files = discover_files(&dir, &["*.js".to_string()], &[]).unwrap();

        let names: Vec<&str> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap())
            .collect();
        assert_eq!(names, vec!["a.js", "b.js"]);
        cleanup(&dir);
    }

    #[test]
    fn discover_nested_with_double_star() {
        let dir = create_test_tree(&[
            "src/index.js",
            "src/utils/helper.js",
            "src/utils/deep/nested.js",
            "README.md",
        ]);

        let files = discover_files(&dir, &["src/**/*.js".to_string()], &[]).unwrap();

        assert_eq!(
            files.len(),
            3,
            "Expected 3 JS files under src/, got: {files:?}"
        );
        for f in &files {
            assert!(f.extension().unwrap() == "js");
        }
        cleanup(&dir);
    }

    #[test]
    fn exclude_patterns_work() {
        let dir = create_test_tree(&[
            "src/app.js",
            "src/test.spec.js",
            "src/utils/helper.js",
            "src/utils/helper.spec.js",
        ]);

        let files = discover_files(
            &dir,
            &["**/*.js".to_string()],
            &["**/*.spec.js".to_string()],
        )
        .unwrap();

        let names: Vec<String> = files
            .iter()
            .map(|p| {
                p.strip_prefix(&dir)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names.len(), 2);
        assert!(names.iter().all(|n| !n.contains("spec")));
        cleanup(&dir);
    }

    #[test]
    fn empty_result_does_not_error() {
        let dir = create_test_tree(&["a.txt", "b.md"]);
        let files = discover_files(&dir, &["**/*.js".to_string()], &[]).unwrap();

        assert!(files.is_empty());
        cleanup(&dir);
    }

    #[test]
    fn multiple_include_patterns() {
        let dir = create_test_tree(&["app.js", "style.css", "data.json", "readme.md"]);

        let files = discover_files(
            &dir,
            &["*.js".to_string(), "*.css".to_string()],
            &[],
        )
        .unwrap();

        let names: Vec<&str> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap())
            .collect();
        assert_eq!(names, vec!["app.js", "style.css"]);
        cleanup(&dir);
    }

    #[test]
    fn results_are_sorted() {
        let dir = create_test_tree(&["z.js", "a.js", "m.js"]);
        let files = discover_files(&dir, &["*.js".to_string()], &[]).unwrap();

        let names: Vec<&str> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap())
            .collect();
        assert_eq!(names, vec!["a.js", "m.js", "z.js"]);
        cleanup(&dir);
    }

    #[test]
    fn invalid_pattern_returns_error() {
        let dir = create_test_tree(&[]);
        let result = discover_files(&dir, &["[invalid".to_string()], &[]);
        assert!(result.is_err());
        cleanup(&dir);
    }

    #[test]
    fn discover_via_config() {
        let dir = create_test_tree(&["src/main.js", "src/lib/utils.js", "test/test.js"]);

        let config = AnalyzerConfig {
            root: dir.clone(),
            include: vec!["src/**/*.js".to_string()],
            exclude: vec![],
            plugins: vec![],
            rfdb_socket: None,
            analyzers: Default::default(),
            services: vec![],
        };

        let files = discover(&config).unwrap();
        assert_eq!(files.len(), 2);
        for f in &files {
            let rel = f.strip_prefix(&dir).unwrap();
            assert!(rel.starts_with("src"));
        }
        cleanup(&dir);
    }

    #[test]
    fn hidden_directory_files_skipped() {
        // Override whitelists take highest precedence, so a hidden *file* that
        // matches an include pattern IS included. However, hidden *directories*
        // are pruned before the walker descends, so files inside them are not found.
        let dir = create_test_tree(&["visible.js", ".hidden.js", ".hidden_dir/secret.js"]);

        let files = discover_files(&dir, &["**/*.js".to_string()], &[]).unwrap();

        let names: Vec<&str> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_str().unwrap())
            .collect();
        // .hidden.js is included because the override whitelist has highest precedence.
        // .hidden_dir/secret.js is excluded because the hidden directory is pruned.
        assert_eq!(names, vec![".hidden.js", "visible.js"]);
        cleanup(&dir);
    }

    #[test]
    fn exclude_entire_directory() {
        let dir = create_test_tree(&[
            "src/app.js",
            "vendor/lib.js",
            "vendor/deep/other.js",
        ]);

        let files = discover_files(
            &dir,
            &["**/*.js".to_string()],
            &["vendor/**".to_string()],
        )
        .unwrap();

        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("app.js"));
        cleanup(&dir);
    }
}
