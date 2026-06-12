use grafema_orchestrator::{analyzer, config, directory_nodes, discovery, gc, plugin, process_pool, profiler, rfdb, source_hash};
#[cfg(feature = "ruby")]
use grafema_orchestrator::ruby_resolver;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

/// Canonical stdlib rule-pack execution order — pack-runner v0 (analyze phase 9).
///
/// ORDER IS A CONTRACT, not a convenience — producers run strictly before
/// consumers:
/// - the four RESOLVER packs (`js_local_refs`, `js_same_file_calls`,
///   `js_this_method_calls`, `rust_calls` — the Wave-1 in-engine replacements for
///   JsLocalRefs.hs / SameFileCalls.hs / JsThisMethodCalls.hs /
///   RustCallResolution.hs) produce the READS_FROM/CALLS state the downstream
///   packs consume;
/// - the three Wave-1b packs run after them: `rust_cross_methods_ctor` reads the
///   CALLS edges `rust_calls` committed as storage EDB (the resolved-constructor
///   seam — MUST follow `rust_calls`); `js_cross_file_calls` and
///   `js_property_access_ns` consume IMPORTS_FROM edges as EDB (produced by
///   `js_module_imports`/`js_import_bindings` above them since Wave 3b/3c) and,
///   as CALLS/READS_FROM producers, must precede the fuzzy fallback and the
///   negators below;
/// - the three JS Wave-2 packs (node_attr-unblocked) interleave by their seams:
///   `js_import_bindings` PRODUCES IMPORTS_FROM (named/aliased/default binding →
///   export target through the parent IMPORT's MODULE edge), so it runs
///   BEFORE every IMPORTS_FROM consumer — `js_class_inheritance` (cross-file
///   arm), `js_cross_file_calls`, `js_property_access_ns`, and depends;
///   `js_class_inheritance` PRODUCES EXTENDS, consumed by
///   `shape_verifier`'s inheritance closure; `js_property_access_full`
///   (this/static arms) produces READS_FROM, so it precedes `method_calls` and
///   `shape_verifier`;
/// - `@stdlib/method_calls` (the fuzzy fallback) reads READS_FROM receiver chains
///   as EDB, so it runs after `js_local_refs` has committed them;
/// - `@stdlib/shape_verifier` NEGATES CALLS (`\+ edge(C, _, "CALLS")`, its
///   skip-resolved filter) and READS_FROM (its PA-fallback guard) as EDB, so it
///   MUST run after EVERY CALLS/READS_FROM producer above — running earlier would
///   flag calls a later pack resolves.
/// - `js_module_imports` (Wave 3b, the module-path kernel) PRODUCES the
///   IMPORT→MODULE IMPORTS_FROM seam + RE_EXPORTS that `js_import_bindings`
///   and the hybrid consumers read as committed EDB, so it runs strictly
///   before them.
/// Full canonical order is js_local_refs → js_same_file_calls →
/// js_this_method_calls → rust_calls → rust_cross_methods_ctor →
/// rust_trait_resolve → rust_receiver_typing → rust_imports → js_module_imports →
/// js_import_bindings → js_class_inheritance → js_cross_file_calls →
/// js_property_access_ns → js_property_access_full → js_builtins_nodes →
/// js_builtins_edges → js_runtime_globals_nodes → js_runtime_globals_edges →
/// depends → method_calls → shape_verifier → axum_routes.
/// Wave 3c moved depends INTO this list, after every IMPORTS_FROM producer:
/// with legacy import-resolution gated, the IMPORT-level edges depends
/// consumes are produced by the packs above it (it ran separately FIRST while
/// the legacy resolver pre-committed them). The server-side registry
/// (`rfdb-server/src/derive/stdlib.rs` STDLIB_PACKS) documents the same
/// order — the two are pinned against each other by
/// `tests::stdlib_rule_packs_match_rfdb_registry_order` below.
const STDLIB_RULE_PACKS: &[&str] = &[
    "@stdlib/js_local_refs",
    "@stdlib/js_same_file_calls",
    "@stdlib/js_this_method_calls",
    "@stdlib/rust_calls",
    "@stdlib/rust_cross_methods_ctor",
    // Rust Wave-2 packs: rust_receiver_typing reads rust_calls' CALLS as EDB
    // (the same MUST-run-AFTER seam as rust_cross_methods_ctor) and produces
    // CALLS, so it precedes the fuzzy fallback and the negators below;
    // rust_trait_resolve consumes analyzer EDB only (IMPL_BLOCK metadata +
    // TRAIT/STRUCT/CLASS nodes).
    "@stdlib/rust_trait_resolve",
    "@stdlib/rust_receiver_typing",
    // Rust Wave-3b pack: rust_imports PRODUCES IMPORTS_FROM (module tree +
    // both rust-imports phases) — strictly before the IMPORTS_FROM consumers
    // (js_cross_file_calls / js_property_access_ns; and depends, once legacy
    // rust-imports is gated off).
    "@stdlib/rust_imports",
    // JS Wave-3b module-path kernel: produces the IMPORT→MODULE IMPORTS_FROM
    // seam + RE_EXPORTS that js_import_bindings (b_mod/resolved_at/star_src)
    // and the hybrid consumers below read as committed EDB — strictly first.
    "@stdlib/js_module_imports",
    "@stdlib/js_import_bindings",
    "@stdlib/js_class_inheritance",
    "@stdlib/js_cross_file_calls",
    "@stdlib/js_property_access_ns",
    "@stdlib/js_property_access_full",
    // Wave 2b builtins split: the nodes pack MINTS the EXTERNAL_* endpoints the
    // edges pack joins as committed EDB (strict nodes→edges order); both are
    // CALLS/IMPORTS_FROM producers — before method_calls/shape_verifier.
    "@stdlib/js_builtins_nodes",
    "@stdlib/js_builtins_edges",
    // Wave 4 runtime-globals split: the nodes pack MINTS the GLOBAL_DEFINITION
    // endpoints (GLOBAL::<seName>, "<runtime/js>") the edges pack joins as
    // committed EDB (strict nodes→edges order); the edges pack is a CALLS
    // producer — before method_calls/shape_verifier.
    "@stdlib/js_runtime_globals_nodes",
    "@stdlib/js_runtime_globals_edges",
    // Wave 3c: depends CONSUMES IMPORTS_FROM (every edge of the shared
    // vocabulary, module- and binding-level). Legacy import-resolution /
    // rust-imports are gated (GRAFEMA_SKIP_RESOLVE_STEPS), so depends must
    // run after ALL in-engine IMPORTS_FROM producers above (rust_imports,
    // js_module_imports, js_import_bindings, js_builtins_edges). It ran
    // FIRST (the separate materialize_datalog("") call) while the legacy
    // resolver pre-committed those edges at analysis time.
    "@stdlib/depends",
    "@stdlib/method_calls",
    "@stdlib/shape_verifier",
    "@stdlib/axum_routes",
];


/// Tag virtual resolution output nodes with a synthetic file for cleanup.
///
/// Resolution plugins create virtual nodes (GLOBAL::*, BUILTIN::*) with no file.
/// Without a synthetic file, `commit_batch` can't clean them up (file-based deletion).
/// This assigns a per-plugin synthetic file so old virtual nodes are properly
/// tombstoned before new ones are added.
#[derive(Parser)]
#[command(name = "grafema-orchestrator", version, about = "Grafema analysis pipeline orchestrator")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run analysis on a project
    Analyze {
        /// Path to grafema.config.yaml
        #[arg(short, long)]
        config: PathBuf,

        /// Path to RFDB unix socket
        #[arg(short, long)]
        socket: Option<PathBuf>,

        /// Number of parallel analysis jobs
        #[arg(short, long, default_value_t = num_cpus())]
        jobs: usize,

        /// Force re-analysis of all files (ignore mtime)
        #[arg(long)]
        force: bool,

        /// Requested resolve-worker count. NOTE: resolution currently runs
        /// single-worker (per-file streaming); a value other than 1 has no
        /// effect and a notice is printed.
        #[arg(long)]
        resolve_jobs: Option<usize>,
    },
    /// Re-run resolution phase on an already-analyzed database
    Resolve {
        /// Path to grafema.config.yaml
        #[arg(short, long)]
        config: PathBuf,
        /// Path to RFDB unix socket
        #[arg(short, long)]
        socket: Option<PathBuf>,
        /// Requested resolve-worker count. NOTE: resolution currently runs
        /// single-worker (per-file streaming); a value other than 1 has no
        /// effect and a notice is printed.
        #[arg(short, long)]
        jobs: Option<usize>,
    },
    /// Commit only DIRECTORY/FILE structural nodes (fast, skips analysis).
    /// Uses the discovered file list from the config to build the directory
    /// tree and upsert structural nodes into the existing RFDB.
    CommitDirs {
        /// Path to grafema.config.yaml
        #[arg(short, long)]
        config: PathBuf,
        /// Path to RFDB unix socket
        #[arg(short, long)]
        socket: Option<PathBuf>,
    },
    /// Run the hex-grid layout pipeline (pack → iswap → xswap).
    ///
    /// Two input modes (mutually exclusive):
    ///   * `--synthetic N` — generate a deterministic N-leaf fixture in memory.
    ///     Useful for benchmarks and visualisation dry-runs.
    ///   * `--socket <path> --config <path>` — load real graph data from a
    ///     live RFDB. MODULE nodes become leaves, MODULE→MODULE DEPENDS_ON
    ///     edges become layout edges.
    Layout {
        /// Use a synthetic tree of N leaves. Mutually exclusive with `--socket`.
        #[arg(long, conflicts_with = "socket")]
        synthetic: Option<usize>,

        /// Path to RFDB unix socket. Mutually exclusive with `--synthetic`.
        /// Requires `--config` so callers explicitly bind the layout run to
        /// a project; the config defaults wiring is intentionally out of scope
        /// for this step.
        #[arg(short, long, requires = "config")]
        socket: Option<PathBuf>,

        /// Path to grafema.config.yaml. Required when `--socket` is given.
        #[arg(short, long)]
        config: Option<PathBuf>,

        /// Skip iswap and xswap (raw pack only — fast, no optimisation).
        #[arg(long)]
        pack_only: bool,

        /// Random seed for synthetic tree generation. Same seed → identical
        /// output bytes.
        #[arg(long, default_value_t = 42)]
        seed: u64,

        /// Average edges per leaf (default 1.5× leaves).
        #[arg(long, default_value_t = 1.5)]
        edge_density: f32,

        /// Dump final coords + stats as pretty JSON to this file. Schema:
        /// `{ "coords": { "<path>": { "q": i32, "r": i32 }, ... }, "stats": {...} }`.
        #[arg(long)]
        dump_json: Option<PathBuf>,

        /// Write `LAYOUT_POSITION` edges back to RFDB after computing the layout.
        /// Each MODULE node gets one edge to a synthetic `HEX::<q>,<r>` id, with
        /// metadata `{"_source":"layout-pack"}`. Requires `--socket` (the layout
        /// must come from RFDB to be committable). Ignored with `--synthetic`
        /// — a warning is printed and the commit is skipped.
        #[arg(long)]
        commit: bool,

        /// Print per-folder torn details in the validation report.
        #[arg(short, long)]
        verbose: bool,

        /// Per-file hard-cap on placeable symbols. Files exceeding the cap
        /// keep only the top-N by degree (ties broken by name, then semantic
        /// id). Skipped symbols get no LAYOUT_POSITION edge; the GUI renders
        /// a red badge on the file's hull. Raise at your own risk — very
        /// large files saturate the atlas at high zoom.
        #[arg(long, default_value_t = grafema_orchestrator::layout::DEFAULT_HARD_CAP)]
        max_symbols_per_file: usize,
    },
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// Number of CPU cores available for resolve workers.
/// Reserves 1 core for the main thread / RFDB / OS.
///
/// Memory-aware: each resolve worker uses ~5GB RSS on large graphs
/// (context nodes like SCOPE, PARAM, CLASS are broadcast to ALL workers).
/// On memory-constrained VMs (e.g., 16GB with RFDB using 3GB), this
/// limits to 1-2 workers to prevent OOM.
///
/// NOTE: Currently unused — JS resolution uses per-file streaming (1 worker).
/// Kept for potential multi-worker use by other languages.
#[allow(dead_code)]
fn resolve_worker_count() -> usize {
    let cpus = num_cpus();
    let cpu_based = std::cmp::min(7, if cpus > 1 { cpus - 1 } else { 1 });

    // Memory-aware: each resolve worker uses ~5GB (context nodes broadcast),
    // RFDB ~3GB, OS+orchestrator ~1GB headroom
    let available_gb = available_memory_gb();
    let mem_based = if available_gb > 4 {
        ((available_gb - 4) / 5) as usize // 4GB reserved, 5GB per worker
    } else {
        1
    };

    let count = cpu_based.min(mem_based).max(1);
    if count < cpu_based {
        tracing::info!(
            cpu_workers = cpu_based,
            mem_workers = count,
            available_gb = available_gb,
            "Worker count limited by available memory"
        );
    }
    count
}

/// Build a user-facing notice when an explicit resolve-worker count is requested
/// that the orchestrator cannot honor. Resolution currently runs single-worker
/// (per-file streaming), so any request other than 1 worker is a no-op today.
/// Surfacing it stops `--resolve-jobs` / `--jobs` from being silently ignored and
/// misleading the user about its effect (REG-563: surface silent skips).
///
/// Returns `Some(message)` when `requested` is `Some(n)` with `n != 1`, else `None`.
fn resolve_jobs_notice(flag: &str, requested: Option<usize>) -> Option<String> {
    match requested {
        Some(n) if n != 1 => Some(format!(
            "{flag}={n} has no effect: resolution currently runs single-worker \
             (per-file streaming); proceeding with 1 worker."
        )),
        _ => None,
    }
}

/// Language keys accepted by `GRAFEMA_SKIP_RESOLVERS` (per-language native
/// resolve skip-flags for the resolve→derive differential harness,
/// the resolve-migration synthesis doc in `_ai/research/`, Wave 0).
const SKIP_RESOLVER_KEYS: [&str; 11] = [
    "js", "rust", "haskell", "beam", "java", "kotlin", "python", "go", "cpp", "swift", "objc",
];

/// Parse a `GRAFEMA_SKIP_RESOLVERS` value (comma-separated language keys,
/// case-insensitive, whitespace-tolerant) into the set of skipped keys.
/// Unknown keys are surfaced loudly and dropped — a typo must not silently
/// leave a native resolver running when the harness expects it disabled.
fn parse_skip_resolvers(raw: &str) -> std::collections::HashSet<String> {
    let mut keys = std::collections::HashSet::new();
    for key in raw.split(',').map(|k| k.trim().to_ascii_lowercase()) {
        if key.is_empty() {
            continue;
        }
        if SKIP_RESOLVER_KEYS.contains(&key.as_str()) {
            keys.insert(key);
        } else {
            tracing::warn!(
                "GRAFEMA_SKIP_RESOLVERS: unknown language key '{key}' ignored (known keys: {})",
                SKIP_RESOLVER_KEYS.join(", ")
            );
        }
    }
    keys
}

