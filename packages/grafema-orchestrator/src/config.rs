//! Configuration parsing for grafema.config.yaml

use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A workspace service (sub-project within the monorepo).
#[derive(Debug, Clone, Deserialize)]
pub struct ServiceConfig {
    /// Service name (human label, e.g., "util")
    pub name: String,

    /// Relative path from project root to the service directory (e.g., "packages/util")
    pub path: String,

    /// Entry point relative to the service directory (e.g., "src/index.ts")
    #[serde(default = "default_entry_point", alias = "entryPoint")]
    pub entry_point: String,
}

fn default_entry_point() -> String {
    "src/index.ts".to_string()
}

/// A discovered workspace package: npm name → entry point file.
#[derive(Debug, Clone)]
pub struct WorkspacePackage {
    /// npm package name (e.g., "@grafema/util")
    pub name: String,
    /// Entry point relative to project root (e.g., "packages/util/src/index.ts")
    pub entry_point: String,
    /// Package directory relative to project root (e.g., "packages/util")
    pub package_dir: String,
}

/// Discover workspace packages by reading package.json from each service.
///
/// For each service in the config, reads `{root}/{service.path}/package.json`,
/// extracts the npm `"name"` field, and combines it with the entry point path.
/// Services with missing or unreadable package.json are skipped with a warning.
pub fn discover_workspace_packages(root: &Path, services: &[ServiceConfig]) -> Vec<WorkspacePackage> {
    let mut packages = Vec::new();
    for service in services {
        let pkg_json_path = root.join(&service.path).join("package.json");
        match std::fs::read_to_string(&pkg_json_path) {
            Ok(content) => {
                match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(json) => {
                        if let Some(npm_name) = json.get("name").and_then(|v| v.as_str()) {
                            let entry_point = format!("{}/{}", service.path, service.entry_point);
                            packages.push(WorkspacePackage {
                                name: npm_name.to_string(),
                                entry_point,
                                package_dir: service.path.clone(),
                            });
                            tracing::info!(
                                npm_name = npm_name,
                                entry_point = %packages.last().unwrap().entry_point,
                                "Discovered workspace package"
                            );
                        } else {
                            tracing::warn!(
                                path = %pkg_json_path.display(),
                                "package.json has no 'name' field, skipping service '{}'",
                                service.name
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            path = %pkg_json_path.display(),
                            "Failed to parse package.json for service '{}': {e}",
                            service.name
                        );
                    }
                }
            }
            Err(e) => {
                tracing::warn!(
                    path = %pkg_json_path.display(),
                    "Cannot read package.json for service '{}': {e}",
                    service.name
                );
            }
        }
    }
    packages
}

/// Top-level analyzer configuration.
#[derive(Debug, Deserialize)]
pub struct AnalyzerConfig {
    /// Project root directory (resolved relative to config file)
    #[serde(default = "default_root")]
    pub root: PathBuf,

    /// Glob patterns for files to include
    pub include: Vec<String>,

    /// Glob patterns for files to exclude
    #[serde(default)]
    pub exclude: Vec<String>,

    /// Plugin configurations
    #[serde(default)]
    pub plugins: Vec<PluginConfig>,

    /// Path to RFDB unix socket (overridable via CLI)
    #[serde(default = "default_rfdb_socket")]
    pub rfdb_socket: Option<PathBuf>,

    /// Analyzer binary path overrides
    #[serde(default)]
    pub analyzers: AnalyzerBinaries,

    /// Workspace services (sub-projects) for cross-package resolution
    #[serde(default)]
    pub services: Vec<ServiceConfig>,
}

/// Optional overrides for analyzer binary paths.
/// When not specified, defaults are used:
/// - JS/TS: "grafema-analyzer" / "grafema-resolve"
/// - Haskell: "haskell-analyzer" / "haskell-resolve"
/// - Rust: "grafema-rust-analyzer" / "grafema-rust-resolve"
#[derive(Debug, Clone, Deserialize)]
pub struct AnalyzerBinaries {
    /// Path to JS/TS analyzer binary (default: "grafema-analyzer")
    #[serde(default = "default_js_analyzer")]
    pub js: String,

    /// Path to Haskell analyzer binary (default: "haskell-analyzer")
    #[serde(default = "default_haskell_analyzer")]
    pub haskell: String,

    /// Path to Rust analyzer binary (default: "grafema-rust-analyzer")
    #[serde(default = "default_rust_analyzer")]
    pub rust: String,

    /// Path to JS/TS resolve binary (default: "grafema-resolve")
    #[serde(default = "default_js_resolve")]
    pub js_resolve: String,

    /// Path to Haskell resolve binary (default: "haskell-resolve")
    #[serde(default = "default_haskell_resolve")]
    pub haskell_resolve: String,

    /// Path to Rust resolve binary (default: "grafema-rust-resolve")
    #[serde(default = "default_rust_resolve")]
    pub rust_resolve: String,
}

impl Default for AnalyzerBinaries {
    fn default() -> Self {
        Self {
            js: default_js_analyzer(),
            haskell: default_haskell_analyzer(),
            rust: default_rust_analyzer(),
            js_resolve: default_js_resolve(),
            haskell_resolve: default_haskell_resolve(),
            rust_resolve: default_rust_resolve(),
        }
    }
}

/// Resolve a bare binary name to a full path by checking known locations.
///
/// Search order:
/// 1. If already an absolute path → return as-is
/// 2. Same directory as the orchestrator binary (std::env::current_exe())
/// 3. ~/.cabal/bin/
/// 4. ~/.local/bin/
/// 5. Return bare name unchanged (falls back to $PATH via Command::new)
pub fn resolve_binary(name: &str) -> String {
    let path = Path::new(name);

    // Already absolute — use as-is
    if path.is_absolute() {
        return name.to_string();
    }

    // Check sibling of current executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                let resolved = candidate.display().to_string();
                tracing::debug!(binary = name, resolved = %resolved, "Resolved binary next to orchestrator");
                return resolved;
            }
        }
    }

    // Check well-known directories
    if let Some(home) = home_dir() {
        for subdir in &["/.cabal/bin/", "/.local/bin/"] {
            let mut candidate = home.clone();
            candidate.push(&subdir[1..]); // strip leading /
            candidate.push(name);
            if candidate.is_file() {
                let resolved = candidate.display().to_string();
                tracing::debug!(binary = name, resolved = %resolved, "Resolved binary in well-known dir");
                return resolved;
            }
        }
    }

    // Fall back to bare name ($PATH lookup by Command::new)
    name.to_string()
}

/// Get the user's home directory.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

impl AnalyzerBinaries {
    /// Resolved path for the JS/TS analyzer binary.
    pub fn js_path(&self) -> String {
        resolve_binary(&self.js)
    }

    /// Resolved path for the Haskell analyzer binary.
    pub fn haskell_path(&self) -> String {
        resolve_binary(&self.haskell)
    }

    /// Resolved path for the Rust analyzer binary.
    pub fn rust_path(&self) -> String {
        resolve_binary(&self.rust)
    }

    /// Resolved path for the JS/TS resolve binary.
    pub fn js_resolve_path(&self) -> String {
        resolve_binary(&self.js_resolve)
    }

    /// Resolved path for the Haskell resolve binary.
    pub fn haskell_resolve_path(&self) -> String {
        resolve_binary(&self.haskell_resolve)
    }

    /// Resolved path for the Rust resolve binary.
    pub fn rust_resolve_path(&self) -> String {
        resolve_binary(&self.rust_resolve)
    }
}

/// Plugin configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct PluginConfig {
    /// Plugin name (unique identifier)
    pub name: String,

    /// Command to execute
    pub command: String,

    /// Datalog query for streaming mode input
    pub query: Option<String>,

    /// Plugin names this depends on
    #[serde(default)]
    pub depends_on: Vec<String>,

    /// Execution mode
    #[serde(default)]
    pub mode: PluginMode,

    /// Execution timeout in seconds (e.g., 60 for one minute)
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

impl PluginConfig {
    /// Create a new plugin config with sensible defaults.
    pub fn new(name: &str, command: &str) -> Self {
        Self {
            name: name.to_string(),
            command: command.to_string(),
            query: None,
            depends_on: vec![],
            mode: PluginMode::default(),
            timeout_secs: None,
        }
    }