/// Whether the native resolve phase for `lang_key` is disabled via the
/// `GRAFEMA_SKIP_RESOLVERS` env var (comma-separated keys, see
/// [`SKIP_RESOLVER_KEYS`]). Used by the derive differential harness to run
/// analyze WITHOUT a native resolver so a Datalog pack produces the edges
/// instead. Unset / empty = never skip (no behavior change).
///
/// Cross-language phases are skipped when EITHER constituent language is
/// listed (apple-cross = swift+objc, jvm-cross = java+kotlin); `objc` only
/// affects apple-cross — there is no Obj-C-only resolve phase.
///
/// Returns `true` with a loud warning naming the flag when skipped.
fn skip_resolver(lang_key: &str) -> bool {
    static SKIPPED: std::sync::OnceLock<std::collections::HashSet<String>> =
        std::sync::OnceLock::new();
    let skipped = SKIPPED.get_or_init(|| {
        parse_skip_resolvers(&std::env::var("GRAFEMA_SKIP_RESOLVERS").unwrap_or_default())
    });
    if skipped.contains(lang_key) {
        tracing::warn!(
            "GRAFEMA_SKIP_RESOLVERS: skipping the native {lang_key} resolve phase — \
             its edges must come from a Datalog pack (differential-harness mode)"
        );
        return true;
    }
    false
}

/// Detect available system memory in GB.
///
/// Linux: reads MemAvailable from /proc/meminfo (accounts for caches/buffers).
/// macOS: reads total physical memory via sysctl hw.memsize.
/// Fallback: 16GB (conservative default).
#[allow(dead_code)]
fn available_memory_gb() -> u64 {
    // Linux: /proc/meminfo MemAvailable (available, not total)
    if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
        for line in content.lines() {
            if line.starts_with("MemAvailable:") {
                if let Some(kb_str) = line.split_whitespace().nth(1) {
                    if let Ok(kb) = kb_str.parse::<u64>() {
                        return kb / 1024 / 1024; // KB → GB
                    }
                }
            }
        }
    }

    // macOS: sysctl hw.memsize (total physical memory)
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
        {
            if let Ok(bytes_str) = std::str::from_utf8(&output.stdout) {
                if let Ok(bytes) = bytes_str.trim().parse::<u64>() {
                    return bytes / 1024 / 1024 / 1024;
                }
            }
        }
    }

    // Default: assume 16GB
    16
}

/// Resolve the URI authority for grafema:// URIs.
///
/// Priority:
/// 1. Explicit config: cfg.authority
/// 2. Git remote: parse `git remote get-url origin` → "github.com/owner/repo"
/// 3. Fallback: "localhost/{basename(root)}"
fn resolve_authority(cfg: &config::AnalyzerConfig) -> String {
    if let Some(ref auth) = cfg.authority {
        return auth.clone();
    }

    // Try git remote
    if let Ok(output) = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&cfg.root)
        .output()
    {
        if output.status.success() {
            let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(authority) = parse_git_remote_authority(&url) {
                return authority;
            }
        }
    }

    // Fallback: localhost/basename
    let basename = cfg.root.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    format!("localhost/{basename}")
}

/// Parse git remote URL to authority format.
/// Supports: git@github.com:owner/repo.git, https://github.com/owner/repo.git
fn parse_git_remote_authority(url: &str) -> Option<String> {
    // SSH format: git@github.com:owner/repo.git
    if let Some(rest) = url.strip_prefix("git@") {
        let colon_pos = rest.find(':')?;
        let host = &rest[..colon_pos];
        let path = rest[colon_pos + 1..].trim_end_matches(".git");
        return Some(format!("{host}/{path}"));
    }

    // HTTPS format: https://github.com/owner/repo.git
    if url.starts_with("https://") || url.starts_with("http://") {
        let without_scheme = url.split("://").nth(1)?;
        let trimmed = without_scheme.trim_end_matches(".git").trim_end_matches('/');
        return Some(trimmed.to_string());
    }

    None
}

/// Build a map from file path to MODULE semantic ID from RFDB.
async fn build_file_to_module_map(rfdb: &mut rfdb::RfdbClient) -> HashMap<String, String> {
    let module_nodes = rfdb.query_nodes_by_type("MODULE").await.unwrap_or_default();
    module_nodes
        .into_iter()
        .filter_map(|n| {
            let file = n.file?;
            let sid = n.semantic_id.or(Some(n.id))?;
            Some((file, sid))
        })
        .collect()
}

/// Parse the user's GRAFEMA_SKIP_RESOLVE_STEPS value (comma-separated,
/// whitespace-tolerant) into the resolve-step skip set. Pure for testability —
/// the caller passes the env var's value.
///
/// Wave 6 dissolved the retired-step merging that used to live here
/// (`RETIRED_FIRST_PASS_STEPS` / `RETIRED_SECOND_PASS_STEPS`): the
/// derive-replaced legacy steps were DELETED from the resolver daemons, not
/// gated, so there is nothing left to retire. Every step the daemons still
/// serve is live native code with no pack replacement (js: `runtime-globals`,
/// the REFERENCE→RESOLVES_TO arm; rust: `rust-cross-methods` — dyn-dispatch +
/// self-field arms — and `rust-globals`), and the env var gates exactly what
/// it names among them: js-daemon steps via the pinned child env
/// (PoolConfig::skip_resolve_steps → the daemon's own `getSkipSteps` gate),
/// rust steps by never sending the command.
fn resolve_step_skips(env_value: Option<&str>) -> HashSet<String> {
    env_value
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Render a skip set as the comma-separated GRAFEMA_SKIP_RESOLVE_STEPS value pinned on a
/// resolver daemon child (sorted for deterministic logs/tests).
fn skip_steps_env_value(skips: &HashSet<String>) -> String {
    let mut steps: Vec<&str> = skips.iter().map(String::as_str).collect();
    steps.sort_unstable();
    steps.join(",")
}

/// Wave 6 fail-fast gate: `analyze` requires the connected server to run the
/// derive pack phase (`datalogDerive` in the Hello features). The
/// legacy js/rust resolve steps and the in-orchestrator P3 DEPENDS_ON fallback
/// were DELETED — on a server without the derive engine nothing is left to produce the resolved
/// slices, so the only correct behavior is a clear, actionable refusal.
fn require_derive_capability(
    rfdb: &rfdb::RfdbClient,
    socket_path: &std::path::Path,
) -> Result<()> {
    if rfdb.supports_derive_materialize() {
        return Ok(());
    }
    anyhow::bail!(
        "rfdb-server at {} does not support derive engine materialize \
         (no `datalogDerive` capability in Hello; server version: {}); \
         analyze requires it — the legacy resolve fallback was removed. \
         Upgrade the rfdb-server binary, and make sure its environment \
         does not set RFDB_DERIVE_ENGINE=off",
        socket_path.display(),
        if rfdb.server_version.is_empty() { "unknown" } else { &rfdb.server_version },
    )
}

/// Per-pack slice ownership, for the phase-9 failure report: with the legacy
/// resolve pipeline deleted (Wave 6) there is NO fallback producer behind any
/// of these packs — a failed pack means its slice is simply MISSING from the
/// graph for this run. The summary names what was lost so the error is
/// actionable instead of "a pack failed".
fn pack_owned_slice(pack: &str) -> &'static str {
    match pack {
        "@stdlib/js_local_refs" => "js same-file READS_FROM (REFERENCE→declaration)",
        "@stdlib/js_same_file_calls" => "js same-file CALLS",
        "@stdlib/js_this_method_calls" => "js this.method() CALLS",
        "@stdlib/rust_calls" => "rust same-file CALLS",
        "@stdlib/rust_cross_methods_ctor" => "rust constructor-typed receiver CALLS",
        "@stdlib/rust_trait_resolve" => "rust IMPLEMENTS (impl Trait for Type)",
        "@stdlib/rust_receiver_typing" => "rust annotation/return-typed receiver CALLS",
        "@stdlib/rust_imports" => "rust IMPORTS_FROM (module tree + bindings)",
        "@stdlib/js_module_imports" => "js IMPORT→MODULE IMPORTS_FROM + star RE_EXPORTS",
        "@stdlib/js_import_bindings" => "js IMPORT_BINDING→export IMPORTS_FROM",
        "@stdlib/js_class_inheritance" => "js EXTENDS",
        "@stdlib/js_cross_file_calls" => "js cross-file CALLS",
        "@stdlib/js_property_access_ns" => "js namespace-import READS_FROM",
        "@stdlib/js_property_access_full" => "js property-access READS_FROM",
        "@stdlib/js_builtins_nodes" => "node-builtin EXTERNAL_MODULE/EXTERNAL_FUNCTION nodes",
        "@stdlib/js_builtins_edges" => "node-builtin IMPORTS_FROM + CALLS",
        "@stdlib/js_runtime_globals_nodes" => "js runtime-global GLOBAL_DEFINITION nodes",
        "@stdlib/js_runtime_globals_edges" => "js runtime-global CALLS",
        "@stdlib/depends" => "MODULE→MODULE DEPENDS_ON",
        "@stdlib/method_calls" => "fuzzy method-call CALLS fallback",
        "@stdlib/shape_verifier" => "shape-violation ISSUE diagnostics",
        "@stdlib/axum_routes" => "axum ROUTES_TO",
        _ => "(unregistered pack)",
    }
}

/// Render the phase-9 pack-failure summary. One line per failed pack: name, the
/// slice it owns (now missing), and the error. Pure for testability.
fn pack_failure_summary(failures: &[(String, String)]) -> String {
    let mut out = String::from(
        "rule-pack phase FAILED — the derive packs are the ONLY producer of their \
         slices (the legacy resolve pipeline was removed); the graph is missing:\n",
    );
    for (pack, err) in failures {
        out.push_str(&format!(
            "  {pack} — owns: {} — error: {err}\n",
            pack_owned_slice(pack)
        ));
    }
    out.push_str("fix the failing pack(s) and re-run analyze; the run is incomplete");
    out
}

/// Phase 9 — the rule-pack phase: run the canonical stdlib rule packs in
/// [`STDLIB_RULE_PACKS`] order (the ordering contract documented at the const).
/// This is the ONLY producer of the resolved slices (DEPENDS_ON included; the
/// legacy P3 in-orchestrator derivation was deleted in Wave 6).
///
/// FAILURE POLICY (Wave 6): a failed pack = its slice is MISSING with no
/// fallback to re-derive it. All packs still run (maximal diagnostics per run —
/// later packs depend on earlier ones only through committed edges, so a failed
/// producer degrades but does not invalidate them), then the phase FAILS with
/// [`pack_failure_summary`] naming every failed pack and its owned slice.
async fn run_stdlib_rule_packs(
    rfdb: &mut rfdb::RfdbClient,
    prof: Option<&profiler::Profiler>,
    imports_from_hint: usize,
) -> Result<()> {
    let mut failed_packs: Vec<(String, String)> = Vec::new();
    for pack in STDLIB_RULE_PACKS {
        let pack_start = std::time::Instant::now();
        match rfdb.materialize_datalog(pack).await {
            Ok(pack_edges) => {
                let pack_ms = pack_start.elapsed().as_millis() as u64;
                tracing::info!(pack = *pack, ms = pack_ms, edges = pack_edges, "Rule pack materialized");
                if let Some(p) = prof {
                    p.event("rule_pack_complete", &[
                        ("pack", pack),
                        ("ms", &pack_ms.to_string()),
                        ("edges", &pack_edges.to_string()),
                    ]);
                }
                if *pack == "@stdlib/depends" {
                    tracing::info!(
                        edges = pack_edges,
                        from_imports = imports_from_hint,
                        "DEPENDS_ON derived by RFDB derive engine @materialize"
                    );
                    if let Some(p) = prof {
                        p.event("depends_on_complete_v2", &[("edges", &pack_edges.to_string())]);
                    }
                }
            }
            Err(err) => {
                tracing::error!(
                    pack = *pack,
                    error = %format!("{err:#}"),
                    "Rule pack @materialize FAILED — its slice is missing (no fallback); \
                     remaining packs still run, the run fails at end of phase"
                );
                failed_packs.push((pack.to_string(), format!("{err:#}")));
            }
        }
    }
    if !failed_packs.is_empty() {
        anyhow::bail!("{}", pack_failure_summary(&failed_packs));
    }
    Ok(())
}

/// Validate, stamp, tag virtual nodes, and commit a resolution output to RFDB.
async fn commit_resolve_output(
    output: &mut plugin::PluginOutput,
    name: &str,
    generation: u64,
    rfdb: &mut rfdb::RfdbClient,
) -> anyhow::Result<()> {
    // Single safe commit path (validate + stamp + tag virtual nodes + tombstone-safe
    // changed_files filter), shared with the per-file resolve durability checkpoints.
    plugin::commit_resolve_chunk(output, name, generation, rfdb).await?;
    tracing::info!(
        plugin = name,
        nodes = output.nodes.len(),
        edges = output.edges.len(),
        "Resolution step complete"
    );
    Ok(())
}

/// Detect which languages are present in the RFDB graph by inspecting MODULE node file extensions.
async fn detect_languages_in_db(rfdb: &mut rfdb::RfdbClient) -> HashSet<config::Language> {
    let module_nodes = rfdb.query_nodes_by_type("MODULE").await.unwrap_or_default();
    let mut langs = HashSet::new();
    for node in &module_nodes {
        if let Some(ref file) = node.file {
            if let Some(lang) = config::detect_language(std::path::Path::new(file)) {
                langs.insert(lang);
            }
        }
    }
    langs
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Analyze {
            config: config_path,
            socket,
            jobs,
            force,
            resolve_jobs,
        } => {
            if let Some(msg) = resolve_jobs_notice("--resolve-jobs", resolve_jobs) {
                tracing::warn!("{msg}");
            }
            let cfg = config::load(&config_path)?.with_defaults();

            // Resolve RFDB socket path: CLI flag > config > default
            let socket_path = socket
                .or(cfg.rfdb_socket.clone())
                .unwrap_or_else(|| PathBuf::from("/tmp/rfdb.sock"));

            // Discover workspace packages from services config
            let ws_packages_raw = config::discover_workspace_packages(&cfg.root, &cfg.services);
            let mut ws_packages: Vec<plugin::WorkspacePackageWire> = ws_packages_raw
                .iter()
                .map(|p| plugin::WorkspacePackageWire {
                    name: p.name.clone(),
                    entry_point: p.entry_point.clone(),
                    package_dir: p.package_dir.clone(),
                })
                .collect();

            // Expand aliases into virtual workspace packages.
            // E.g., alias "jodit/esm" → "jodit/src" creates a virtual package
            // so `import from 'jodit/esm/config'` resolves to `jodit/src/config.ts`.
            for (alias_prefix, target_dir) in &cfg.aliases {
                let index_candidates = ["index.ts", "index.tsx", "index.js"];
                let entry = index_candidates
                    .iter()
                    .map(|f| format!("{}/{}", target_dir, f))
                    .find(|p| cfg.root.join(p).exists())
                    .unwrap_or_else(|| format!("{}/index.ts", target_dir));

                tracing::info!(
                    alias = %alias_prefix,
                    target = %target_dir,
                    entry = %entry,
                    "Alias expanded to virtual workspace package"
                );
                ws_packages.push(plugin::WorkspacePackageWire {
                    name: alias_prefix.clone(),
                    entry_point: entry,
                    package_dir: target_dir.clone(),
                });
            }

            if !ws_packages.is_empty() {
                tracing::info!(
                    count = ws_packages.len(),
                    "Workspace packages for cross-package resolution (including aliases)"
                );
            }

            tracing::info!(
                config = %config_path.display(),
                socket = %socket_path.display(),
                jobs = jobs,
                force = force,
                "Starting analysis"
            );

            // 0. Create profiler
            let profile_path = cfg.root.join(".grafema").join("analysis-profile.jsonl");
            let prof = profiler::Profiler::new(&profile_path).ok();
            macro_rules! profile {
                ($event:expr $(, $k:expr => $v:expr)*) => {
                    if let Some(ref p) = prof {
                        p.event($event, &[$(($k, &$v.to_string())),*]);
                    }
                };
            }
            profile!("analysis_start", "config" => config_path.display());

            let pipeline_start = std::time::Instant::now();

            // 1. Discover files
            let discovery_start = std::time::Instant::now();
            let files = discovery::discover(&cfg)?;
            let discovery_ms = discovery_start.elapsed().as_millis() as u64;
            tracing::info!(count = files.len(), "Discovered files");
            profile!("files_discovered", "count" => files.len(), "duration_ms" => discovery_ms);

            if files.is_empty() {
                tracing::warn!("No files matched include patterns");
                return Ok(());
            }

            // 2. Connect to RFDB
            let mut rfdb = rfdb::RfdbClient::connect(&socket_path)
                .await
                .with_context(|| format!("Failed to connect to RFDB at {}", socket_path.display()))?;

            // Wave 6: analyze REQUIRES the server-side derive pack phase. The
            // legacy resolve steps and the in-orchestrator P3 DEPENDS_ON fallback
            // were deleted — on a server without the capability there is nothing
            // left that could produce the resolved slices, so fail fast and loud
            // instead of silently shipping an unresolved graph.
            require_derive_capability(&rfdb, &socket_path)?;

            let db_name = "default";
            rfdb.create_database(db_name, false).await?;
            rfdb.open_database(db_name, "rw").await?;
            tracing::info!(db = db_name, "Connected to RFDB");

            // 3. Set up generation tracker and filter changed files
            let filter_start = std::time::Instant::now();
            let tracker_path = cfg.root.join(".grafema").join("gen-tracker.json");
            let mut gen_tracker = gc::GenerationTracker::load(&tracker_path);
            let generation = gen_tracker.bump();
            let (changed_files, unchanged_files) =
                gc::filter_changed_files(&files, &gen_tracker, force)?;
            let filter_ms = filter_start.elapsed().as_millis() as u64;

            tracing::info!(
                changed = changed_files.len(),
                skipped = unchanged_files.len(),
                generation = generation,
                "Filtered files for analysis"
            );

            if changed_files.is_empty() {
                tracing::info!("All files up to date, nothing to analyze");
                return Ok(());
            }

            // RFDB MVCC C2/C3: a FULL analysis is a bulk ingest — defer per-commit
            // fsync to a single barrier (EndBulkLoad) and let the server route
            // CommitBatch through the serial auto-compacting path that bounds the
            // live segment count. Incremental runs are small and deliberately skip
            // compaction, so they stay on the normal concurrent path.
            let use_bulk = changed_files.len() == files.len();
            if use_bulk {
                rfdb.begin_bulk_load()
                    .await
                    .context("Failed to enter RFDB bulk-load mode")?;
                tracing::info!(files = changed_files.len(), "RFDB bulk-load mode armed (full analysis)");
            }

            // 3b. Partition by language
            let (js_files, hs_files, rs_files, java_files, kotlin_files, py_files, go_files, cpp_files, swift_files, objc_files, beam_files, rb_files) = config::partition_by_language(&changed_files);
            tracing::info!(
                js = js_files.len(),
                haskell = hs_files.len(),
                rust = rs_files.len(),
                java = java_files.len(),
                kotlin = kotlin_files.len(),
                python = py_files.len(),
                go = go_files.len(),
                cpp = cpp_files.len(),
                swift = swift_files.len(),
                objc = objc_files.len(),
                beam = beam_files.len(),
                ruby = rb_files.len(),
                "Partitioned files by language"
            );

            // 3c. Verify binary freshness (source hash check)
            {
                let mut binaries_to_check = Vec::new();
                if !js_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.js_path());
                    binaries_to_check.push(cfg.analyzers.js_resolve_path());
                }
                if !hs_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.haskell_path());
                    binaries_to_check.push(cfg.analyzers.haskell_resolve_path());
                }
                if !rs_files.is_empty() {
                    // Rust analyzer is in-process (grafema_orchestrator::rust_analyzer); only resolve daemon is external
                    binaries_to_check.push(cfg.analyzers.rust_resolve_path());
                }
                if !java_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.java_path());
                    binaries_to_check.push(cfg.analyzers.java_resolve_path());
                }
                if !kotlin_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.kotlin_path());
                    binaries_to_check.push(cfg.analyzers.kotlin_resolve_path());
                }
                if !go_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.go_path());
                    binaries_to_check.push(cfg.analyzers.go_resolve_path());
                }
                if !cpp_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.cpp_path());
                    binaries_to_check.push(cfg.analyzers.cpp_resolve_path());
                }
                if !swift_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.swift_parser_path());
                    binaries_to_check.push(cfg.analyzers.swift_path());
                    binaries_to_check.push(cfg.analyzers.swift_resolve_path());
                }
                if !objc_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.objc_parser_path());
                    binaries_to_check.push(cfg.analyzers.objc_path());
                }
                if !beam_files.is_empty() {
                    binaries_to_check.push(cfg.analyzers.beam_path());
                    binaries_to_check.push(cfg.analyzers.beam_resolve_path());
                }

                for binary in &binaries_to_check {
                    if let Err(msg) = source_hash::verify_binary(binary, &cfg.root) {
                        anyhow::bail!("{msg}");
                    }
                }
            }

            // 4. Streaming double-buffer analysis pipeline.
            //
            //    ALL languages analyze in parallel, sending results through ONE
            //    bounded mpsc channel. A single receiver batches INGEST_BATCH_SIZE
            //    results and commits to RFDB while analysis continues filling the
            //    channel. Memory stays proportional to batch size, not project size.
            //
            //    JS/TS: per-file streaming (results sent as each file completes)
            //    Other: per-language streaming (results forwarded after pool completes)
            let size_limits = config::SizeLimits::from_config(&cfg);
            const INGEST_BATCH_SIZE: usize = 20;
            let analysis_timer = std::time::Instant::now();
            let mut total_nodes = 0usize;
            let mut total_edges = 0usize;
            let mut total_errors = 0usize;
            let mut total_files_committed = 0usize;
            let root_str = cfg.root.display().to_string();
            let effects_db_dir = cfg.root.join("effects-db");
            let effects_db_path: Option<String> = if effects_db_dir.exists() {
                Some(effects_db_dir.to_string_lossy().to_string())
            } else {
                None
            };
            let authority = resolve_authority(&cfg);
            let total_files = files.len();

            // Helper: prepare and commit a chunk of analysis results to RFDB.
            // Takes ownership → results are freed after commit.
            async fn ingest_chunk(
                mut results: Vec<analyzer::AnalysisResult>,
                rfdb: &mut rfdb::RfdbClient,
                root_str: &str,
                authority: &str,
                generation: u64,
                global_progress: usize,
                total_files: usize,
            ) -> anyhow::Result<(usize, usize, usize)> {
                let mut nodes_total = 0usize;
                let mut edges_total = 0usize;
                let mut errors_total = 0usize;

                // Convert byte offsets → line:column for JS/TS files (Haskell
                // js-analyzer outputs byte offsets, not line numbers).
                // Must happen BEFORE relativize_paths since we need absolute paths.
                for result in &mut results {
                    if let Some(ref mut analysis) = result.analysis {
                        if analyzer::is_js_ts_file(&result.file) {
                            analysis.convert_byte_offsets_to_lines(&result.file);
                        }
                        analysis.relativize_paths(root_str);
                        analysis.ensure_function_contains_edges();
                        analysis.ensure_function_scope_edges();
                        analysis.ensure_exported_flags();
                        analysis.to_uri_format(authority);
                    }
                }

                let mut batch_nodes: Vec<rfdb::WireNode> = Vec::new();
                let mut batch_edges: Vec<rfdb::WireEdge> = Vec::new();
                let mut batch_files: Vec<String> = Vec::new();

                for result in &results {
                    if !result.errors.is_empty() {
                        errors_total += result.errors.len();
                        for err in &result.errors {
                            tracing::error!(file = %result.file.display(), "{err}");
                        }
                    }

                    if let Some(ref analysis) = result.analysis {
                        let mut wire_nodes = analyzer::to_wire_nodes(analysis);
                        let mut wire_edges = analyzer::to_wire_edges(analysis);

                        for node in &mut wire_nodes {
                            gc::stamp_node_metadata(&mut node.metadata, generation, "analyzer");
                        }
                        for edge in &mut wire_edges {
                            gc::stamp_edge_metadata(&mut edge.metadata, generation, "analyzer");
                        }

                        nodes_total += wire_nodes.len();
                        edges_total += wire_edges.len();

                        batch_files.push(analysis.file.clone());
                        batch_nodes.extend(wire_nodes);
                        batch_edges.extend(wire_edges);
                    }

                    // Persist METRIC nodes for per-file performance data
                    {
                        let abs_file = result.file.display().to_string();
                        let root_prefix = if root_str.ends_with('/') {
                            root_str.to_string()
                        } else {
                            format!("{root_str}/")
                        };
                        let rel_file = abs_file.strip_prefix(&root_prefix)
                            .unwrap_or(&abs_file);

                        let (mut metric_nodes, mut metric_edges) =
                            analyzer::metrics_to_wire(&result.metrics, rel_file, authority);

                        for node in &mut metric_nodes {
                            gc::stamp_node_metadata(&mut node.metadata, generation, "orchestrator-metrics");
                        }
                        for edge in &mut metric_edges {
                            gc::stamp_edge_metadata(&mut edge.metadata, generation, "orchestrator-metrics");
                        }

                        nodes_total += metric_nodes.len();
                        edges_total += metric_edges.len();

                        batch_nodes.extend(metric_nodes);
                        batch_edges.extend(metric_edges);
                    }

                    // Persist ISSUE nodes for analysis problems (oversized files, parse errors, etc.)
                    if !result.issues.is_empty() {
                        let abs_file = result.file.display().to_string();
                        let root_prefix = if root_str.ends_with('/') {
                            root_str.to_string()
                        } else {
                            format!("{root_str}/")
                        };
                        let rel_file = abs_file.strip_prefix(&root_prefix)
                            .unwrap_or(&abs_file);

                        let include_module_stub = result.analysis.is_none();
                        let (mut issue_nodes, mut issue_edges) =
                            analyzer::issues_to_wire(&result.issues, rel_file, authority, include_module_stub);

                        for node in &mut issue_nodes {
                            gc::stamp_node_metadata(&mut node.metadata, generation, "analyzer");
                        }
                        for edge in &mut issue_edges {
                            gc::stamp_edge_metadata(&mut edge.metadata, generation, "analyzer");
                        }

                        nodes_total += issue_nodes.len();
                        edges_total += issue_edges.len();

                        // Ensure file is in batch for RFDB file-scoped deletion
                        if result.analysis.is_none() {
                            batch_files.push(rel_file.to_string());
                        }
                        batch_nodes.extend(issue_nodes);
                        batch_edges.extend(issue_edges);
                    }
                }

                if !batch_files.is_empty() {
                    tracing::info!(
                        progress = format!("{}/{}", global_progress, total_files),
                        files = batch_files.len(),
                        nodes = batch_nodes.len(),
                        edges = batch_edges.len(),
                        "Committing batch to RFDB"
                    );
                    rfdb.commit_batch(&batch_files, &batch_nodes, &batch_edges, true)
                        .await
                        .context("Failed to commit analysis batch")?;
                }

                Ok((nodes_total, edges_total, errors_total))
            }

            // Shared channel for all languages. Bounded = backpressure when
            // ingestion is slower than analysis.
            let (tx, mut rx) =
                tokio::sync::mpsc::channel::<analyzer::AnalysisResult>(INGEST_BATCH_SIZE * 2);

            // Save JS file count before moving into streaming task
            let js_file_count = js_files.len();

            // Macro: spawn a language's analysis in background, forward results
            // through the shared channel. Clones the file list (fine for non-JS
            // languages which typically have <1K files).
            macro_rules! spawn_analysis {
                ($files:expr, $lang:expr, $analyze_fn:expr) => {
                    if !$files.is_empty() {
                        tracing::info!(count = $files.len(), concat!("Analyzing ", $lang, " files"));
                        let tx = tx.clone();
                        let files_vec: Vec<std::path::PathBuf> = $files.to_vec();
                        let analyzers = cfg.analyzers.clone();
                        let jobs = jobs;
                        let limits = size_limits;
                        tokio::spawn(async move {
                            let results = $analyze_fn(&files_vec, jobs, &analyzers, limits).await;
                            for r in results {
                                if tx.send(r).await.is_err() { break; }
                            }
                        });
                    }
                };
            }

            // 4a. JS/TS — per-file streaming (most critical for 14K+ file projects)
            if js_file_count > 0 {
                tracing::info!(count = js_file_count, "Analyzing JS/TS files");
                let tx_js = tx.clone();
                let js_analyzer_path = cfg.analyzers.js_path();
                let js_jobs = jobs;
                let js_limits = size_limits;
                tokio::spawn(async move {
                    analyzer::analyze_js_files_streaming(
                        js_files, js_jobs, js_analyzer_path, tx_js, js_limits,
                    )
                    .await;
                });
            }

            // 4b–4k. All other languages — pool-based analysis, results forwarded
            spawn_analysis!(hs_files, "Haskell", analyzer::analyze_haskell_files_parallel_pooled);
            spawn_analysis!(rs_files, "Rust", grafema_orchestrator::rust_analyzer::analyze_rust_files_native);
            spawn_analysis!(java_files, "Java", analyzer::analyze_java_files_parallel_pooled);
            spawn_analysis!(kotlin_files, "Kotlin", analyzer::analyze_kotlin_files_parallel_pooled);
            spawn_analysis!(py_files, "Python", analyzer::analyze_python_files_parallel_pooled);
            spawn_analysis!(go_files, "Go", analyzer::analyze_go_files_parallel_pooled);
            spawn_analysis!(swift_files, "Swift", analyzer::analyze_swift_files_parallel_pooled);
            spawn_analysis!(objc_files, "Obj-C", analyzer::analyze_objc_files_parallel_pooled);
            spawn_analysis!(beam_files, "BEAM", analyzer::analyze_beam_files_parallel_pooled);
            #[cfg(feature = "ruby")]
            spawn_analysis!(rb_files, "Ruby", grafema_orchestrator::ruby_analyzer::analyze_ruby_files_native);

            // C++ needs compile_commands — handle separately
            if !cpp_files.is_empty() {
                tracing::info!(count = cpp_files.len(), "Analyzing C/C++ files");

                let compile_commands = {
                    let search_dirs = [
                        cfg.root.clone(),
                        cfg.root.join("build"),
                        cfg.root.join("cmake-build-debug"),
                        cfg.root.join("cmake-build-release"),
                        cfg.root.join("out"),
                        cfg.root.join("_build"),
                    ];
                    let mut db = None;
                    for dir in &search_dirs {
                        let cc_path = dir.join("compile_commands.json");
                        if cc_path.is_file() {
                            match grafema_orchestrator::cpp_parser::CompileCommandsDb::load(&cc_path) {
                                Ok(loaded) => {
                                    tracing::info!(
                                        path = %cc_path.display(),
                                        "Loaded compile_commands.json"
                                    );
                                    db = Some(loaded);
                                    break;
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        path = %cc_path.display(),
                                        "Failed to load compile_commands.json: {e}"
                                    );
                                }
                            }
                        }
                    }
                    db
                };

                let tx_cpp = tx.clone();
                let cpp_files_vec: Vec<PathBuf> = cpp_files.to_vec();
                let cpp_analyzers = cfg.analyzers.clone();
                let cpp_jobs = jobs;
                let cpp_limits = size_limits;
                tokio::spawn(async move {
                    let results = analyzer::analyze_cpp_files_parallel_pooled(
                        &cpp_files_vec,
                        cpp_jobs,
                        &cpp_analyzers,
                        compile_commands.as_ref(),
                        cpp_limits,
                    )
                    .await;
                    for r in results {
                        if tx_cpp.send(r).await.is_err() { break; }
                    }
                });
            }

            // Drop the original sender — channel closes when ALL language tasks complete
            drop(tx);

            // Single receiver: batch results from all languages and commit to RFDB.
            // Analysis and ingestion run in parallel (double-buffer).
            let mut batch = Vec::with_capacity(INGEST_BATCH_SIZE);
            let mut batch_idx: usize = 0;
            let mut rfdb_commit_total_ms: u128 = 0;
            let mut batch_commit_latencies: Vec<u128> = Vec::new();
            while let Some(mut result) = rx.recv().await {
                // Compute semantic density metrics from analysis nodes
                result.metrics.fill_density(&result.analysis);
                // Emit per-file profiler event
                let m = &result.metrics;
                let file_str = result.file.display().to_string();
                profile!("file_analyzed",
                    "file" => file_str,
                    "file_size_bytes" => m.file_size_bytes,
                    "ast_size_bytes" => m.ast_size_bytes,
                    "parse_ms" => m.parse_ms,
                    "analyze_ms" => m.analyze_ms,
                    "total_ms" => m.total_ms,
                    "node_count" => m.node_count,
                    "edge_count" => m.edge_count,
                    "decl_count" => m.decl_count,
                    "ref_count" => m.ref_count,
                    "call_count" => m.call_count,
                    "prop_count" => m.prop_count
                );
                batch.push(result);
                if batch.len() >= INGEST_BATCH_SIZE {
                    let full_batch = std::mem::replace(
                        &mut batch,
                        Vec::with_capacity(INGEST_BATCH_SIZE),
                    );
                    let batch_len = full_batch.len();
                    let commit_start = std::time::Instant::now();
                    let (n, e, err) = ingest_chunk(
                        full_batch,
                        &mut rfdb,
                        &root_str,
                        &authority,
                        generation,
                        total_files_committed + batch_len,
                        total_files,
                    )
                    .await?;
                    let commit_ms = commit_start.elapsed().as_millis();
                    rfdb_commit_total_ms += commit_ms;
                    batch_commit_latencies.push(commit_ms);
                    profile!("batch_committed",
                        "batch_index" => batch_idx,
                        "files" => batch_len,
                        "nodes" => n,
                        "edges" => e,
                        "commit_ms" => commit_ms
                    );
                    total_nodes += n;
                    total_edges += e;
                    total_errors += err;
                    total_files_committed += batch_len;
                    if batch_idx % 10 == 0 {
                        let bp = analyzer::read_backpressure_count();
                        if bp > 0 {
                            profile!("channel_backpressure", "blocked_count" => bp);
                        }
                    }
                    batch_idx += 1;
                }
            }
            // Flush remaining results
            if !batch.is_empty() {
                let batch_len = batch.len();
                let commit_start = std::time::Instant::now();
                let (n, e, err) = ingest_chunk(
                    batch,
                    &mut rfdb,
                    &root_str,
                    &authority,
                    generation,
                    total_files_committed + batch_len,
                    total_files,
                )
                .await?;
                let commit_ms = commit_start.elapsed().as_millis();
                rfdb_commit_total_ms += commit_ms;
                batch_commit_latencies.push(commit_ms);
                profile!("batch_committed",
                    "batch_index" => batch_idx,
                    "files" => batch_len,
                    "nodes" => n,
                    "edges" => e,
                    "commit_ms" => commit_ms
                );
                total_nodes += n;
                total_edges += e;
                total_errors += err;
                total_files_committed += batch_len;
                let bp = analyzer::read_backpressure_count();
                if bp > 0 {
                    profile!("channel_backpressure", "blocked_count" => bp);
                }
            }

            // NOTE: Do NOT flush/rebuild_indexes here. Analysis commits
            // tombstone resolution edges (via delete_node cascading to edges).
            // If we flush now, tombstones get persisted to the store before
            // resolution can clear them via add_edges. Resolution edges would
            // then be removed by compaction. Let compact() handle the flush.
            // V2 engine write buffers are queryable without flushing.
            //
            // EXPERIMENT RESULT (2026-03-17): Pre-resolve compact made everything
            // 2x SLOWER (174s→305s). Compact creates L1 segments with indexes, but
            // each resolve commit_batch writes to write buffer, invalidating the
            // edge_type_index. Queries then scan both L1 + write buffer, paying
            // double. The real fix is write-buffer-level indexes (HashMap by type)
            // that survive mutations, not L1 compaction.

            // RFDB commit aggregate statistics
            let (batch_count, p50_ms, p95_ms, p99_ms) = if !batch_commit_latencies.is_empty() {
                batch_commit_latencies.sort();
                let len = batch_commit_latencies.len();
                let p50 = batch_commit_latencies[len / 2];
                let p95 = batch_commit_latencies[(len * 95) / 100];
                let p99 = batch_commit_latencies[(len * 99) / 100];
                let total_commit_ms = batch_commit_latencies.iter().sum::<u128>();
                let avg_nodes_per_sec = if total_commit_ms > 0 {
                    (total_nodes as u128 * 1000) / total_commit_ms
                } else { 0 };
                let avg_edges_per_sec = if total_commit_ms > 0 {
                    (total_edges as u128 * 1000) / total_commit_ms
                } else { 0 };

                profile!("rfdb_commit_summary",
                    "batches" => len,
                    "total_ms" => total_commit_ms,
                    "p50_ms" => p50,
                    "p95_ms" => p95,
                    "p99_ms" => p99,
                    "avg_nodes_per_sec" => avg_nodes_per_sec,
                    "avg_edges_per_sec" => avg_edges_per_sec
                );
                (len as u64, p50 as u64, p95 as u64, p99 as u64)
            } else {
                (0u64, 0u64, 0u64, 0u64)
            };

            tracing::info!(
                nodes = total_nodes,
                edges = total_edges,
                errors = total_errors,
                "Analysis complete"
            );
            profile!("analysis_complete",
                "nodes" => total_nodes, "edges" => total_edges, "errors" => total_errors);

            // 6.5. Build DIRECTORY/FILE structural nodes
            let dirstruct_start = std::time::Instant::now();
            let root_prefix_for_dirs = if root_str.ends_with('/') {
                root_str.clone()
            } else {
                format!("{root_str}/")
            };
            let relative_files: Vec<String> = files.iter()
                .map(|p| {
                    let abs = p.display().to_string();
                    abs.strip_prefix(&root_prefix_for_dirs).unwrap_or(&abs).to_string()
                })
                .collect();
            let (dir_nodes, dir_edges, cleanup_files) = directory_nodes::build(&relative_files);
            if !dir_nodes.is_empty() {
                match rfdb.commit_batch(&cleanup_files, &dir_nodes, &dir_edges, false).await {
                    Ok(_) => {
                        tracing::info!(
                            dir_nodes = dir_nodes.len(),
                            dir_edges = dir_edges.len(),
                            duration_ms = dirstruct_start.elapsed().as_millis() as u64,
                            "Directory/file structure committed"
                        );
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "Failed to commit directory structure (non-fatal)");
                    }
                }
            }

            // 7. Handle deleted files
            let deleted = gc::detect_deleted_files(&gen_tracker, &files);
            if !deleted.is_empty() {
                tracing::info!(count = deleted.len(), "Cleaning up deleted files");
                let root_prefix = if root_str.ends_with('/') {
                    root_str.clone()
                } else {
                    format!("{root_str}/")
                };
                for del_file in &deleted {
                    let abs_str = del_file.display().to_string();
                    let file_str = abs_str.strip_prefix(&root_prefix).unwrap_or(&abs_str).to_string();
                    rfdb.commit_batch(&[file_str], &[], &[], false).await?;
                }
            }

            // 7. Update mtime tracker for next incremental run
            gc::update_mtimes(&mut gen_tracker, &changed_files)?;
            if let Err(e) = gen_tracker.save(&tracker_path) {
                tracing::warn!("Failed to save generation tracker: {}", e);
            }

            let analysis_ms = analysis_timer.elapsed().as_millis() as u64;

            // Collect IMPORTS_FROM edges from all import resolvers for DEPENDS_ON derivation
            let resolve_timer = std::time::Instant::now();
            let mut all_imports_from_edges: Vec<(String, String)> = Vec::new();

            // Build file → MODULE semantic ID map from RFDB (full graph)
            let file_to_module = build_file_to_module_map(&mut rfdb).await;

            // Resolve-step gating: GRAFEMA_SKIP_RESOLVE_STEPS gates the REMAINING
            // native steps (the derive-replaced ones were deleted in Wave 6) — js
            // daemon steps via the pinned child env below, rust steps by never
            // sending the command (8b). See `resolve_step_skips`.
            let resolve_skips = resolve_step_skips(
                std::env::var("GRAFEMA_SKIP_RESOLVE_STEPS").ok().as_deref(),
            );
            let resolve_skips_env = if resolve_skips.is_empty() {
                None
            } else {
                let value = skip_steps_env_value(&resolve_skips);
                tracing::info!(
                    steps = %value,
                    "Native resolve steps gated via GRAFEMA_SKIP_RESOLVE_STEPS"
                );
                Some(value)
            };

            // 8. Run JS resolution with per-file streaming (build-index + resolve-file)
            if js_file_count > 0 && !skip_resolver("js") {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolution: JS/TS (per-file streaming, 1 worker)...");
                profile!("js_resolve_start", "workers" => 1);

                let resolve_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.js_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    max_message_size: 200 * 1024 * 1024,
                    request_timeout: std::time::Duration::from_secs(300),
                    effects_db_path: effects_db_path.clone(),
                    skip_resolve_steps: resolve_skips_env.clone(),
                };

                match process_pool::ProcessPool::new(resolve_pool_config, 1) {
                    Ok(resolve_pool) => {
                        let handles = resolve_pool.acquire_all().await?;

                        let output = plugin::resolve_per_file(
                            &mut rfdb,
                            config::Language::JavaScript,
                            &handles[0],
                            &ws_packages,
                            "js-resolution",
                            generation,
                            prof.as_ref(),
                        ).await?;

                        // Extract IMPORTS_FROM edges for DEPENDS_ON derivation
                        for edge in &output.edges {
                            if edge.edge_type == "IMPORTS_FROM" {
                                all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                            }
                        }

                        // resolve_per_file commits its own output incrementally
                        // (per-checkpoint), so no end-of-phase commit here.
                        //
                        // (The former SECOND pass — js-this-method-calls + runtime-
                        // call-globals — was deleted in Wave 6: the js_this_method_calls
                        // and js_runtime_globals_nodes/_edges packs own those slices,
                        // proven set-identical — W9 432≡432, Wave 4 7,800≡7,800.)
                        drop(handles);

                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("js_resolve_complete",
                            "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                            "duration_ms" => lang_ms);
                        eprintln!("  Resolution: JS complete ({} edges, {:.1}s)",
                            output.edges.len(), lang_ms as f64 / 1000.0);

                        resolve_pool.shutdown().await;
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to create resolve pool, skipping built-in resolution: {e}"
                        );
                    }
                }
            }

            // 8a. Run Haskell resolution (streaming)
            if !hs_files.is_empty() && !skip_resolver("haskell") {
                let lang_start = std::time::Instant::now();
                profile!("haskell_resolve_start");
                let hs_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.haskell_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(hs_pool_config, 1) {
                    Ok(hs_pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Haskell],
                            &[("haskell-imports", &[]), ("haskell-local-refs", &[]), ("haskell-local-calls", &[]), ("haskell-cross-module-calls", &[]), ("haskell-globals", &[])],
                            &hs_pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            let commit_name = match cmd.as_str() {
                                "haskell-imports" => "haskell-import-resolution",
                                "haskell-local-calls" => "haskell-local-calls",
                                "haskell-cross-module-calls" => "haskell-cross-module-calls",
                                "haskell-globals" => "haskell-runtime-globals",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "haskell", "cmd" => commit_name,
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        hs_pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("haskell_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to create Haskell resolve pool: {e}");
                    }
                }
            }

            // 8b. Run Rust resolution (streaming)
            if !rs_files.is_empty() && !skip_resolver("rust") {
                let lang_start = std::time::Instant::now();
                profile!("rust_resolve_start");
                let rs_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.rust_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    skip_resolve_steps: resolve_skips_env.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(rs_pool_config, 1) {
                    Ok(rs_pool) => {
                        // The remaining NATIVE rust steps (no pack replacement):
                        // rust-cross-methods (dyn-dispatch + self-field arms) and
                        // rust-globals (effects-db). rust-imports / rust-calls /
                        // rust-trait-resolve were deleted in Wave 6 — the
                        // rust_imports / rust_calls / rust_trait_resolve packs own
                        // those slices. Both remaining cmds stay env-skippable.
                        let rust_cmds: Vec<(&str, &[plugin::WorkspacePackageWire])> =
                            [("rust-cross-methods", &[] as &[plugin::WorkspacePackageWire]), ("rust-globals", &[])]
                                .into_iter()
                                .filter(|(name, _)| {
                                    let keep = !resolve_skips.contains(*name);
                                    if !keep {
                                        tracing::warn!(step = name, "Native resolve step skipped (GRAFEMA_SKIP_RESOLVE_STEPS)");
                                    }
                                    keep
                                })
                                .collect();
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Rust],
                            &rust_cmds,
                            &rs_pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            let commit_name = match cmd.as_str() {
                                "rust-cross-methods" => "rust-cross-method-calls",
                                "rust-globals" => "rust-runtime-globals",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "rust", "cmd" => commit_name,
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        rs_pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("rust_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to create Rust resolve pool: {e}");
                    }
                }
            }

            // 8c. Run Java resolution (streaming)
            if !java_files.is_empty() && !skip_resolver("java") {
                let lang_start = std::time::Instant::now();
                profile!("java_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.java_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Java], &[("java-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "java-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "java", "cmd" => "java-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("java_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create Java resolve pool: {e}"),
                }
            }

            // 8d. Run Kotlin resolution (streaming)
            if !kotlin_files.is_empty() && !skip_resolver("kotlin") {
                let lang_start = std::time::Instant::now();
                profile!("kotlin_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.kotlin_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Kotlin], &[("kotlin-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "kotlin-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "kotlin", "cmd" => "kotlin-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("kotlin_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create Kotlin resolve pool: {e}"),
                }
            }

            // 8e. Run Python resolution (streaming)
            if !py_files.is_empty() && !skip_resolver("python") {
                let lang_start = std::time::Instant::now();
                profile!("python_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.python_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Python], &[("python-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "python-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "python", "cmd" => "python-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("python_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create Python resolve pool: {e}"),
                }
            }

            // 8f. Run Go resolution (streaming)
            if !go_files.is_empty() && !skip_resolver("go") {
                let lang_start = std::time::Instant::now();
                profile!("go_resolve_start");
                let go_module_path = config::discover_go_module_path(&cfg.root);
                let go_ws_packages: Vec<plugin::WorkspacePackageWire> = go_module_path
                    .map(|mp| vec![plugin::WorkspacePackageWire {
                        name: mp.clone(),
                        entry_point: String::new(),
                        package_dir: cfg.root.display().to_string(),
                    }])
                    .unwrap_or_default();

                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.go_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Go], &[("go-all", &go_ws_packages)], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "go-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "go", "cmd" => "go-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("go_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create Go resolve pool: {e}"),
                }
            }

            // 8g. Run Swift resolution (streaming)
            if !swift_files.is_empty() && !skip_resolver("swift") {
                let lang_start = std::time::Instant::now();
                profile!("swift_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.swift_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Swift], &[("swift-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "swift-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "swift", "cmd" => "swift-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("swift_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create Swift resolve pool: {e}"),
                }
            }

            // 8h. Run Apple cross-language resolution (streaming, Swift + Obj-C)
            if !swift_files.is_empty()
                && !objc_files.is_empty()
                && !skip_resolver("swift")
                && !skip_resolver("objc")
            {
                let lang_start = std::time::Instant::now();
                profile!("apple_cross_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.apple_cross_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Swift, config::Language::ObjectiveC],
                            &[("apple-cross-all", &[])],
                            &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            commit_resolve_output(&mut output, "apple-cross-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "apple-cross", "cmd" => "apple-cross-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("apple_cross_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create Apple cross-resolve pool: {e}"),
                }
            }

            // 8i. Run JVM cross-language resolution (streaming, Java + Kotlin)
            if !java_files.is_empty()
                && !kotlin_files.is_empty()
                && !skip_resolver("java")
                && !skip_resolver("kotlin")
            {
                let lang_start = std::time::Instant::now();
                profile!("jvm_cross_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.jvm_cross_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Java, config::Language::Kotlin],
                            &[("jvm-cross-all", &[])],
                            &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "jvm-cross-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "jvm-cross", "cmd" => "jvm-cross-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("jvm_cross_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create JVM cross-resolve pool: {e}"),
                }
            }

            // 8j. Run C/C++ resolution (streaming)
            if !cpp_files.is_empty() && !skip_resolver("cpp") {
                let lang_start = std::time::Instant::now();
                profile!("cpp_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.cpp_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Cpp], &[("cpp-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "cpp-resolution", generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "cpp", "cmd" => "cpp-resolution",
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("cpp_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create C/C++ resolve pool: {e}"),
                }
            }

            // 8k. Run BEAM resolution (streaming)
            if !beam_files.is_empty() && !skip_resolver("beam") {
                let lang_start = std::time::Instant::now();
                profile!("beam_resolve_start");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.beam_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Beam],
                            &[
                                ("beam-imports", &[]),
                                ("beam-local-refs", &[]),
                                ("beam-runtime-globals", &[]),
                                ("beam-behaviours", &[]),
                                ("beam-protocols", &[]),
                                // REG-1098 W6: resolve wrapper calls into virtual effect edges
                                // (runs after beam-local-refs so CALLS edges exist for walking)
                                ("beam-wrapper-resolve", &[]),
                                // REG-1098 W6.5: upgrade coarse SENDS_TO→PROCESS into precise
                                // SENDS_MESSAGE / SELF_SCHEDULE edges to MESSAGE_TYPE clauses
                                // (needs wrapper-resolve first so virtual calls from wrappers are seen)
                                ("beam-message-types", &[]),
                                // GAP-C: close the PubSub delivery loop — emit PUBLISHES edges
                                // from broadcast CALLs to subscriber handle_info clauses by
                                // matching (pubsub_server, topic) + shape unification.
                                ("beam-pubsub-delivery", &[]),
                                // REG-1098 W9: emit ISSUE nodes for MessageFlow findings
                                // (runs last; reads the post-resolution node snapshot)
                                ("beam-message-findings", &[]),
                            ],
                            &pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let cmd_start = std::time::Instant::now();
                            let commit_name = match cmd.as_str() {
                                "beam-imports" => "beam-import-resolution",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                            let cmd_ms = cmd_start.elapsed().as_millis();
                            profile!("resolve_cmd_complete", "language" => "beam", "cmd" => commit_name,
                                "nodes" => output.nodes.len(), "edges" => output.edges.len(),
                                "duration_ms" => cmd_ms);
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("beam_resolve_complete", "duration_ms" => lang_ms);
                    }
                    Err(e) => tracing::warn!("Failed to create BEAM resolve pool: {e}"),
                }
            }

            // 8l. Ruby resolution (embedded — no external binary)
            #[cfg(feature = "ruby")]
            if !rb_files.is_empty() {
                let lang_start = std::time::Instant::now();
                profile!("ruby_resolve_start");
                match ruby_resolver::resolve_ruby_imports(&mut rfdb, &root_str).await {
                    Ok(output) => {
                        for edge in &output.edges {
                            if edge.edge_type == "IMPORTS_FROM" {
                                all_imports_from_edges
                                    .push((edge.src.clone(), edge.dst.clone()));
                            }
                        }
                        if !output.edges.is_empty() {
                            rfdb.commit_batch(&[], &output.nodes, &output.edges, true)
                                .await
                                .context("Failed to commit Ruby resolution edges")?;
                        }
                        let lang_ms = lang_start.elapsed().as_millis();
                        profile!("ruby_resolve_complete",
                            "edges" => output.edges.len(),
                            "duration_ms" => lang_ms);
                        tracing::info!(
                            edges = output.edges.len(),
                            duration_ms = lang_ms as u64,
                            "Ruby resolution complete"
                        );
                    }
                    Err(e) => tracing::warn!("Ruby resolution failed: {e}"),
                }
            }

            // 8m. Run user-defined plugins via DAG (if any non-default plugins configured)
            let user_plugins: Vec<_> = cfg
                .plugins
                .iter()
                .filter(|p| {
                    p.name != "js-import-resolution" && p.name != "runtime-globals"
                })
                .cloned()
                .collect();
            if !user_plugins.is_empty() {
                tracing::info!(count = user_plugins.len(), "Running user-defined plugins");

                let resolve_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.js_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                let resolve_pool = match process_pool::ProcessPool::new(resolve_pool_config, 1) {
                    Ok(pool) => Some(pool),
                    Err(e) => {
                        tracing::warn!("Failed to create resolve pool for user plugins: {e}");
                        None
                    }
                };

                // A plugin failure aborts the analyze run (loud-failure policy,
                // same as derive-pack failures) — but shut the pool down first.
                let dag_result = plugin::run_plugins_dag(
                    &user_plugins,
                    &mut rfdb,
                    &socket_path,
                    db_name,
                    generation,
                    resolve_pool.as_ref(),
                )
                .await;

                if let Some(pool) = resolve_pool {
                    pool.shutdown().await;
                }

                dag_result?;
            }

            let resolve_ms = resolve_timer.elapsed().as_millis() as u64;



            // 8n. Commit WORKSPACE_PACKAGE facts (Wave 3c): the workspace map the
            // legacy resolver consumed over the wire becomes graph facts, so the
            // datalog packs (js_module_imports workspace arms) can join them.
            // Must land BEFORE the pack phase below. Re-emitted every run: ids are
            // stable (upsert dedups), and re-analysis of an entry-point file
            // tombstones its fact until this re-commit restores it.
            if !ws_packages.is_empty() {
                let mut ws_nodes = analyzer::workspace_packages_to_wire(&ws_packages, &authority);
                for node in &mut ws_nodes {
                    gc::stamp_node_metadata(&mut node.metadata, generation, "workspace-packages");
                }
                let n_ws = ws_nodes.len();
                rfdb.commit_batch(&[], &ws_nodes, &[], true)
                    .await
                    .context("Failed to commit WORKSPACE_PACKAGE facts")?;
                tracing::info!(count = n_ws, "WORKSPACE_PACKAGE facts committed");
            }

            // 9. Rule-pack phase. The server's capability was asserted at
            // connect time (fail-fast above), so this phase ALWAYS runs — see
            // `run_stdlib_rule_packs` for the ordering contract and the Wave-6
            // failure policy (any failed pack fails the run at end of phase).
            let depends_on_start = std::time::Instant::now();
            profile!("depends_on_start", "imports_from_edges" => all_imports_from_edges.len());
            run_stdlib_rule_packs(&mut rfdb, prof.as_ref(), all_imports_from_edges.len()).await?;
            let depends_on_ms = depends_on_start.elapsed().as_millis() as u64;

            // 10. Generate unresolved diagnostics — AFTER the pack phase (Wave 3c):
            // with legacy resolve steps gated (GRAFEMA_SKIP_RESOLVE_STEPS), the
            // CALLS/IMPORTS_FROM edges the negation queries below check for are
            // produced by the datalog packs; running diagnostics before them
            // would report every pack-resolved node as unresolved.
            let diagnostics_start = std::time::Instant::now();
            {
                // RFD-65: the resolver commits CALLS/IMPORTS_FROM edges with
                // defer_index=true, so the index is stale here. Rebuild BEFORE the
                // negation queries below — otherwise `\+ edge(X, _, "CALLS")` reads a
                // stale index, over-counts unresolved nodes, and the ISSUE count
                // alternates between runs depending on L0/L1 compaction timing.
                rfdb.rebuild_indexes().await.context("Failed to rebuild indexes before unresolved diagnostics")?;

                // Query for unresolved CALL nodes (no outgoing CALLS edge)
                let unresolved_calls_query = r#"violation(X, Name, File) :- node(X, "CALL"), attr(X, "name", Name), attr(X, "file", File), \+ edge(X, _, "CALLS")."#;

                // Query for unresolved IMPORT_BINDING nodes (no outgoing IMPORTS_FROM edge)
                let unresolved_imports_query = r#"violation(X, Name, File) :- node(X, "IMPORT_BINDING"), attr(X, "name", Name), attr(X, "file", File), \+ edge(X, _, "IMPORTS_FROM")."#;

                let mut unresolved: Vec<(String, String, String)> = Vec::new();

                for query in [unresolved_calls_query, unresolved_imports_query] {
                    match rfdb.datalog_query(query).await {
                        Ok(results) => {
                            for r in results {
                                let x = r.bindings.get("X").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let name = r.bindings.get("Name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let file = r.bindings.get("File").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                if !x.is_empty() {
                                    unresolved.push((x, name, file));
                                }
                            }
                        }
                        Err(e) => tracing::warn!("Unresolved diagnostics query failed: {e}"),
                    }
                }

                if !unresolved.is_empty() {
                    let file_set: HashSet<String> = file_to_module.keys().cloned().collect();
                    let (mut diag_nodes, mut diag_edges) = analyzer::unresolved_diagnostics_to_wire(
                        &unresolved, &file_set, &authority,
                    );

                    // Stamp generation so ISSUE nodes are GC'd on next analyze
                    for node in &mut diag_nodes {
                        gc::stamp_node_metadata(&mut node.metadata, generation, "unresolved-diagnostics");
                    }
                    for edge in &mut diag_edges {
                        gc::stamp_edge_metadata(&mut edge.metadata, generation, "unresolved-diagnostics");
                    }

                    if !diag_nodes.is_empty() {
                        let diag_files = vec!["__grafema_virtual/unresolved-diagnostics".to_string()];
                        rfdb.commit_batch(&diag_files, &diag_nodes, &diag_edges, true)
                            .await
                            .context("Failed to commit unresolved diagnostics")?;

                        let external = diag_nodes.iter().filter(|n| {
                            n.metadata.as_ref().is_some_and(|m| m.contains("unresolved_external"))
                        }).count();
                        let internal = diag_nodes.iter().filter(|n| {
                            n.metadata.as_ref().is_some_and(|m| m.contains("unresolved_internal"))
                        }).count();

                        tracing::info!(
                            total = unresolved.len(),
                            external = external,
                            internal = internal,
                            "Unresolved diagnostics generated"
                        );
                    }
                }
            }

            let diagnostics_ms = diagnostics_start.elapsed().as_millis() as u64;

            // Compact to deduplicate segments after all commits.
            // This is needed because:
            // 1. Re-analyzed files create new segment versions alongside old ones.
            //    The superseded_node/edge_count in the engine corrects node_count()
            //    for edges that go through the delete+readd path.
            // 2. DEPENDS_ON and other derived edges are committed with empty
            //    changed_files (no deletion phase), so old segment versions
            //    accumulate. Compaction deduplicates these by (src,dst,type) key.
            //
            // For incremental analysis (few files changed), skip compaction and
            // only rebuild indexes — same pattern as `grafema resolve`. L0 segments
            // remain queryable; full compaction runs on next full analysis or when
            // L0 accumulation triggers it. This avoids O(total_graph) compaction
            // cost for small changes.
            // RFDB MVCC C2/C3: leave bulk-load mode before the post-analysis
            // compaction — runs the single durable barrier (fsync the whole
            // current version once) + bounded reclaim and restores per-commit
            // durability, so the subsequent compact()/rebuild_indexes run Strict.
            if use_bulk {
                rfdb.end_bulk_load()
                    .await
                    .context("Failed to leave RFDB bulk-load mode (durable barrier)")?;
                tracing::info!("RFDB bulk-load barrier complete (state durable)");
            }

            let compact_start = std::time::Instant::now();
            profile!("compact_start", "analysis_nodes" => total_nodes, "analysis_edges" => total_edges);
            let is_incremental = changed_files.len() < files.len();
            if is_incremental {
                tracing::info!(
                    changed = changed_files.len(),
                    total = files.len(),
                    "Incremental analysis — skipping compaction, rebuilding indexes only"
                );
                rfdb.rebuild_indexes().await.context("Failed to rebuild indexes")?;
            } else {
                rfdb.compact().await.context("Failed to compact")?;
            }
            let compact_ms = compact_start.elapsed().as_millis();
            profile!("compact_complete", "duration_ms" => compact_ms, "incremental" => is_incremental);

            // 10. Emit pipeline-level phase metrics as METRIC nodes
            {
                let phase_metrics: Vec<(&str, &str, u64, &str)> = vec![
                    ("discovery",    "duration_ms",  discovery_ms,               "ms"),
                    ("filter",       "duration_ms",  filter_ms,                  "ms"),
                    ("analysis",     "duration_ms",  analysis_ms,                "ms"),
                    ("analysis",     "total_nodes",  total_nodes as u64,         "count"),
                    ("analysis",     "total_edges",  total_edges as u64,         "count"),
                    ("analysis",     "total_files",  changed_files.len() as u64, "count"),
                    ("rfdb_commit",  "total_ms",     rfdb_commit_total_ms as u64, "ms"),
                    ("rfdb_commit",  "p50_ms",       p50_ms,                     "ms"),
                    ("rfdb_commit",  "p95_ms",       p95_ms,                     "ms"),
                    ("rfdb_commit",  "p99_ms",       p99_ms,                     "ms"),
                    ("rfdb_commit",  "batches",      batch_count,                "count"),
                    ("resolve",      "duration_ms",  resolve_ms,                 "ms"),
                    ("diagnostics",  "duration_ms",  diagnostics_ms,             "ms"),
                    ("depends_on",   "duration_ms",  depends_on_ms,              "ms"),
                    ("compact",      "duration_ms",  compact_ms as u64,          "ms"),
                ];

                let (mut phase_nodes, phase_edges) =
                    analyzer::phase_metrics_to_wire(&phase_metrics, &authority);

                for node in &mut phase_nodes {
                    gc::stamp_node_metadata(&mut node.metadata, generation, "orchestrator-metrics");
                }

                if !phase_nodes.is_empty() {
                    // Synthetic files for tombstoning on re-analysis
                    let phase_files: Vec<String> = phase_nodes
                        .iter()
                        .filter_map(|n| n.file.clone())
                        .collect::<HashSet<_>>()
                        .into_iter()
                        .collect();
                    rfdb.commit_batch(&phase_files, &phase_nodes, &phase_edges, true)
                        .await
                        .context("Failed to commit phase metrics")?;
                    tracing::info!(
                        nodes = phase_nodes.len(),
                        "Phase metrics committed"
                    );
                }
            }

            // Phase timing summary
            let total_ms = pipeline_start.elapsed().as_millis() as u64;
            profile!("phase_summary",
                "discovery_ms" => discovery_ms,
                "filter_ms" => filter_ms,
                "analysis_ms" => analysis_ms,
                "rfdb_commit_ms" => rfdb_commit_total_ms,
                "resolve_ms" => resolve_ms,
                "diagnostics_ms" => diagnostics_ms,
                "depends_on_ms" => depends_on_ms,
                "compact_ms" => compact_ms,
                "total_ms" => total_ms
            );

            // 11. Summary
            println!(
                "Analyzed {} files ({} JS, {} Haskell, {} Rust, {} Java, {} Kotlin, {} Python, {} Go, {} C/C++, {} BEAM, {} skipped): {} nodes, {} edges, {} errors",
                changed_files.len(),
                js_file_count,
                hs_files.len(),
                rs_files.len(),
                java_files.len(),
                kotlin_files.len(),
                py_files.len(),
                go_files.len(),
                cpp_files.len(),
                beam_files.len(),
                unchanged_files.len(),
                total_nodes,
                total_edges,
                total_errors
            );
            profile!("analysis_complete_final",
                "files" => changed_files.len(), "nodes" => total_nodes,
                "edges" => total_edges, "errors" => total_errors);

            Ok(())
        }

        Commands::Resolve {
            config: config_path,
            socket,
            jobs,
        } => {
            if let Some(msg) = resolve_jobs_notice("--jobs", jobs) {
                tracing::warn!("{msg}");
            }
            let cfg = config::load(&config_path)?.with_defaults();

            // Resolve RFDB socket path: CLI flag > config > default
            let socket_path = socket
                .or(cfg.rfdb_socket.clone())
                .unwrap_or_else(|| PathBuf::from("/tmp/rfdb.sock"));

            let effects_db_dir = cfg.root.join("effects-db");
            let effects_db_path: Option<String> = if effects_db_dir.exists() {
                Some(effects_db_dir.to_string_lossy().to_string())
            } else {
                None
            };

            // Discover workspace packages from services config
            let ws_packages_raw = config::discover_workspace_packages(&cfg.root, &cfg.services);
            let mut ws_packages: Vec<plugin::WorkspacePackageWire> = ws_packages_raw
                .iter()
                .map(|p| plugin::WorkspacePackageWire {
                    name: p.name.clone(),
                    entry_point: p.entry_point.clone(),
                    package_dir: p.package_dir.clone(),
                })
                .collect();

            // Expand aliases into virtual workspace packages
            for (alias_prefix, target_dir) in &cfg.aliases {
                let index_candidates = ["index.ts", "index.tsx", "index.js"];
                let entry = index_candidates
                    .iter()
                    .map(|f| format!("{}/{}", target_dir, f))
                    .find(|p| cfg.root.join(p).exists())
                    .unwrap_or_else(|| format!("{}/index.ts", target_dir));

                ws_packages.push(plugin::WorkspacePackageWire {
                    name: alias_prefix.clone(),
                    entry_point: entry,
                    package_dir: target_dir.clone(),
                });
            }

            tracing::info!(
                config = %config_path.display(),
                socket = %socket_path.display(),
                "Starting resolve-only pass"
            );

            let pipeline_start = std::time::Instant::now();

            // Connect to RFDB
            let mut rfdb = rfdb::RfdbClient::connect(&socket_path)
                .await
                .with_context(|| format!("Failed to connect to RFDB at {}", socket_path.display()))?;

            // Wave 6: resolve-only passes need the derive pack phase too —
            // the packs are the only producer of the resolved slices.
            require_derive_capability(&rfdb, &socket_path)?;

            let db_name = "default";
            let open_resp = rfdb.open_database(db_name, "rw").await?;
            if open_resp.node_count == 0 {
                anyhow::bail!(
                    "Database '{}' has 0 nodes — run `grafema analyze` first before resolve",
                    db_name
                );
            }
            tracing::info!(
                db = db_name,
                nodes = open_resp.node_count,
                edges = open_resp.edge_count,
                "Connected to RFDB (resolve-only)"
            );

            let authority = resolve_authority(&cfg);
            let generation = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();

            // Detect which languages are present in the graph
            let detected_langs = detect_languages_in_db(&mut rfdb).await;
            tracing::info!(?detected_langs, "Languages detected in graph");

            // Build file → MODULE semantic ID map
            let file_to_module = build_file_to_module_map(&mut rfdb).await;

            let resolve_timer = std::time::Instant::now();
            let mut all_imports_from_edges: Vec<(String, String)> = Vec::new();

            // --- JS resolution (per-file streaming) ---
            if detected_langs.contains(&config::Language::JavaScript) && !skip_resolver("js") {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: JS/TS (per-file streaming, 1 worker)...");

                let resolve_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.js_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    max_message_size: 200 * 1024 * 1024,
                    request_timeout: std::time::Duration::from_secs(300),
                    effects_db_path: effects_db_path.clone(),
                    // No pinned skip set: the daemon child inherits any user-set
                    // GRAFEMA_SKIP_RESOLVE_STEPS from the parent env, which gates
                    // the remaining native step (runtime-globals).
                    skip_resolve_steps: None,
                };

                match process_pool::ProcessPool::new(resolve_pool_config, 1) {
                    Ok(resolve_pool) => {
                        let handles = resolve_pool.acquire_all().await?;

                        let output = plugin::resolve_per_file(
                            &mut rfdb,
                            config::Language::JavaScript,
                            &handles[0],
                            &ws_packages,
                            "js-resolution",
                            generation,
                            None,
                        ).await?;

                        // Extract IMPORTS_FROM edges for DEPENDS_ON derivation
                        for edge in &output.edges {
                            if edge.edge_type == "IMPORTS_FROM" {
                                all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                            }
                        }

                        // resolve_per_file commits its own output incrementally
                        // (per-checkpoint), so no end-of-phase commit here.
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: JS complete ({} edges, {:.1}s)",
                            output.edges.len(), lang_ms as f64 / 1000.0);
                        tracing::info!(duration_ms = lang_ms, "JS resolve complete");

                        drop(handles);
                        resolve_pool.shutdown().await;
                    }
                    Err(e) => {
                        tracing::warn!("Failed to create JS resolve pool: {e}");
                    }
                }
            }

            // --- Haskell resolution ---
            if detected_langs.contains(&config::Language::Haskell) && !skip_resolver("haskell") {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Haskell...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.haskell_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Haskell],
                            &[("haskell-imports", &[]), ("haskell-local-refs", &[]), ("haskell-local-calls", &[]), ("haskell-cross-module-calls", &[]), ("haskell-globals", &[])],
                            &pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let commit_name = match cmd.as_str() {
                                "haskell-imports" => "haskell-import-resolution",
                                "haskell-local-calls" => "haskell-local-calls",
                                "haskell-cross-module-calls" => "haskell-cross-module-calls",
                                "haskell-globals" => "haskell-runtime-globals",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Haskell complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Haskell resolve pool: {e}"),
                }
            }

            // --- Rust resolution ---
            if detected_langs.contains(&config::Language::Rust) && !skip_resolver("rust") {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Rust...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.rust_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        // Wave 6: only the remaining native rust steps — the
                        // rust_imports / rust_calls / rust_trait_resolve packs own
                        // the deleted steps' slices.
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Rust],
                            &[("rust-cross-methods", &[]), ("rust-globals", &[])],
                            &pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let commit_name = match cmd.as_str() {
                                "rust-cross-methods" => "rust-cross-method-calls",
                                "rust-globals" => "rust-runtime-globals",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Rust complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Rust resolve pool: {e}"),
                }
            }

            // --- Java resolution ---
            if detected_langs.contains(&config::Language::Java) && !skip_resolver("java") {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Java...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.java_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Java], &[("java-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "java-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Java complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Java resolve pool: {e}"),
                }
            }

            // --- Kotlin resolution ---
            if detected_langs.contains(&config::Language::Kotlin) && !skip_resolver("kotlin") {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Kotlin...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.kotlin_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Kotlin], &[("kotlin-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "kotlin-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Kotlin complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Kotlin resolve pool: {e}"),
                }
            }

            // --- Python resolution ---
            if detected_langs.contains(&config::Language::Python) && !skip_resolver("python") {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Python...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.python_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Python], &[("python-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "python-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Python complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Python resolve pool: {e}"),
                }
            }

            // --- Go resolution ---
            if detected_langs.contains(&config::Language::Go) && !skip_resolver("go") {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Go...");
                let go_module_path = config::discover_go_module_path(&cfg.root);
                let go_ws_packages: Vec<plugin::WorkspacePackageWire> = go_module_path
                    .map(|mp| vec![plugin::WorkspacePackageWire {
                        name: mp.clone(),
                        entry_point: String::new(),
                        package_dir: cfg.root.display().to_string(),
                    }])
                    .unwrap_or_default();

                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.go_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Go], &[("go-all", &go_ws_packages)], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "go-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Go complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Go resolve pool: {e}"),
                }
            }

            // --- Swift resolution ---
            if detected_langs.contains(&config::Language::Swift) && !skip_resolver("swift") {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Swift...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.swift_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Swift], &[("swift-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "swift-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Swift complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Swift resolve pool: {e}"),
                }
            }

            // --- Apple cross-language resolution (Swift + Obj-C) ---
            if detected_langs.contains(&config::Language::Swift)
                && detected_langs.contains(&config::Language::ObjectiveC)
                && !skip_resolver("swift")
                && !skip_resolver("objc")
            {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: Apple cross-language...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.apple_cross_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Swift, config::Language::ObjectiveC],
                            &[("apple-cross-all", &[])],
                            &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            commit_resolve_output(&mut output, "apple-cross-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: Apple cross-language complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create Apple cross-resolve pool: {e}"),
                }
            }

            // --- JVM cross-language resolution (Java + Kotlin) ---
            if detected_langs.contains(&config::Language::Java)
                && detected_langs.contains(&config::Language::Kotlin)
                && !skip_resolver("java")
                && !skip_resolver("kotlin")
            {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: JVM cross-language...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.jvm_cross_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Java, config::Language::Kotlin],
                            &[("jvm-cross-all", &[])],
                            &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "jvm-cross-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: JVM cross-language complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create JVM cross-resolve pool: {e}"),
                }
            }

            // --- C/C++ resolution ---
            if detected_langs.contains(&config::Language::Cpp) && !skip_resolver("cpp") {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: C/C++...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.cpp_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb, &[config::Language::Cpp], &[("cpp-all", &[])], &pool,
                        ).await?;
                        for (_cmd, mut output) in results {
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, "cpp-resolution", generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: C/C++ complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create C/C++ resolve pool: {e}"),
                }
            }

            // --- BEAM resolution ---
            if detected_langs.contains(&config::Language::Beam) && !skip_resolver("beam") {
                let lang_start = std::time::Instant::now();
                eprintln!("  Resolve: BEAM...");
                let pool_cfg = process_pool::PoolConfig {
                    command: cfg.analyzers.beam_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                match process_pool::ProcessPool::new(pool_cfg, 1) {
                    Ok(pool) => {
                        let results = plugin::stream_and_resolve_single_worker(
                            &mut rfdb,
                            &[config::Language::Beam],
                            &[
                                ("beam-imports", &[]),
                                ("beam-local-refs", &[]),
                                ("beam-runtime-globals", &[]),
                                ("beam-behaviours", &[]),
                                ("beam-protocols", &[]),
                                // REG-1098 W6: resolve wrapper calls into virtual effect edges
                                ("beam-wrapper-resolve", &[]),
                                // REG-1098 W6.5: precise CALL→MESSAGE_TYPE edges via shape unification
                                ("beam-message-types", &[]),
                                // GAP-C: PUBLISHES edges from broadcasts to subscriber handlers
                                ("beam-pubsub-delivery", &[]),
                                // REG-1098 W9: emit ISSUE nodes for MessageFlow findings
                                ("beam-message-findings", &[]),
                            ],
                            &pool,
                        ).await?;
                        for (cmd, mut output) in results {
                            let commit_name = match cmd.as_str() {
                                "beam-imports" => "beam-import-resolution",
                                _ => &cmd,
                            };
                            for edge in &output.edges {
                                if edge.edge_type == "IMPORTS_FROM" {
                                    all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
                                }
                            }
                            commit_resolve_output(&mut output, commit_name, generation, &mut rfdb).await?;
                        }
                        pool.shutdown().await;
                        let lang_ms = lang_start.elapsed().as_millis();
                        eprintln!("  Resolve: BEAM complete ({:.1}s)", lang_ms as f64 / 1000.0);
                    }
                    Err(e) => tracing::warn!("Failed to create BEAM resolve pool: {e}"),
                }
            }

            let resolve_ms = resolve_timer.elapsed().as_millis() as u64;

            // User-defined plugins
            let user_plugins: Vec<_> = cfg
                .plugins
                .iter()
                .filter(|p| {
                    p.name != "js-import-resolution" && p.name != "runtime-globals"
                })
                .cloned()
                .collect();
            if !user_plugins.is_empty() {
                tracing::info!(count = user_plugins.len(), "Running user-defined plugins");

                let resolve_pool_config = process_pool::PoolConfig {
                    command: cfg.analyzers.js_resolve_path(),
                    args: vec!["--daemon".to_string()],
                    effects_db_path: effects_db_path.clone(),
                    ..process_pool::PoolConfig::default()
                };
                let resolve_pool = match process_pool::ProcessPool::new(resolve_pool_config, 1) {
                    Ok(pool) => Some(pool),
                    Err(e) => {
                        tracing::warn!("Failed to create resolve pool for user plugins: {e}");
                        None
                    }
                };

                // A plugin failure aborts the analyze run (loud-failure policy,
                // same as derive-pack failures) — but shut the pool down first.
                let dag_result = plugin::run_plugins_dag(
                    &user_plugins,
                    &mut rfdb,
                    &socket_path,
                    db_name,
                    generation,
                    resolve_pool.as_ref(),
                )
                .await;

                if let Some(pool) = resolve_pool {
                    pool.shutdown().await;
                }

                dag_result?;
            }

            // Rule-pack phase (Wave 6): the packs are the only producer of the
            // resolved CALLS/READS_FROM/IMPORTS_FROM/DEPENDS_ON slices (the
            // legacy steps were deleted), so a resolve-only pass must run them
            // too — and BEFORE the unresolved diagnostics below, whose negation
            // queries would otherwise flag every pack-resolved node.
            let depends_on_start = std::time::Instant::now();
            run_stdlib_rule_packs(&mut rfdb, None, all_imports_from_edges.len()).await?;
            let depends_on_ms = depends_on_start.elapsed().as_millis() as u64;

            // Unresolved diagnostics
            let diagnostics_start = std::time::Instant::now();
            {
                // RFD-65: rebuild the index before the unresolved-diagnostics negation
                // queries (resolver commits CALLS/IMPORTS_FROM with defer_index=true);
                // a stale index here makes the ISSUE count nondeterministic.
                rfdb.rebuild_indexes().await.context("Failed to rebuild indexes before unresolved diagnostics")?;

                let unresolved_calls_query = r#"violation(X, Name, File) :- node(X, "CALL"), attr(X, "name", Name), attr(X, "file", File), \+ edge(X, _, "CALLS")."#;
                let unresolved_imports_query = r#"violation(X, Name, File) :- node(X, "IMPORT_BINDING"), attr(X, "name", Name), attr(X, "file", File), \+ edge(X, _, "IMPORTS_FROM")."#;

                let mut unresolved: Vec<(String, String, String)> = Vec::new();

                for query in [unresolved_calls_query, unresolved_imports_query] {
                    match rfdb.datalog_query(query).await {
                        Ok(results) => {
                            for r in results {
                                let x = r.bindings.get("X").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let name = r.bindings.get("Name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let file = r.bindings.get("File").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                if !x.is_empty() {
                                    unresolved.push((x, name, file));
                                }
                            }
                        }
                        Err(e) => tracing::warn!("Unresolved diagnostics query failed: {e}"),
                    }
                }

                if !unresolved.is_empty() {
                    let file_set: HashSet<String> = file_to_module.keys().cloned().collect();
                    let (mut diag_nodes, mut diag_edges) = analyzer::unresolved_diagnostics_to_wire(
                        &unresolved, &file_set, &authority,
                    );

                    // Stamp generation so ISSUE nodes are GC'd on next analyze
                    for node in &mut diag_nodes {
                        gc::stamp_node_metadata(&mut node.metadata, generation, "unresolved-diagnostics");
                    }
                    for edge in &mut diag_edges {
                        gc::stamp_edge_metadata(&mut edge.metadata, generation, "unresolved-diagnostics");
                    }

                    if !diag_nodes.is_empty() {
                        let diag_files = vec!["__grafema_virtual/unresolved-diagnostics".to_string()];
                        rfdb.commit_batch(&diag_files, &diag_nodes, &diag_edges, true)
                            .await
                            .context("Failed to commit unresolved diagnostics")?;

                        let external = diag_nodes.iter().filter(|n| {
                            n.metadata.as_ref().is_some_and(|m| m.contains("unresolved_external"))
                        }).count();
                        let internal = diag_nodes.iter().filter(|n| {
                            n.metadata.as_ref().is_some_and(|m| m.contains("unresolved_internal"))
                        }).count();

                        tracing::info!(
                            total = unresolved.len(),
                            external = external,
                            internal = internal,
                            "Unresolved diagnostics generated"
                        );
                    }
                }
            }
            let diagnostics_ms = diagnostics_start.elapsed().as_millis() as u64;

            // (DEPENDS_ON is derived by the @stdlib/depends pack in the rule-pack
            // phase above — the inline legacy sid-parse derivation was deleted in
            // Wave 6 together with the analyze-side P3 fallback.)

            // Skip compact during resolve to avoid OOM on memory-constrained VMs.
            // Resolution adds edges via virtual files — no segment dedup strictly
            // needed. Compact runs at the end of the next `grafema analyze`.
            // Instead, just flush write buffers so data is persisted to disk.
            let compact_start = std::time::Instant::now();
            rfdb.rebuild_indexes().await.context("Failed to flush after resolve")?;
            let compact_ms = compact_start.elapsed().as_millis();

            // Phase metrics (resolve-only subset)
            {
                let phase_metrics: Vec<(&str, &str, u64, &str)> = vec![
                    ("resolve",      "duration_ms",  resolve_ms,                 "ms"),
                    ("diagnostics",  "duration_ms",  diagnostics_ms,             "ms"),
                    ("depends_on",   "duration_ms",  depends_on_ms,              "ms"),
                    ("flush",        "duration_ms",  compact_ms as u64,          "ms"),
                ];

                let (mut phase_nodes, phase_edges) =
                    analyzer::phase_metrics_to_wire(&phase_metrics, &authority);

                for node in &mut phase_nodes {
                    gc::stamp_node_metadata(&mut node.metadata, generation, "orchestrator-metrics");
                }

                if !phase_nodes.is_empty() {
                    let phase_files: Vec<String> = phase_nodes
                        .iter()
                        .filter_map(|n| n.file.clone())
                        .collect::<HashSet<_>>()
                        .into_iter()
                        .collect();
                    rfdb.commit_batch(&phase_files, &phase_nodes, &phase_edges, true)
                        .await
                        .context("Failed to commit phase metrics")?;
                }
            }

            let total_ms = pipeline_start.elapsed().as_millis() as u64;
            println!(
                "Resolve complete: resolve {resolve_ms}ms, diagnostics {diagnostics_ms}ms, depends_on {depends_on_ms}ms, flush {compact_ms}ms, total {total_ms}ms"
            );

            Ok(())
        }

        Commands::CommitDirs {
            config: config_path,
            socket,
        } => {
            let cfg = config::load(&config_path)?.with_defaults();

            let socket_path = socket
                .or(cfg.rfdb_socket.clone())
                .unwrap_or_else(|| PathBuf::from("/tmp/rfdb.sock"));

            let mut rfdb = rfdb::RfdbClient::connect(&socket_path).await?;

            // Discover files using the same discovery code as analyze.
            let files = discovery::discover(&cfg)?;
            tracing::info!(file_count = files.len(), "Discovered files for commit-dirs");

            let root_str = cfg.root.to_string_lossy().to_string();
            let root_prefix = if root_str.ends_with('/') {
                root_str.clone()
            } else {
                format!("{root_str}/")
            };
            let relative_files: Vec<String> = files
                .iter()
                .map(|p| {
                    let abs = p.display().to_string();
                    abs.strip_prefix(&root_prefix).unwrap_or(&abs).to_string()
                })
                .collect();

            let (dir_nodes, dir_edges, mut cleanup_files) =
                directory_nodes::build(&relative_files);

            if dir_nodes.is_empty() {
                println!("No directory/file nodes to commit.");
                return Ok(());
            }

            // Also clean up legacy virtual path from earlier releases that
            // stored all DIRECTORY/FILE nodes under a single synthetic file.
            cleanup_files.push("__grafema_virtual/directory-structure".to_string());

            let start = std::time::Instant::now();
            rfdb.commit_batch(&cleanup_files, &dir_nodes, &dir_edges, false)
                .await
                .context("Failed to commit directory structure")?;

            println!(
                "Committed {} directory/file nodes, {} CONTAINS edges in {}ms",
                dir_nodes.len(),
                dir_edges.len(),
                start.elapsed().as_millis()
            );

            Ok(())
        }

        Commands::Layout {
            synthetic,
            socket,
            config,
            pack_only,
            seed,
            edge_density,
            dump_json,
            commit,
            verbose,
            max_symbols_per_file,
        } => {
            let t_total = std::time::Instant::now();
            // Hold the RFDB client past the load step when --commit is set,
            // so the commit phase can reuse the same connection. Synthetic
            // mode never needs an RFDB client.
            let mut rfdb_for_commit: Option<grafema_orchestrator::rfdb::RfdbClient> = None;
            // Pick input source. Clap's `conflicts_with` already rejects
            // (Some, Some) at parse time, so the unreachable arm is just a
            // belt-and-braces guard.
            let input = match (synthetic, socket.as_ref(), config.as_ref()) {
                (Some(n), None, _) => {
                    eprintln!(
                        "Generating synthetic tree: {} leaves, seed {}, edge density {}",
                        n, seed, edge_density
                    );
                    grafema_orchestrator::layout::generate(n, seed, edge_density)
                }
                (None, Some(sock), Some(_cfg)) => {
                    // `--config` is reserved for future use (auto-detect socket
                    // path, project-aware reporting). For now we just require
                    // the user to pass `--socket` explicitly.
                    eprintln!("Loading layout input from RFDB at {}", sock.display());
                    let mut rfdb = grafema_orchestrator::rfdb::RfdbClient::connect(sock)
                        .await
                        .with_context(|| {
                            format!("Failed to connect to RFDB at {}", sock.display())
                        })?;
                    let loaded = grafema_orchestrator::layout::load_from_rfdb(&mut rfdb).await?;
                    // Stash the live connection for the commit phase; if --commit
                    // isn't set this just gets dropped at the end of the arm.
                    rfdb_for_commit = Some(rfdb);
                    loaded
                }
                (None, None, _) => {
                    anyhow::bail!(
                        "layout: must provide either --synthetic N or --socket <path> --config <path>"
                    );
                }
                (Some(_), Some(_), _) => {
                    unreachable!("clap `conflicts_with` should prevent --synthetic + --socket")
                }
                (None, Some(_), None) => {
                    unreachable!("clap `requires = config` should prevent --socket without --config")
                }
            };
            eprintln!(
                "Tree: {} folders (max depth {}), {} edges, {} nodes",
                input.tree.len(),
                input.tree.max_depth(),
                input.edges.len(),
                input.n_nodes
            );

            let opts = grafema_orchestrator::layout::RunOpts { pack_only };
            let result = grafema_orchestrator::layout::run_layout(&input, &opts);

            let report = grafema_orchestrator::layout::validate(&result.coords, &input.tree);
            eprintln!();
            eprint!("{}", report);

            eprintln!();
            eprintln!("Stats:");
            eprintln!(
                "  pack:   {} ms, Σlinks = {:.1}",
                result.stats.pack_ms, result.stats.sigma_link_pre
            );
            if !pack_only {
                let pct = |after: f64, before: f64| -> f64 {
                    if before == 0.0 {
                        0.0
                    } else {
                        (after - before) / before * 100.0
                    }
                };
                eprintln!(
                    "  iswap:  {} ms, {} swaps, Σlinks = {:.1} ({:+.1}%)",
                    result.stats.iswap_ms,
                    result.stats.iswap_swaps,
                    result.stats.sigma_link_after_iswap,
                    pct(result.stats.sigma_link_after_iswap, result.stats.sigma_link_pre)
                );
                eprintln!(
                    "  xswap:  {} ms, {} swaps, Σlinks = {:.1} ({:+.1}%)",
                    result.stats.xswap_ms,
                    result.stats.xswap_swaps,
                    result.stats.sigma_link_after_xswap,
                    pct(result.stats.sigma_link_after_xswap, result.stats.sigma_link_pre)
                );
            }
            eprintln!("  total:  {} ms", t_total.elapsed().as_millis());

            if verbose {
                for t in &report.torn {
                    eprintln!("  torn: {} ({}/{} connected)", t.path, t.connected, t.size);
                }
            }

            if let Some(path) = dump_json {
                let pairs: Vec<(grafema_orchestrator::layout::NodeIdx, &str)> =
                    input.iter_leaf_paths().collect();
                let f = std::fs::File::create(&path)
                    .with_context(|| format!("Failed to create {}", path.display()))?;
                grafema_orchestrator::layout::dump_to_writer(
                    &pairs,
                    &result.coords,
                    &result.stats,
                    f,
                )
                .with_context(|| format!("Failed to write JSON to {}", path.display()))?;
                eprintln!("JSON dumped to {}", path.display());
            }

            // ── Commit phase (optional) ────────────────────────────────────
            // --commit only makes sense with --socket. Synthetic leaf paths
            // don't correspond to any MODULE in any RFDB, so committing
            // would produce edges that point at nothing. Print a warning
            // and skip rather than error — the user may have left --commit
            // on while iterating on synthetic dry-runs.
            if commit {
                if let Some(mut rfdb) = rfdb_for_commit {
                    eprintln!(
                        "Committing per-symbol layout to RFDB (hard-cap {max_symbols_per_file})..."
                    );
                    let payload = grafema_orchestrator::layout::commit_layout(
                        &mut rfdb,
                        &input,
                        &result,
                        max_symbols_per_file,
                    )
                    .await?;
                    eprintln!(
                        "Committed {} LAYOUT_POSITION edges, {} REGION nodes, {} CONTAINS edges",
                        payload.layout_position_count,
                        payload.region_node_count,
                        payload.contains_count
                    );
                    if !payload.overflow_by_file.is_empty() {
                        let worst = payload
                            .overflow_by_file
                            .iter()
                            .max_by_key(|(_, (skipped, cap))| *skipped + *cap);
                        if let Some((file, (skipped, cap))) = worst {
                            eprintln!(
                                "Overflow: {} files exceeded hard-cap (max {} symbols in {})",
                                payload.overflow_by_file.len(),
                                skipped + cap,
                                file
                            );
                        }
                    }
                } else {
                    eprintln!(
                        "warning: --commit requires --socket; ignoring (synthetic mode)"
                    );
                }
            }

            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_git_remote_ssh() {
        assert_eq!(
            parse_git_remote_authority("git@github.com:owner/repo.git"),
            Some("github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn test_parse_git_remote_https() {
        assert_eq!(
            parse_git_remote_authority("https://github.com/owner/repo.git"),
            Some("github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn test_parse_git_remote_https_no_git_suffix() {
        assert_eq!(
            parse_git_remote_authority("https://github.com/owner/repo"),
            Some("github.com/owner/repo".to_string())
        );
    }

    #[test]
    fn test_parse_git_remote_invalid() {
        assert_eq!(parse_git_remote_authority("not-a-url"), None);
    }

    #[test]
    fn resolve_jobs_notice_silent_for_default_and_single_worker() {
        // Unset or exactly 1 worker matches reality → no notice (no false alarm).
        assert!(resolve_jobs_notice("--resolve-jobs", None).is_none());
        assert!(resolve_jobs_notice("--resolve-jobs", Some(1)).is_none());
    }

    #[test]
    fn resolve_jobs_notice_surfaces_unhonored_request() {
        // n > 1 is silently a no-op today → must be surfaced, naming the flag,
        // the requested value, and that it runs single-worker.
        let msg = resolve_jobs_notice("--resolve-jobs", Some(8)).expect("n>1 surfaced");
        assert!(msg.contains("--resolve-jobs"), "names the flag: {msg}");
        assert!(msg.contains('8'), "echoes the requested value: {msg}");
        assert!(msg.contains("single-worker"), "states actual behavior: {msg}");

        // 0 is also a non-unit request → surfaced, not silently swallowed.
        assert!(resolve_jobs_notice("--jobs", Some(0)).is_some());
        // The flag name is threaded through (resolve subcommand uses --jobs).
        assert!(resolve_jobs_notice("--jobs", Some(4)).unwrap().contains("--jobs"));
    }

    /// Wave-0 skip-flags (resolve→derive synthesis): unset/empty env value must
    /// change nothing — no language is skipped.
    #[test]
    fn skip_resolvers_empty_means_no_skip() {
        assert!(parse_skip_resolvers("").is_empty());
        assert!(parse_skip_resolvers("  ").is_empty());
        assert!(parse_skip_resolvers(",,").is_empty());
    }

    /// Comma-separated keys parse case-insensitively, whitespace-tolerant, and
    /// every documented language key is accepted.
    #[test]
    fn skip_resolvers_parses_listed_keys() {
        let set = parse_skip_resolvers(" js, RUST ,haskell");
        assert!(set.contains("js") && set.contains("rust") && set.contains("haskell"));
        assert_eq!(set.len(), 3);

        // All 11 documented keys round-trip.
        let all = SKIP_RESOLVER_KEYS.join(",");
        let set = parse_skip_resolvers(&all);
        for key in SKIP_RESOLVER_KEYS {
            assert!(set.contains(key), "key '{key}' must be accepted");
        }
        assert_eq!(set.len(), SKIP_RESOLVER_KEYS.len());
    }

    /// A typo'd key must not poison the set: it is dropped (and warned about),
    /// while valid keys in the same list still take effect.
    #[test]
    fn skip_resolvers_drops_unknown_keys() {
        let set = parse_skip_resolvers("js,javascrpt,rust");
        assert!(set.contains("js") && set.contains("rust"));
        assert!(!set.contains("javascrpt"));
        assert_eq!(set.len(), 2);
    }

    /// Wave 6: GRAFEMA_SKIP_RESOLVE_STEPS gates exactly what it names among the
    /// REMAINING native steps (whitespace-tolerant, empty segments dropped); with
    /// no env value nothing is skipped — there is no retired-set merging anymore
    /// (the derive-replaced steps were deleted, not gated).
    #[test]
    fn resolve_step_skips_gates_only_what_env_names() {
        assert!(resolve_step_skips(None).is_empty(), "no env → nothing skipped");

        let skips = resolve_step_skips(Some("rust-globals, runtime-globals"));
        assert!(skips.contains("rust-globals"), "env-listed step is gated");
        assert!(skips.contains("runtime-globals"), "whitespace-tolerant split");
        assert_eq!(skips.len(), 2, "exactly what the env names, nothing merged in");

        let noisy = resolve_step_skips(Some(",, rust-cross-methods ,"));
        assert_eq!(
            noisy,
            ["rust-cross-methods".to_string()].into_iter().collect::<HashSet<_>>(),
            "empty segments are filtered"
        );

        // The rendered child-env value is deterministic (sorted, comma-joined).
        let rendered =
            skip_steps_env_value(&resolve_step_skips(Some("runtime-globals,rust-globals")));
        assert_eq!(rendered, "runtime-globals,rust-globals");
    }

    /// Wave 6 failure policy: the pack-failure summary names every failed pack,
    /// the slice it owns (so the operator knows what is MISSING from the graph),
    /// and the underlying error — and every pack in the production list has a
    /// registered slice description (a new pack without one fails here).
    #[test]
    fn pack_failure_summary_names_packs_and_owned_slices() {
        let failures = vec![
            ("@stdlib/depends".to_string(), "boom".to_string()),
            ("@stdlib/js_local_refs".to_string(), "parse error".to_string()),
        ];
        let summary = pack_failure_summary(&failures);
        assert!(summary.contains("@stdlib/depends"), "failed pack named");
        assert!(summary.contains("MODULE→MODULE DEPENDS_ON"), "owned slice named");
        assert!(summary.contains("boom"), "underlying error included");
        assert!(summary.contains("@stdlib/js_local_refs"));
        assert!(summary.contains("READS_FROM"), "js_local_refs slice named");
        assert!(summary.contains("no fallback") || summary.contains("ONLY producer"),
            "summary states there is no fallback");

        for pack in STDLIB_RULE_PACKS {
            assert_ne!(
                pack_owned_slice(pack),
                "(unregistered pack)",
                "{pack} must have a slice description in pack_owned_slice"
            );
        }
    }

    /// Spawn a fake RFDB server on a temp Unix socket that answers the Hello
    /// handshake with the given feature list and then serves `materializeDatalog`
    /// requests: every pack succeeds (count=1) except those named in
    /// `failing_packs`, which get a coded error response. Returns the socket path.
    fn spawn_fake_rfdb_server(
        features: Vec<String>,
        failing_packs: Vec<String>,
    ) -> std::path::PathBuf {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // Unique per call: pid + a process-wide counter. A timestamp alone is
        // NOT unique — concurrent tests can land in the same SystemTime tick,
        // collide on the socket name, and the second bind panics (flaky
        // EADDRINUSE in pack_failure_fails_the_run_with_a_loud_summary).
        static SOCK_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir();
        let sock = dir.join(format!(
            "grafema-fake-rfdb-{}-{}.sock",
            std::process::id(),
            SOCK_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&sock);
        let listener = std::os::unix::net::UnixListener::bind(&sock).expect("bind fake socket");
        listener.set_nonblocking(true).expect("nonblocking");
        let listener = tokio::net::UnixListener::from_std(listener).expect("tokio listener");

        tokio::spawn(async move {
            let (mut stream, _) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => return,
            };
            loop {
                let mut len_buf = [0u8; 4];
                if stream.read_exact(&mut len_buf).await.is_err() {
                    return;
                }
                let len = u32::from_be_bytes(len_buf) as usize;
                let mut buf = vec![0u8; len];
                if stream.read_exact(&mut buf).await.is_err() {
                    return;
                }
                let req: serde_json::Value = rmp_serde::from_slice(&buf).expect("decode request");
                let request_id = req["requestId"].as_str().unwrap_or("r?").to_string();
                let cmd = req["cmd"].as_str().unwrap_or("");
                let resp = match cmd {
                    "hello" => serde_json::json!({
                        "requestId": request_id,
                        "protocolVersion": 3u32,
                        "serverVersion": "fake-rfdb-test",
                        "features": features,
                    }),
                    "materializeDatalog" => {
                        let source = req["source"].as_str().unwrap_or("");
                        if failing_packs.iter().any(|p| p == source) {
                            serde_json::json!({
                                "requestId": request_id,
                                "error": format!("forced test failure for {source}"),
                                "code": "E-TEST-PACK",
                            })
                        } else {
                            serde_json::json!({ "requestId": request_id, "count": 1u32 })
                        }
                    }
                    other => serde_json::json!({
                        "requestId": request_id,
                        "error": format!("fake server does not implement {other}"),
                        "code": "E-TEST-UNIMPLEMENTED",
                    }),
                };
                let payload = rmp_serde::to_vec_named(&resp).expect("encode response");
                let len = (payload.len() as u32).to_be_bytes();
                if stream.write_all(&len).await.is_err() || stream.write_all(&payload).await.is_err() {
                    return;
                }
                let _ = stream.flush().await;
            }
        });
        sock
    }

    /// Wave 6 fail-fast: against a server whose Hello does NOT advertise
    /// `datalogDerive`, analyze must refuse with an actionable error
    /// (upgrade the binary / un-set RFDB_DERIVE_ENGINE=off) — there is no legacy
    /// fallback left to run. With the capability, the gate passes.
    #[tokio::test]
    async fn analyze_fails_fast_without_derive_capability() {
        // No capability → clear, actionable refusal.
        let sock = spawn_fake_rfdb_server(vec!["somethingElse".to_string()], vec![]);
        let client = rfdb::RfdbClient::connect(&sock).await.expect("connect fake server");
        assert!(!client.supports_derive_materialize());
        let err = require_derive_capability(&client, &sock)
            .expect_err("gate must refuse a server without the derive capability");
        let msg = format!("{err:#}");
        assert!(msg.contains("datalogDerive"), "names the missing capability: {msg}");
        assert!(msg.contains("Upgrade the rfdb-server binary"), "actionable: {msg}");
        assert!(msg.contains("RFDB_DERIVE_ENGINE=off"), "names the kill switch: {msg}");
        assert!(msg.contains("fake-rfdb-test"), "names the server version: {msg}");
        let _ = std::fs::remove_file(&sock);

        // With the capability → the gate passes.
        let sock2 = spawn_fake_rfdb_server(vec!["datalogDerive".to_string()], vec![]);
        let client2 = rfdb::RfdbClient::connect(&sock2).await.expect("connect fake server");
        assert!(client2.supports_derive_materialize());
        require_derive_capability(&client2, &sock2).expect("derive-capable server passes the gate");
        let _ = std::fs::remove_file(&sock2);
    }

    /// Wave 6 failure policy, end-to-end through the production pack loop: a pack
    /// forced to fail (fake server errors on it) makes `run_stdlib_rule_packs`
    /// return Err naming the pack and its owned slice — while the remaining packs
    /// still ran (the fake server saw materialize requests after the failing one;
    /// proven by a LATER pack also being forced to fail and appearing in the
    /// summary too). A fully-green run returns Ok.
    #[tokio::test]
    async fn pack_failure_fails_the_run_with_a_loud_summary() {
        let features = vec!["datalogDerive".to_string()];

        // Force an EARLY pack and a LATE pack to fail: both must appear in the
        // summary, proving the loop continued past the first failure.
        let sock = spawn_fake_rfdb_server(
            features.clone(),
            vec!["@stdlib/js_local_refs".to_string(), "@stdlib/axum_routes".to_string()],
        );
        let mut client = rfdb::RfdbClient::connect(&sock).await.expect("connect fake server");
        let err = run_stdlib_rule_packs(&mut client, None, 0)
            .await
            .expect_err("a failed pack must fail the phase");
        let msg = format!("{err:#}");
        assert!(msg.contains("@stdlib/js_local_refs"), "early failed pack named: {msg}");
        assert!(msg.contains("@stdlib/axum_routes"), "late failed pack named — loop continued: {msg}");
        assert!(msg.contains("axum ROUTES_TO"), "owned slice named: {msg}");
        assert!(msg.contains("forced test failure"), "server error surfaced: {msg}");
        let _ = std::fs::remove_file(&sock);

        // All packs green → Ok.
        let sock2 = spawn_fake_rfdb_server(features, vec![]);
        let mut client2 = rfdb::RfdbClient::connect(&sock2).await.expect("connect fake server");
        run_stdlib_rule_packs(&mut client2, None, 0)
            .await
            .expect("green pack phase passes");
        let _ = std::fs::remove_file(&sock2);
    }

    /// Wave 3c: production iterates THIS crate's `STDLIB_RULE_PACKS`, not the
    /// server-side registry — and with legacy import-resolution gated the order is
    /// load-bearing (producers before consumers/negators) while pack failures are
    /// log-and-continue, so a silent reorder (e.g. depends before
    /// js_import_bindings) under-derives DEPENDS_ON with zero signal. Pin the
    /// orchestrator list against rfdb's `STDLIB_PACKS` registry order, read at
    /// compile time from the server source (a moved/renamed registry file fails
    /// the build; a reorder on either side fails this test).
    #[test]
    fn stdlib_rule_packs_match_rfdb_registry_order() {
        let registry_src = include_str!("../../rfdb-server/src/derive/stdlib.rs");

        // Extract pack names, in declaration order, from the const body: entries
        // are lines of the form `("name", NAME_DL),`; `//` comment lines never
        // start with `("` and are skipped.
        let body = registry_src
            .split_once("pub const STDLIB_PACKS")
            .expect("rfdb stdlib.rs must declare `pub const STDLIB_PACKS`")
            .1;
        let body = body
            .split_once("];")
            .expect("STDLIB_PACKS must be terminated with `];`")
            .0;
        let registry_order: Vec<&str> = body
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("(\""))
            .map(|line| {
                line.trim_start_matches("(\"")
                    .split_once('"')
                    .expect("pack entry must close its name quote")
                    .0
            })
            .collect();
        assert!(
            registry_order.len() >= 10,
            "parsed only {} pack names — STDLIB_PACKS layout changed; fix this parser, \
             do not weaken the pin",
            registry_order.len()
        );

        let orchestrator_order: Vec<&str> = STDLIB_RULE_PACKS
            .iter()
            .map(|pack| {
                pack.strip_prefix("@stdlib/")
                    .expect("every orchestrator pack name is @stdlib/-prefixed")
            })
            .collect();

        assert_eq!(
            orchestrator_order, registry_order,
            "STDLIB_RULE_PACKS (orchestrator) must match rfdb's STDLIB_PACKS registry \
             order exactly — see the canonical-order doc comment at the const"
        );
    }
}