    /// Returns the timeout as a `Duration`, if configured.
    pub fn timeout(&self) -> Option<Duration> {
        self.timeout_secs.map(Duration::from_secs)
    }
}

impl AnalyzerConfig {
    /// Apply default plugins if none are configured.
    ///
    /// Default plugins:
    /// 1. `js-import-resolution`: resolves import bindings to their targets
    /// 2. `runtime-globals`: detects global variable usage (depends on import resolution)
    pub fn with_defaults(mut self) -> Self {
        if self.plugins.is_empty() {
            self.plugins = vec![
                PluginConfig::new("js-import-resolution", "grafema-resolve imports"),
                PluginConfig {
                    depends_on: vec!["js-import-resolution".to_string()],
                    ..PluginConfig::new("runtime-globals", "grafema-resolve runtime-globals")
                },
            ];
        }
        self
    }
}

/// Plugin execution mode.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginMode {
    /// Orchestrator queries RFDB, pipes nodes to plugin stdin
    #[default]
    Streaming,
    /// Plugin gets RFDB_SOCKET env var, queries directly
    Batch,
}

fn default_root() -> PathBuf {
    PathBuf::from(".")
}

fn default_rfdb_socket() -> Option<PathBuf> {
    Some(PathBuf::from("/tmp/rfdb.sock"))
}

fn default_js_analyzer() -> String {
    "grafema-analyzer".to_string()
}

fn default_haskell_analyzer() -> String {
    "haskell-analyzer".to_string()
}

fn default_rust_analyzer() -> String {
    "grafema-rust-analyzer".to_string()
}

fn default_js_resolve() -> String {
    "grafema-resolve".to_string()
}

fn default_haskell_resolve() -> String {
    "haskell-resolve".to_string()
}

fn default_rust_resolve() -> String {
    "grafema-rust-resolve".to_string()
}

/// Language detection based on file extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    JavaScript,
    Haskell,
    Rust,
}

/// Detect language from file extension.
pub fn detect_language(path: &Path) -> Option<Language> {
    match path.extension()?.to_str()? {
        "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts" => {
            Some(Language::JavaScript)
        }
        "hs" => Some(Language::Haskell),
        "rs" => Some(Language::Rust),
        _ => None,
    }
}

/// Partition files by detected language.
pub fn partition_by_language(files: &[PathBuf]) -> (Vec<PathBuf>, Vec<PathBuf>, Vec<PathBuf>) {
    let mut js_files = Vec::new();
    let mut hs_files = Vec::new();
    let mut rs_files = Vec::new();
    for file in files {
        match detect_language(file) {
            Some(Language::JavaScript) => js_files.push(file.clone()),
            Some(Language::Haskell) => hs_files.push(file.clone()),
            Some(Language::Rust) => rs_files.push(file.clone()),
            None => {} // skip unknown extensions
        }
    }
    (js_files, hs_files, rs_files)
}

/// Load and validate configuration from a YAML file.
pub fn load(path: &Path) -> Result<AnalyzerConfig> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read config: {}", path.display()))?;

    let mut config: AnalyzerConfig = serde_yaml::from_str(&content)
        .with_context(|| format!("Failed to parse config: {}", path.display()))?;

    // Resolve root relative to config file location
    if config.root.is_relative() {
        if let Some(parent) = path.parent() {
            config.root = parent.join(&config.root);
        }
    }

    // Canonicalize so downstream code gets a clean absolute path
    config.root = config.root.canonicalize().with_context(|| {
        format!(
            "Config 'root' directory does not exist or is not accessible: {}",
            config.root.display()
        )
    })?;

    if !config.root.is_dir() {
        anyhow::bail!(
            "Config 'root' must be a directory, got: {}",
            config.root.display()
        );
    }

    if config.include.is_empty() {
        anyhow::bail!("Config must have at least one 'include' pattern");
    }

    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// Create a unique temp directory for each test.
    fn test_dir() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join("grafema-config-tests")
            .join(format!("{}_{}", std::process::id(), id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Helper: write a temporary config file and return its path.
    fn write_config(dir: &Path, yaml: &str) -> PathBuf {
        let path = dir.join("grafema.config.yaml");
        fs::write(&path, yaml).unwrap();
        path
    }

    /// Cleanup helper (best-effort).
    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn load_minimal_config() {
        let dir = test_dir();
        let config_path = write_config(
            &dir,
            &format!(
                "root: \"{}\"\ninclude:\n  - \"**/*.js\"\n",
                dir.display()
            ),
        );

        let cfg = load(&config_path).unwrap();
        assert_eq!(cfg.include, vec!["**/*.js"]);
        assert!(cfg.exclude.is_empty());
        assert!(cfg.plugins.is_empty());
        // Default rfdb_socket
        assert_eq!(cfg.rfdb_socket, Some(PathBuf::from("/tmp/rfdb.sock")));
        cleanup(&dir);
    }

    #[test]
    fn load_empty_include_fails() {
        let dir = test_dir();
        let config_path = write_config(
            &dir,
            &format!("root: \"{}\"\ninclude: []\n", dir.display()),
        );

        let err = load(&config_path).unwrap_err();
        assert!(
            err.to_string().contains("at least one 'include' pattern"),
            "unexpected error: {err}"
        );
        cleanup(&dir);
    }

    #[test]
    fn load_nonexistent_root_fails() {
        let dir = test_dir();
        let config_path = write_config(
            &dir,
            "root: \"/nonexistent/path/that/does/not/exist\"\ninclude:\n  - \"**/*.js\"\n",
        );

        let err = load(&config_path).unwrap_err();
        assert!(
            err.to_string().contains("does not exist"),
            "unexpected error: {err}"
        );
        cleanup(&dir);
    }

    #[test]
    fn root_resolved_relative_to_config_dir() {
        let dir = test_dir();
        let sub = dir.join("project");
        fs::create_dir_all(&sub).unwrap();

        let config_path = write_config(
            &dir,
            "root: \"project\"\ninclude:\n  - \"**/*.js\"\n",
        );

        let cfg = load(&config_path).unwrap();
        // After canonicalize, should point to the sub directory
        assert_eq!(cfg.root, sub.canonicalize().unwrap());
        cleanup(&dir);
    }

    #[test]
    fn rfdb_socket_override() {
        let dir = test_dir();
        let config_path = write_config(
            &dir,
            &format!(
                "root: \"{}\"\ninclude:\n  - \"**/*.js\"\nrfdb_socket: /custom/rfdb.sock\n",
                dir.display()
            ),
        );

        let cfg = load(&config_path).unwrap();
        assert_eq!(cfg.rfdb_socket, Some(PathBuf::from("/custom/rfdb.sock")));
        cleanup(&dir);
    }

    #[test]
    fn plugin_timeout_as_seconds() {
        let dir = test_dir();
        let yaml = format!(
            r#"
root: "{}"
include:
  - "**/*.js"
plugins:
  - name: resolver
    command: "grafema-resolve imports"
    timeout_secs: 120
"#,
            dir.display()
        );
        let config_path = write_config(&dir, &yaml);
        let cfg = load(&config_path).unwrap();

        assert_eq!(cfg.plugins.len(), 1);
        assert_eq!(cfg.plugins[0].timeout(), Some(Duration::from_secs(120)));
        cleanup(&dir);
    }

    #[test]
    fn plugin_timeout_absent() {
        let dir = test_dir();
        let yaml = format!(
            r#"
root: "{}"
include:
  - "**/*.js"
plugins:
  - name: resolver
    command: "grafema-resolve imports"
"#,
            dir.display()
        );
        let config_path = write_config(&dir, &yaml);
        let cfg = load(&config_path).unwrap();

        assert_eq!(cfg.plugins[0].timeout(), None);
        cleanup(&dir);
    }

    #[test]
    fn plugin_mode_defaults_to_streaming() {
        let dir = test_dir();
        let yaml = format!(
            r#"
root: "{}"
include:
  - "**/*.js"
plugins:
  - name: resolver
    command: "grafema-resolve"
"#,
            dir.display()
        );
        let config_path = write_config(&dir, &yaml);
        let cfg = load(&config_path).unwrap();
        assert!(matches!(cfg.plugins[0].mode, PluginMode::Streaming));
        cleanup(&dir);
    }

    #[test]
    fn plugin_mode_batch() {
        let dir = test_dir();
        let yaml = format!(
            r#"
root: "{}"
include:
  - "**/*.js"
plugins:
  - name: resolver
    command: "grafema-resolve"
    mode: batch
"#,
            dir.display()
        );
        let config_path = write_config(&dir, &yaml);
        let cfg = load(&config_path).unwrap();
        assert!(matches!(cfg.plugins[0].mode, PluginMode::Batch));
        cleanup(&dir);
    }

    #[test]
    fn missing_config_file_fails() {
        let err = load(Path::new("/nonexistent/grafema.config.yaml")).unwrap_err();
        assert!(
            err.to_string().contains("Failed to read config"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn malformed_yaml_fails() {
        let dir = test_dir();
        let config_path = write_config(&dir, "not: [valid: yaml: {{");

        let err = load(&config_path).unwrap_err();
        assert!(
            err.to_string().contains("Failed to parse config"),
            "unexpected error: {err}"
        );
        cleanup(&dir);
    }

    #[test]
    fn plugin_config_new_defaults() {
        let p = PluginConfig::new("test-plugin", "echo hello");
        assert_eq!(p.name, "test-plugin");
        assert_eq!(p.command, "echo hello");
        assert!(p.query.is_none());
        assert!(p.depends_on.is_empty());
        assert!(matches!(p.mode, PluginMode::Streaming));
        assert!(p.timeout_secs.is_none());
    }

    #[test]
    fn with_defaults_adds_plugins_when_empty() {
        let dir = test_dir();
        let config_path = write_config(
            &dir,
            &format!(
                "root: \"{}\"\ninclude:\n  - \"**/*.js\"\n",
                dir.display()
            ),
        );

        let cfg = load(&config_path).unwrap().with_defaults();
        assert_eq!(cfg.plugins.len(), 2);
        assert_eq!(cfg.plugins[0].name, "js-import-resolution");
        assert_eq!(cfg.plugins[0].command, "grafema-resolve imports");
        assert!(cfg.plugins[0].depends_on.is_empty());
        assert_eq!(cfg.plugins[1].name, "runtime-globals");
        assert_eq!(cfg.plugins[1].command, "grafema-resolve runtime-globals");
        assert_eq!(cfg.plugins[1].depends_on, vec!["js-import-resolution"]);
        cleanup(&dir);
    }

    #[test]
    fn with_defaults_preserves_existing_plugins() {
        let dir = test_dir();
        let yaml = format!(
            r#"
root: "{}"
include:
  - "**/*.js"
plugins:
  - name: custom-plugin
    command: "my-plugin"
"#,
            dir.display()
        );
        let config_path = write_config(&dir, &yaml);

        let cfg = load(&config_path).unwrap().with_defaults();
        assert_eq!(cfg.plugins.len(), 1);
        assert_eq!(cfg.plugins[0].name, "custom-plugin");
        cleanup(&dir);
    }

    #[test]
    fn detect_language_js_extensions() {
        for ext in &["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"] {
            let path = PathBuf::from(format!("src/app.{ext}"));
            assert_eq!(
                detect_language(&path),
                Some(Language::JavaScript),
                "expected JavaScript for .{ext}"
            );
        }
    }

    #[test]
    fn detect_language_haskell() {
        let path = PathBuf::from("src/Main.hs");
        assert_eq!(detect_language(&path), Some(Language::Haskell));
    }

    #[test]
    fn detect_language_unknown_returns_none() {
        assert_eq!(detect_language(Path::new("README.md")), None);
        assert_eq!(detect_language(Path::new("Makefile")), None);
        assert_eq!(detect_language(Path::new("src/main.py")), None);
    }

    #[test]
    fn partition_by_language_splits_correctly() {
        let files = vec![
            PathBuf::from("src/index.ts"),
            PathBuf::from("src/Main.hs"),
            PathBuf::from("src/app.jsx"),
            PathBuf::from("src/Lib.hs"),
            PathBuf::from("src/main.rs"),
            PathBuf::from("src/lib.rs"),
            PathBuf::from("README.md"),
        ];
        let (js, hs, rs) = partition_by_language(&files);
        assert_eq!(js, vec![PathBuf::from("src/index.ts"), PathBuf::from("src/app.jsx")]);
        assert_eq!(hs, vec![PathBuf::from("src/Main.hs"), PathBuf::from("src/Lib.hs")]);
        assert_eq!(rs, vec![PathBuf::from("src/main.rs"), PathBuf::from("src/lib.rs")]);
    }

    #[test]
    fn partition_by_language_empty_input() {
        let (js, hs, rs) = partition_by_language(&[]);
        assert!(js.is_empty());
        assert!(hs.is_empty());
        assert!(rs.is_empty());
    }

    #[test]
    fn detect_language_rust() {
        let path = PathBuf::from("src/main.rs");
        assert_eq!(detect_language(&path), Some(Language::Rust));
    }

    #[test]
    fn config_with_analyzers_field_deserializes() {
        let dir = test_dir();
        let yaml = format!(
            r#"
root: "{}"
include:
  - "**/*.js"
analyzers:
  js: "/usr/local/bin/my-js-analyzer"
  haskell: "/usr/local/bin/my-hs-analyzer"
  rust: "/usr/local/bin/my-rust-analyzer"
"#,
            dir.display()
        );
        let config_path = write_config(&dir, &yaml);
        let cfg = load(&config_path).unwrap();
        assert_eq!(cfg.analyzers.js, "/usr/local/bin/my-js-analyzer");
        assert_eq!(cfg.analyzers.haskell, "/usr/local/bin/my-hs-analyzer");
        assert_eq!(cfg.analyzers.rust, "/usr/local/bin/my-rust-analyzer");
        cleanup(&dir);
    }

    #[test]
    fn config_without_analyzers_gets_defaults() {
        let dir = test_dir();
        let config_path = write_config(
            &dir,
            &format!(
                "root: \"{}\"\ninclude:\n  - \"**/*.js\"\n",
                dir.display()
            ),
        );
        let cfg = load(&config_path).unwrap();
        assert_eq!(cfg.analyzers.js, "grafema-analyzer");
        assert_eq!(cfg.analyzers.haskell, "haskell-analyzer");
        assert_eq!(cfg.analyzers.rust, "grafema-rust-analyzer");
        assert_eq!(cfg.analyzers.js_resolve, "grafema-resolve");
        assert_eq!(cfg.analyzers.haskell_resolve, "haskell-resolve");
        assert_eq!(cfg.analyzers.rust_resolve, "grafema-rust-resolve");
        cleanup(&dir);
    }

    #[test]
    fn analyzer_binaries_default_values() {
        let defaults = AnalyzerBinaries::default();
        assert_eq!(defaults.js, "grafema-analyzer");
        assert_eq!(defaults.haskell, "haskell-analyzer");
        assert_eq!(defaults.rust, "grafema-rust-analyzer");
        assert_eq!(defaults.js_resolve, "grafema-resolve");
        assert_eq!(defaults.haskell_resolve, "haskell-resolve");
        assert_eq!(defaults.rust_resolve, "grafema-rust-resolve");
    }

    #[test]
    fn resolve_binary_absolute_path_unchanged() {
        let result = resolve_binary("/usr/local/bin/my-analyzer");
        assert_eq!(result, "/usr/local/bin/my-analyzer");
    }

    #[test]
    fn resolve_binary_bare_name_returns_bare_when_not_found() {
        // A name that won't exist anywhere
        let result = resolve_binary("nonexistent-binary-xyz-12345");
        assert_eq!(result, "nonexistent-binary-xyz-12345");
    }

    #[test]
    fn resolve_binary_finds_sibling_of_current_exe() {
        // Create a temp file next to the current executable
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let fake_bin = dir.join("test-resolve-binary-sentinel");
                let _ = fs::write(&fake_bin, "");
                let result = resolve_binary("test-resolve-binary-sentinel");
                assert_eq!(result, fake_bin.display().to_string());
                let _ = fs::remove_file(&fake_bin);
            }
        }
    }

    #[test]
    fn analyzer_binaries_path_methods_with_absolute() {
        let bins = AnalyzerBinaries {
            js: "/abs/grafema-analyzer".to_string(),
            haskell: "/abs/haskell-analyzer".to_string(),
            rust: "/abs/grafema-rust-analyzer".to_string(),
            js_resolve: "/abs/grafema-resolve".to_string(),
            haskell_resolve: "/abs/haskell-resolve".to_string(),
            rust_resolve: "/abs/grafema-rust-resolve".to_string(),
        };
        assert_eq!(bins.js_path(), "/abs/grafema-analyzer");
        assert_eq!(bins.haskell_path(), "/abs/haskell-analyzer");
        assert_eq!(bins.rust_path(), "/abs/grafema-rust-analyzer");
        assert_eq!(bins.js_resolve_path(), "/abs/grafema-resolve");
        assert_eq!(bins.haskell_resolve_path(), "/abs/haskell-resolve");
        assert_eq!(bins.rust_resolve_path(), "/abs/grafema-rust-resolve");
    }

    #[test]
    fn config_with_services_deserializes() {
        let dir = test_dir();
        let yaml = format!(
            r#"
root: "{}"
include:
  - "**/*.ts"
services:
  - name: util
    path: packages/util
    entry_point: src/index.ts
  - name: cli
    path: packages/cli
"#,
            dir.display()
        );
        let config_path = write_config(&dir, &yaml);
        let cfg = load(&config_path).unwrap();
        assert_eq!(cfg.services.len(), 2);
        assert_eq!(cfg.services[0].name, "util");
        assert_eq!(cfg.services[0].path, "packages/util");
        assert_eq!(cfg.services[0].entry_point, "src/index.ts");
        assert_eq!(cfg.services[1].name, "cli");
        assert_eq!(cfg.services[1].entry_point, "src/index.ts"); // default
        cleanup(&dir);
    }

    #[test]
    fn config_without_services_defaults_to_empty() {
        let dir = test_dir();
        let config_path = write_config(
            &dir,
            &format!(
                "root: \"{}\"\ninclude:\n  - \"**/*.js\"\n",
                dir.display()
            ),
        );
        let cfg = load(&config_path).unwrap();
        assert!(cfg.services.is_empty());
        cleanup(&dir);
    }

    #[test]
    fn discover_workspace_packages_reads_package_json() {
        let dir = test_dir();
        let pkg_dir = dir.join("packages").join("util");
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(
            pkg_dir.join("package.json"),
            r#"{"name": "@grafema/util", "version": "0.1.0"}"#,
        )
        .unwrap();

        let services = vec![ServiceConfig {
            name: "util".to_string(),
            path: "packages/util".to_string(),
            entry_point: "src/index.ts".to_string(),
        }];

        let packages = discover_workspace_packages(&dir, &services);
        assert_eq!(packages.len(), 1);
        assert_eq!(packages[0].name, "@grafema/util");
        assert_eq!(packages[0].entry_point, "packages/util/src/index.ts");
        assert_eq!(packages[0].package_dir, "packages/util");
        cleanup(&dir);
    }

    #[test]
    fn discover_workspace_packages_skips_missing_package_json() {
        let dir = test_dir();
        let services = vec![ServiceConfig {
            name: "missing".to_string(),
            path: "packages/missing".to_string(),
            entry_point: "src/index.ts".to_string(),
        }];

        let packages = discover_workspace_packages(&dir, &services);
        assert!(packages.is_empty());
        cleanup(&dir);
    }

    #[test]
    fn discover_workspace_packages_skips_no_name_field() {
        let dir = test_dir();
        let pkg_dir = dir.join("packages").join("noname");
        fs::create_dir_all(&pkg_dir).unwrap();
        fs::write(
            pkg_dir.join("package.json"),
            r#"{"version": "0.1.0"}"#,
        )
        .unwrap();

        let services = vec![ServiceConfig {
            name: "noname".to_string(),
            path: "packages/noname".to_string(),
            entry_point: "src/index.ts".to_string(),
        }];

        let packages = discover_workspace_packages(&dir, &services);
        assert!(packages.is_empty());
        cleanup(&dir);
    }
}
