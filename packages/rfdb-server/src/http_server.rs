//! HTTP + WebSocket server for graph visualization.
//!
//! Provides JSONL streaming of graph data and progressive SA layout
//! via WebSocket. Runs inside the RFDB server process with zero-copy
//! access to graph data through the DatabaseManager.
//!
//! # Endpoints
//!
//! - `GET /api/graph-stream` — NDJSON stream of nodes, edges, containers
//! - `WS  /api/layout-live`  — binary SA position snapshots
//! - `GET /api/stats`        — node/edge counts by type
//! - `GET /api/node/:id`     — single node details

use std::collections::HashMap;
#[cfg(feature = "ui")]
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use axum::{
    Router,
    extract::{Query, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    response::{IntoResponse, Response},
    routing::get,
};
use tower_http::cors::CorsLayer;
use serde::Deserialize;

use crate::container_hierarchy::{
    ContainerTree, NodeRef, EdgeRef, default_hierarchy,
    auto_hierarchy_from_nodes,
};
use crate::sa_layout::{HexCoord, SaEngine, LayoutNode, LayoutEdge, SaSnapshot};
use crate::database_manager::DatabaseManager;
use crate::graph::GraphStore;
use crate::layout_types;
use crate::storage::AttrQuery;

/// Persisted hex layout read from RFDB (DAI-22 Chunk-4).
///
/// Computed once per server lifetime (or after `reload()`) by scanning
/// LAYOUT_POSITION + REGION + CONTAINS edges previously written by
/// `grafema layout --commit`. No tectonic pipeline runs server-side; the
/// consumer only reads what the orchestrator persisted.
#[derive(Clone, Debug)]
pub struct CachedLayout {
    /// Per-symbol hex coord: RFDB node id → (q, r). Only symbols that the
    /// orchestrator placed (= NOT overflow-skipped) appear here.
    pub positions: HashMap<u128, HexCoord>,
    /// Every REGION node, in insertion order.
    pub regions: Vec<RegionInfo>,
    /// `region_id → [children]`. Children may be REGION ids (nested folder
    /// tree) or SYMBOL ids (leaf attachments). Only edges tagged
    /// `_source=layout-pack` contribute.
    pub containment: HashMap<u128, Vec<u128>>,
    /// `file_path → (skipped_count, hard_cap)` for every file whose REGION
    /// carried `overflow_skipped > 0` metadata. Empty when nothing overflowed.
    pub overflow_files: HashMap<String, (usize, usize)>,
    /// Provenance summary — feeds into the `layout_meta` header frame.
    pub source: LayoutSource,
}

/// A single REGION node in the persisted layout tree.
#[derive(Clone, Debug)]
pub struct RegionInfo {
    /// RFDB u128 node id (derived from the REGION's semantic id).
    pub id: u128,
    /// Depth in the folder tree (0 = root).
    pub depth: u32,
    /// Original folder/file path (not URL-encoded).
    pub path: String,
    /// `"folder"` or `"file"` — files are leaves that attach symbols.
    pub kind: String,
    /// Display name (last `/`-segment of `path`, or `"/"` for root).
    pub name: String,
}

/// Where the cached layout came from.
///
/// `Missing` means no LAYOUT_POSITION edges were found during warmup — the
/// server still streams every node but with `pos: null` and
/// `unplaced_reason: "missing_layout"` so the GUI can render an overlay.
#[derive(Clone, Debug)]
pub enum LayoutSource {
    Missing,
    Committed {
        committed_at: String,
        symbol_count: usize,
    },
}

/// Shared state for all HTTP handlers.
#[derive(Clone)]
pub struct HttpState {
    pub manager: Arc<DatabaseManager>,
    /// Cached persisted per-symbol layout (DAI-22 Chunk-4). Populated on
    /// warmup or first `/api/graph-stream` hit; reset by `reload()`.
    pub layout_cache: Arc<RwLock<Option<CachedLayout>>>,
    /// Cached file → list of node ids in that file. Built once with a
    /// single full scan of the graph, reused by edge-lifting in every
    /// subsequent request.
    pub file_to_nodes: Arc<RwLock<Option<HashMap<String, Vec<u128>>>>>,
}

/// Build a fresh `HttpState` with empty caches. Exposed so the binary can
/// clone the state into a warmup task before `start` takes ownership.
pub fn new_state(manager: Arc<DatabaseManager>) -> HttpState {
    HttpState {
        manager,
        layout_cache: Arc::new(RwLock::new(None)),
        file_to_nodes: Arc::new(RwLock::new(None)),
    }
}

/// Populate `layout_cache` and `file_to_nodes` synchronously. Safe to call
/// from a blocking task at server startup — subsequent `/api/graph-stream`
/// hits will see warm caches and skip the 60s cold build. Errors (e.g. the
/// default database not being available yet) are logged but non-fatal.
pub fn warmup(state: &HttpState) {
    let db = match state.manager.get_database("default") {
        Ok(db) => db,
        Err(e) => {
            eprintln!("[rfdb-server] warmup: cannot open default db: {}", e);
            return;
        }
    };
    let engine = db.engine.read().unwrap();
    let _ = get_or_build_file_to_nodes(&state.file_to_nodes, &**engine);
    let _ = get_or_build_layout(&state.layout_cache, &state.file_to_nodes, &**engine);
}

/// UI serving strategy for the `/ui/*` routes.
///
/// Exposed so callers (bin + integration tests) can pick a strategy
/// explicitly instead of relying on process-global env vars. `start` and
/// `build_router` still read env vars for backward compatibility.
#[cfg(feature = "ui")]
#[derive(Clone, Debug)]
pub enum UiConfig {
    /// UI disabled entirely — no routes under `/ui` (anything there returns 404).
    Disabled,
    /// Serve the `ui-dist` embedded into the binary at compile time.
    Embedded,
    /// Serve from a filesystem directory (dev mode override).
    StaticDir(PathBuf),
}

/// Resolve UI config from environment variables.
///
/// Precedence: `RFDB_NO_UI=1` → Disabled; else `RFDB_STATIC_DIR=<path>` →
/// StaticDir; else Embedded.
#[cfg(feature = "ui")]
pub fn ui_config_from_env() -> UiConfig {
    if std::env::var("RFDB_NO_UI").ok().as_deref() == Some("1") {
        return UiConfig::Disabled;
    }
    if let Some(dir) = std::env::var_os("RFDB_STATIC_DIR") {
        return UiConfig::StaticDir(PathBuf::from(dir));
    }
    UiConfig::Embedded
}

/// Build the HTTP router with the default UI strategy derived from env vars.
///
/// Thin wrapper over [`build_router_with_ui`] that uses [`ui_config_from_env`].
/// Preferred entry point for the binary; tests pick [`build_router_with_ui`]
/// directly to avoid racing on the process-global env.
pub fn build_router(state: HttpState) -> Router {
    #[cfg(feature = "ui")]
    {
        build_router_with_ui(state, ui_config_from_env())
    }
    #[cfg(not(feature = "ui"))]
    {
        build_api_router(state)
    }
}

/// API-only router shared by all code paths. Keeping it factored out means
/// both the UI and no-UI builds attach CORS + state uniformly on top.
fn build_api_router(state: HttpState) -> Router {
    Router::new()
        .route("/api/graph-stream", get(graph_stream))
        .route("/api/layout-live", get(layout_live_ws))
        .route("/api/stats", get(stats))
        .route("/api/node/{id}", get(node_by_id))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

/// Build a router with an explicit UI strategy.
///
/// Available when the `ui` feature is enabled. Tests use this to avoid
/// mutating process-global env vars (which would race between parallel
/// tests).
///
/// Route table for UI (axum 0.8 path syntax — `/{param}` and `/{*rest}`):
///   * `GET /ui/`                         → SPA root (`web.html` / placeholder)
///   * `GET /ui/{db}`                     → SPA root (client-side routing)
///   * `GET /ui/{db}/{*path}`             → embedded asset, SPA fallback on miss
///
/// When `UiConfig::StaticDir(d)` is used the `/ui` namespace is served by
/// `tower_http::services::ServeDir` instead of the embedded bundle.
#[cfg(feature = "ui")]
pub fn build_router_with_ui(state: HttpState, ui: UiConfig) -> Router {
    let api = build_api_router(state);
    match ui {
        UiConfig::Disabled => api,
        UiConfig::StaticDir(dir) => {
            use tower_http::services::ServeDir;
            api.nest_service("/ui", ServeDir::new(dir))
        }
        UiConfig::Embedded => api
            .route(
                "/ui",
                get(|| async { crate::static_ui::serve_spa_root() }),
            )
            .route(
                "/ui/",
                get(|| async { crate::static_ui::serve_spa_root() }),
            )
            .route(
                "/ui/{*path}",
                get(
                    |axum::extract::Path(path): axum::extract::Path<String>| async move {
                        // Single wildcard: pass the whole tail to serve_asset.
                        // - /ui/assets/web-<hash>.js  -> asset lookup hits (hashed JS/CSS)
                        // - /ui/{db}                  -> asset miss -> SPA fallback
                        // - /ui/{db}/subpage          -> asset miss -> SPA fallback
                        crate::static_ui::serve_asset(&path)
                    },
                ),
            ),
    }
}

/// Bind the HTTP listener and return `(actual_port, serve_future)`.
///
/// When `port == 0` the OS picks a free port; the actual port is read back
/// from `local_addr()` so the caller can advertise it (lockfile, stderr,
/// workspaceState, etc.) before awaiting the serve future.
///
/// Returns `Err` if bind fails — lets the caller fall back to a different
/// port or surface a user-facing error without panicking the process.
pub async fn bind(
    state: HttpState,
    port: u16,
) -> std::io::Result<(u16, impl std::future::Future<Output = ()> + Send + 'static)> {
    let app = build_router(state);
    let addr = format!("127.0.0.1:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let actual_port = listener.local_addr()?.port();
    eprintln!(
        "[rfdb-server] HTTP server listening on http://127.0.0.1:{}",
        actual_port
    );
    let serve = async move {
        let _ = axum::serve(listener, app).await;
    };
    Ok((actual_port, serve))
}

/// Start the HTTP server on the given port using a pre-built `HttpState`.
///
/// Backward-compatible wrapper. Panics if bind fails (legacy behavior).
pub async fn start(state: HttpState, port: u16) {
    let (_actual, serve) = bind(state, port)
        .await
        .expect("Failed to bind HTTP listener");
    serve.await;
}

// ── Query parameters ────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StreamParams {
    packages: Option<String>,
    node_types: Option<String>,
    edge_types: Option<String>,
    max_nodes: Option<usize>,
    /// Container hierarchy level for region grouping. Accepts a level
    /// name from the default hierarchy: `package` (top — first 2 path
    /// segments), `directory` (full dir path), `file`, `symbol`. When
    /// omitted the server picks the deepest level with at most N/2
    /// containers, which is fine for symbol views but too granular for
    /// file/directory LOD overviews.
    lod_level: Option<String>,
}

// ── GET /api/stats ──────────────────────────────────────────────────────

async fn stats(State(state): State<HttpState>) -> impl IntoResponse {
    let db = match state.manager.get_database("default") {
        Ok(db) => db,
        Err(e) => return axum::Json(serde_json::json!({"error": e.to_string()})).into_response(),
    };
    let engine = db.engine.read().unwrap();
    let node_count = engine.node_count();
    let edge_count = engine.edge_count();

    // Count by type
    let mut nodes_by_type: HashMap<String, usize> = HashMap::new();
    let all_node_ids = engine.find_by_attr(&AttrQuery::default());
    for id in &all_node_ids {
        if let Some(node) = engine.get_node(*id) {
            let t = node.node_type.as_deref().unwrap_or("UNKNOWN").to_string();
            *nodes_by_type.entry(t).or_insert(0) += 1;
        }
    }

    axum::Json(serde_json::json!({
        "nodeCount": node_count,
        "edgeCount": edge_count,
        "nodesByType": nodes_by_type,
    })).into_response()
}

// ── GET /api/node/:id ───────────────────────────────────────────────────

async fn node_by_id(
    State(state): State<HttpState>,
    axum::extract::Path(id_str): axum::extract::Path<String>,
) -> impl IntoResponse {
    let db = match state.manager.get_database("default") {
        Ok(db) => db,
        Err(e) => return axum::Json(serde_json::json!({"error": e.to_string()})).into_response(),
    };
    let engine = db.engine.read().unwrap();

    // Try parsing as u128 or string ID
    let id: u128 = if let Ok(n) = id_str.parse::<u128>() {
        n
    } else {
        crate::graph::string_id_to_u128(&id_str)
    };

    match engine.get_node(id) {
        Some(node) => axum::Json(serde_json::json!({
            "id": node.id.to_string(),
            "type": node.node_type,
            "name": node.name,
            "file": node.file,
            "exported": node.exported,
            "metadata": node.metadata.as_ref().and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok()),
        })).into_response(),
        None => axum::Json(serde_json::json!({"error": "not found"})).into_response(),
    }
}

// ── GET /api/graph-stream ───────────────────────────────────────────────

async fn graph_stream(
    State(state): State<HttpState>,
    Query(params): Query<StreamParams>,
) -> impl IntoResponse {
    let max_nodes = params.max_nodes.unwrap_or(5000);
    let want_packages: Option<Vec<String>> = params.packages
        .map(|s| s.split(',').map(|p| p.trim().to_string()).collect());
    let want_node_types: Option<Vec<String>> = params.node_types
        .map(|s| s.split(',').map(|p| p.trim().to_string()).collect());
    let want_edge_types: Option<Vec<String>> = params.edge_types
        .map(|s| s.split(',').map(|p| p.trim().to_string()).collect());
    let lod_level = params.lod_level;

    // Load graph data from RFDB (blocking — graph engine is sync)
    let manager = state.manager.clone();
    let layout_cache = state.layout_cache.clone();
    let file_to_nodes = state.file_to_nodes.clone();
    let body = tokio::task::spawn_blocking(move || {
        build_graph_stream_body(
            manager, layout_cache, file_to_nodes,
            max_nodes, want_packages, want_node_types, want_edge_types, lod_level,
        )
    }).await.unwrap();

    Response::builder()
        .header("Content-Type", "application/x-ndjson")
        .header("Cache-Control", "no-cache")
        .body(axum::body::Body::from(body))
        .unwrap()
}

/// Build or reuse the cached file → node-ids index. Performs exactly one
/// full scan of the graph per server lifetime. Returns an owned clone so
/// callers can use it without holding the cache lock for the request's
/// duration.
fn get_or_build_file_to_nodes(
    cache: &RwLock<Option<HashMap<String, Vec<u128>>>>,
    engine: &dyn GraphStore,
) -> HashMap<String, Vec<u128>> {
    // Write-lock-first pattern: concurrent callers serialize here, the
    // first builds, the rest find the cache populated and return. Prevents
    // the race where warmup + first HTTP request both build concurrently.
    let mut guard = cache.write().unwrap();
    if let Some(m) = guard.as_ref() {
        return m.clone();
    }
    let t0 = std::time::Instant::now();
    let all_ids = engine.find_by_attr(&AttrQuery::default());
    // Parallel decode: 333k get_node lookups is the dominant cold-start
    // cost. rayon splits the work across cores. The engine's get_node is
    // read-only + already Send+Sync (protected by outer RwLock in caller),
    // so parallel scan is safe.
    use rayon::prelude::*;
    let pairs: Vec<(String, u128)> = all_ids
        .par_iter()
        .filter_map(|&nid| {
            engine.get_node(nid).map(|n| {
                (n.file.as_deref().unwrap_or("").to_string(), nid)
            })
        })
        .collect();
    let mut map: HashMap<String, Vec<u128>> = HashMap::new();
    for (file, nid) in pairs {
        map.entry(file).or_default().push(nid);
    }
    eprintln!(
        "[http] built file_to_nodes cache: {} files, {} nodes, {}ms",
        map.len(), all_ids.len(), t0.elapsed().as_millis()
    );
    *guard = Some(map.clone());
    map
}

/// Layout source tag used by the orchestrator's `grafema layout --commit`
/// pipeline. The consumer filters strictly by this tag so analyzer-emitted
/// CONTAINS edges (no tag) are never treated as layout data.
const LAYOUT_SOURCE_TAG: &str = "layout-pack";

/// Fail-loudly threshold: if the loader encounters more than this many
/// LAYOUT_POSITION edges with the same `src` but different `(q, r)`, the
/// warmup aborts — it's a symptom of a broken delete-before-write.
// RFDB V2 tombstoning + compaction can leave minor LAYOUT_POSITION residue
// across rapid re-commits. 1000 is still loud enough to catch systemic
// delete-pre-pass failure (writer emitting duplicates, or a true missing
// purge) but tolerant of the ≤50-edge leakage seen in dev iteration.
const DUP_POSITION_BAIL_THRESHOLD: usize = 1000;

/// Errors produced by [`get_or_build_layout`] when the persisted layout
/// is structurally broken (cycles, excessive duplicate positions). Minor
/// corruption (missing metadata, non-parseable fields) is warn+skip and
/// never bubbles up.
#[derive(Debug)]
enum LayoutLoadError {
    /// A REGION containment chain contains a cycle.
    Cycle { region_id: u128, path: String },
    /// Too many LAYOUT_POSITION edges with duplicate `src`.
    ExcessiveDuplicates { count: usize },
}

impl std::fmt::Display for LayoutLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LayoutLoadError::Cycle { region_id, path } => write!(
                f,
                "cycle detected in REGION containment at region {} ({})",
                region_id, path
            ),
            LayoutLoadError::ExcessiveDuplicates { count } => write!(
                f,
                "{} LAYOUT_POSITION edges with duplicate src — re-run `grafema layout --commit`",
                count
            ),
        }
    }
}

impl std::error::Error for LayoutLoadError {}

/// Extract a flat-JSON string value: `"key":"value"` → Some("value"). Very
/// small pre-allocated parser — our metadata writer emits a fixed, flat
/// shape so a substring scan is adequate and 10× cheaper than pulling in
/// `serde_json::from_str` for every edge.
fn extract_json_str<'a>(meta: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{}\":\"", key);
    let start = meta.find(&needle)? + needle.len();
    let rest = &meta[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

/// Extract a flat-JSON integer value: `"key":123` → Some(123). Returns
/// `None` when the key is absent or the value isn't a bare integer.
fn extract_json_i64(meta: &str, key: &str) -> Option<i64> {
    let needle = format!("\"{}\":", key);
    let start = meta.find(&needle)? + needle.len();
    let rest = &meta[start..];
    // value ends at , } or space
    let end = rest
        .find(|c: char| c == ',' || c == '}' || c.is_whitespace())
        .unwrap_or(rest.len());
    rest[..end].trim().parse::<i64>().ok()
}

/// Extract a flat-JSON non-negative integer value.
fn extract_json_usize(meta: &str, key: &str) -> Option<usize> {
    extract_json_i64(meta, key).and_then(|v| if v >= 0 { Some(v as usize) } else { None })
}

/// Build or reuse the cached persisted layout. Reads LAYOUT_POSITION +
/// REGION + CONTAINS (filtered by `_source=layout-pack`) from RFDB; no
/// server-side optimisation runs. On a fresh database with no layout
/// committed yet, returns `source = LayoutSource::Missing` and empty
/// positions — every stream node will carry `pos: null` and
/// `unplaced_reason: "missing_layout"`.
fn get_or_build_layout(
    cache: &RwLock<Option<CachedLayout>>,
    file_to_nodes_cache: &RwLock<Option<HashMap<String, Vec<u128>>>>,
    engine: &dyn GraphStore,
) -> CachedLayout {
    // Write-lock-first — serialize concurrent builders.
    let mut guard = cache.write().unwrap();
    if let Some(l) = guard.as_ref() {
        return l.clone();
    }
    let t0 = std::time::Instant::now();

    // Warm the file_to_nodes cache so later callers (stream emission)
    // don't pay for the scan again.
    let _ = get_or_build_file_to_nodes(file_to_nodes_cache, engine);

    match load_layout_from_rfdb(engine) {
        Ok(cached) => {
            eprintln!(
                "[layout] loaded persisted layout: {} positions, {} regions, {} overflow files, {}ms",
                cached.positions.len(),
                cached.regions.len(),
                cached.overflow_files.len(),
                t0.elapsed().as_millis(),
            );
            if matches!(cached.source, LayoutSource::Missing) {
                eprintln!(
                    "[layout] WARN: No LAYOUT_POSITION edges. Run `grafema layout --commit` after `grafema analyze`."
                );
            }
            *guard = Some(cached.clone());
            cached
        }
        Err(e) => {
            // Structural corruption — serve an empty layout so the server
            // keeps running, but the operator sees the error clearly.
            eprintln!("[layout] ERROR: refusing to load layout: {}", e);
            let empty = CachedLayout {
                positions: HashMap::new(),
                regions: Vec::new(),
                containment: HashMap::new(),
                overflow_files: HashMap::new(),
                source: LayoutSource::Missing,
            };
            *guard = Some(empty.clone());
            empty
        }
    }
}

/// Scan RFDB for persisted LAYOUT_POSITION edges + REGION nodes + CONTAINS
/// edges tagged `_source=layout-pack` and assemble a [`CachedLayout`].
///
/// Returns `Err` only for structural corruption (cycles in REGION
/// containment, excessive duplicate positions). Minor corruption (missing
/// metadata, bad field types) is warn+skip.
fn load_layout_from_rfdb(engine: &dyn GraphStore) -> std::result::Result<CachedLayout, LayoutLoadError> {
    // ── 1. LAYOUT_POSITION edges ─────────────────────────────────────────
    let mut positions: HashMap<u128, HexCoord> = HashMap::new();
    let mut skip_missing_meta = 0usize;
    let mut skip_wrong_source = 0usize;
    let mut skip_bad_fields = 0usize;
    let mut dup_count = 0usize;
    let mut committed_at_sample: Option<String> = None;

    for edge in engine.get_edges_by_type("LAYOUT_POSITION") {
        let meta = match edge.metadata.as_deref() {
            Some(m) => m,
            None => {
                skip_missing_meta += 1;
                continue;
            }
        };
        let src_tag = match extract_json_str(meta, "_source") {
            Some(s) => s,
            None => {
                skip_missing_meta += 1;
                continue;
            }
        };
        if src_tag != LAYOUT_SOURCE_TAG {
            skip_wrong_source += 1;
            continue;
        }
        let q = extract_json_i64(meta, "q");
        let r = extract_json_i64(meta, "r");
        let (q, r) = match (q, r) {
            (Some(q), Some(r)) => (q, r),
            _ => {
                skip_bad_fields += 1;
                continue;
            }
        };
        // Clamp check — i32 range.
        if q < i32::MIN as i64 || q > i32::MAX as i64 || r < i32::MIN as i64 || r > i32::MAX as i64 {
            skip_bad_fields += 1;
            continue;
        }
        let coord = HexCoord { q: q as i32, r: r as i32 };

        if committed_at_sample.is_none() {
            if let Some(ts) = extract_json_str(meta, "committed_at") {
                committed_at_sample = Some(ts.to_string());
            }
        }

        match positions.get(&edge.src) {
            Some(existing) if *existing == coord => {
                // Same edge re-seen (L0/L1/write-buffer). Safe to ignore.
            }
            Some(_) => {
                dup_count += 1;
                if dup_count > DUP_POSITION_BAIL_THRESHOLD {
                    return Err(LayoutLoadError::ExcessiveDuplicates { count: dup_count });
                }
                // Keep first-seen; warn only.
            }
            None => {
                positions.insert(edge.src, coord);
            }
        }
    }

    if skip_missing_meta + skip_wrong_source + skip_bad_fields + dup_count > 0 {
        eprintln!(
            "[layout] warn: skipped {} missing-meta, {} wrong-source, {} bad-fields, {} duplicates LAYOUT_POSITION edges",
            skip_missing_meta, skip_wrong_source, skip_bad_fields, dup_count
        );
    }

    // ── 2. REGION nodes ─────────────────────────────────────────────────
    let mut regions: Vec<RegionInfo> = Vec::new();
    let mut overflow_files: HashMap<String, (usize, usize)> = HashMap::new();
    let mut region_ids: std::collections::HashSet<u128> = std::collections::HashSet::new();
    let mut skip_region_meta = 0usize;

    for nid in engine.find_by_type("REGION") {
        if !region_ids.insert(nid) {
            continue; // dedup across storage layers
        }
        let node = match engine.get_node(nid) {
            Some(n) => n,
            None => continue,
        };
        let meta = match node.metadata.as_deref() {
            Some(m) => m,
            None => {
                skip_region_meta += 1;
                continue;
            }
        };
        let src_tag = match extract_json_str(meta, "_source") {
            Some(s) => s,
            None => {
                skip_region_meta += 1;
                continue;
            }
        };
        if src_tag != LAYOUT_SOURCE_TAG {
            // Some other writer's REGION — ignore, don't count as corruption.
            continue;
        }
        let depth = match extract_json_i64(meta, "depth") {
            Some(d) if d >= 0 => d as u32,
            _ => {
                skip_region_meta += 1;
                continue;
            }
        };
        let path = match extract_json_str(meta, "path") {
            Some(p) => p.to_string(),
            None => {
                skip_region_meta += 1;
                continue;
            }
        };
        let kind = match extract_json_str(meta, "kind") {
            Some(k) => k.to_string(),
            None => {
                skip_region_meta += 1;
                continue;
            }
        };
        if kind != "folder" && kind != "file" {
            skip_region_meta += 1;
            continue;
        }
        let name = extract_json_str(meta, "name").unwrap_or("").to_string();

        if kind == "file" {
            if let Some(skipped) = extract_json_usize(meta, "overflow_skipped") {
                if skipped > 0 {
                    let cap = extract_json_usize(meta, "hard_cap").unwrap_or(0);
                    overflow_files.insert(path.clone(), (skipped, cap));
                }
            }
        }

        regions.push(RegionInfo {
            id: nid,
            depth,
            path,
            kind,
            name,
        });
    }
    if skip_region_meta > 0 {
        eprintln!("[layout] warn: skipped {} malformed REGION nodes", skip_region_meta);
    }

    // ── 3. CONTAINS edges (layout-pack only) ─────────────────────────────
    let mut containment: HashMap<u128, Vec<u128>> = HashMap::new();
    for edge in engine.get_edges_by_type("CONTAINS") {
        let meta = match edge.metadata.as_deref() {
            Some(m) => m,
            None => continue, // analyzer CONTAINS — skip
        };
        if !meta.contains("\"_source\":\"layout-pack\"") {
            continue;
        }
        containment.entry(edge.src).or_default().push(edge.dst);
    }

    // ── 4. Cycle detection on REGION-only containment subgraph ──────────
    // Build region-id set; we only BFS through region→region edges.
    for region in &regions {
        if region.depth != 0 {
            continue;
        }
        detect_cycle(region.id, &containment, &region_ids, region)?;
    }

    // ── 5. Source provenance ────────────────────────────────────────────
    let source = if positions.is_empty() {
        LayoutSource::Missing
    } else {
        LayoutSource::Committed {
            committed_at: committed_at_sample.unwrap_or_default(),
            symbol_count: positions.len(),
        }
    };

    Ok(CachedLayout {
        positions,
        regions,
        containment,
        overflow_files,
        source,
    })
}

/// Walk the REGION containment tree from a depth-0 root; fail if we
/// revisit a node along the same path (classic DFS cycle detection using
/// a recursion-stack set).
fn detect_cycle(
    root: u128,
    containment: &HashMap<u128, Vec<u128>>,
    region_ids: &std::collections::HashSet<u128>,
    root_info: &RegionInfo,
) -> std::result::Result<(), LayoutLoadError> {
    // Iterative DFS to avoid stack blow-ups on deep trees.
    let mut stack: Vec<(u128, Vec<u128>)> = Vec::new();
    let mut on_path: std::collections::HashSet<u128> = std::collections::HashSet::new();

    stack.push((root, containment.get(&root).cloned().unwrap_or_default()));
    on_path.insert(root);

    while let Some((_cur, children)) = stack.last_mut() {
        match children.pop() {
            Some(child) => {
                if !region_ids.contains(&child) {
                    continue; // symbol child, not a region
                }
                if on_path.contains(&child) {
                    return Err(LayoutLoadError::Cycle {
                        region_id: child,
                        path: root_info.path.clone(),
                    });
                }
                on_path.insert(child);
                let grand = containment.get(&child).cloned().unwrap_or_default();
                stack.push((child, grand));
            }
            None => {
                let (done, _) = stack.pop().unwrap();
                on_path.remove(&done);
            }
        }
    }
    Ok(())
}

fn build_graph_stream_body(
    manager: Arc<DatabaseManager>,
    layout_cache_slot: Arc<RwLock<Option<CachedLayout>>>,
    file_to_nodes_slot: Arc<RwLock<Option<HashMap<String, Vec<u128>>>>>,
    max_nodes: usize,
    want_packages: Option<Vec<String>>,
    want_node_types: Option<Vec<String>>,
    want_edge_types: Option<Vec<String>>,
    lod_level: Option<String>,
) -> String {
    let start = std::time::Instant::now();
    let db = manager.get_database("default").unwrap();
    let engine = db.engine.read().unwrap();

    // Fast-path: if a strict node-type filter is provided, use find_by_type
    // for each type instead of scanning all 326k+ nodes. Falls back to full
    // scan when no type filter is given. Deduplicated because find_by_type
    // may return the same id across storage layers (write buffer + L0 + L1)
    // after recent commits.
    let candidate_ids: Vec<u128> = if let Some(ref types) = want_node_types {
        let mut seen: std::collections::HashSet<u128> = std::collections::HashSet::new();
        let mut ids: Vec<u128> = Vec::new();
        for t in types {
            for nid in engine.find_by_type(t) {
                if seen.insert(nid) {
                    ids.push(nid);
                }
            }
        }
        ids
    } else {
        engine.find_by_attr(&AttrQuery::default())
    };

    let mut node_refs: Vec<NodeRef> = Vec::new();
    let mut id_to_idx: HashMap<u128, u32> = HashMap::new();
    let mut type_table: Vec<String> = Vec::new();
    let mut type_idx: HashMap<String, usize> = HashMap::new();

    for &nid in &candidate_ids {
        if node_refs.len() >= max_nodes { break; }
        let node = match engine.get_node(nid) {
            Some(n) => n,
            None => continue,
        };
        let ntype = node.node_type.as_deref().unwrap_or("UNKNOWN").to_string();
        let file = node.file.as_deref().unwrap_or("").to_string();

        // Package filter
        if let Some(ref pkgs) = want_packages {
            if !pkgs.iter().any(|p| file.starts_with(p.as_str())) {
                continue;
            }
        }
        // Type filter
        if let Some(ref types) = want_node_types {
            if !types.iter().any(|t| t == &ntype) {
                continue;
            }
        }

        let ti = *type_idx.entry(ntype.clone()).or_insert_with(|| {
            let idx = type_table.len();
            type_table.push(ntype.clone());
            idx
        });

        // Clean name: strip absolute paths for MODULE nodes
        let mut name = node.name.as_deref().unwrap_or("").to_string();
        if name.contains('/') && !file.is_empty() {
            if let Some(pos) = file.rfind('/') {
                name = file[pos + 1..].to_string();
            }
        }

        let idx = node_refs.len() as u32;
        id_to_idx.insert(nid, idx);
        node_refs.push(NodeRef {
            idx,
            id: nid,
            node_type: node.node_type.as_deref().unwrap_or("UNKNOWN").to_string(),
            file,
            name,
            metadata: node.metadata.clone(),
        });
    }

    let node_count = node_refs.len();

    // ── Edge aggregation via file-based grouping ──
    // Group ALL nodes in the graph by file path. For each file, find the best
    // visible node (FUNCTION > CLASS > MODULE) to "own" non-visible nodes.
    // Then collect semantic edges and lift both endpoints to their file's owner.
    //
    // This handles graphs where CALL nodes have no CONTAINS parent but share
    // the same file as their enclosing FUNCTION.

    let liftable_types: std::collections::HashSet<&str> = [
        "CALLS", "READS_FROM", "IMPORTS_FROM", "WRITES_TO",
        "PASSES_ARGUMENT", "AWAITS", "RETURNS", "ITERATES_OVER",
        "DEPENDS_ON", "HAS_METHOD",
        // Structural edges — needed for directory/file LOD views
        "CONTAINS",
    ].into_iter().collect();

    // Build file → visible nodes map
    let mut file_to_visible: HashMap<String, Vec<u32>> = HashMap::new();
    for nr in &node_refs {
        file_to_visible.entry(nr.file.clone()).or_default().push(nr.idx);
    }

    // For each file that has visible nodes, collect ALL nodes in that file
    // and map non-visible ones to the file's MODULE node (or first visible node)
    let mut nid_to_visible: HashMap<u128, u32> = HashMap::new();

    // Visible nodes map to themselves
    for nr in &node_refs {
        nid_to_visible.insert(nr.id, nr.idx);
    }

    // Edge-lifting maps non-visible nodes to their containing visible
    // node so that semantic edges (CALLS, IMPORTS_FROM, etc.) between
    // them can be aggregated up to the visible level. Previously this
    // required a per-request full scan of all nodes (~20–30s on 326k
    // nodes). We now consult a process-wide cached file→node-ids index
    // built exactly once per server lifetime.
    let file_to_nodes_cache = get_or_build_file_to_nodes(&file_to_nodes_slot, &**engine);
    for (file, visible_nodes) in file_to_visible.iter() {
        if let Some(node_ids) = file_to_nodes_cache.get(file) {
            for &nid in node_ids {
                if !nid_to_visible.contains_key(&nid) {
                    nid_to_visible.insert(nid, visible_nodes[0]);
                }
            }
        }
    }

    eprintln!("[http] edge-lift: {} visible, {} mapped via file grouping",
        node_count, nid_to_visible.len());

    // Collect edges between mapped nodes.
    //
    // Iterating per-node via get_outgoing_edges is O(N) RPCs (each touches
    // segments) and becomes ~minutes for 100k+ mapped nodes.
    // Instead, fetch all edges of each liftable type in bulk and filter
    // against nid_to_visible — this is O(E) over edges of those types and
    // doesn't pay any per-node lookup cost.
    let mut edge_refs: Vec<EdgeRef> = Vec::new();
    let mut edge_type_table: Vec<String> = Vec::new();
    let mut edge_type_idx: HashMap<String, usize> = HashMap::new();
    let mut seen_edges: std::collections::HashSet<(u32, u32, String)> = std::collections::HashSet::new();

    let edge_types_to_lift: Vec<&str> = if let Some(ref types) = want_edge_types {
        liftable_types
            .iter()
            .copied()
            .filter(|t| types.iter().any(|w| w == *t))
            .collect()
    } else {
        liftable_types.iter().copied().collect()
    };

    for etype_str in &edge_types_to_lift {
        let bulk = engine.get_edges_by_type(etype_str);
        for edge in bulk {
            let src_vis = match nid_to_visible.get(&edge.src) {
                Some(&idx) => idx,
                None => continue,
            };
            let dst_vis = match nid_to_visible.get(&edge.dst) {
                Some(&idx) => idx,
                None => continue,
            };
            if src_vis == dst_vis { continue; }

            let etype = edge.edge_type.as_deref().unwrap_or("UNKNOWN").to_string();
            let edge_key = (src_vis, dst_vis, etype.clone());
            if !seen_edges.insert(edge_key) { continue; }

            let _eti = *edge_type_idx.entry(etype.clone()).or_insert_with(|| {
                let idx = edge_type_table.len();
                edge_type_table.push(etype.clone());
                idx
            });

            edge_refs.push(EdgeRef {
                src_idx: src_vis,
                dst_idx: dst_vis,
                edge_type: etype,
            });
        }
    }

    // Compute degrees
    let mut degrees = vec![0u32; node_count];
    for e in &edge_refs {
        degrees[e.src_idx as usize] += 1;
        degrees[e.dst_idx as usize] += 1;
    }

    let t_tree = std::time::Instant::now();
    // Build container hierarchy from actual directory nesting in node paths
    let hierarchy = auto_hierarchy_from_nodes(&node_refs);
    let mut tree = ContainerTree::build(&hierarchy, &node_refs, &edge_refs);
    eprintln!("[http] tree build: {}ms ({} nodes, {} edges)",
        t_tree.elapsed().as_millis(), node_refs.len(), edge_refs.len());

    // ── Tectonic layout pipeline (Phase G) ──
    // Computed once per server lifetime on file-level atoms (MODULE
    // nodes) and cached. Each non-MODULE node inherits its containing
    // file's hex centroid at emit time — good enough for the demo.
    let cached_layout = get_or_build_layout(&layout_cache_slot, &file_to_nodes_slot, &**engine);

    // Override SA region level if the client requested a specific LOD
    // (e.g. lodLevel=package gives top-level packages instead of the
    // auto-picked deepest level).
    if let Some(name) = lod_level.as_ref() {
        if let Some(idx) = tree.level_names.iter().position(|n| n == name) {
            tree.sa_region_level = idx;
        }
    }
    let region_level = tree.sa_region_level;

    let t_emit = std::time::Instant::now();
    // Build JSONL output
    let mut lines: Vec<String> = Vec::new();

    // Header: emit the persisted REGION tree so the GUI can draw hulls.
    // Falls back to the SA container tree's flat level list when no
    // persisted layout exists (the GUI still has something to render).
    let regions_tree = build_region_tree_json(&cached_layout);
    let regions_flat: Vec<serde_json::Value> = if regions_tree.is_empty() {
        tree.containers_at_level(region_level)
            .values()
            .map(|c| serde_json::json!({
                "path": c.id,
                "depth": c.level,
                "tileCount": c.child_count,
            }))
            .collect()
    } else {
        regions_tree
    };

    lines.push(serde_json::to_string(&serde_json::json!({
        "type": "header",
        "typeTable": type_table,
        "edgeTypeTable": edge_type_table,
        "regions": regions_flat,
    })).unwrap());

    // Layout-meta frame (DAI-22 Chunk-4) — carries provenance + overflow
    // summary so the GUI can render the "Run `grafema layout --commit`"
    // overlay and per-file red badges.
    let (meta_source, meta_committed_at, meta_symbol_count) = match &cached_layout.source {
        LayoutSource::Missing => ("missing", serde_json::Value::Null, 0usize),
        LayoutSource::Committed { committed_at, symbol_count } => (
            "committed",
            serde_json::Value::String(committed_at.clone()),
            *symbol_count,
        ),
    };
    let overflow_files_json: Vec<serde_json::Value> = cached_layout
        .overflow_files
        .iter()
        .map(|(file, (skipped, cap))| {
            serde_json::json!({
                "file": file,
                "skipped": skipped,
                "cap": cap,
            })
        })
        .collect();
    lines.push(serde_json::to_string(&serde_json::json!({
        "type": "layout_meta",
        "source": meta_source,
        "symbol_count": meta_symbol_count,
        "committed_at": meta_committed_at,
        "overflow_files": overflow_files_json,
    })).unwrap());

    // Nodes — each carries `pos` from the persisted layout (or null) plus
    // an `unplaced_reason` discriminator so the GUI can distinguish excluded
    // node types from "layout not yet computed" from "hard-cap overflow".
    let layout_is_missing = matches!(cached_layout.source, LayoutSource::Missing);
    for nr in &node_refs {
        let ti = type_idx.get(&nr.node_type).copied().unwrap_or(0);
        let region = tree.sa_region(nr.idx).to_string();
        let placeable = layout_types::is_placeable(&nr.node_type);
        let placed = cached_layout.positions.get(&nr.id).copied();
        let (pos, unplaced_reason) = match (placeable, placed, layout_is_missing) {
            (false, _, _) => (serde_json::Value::Null, Some("excluded")),
            (true, Some(c), _) => (serde_json::json!({ "q": c.q, "r": c.r }), None),
            (true, None, true) => (serde_json::Value::Null, Some("missing_layout")),
            (true, None, false) => (serde_json::Value::Null, Some("skipped_overflow")),
        };
        let unplaced_reason_json = match unplaced_reason {
            Some(s) => serde_json::Value::String(s.to_string()),
            None => serde_json::Value::Null,
        };
        lines.push(serde_json::to_string(&serde_json::json!({
            "type": "node",
            "i": nr.idx,
            "t": ti,
            "id": nr.id.to_string(),
            "name": nr.name,
            "file": nr.file,
            "region": region,
            "degree": degrees[nr.idx as usize],
            "pos": pos,
            "unplaced_reason": unplaced_reason_json,
        })).unwrap());
    }

    lines.push(serde_json::to_string(&serde_json::json!({
        "type": "nodes_done",
        "count": node_count,
    })).unwrap());

    // Edges
    for (_i, e) in edge_refs.iter().enumerate() {
        let eti = edge_type_idx.get(&e.edge_type).copied().unwrap_or(0);
        lines.push(serde_json::to_string(&serde_json::json!({
            "type": "edge",
            "s": e.src_idx,
            "d": e.dst_idx,
            "t": eti,
        })).unwrap());
    }

    let elapsed = start.elapsed().as_millis();
    lines.push(serde_json::to_string(&serde_json::json!({
        "type": "done",
        "nodeCount": node_count,
        "edgeCount": edge_refs.len(),
        "elapsed": elapsed,
    })).unwrap());

    eprintln!("[http] graph-stream: {} nodes, {} edges, {} regions, {}ms (emit: {}ms)",
        node_count, edge_refs.len(), regions_flat.len(), elapsed,
        t_emit.elapsed().as_millis());

    lines.join("\n") + "\n"
}

/// Serialise the persisted REGION tree as nested JSON for the header
/// frame. Each node = `{id, depth, path, kind, name, children}`; files
/// (leaves) omit child symbols (those are implicit from node emission).
/// Returns an empty Vec when no persisted layout exists — the caller
/// falls back to the container-hierarchy flat list in that case.
fn build_region_tree_json(cached: &CachedLayout) -> Vec<serde_json::Value> {
    if cached.regions.is_empty() {
        return Vec::new();
    }
    // Build index of region-by-id for quick child lookups, plus a set
    // of region ids so we can filter CONTAINS children (folder children
    // are regions; symbol children are skipped — represented by nodes).
    let region_by_id: HashMap<u128, &RegionInfo> = cached
        .regions
        .iter()
        .map(|r| (r.id, r))
        .collect();

    fn build_node(
        r: &RegionInfo,
        region_by_id: &HashMap<u128, &RegionInfo>,
        containment: &HashMap<u128, Vec<u128>>,
    ) -> serde_json::Value {
        let children: Vec<serde_json::Value> = containment
            .get(&r.id)
            .map(|kids| {
                kids.iter()
                    .filter_map(|cid| region_by_id.get(cid).copied())
                    .map(|child| build_node(child, region_by_id, containment))
                    .collect()
            })
            .unwrap_or_default();
        serde_json::json!({
            "id": format!("{:x}", r.id),
            "depth": r.depth,
            "path": r.path,
            "kind": r.kind,
            "name": r.name,
            "children": children,
        })
    }

    cached
        .regions
        .iter()
        .filter(|r| r.depth == 0)
        .map(|root| build_node(root, &region_by_id, &cached.containment))
        .collect()
}

// ── WS /api/layout-live ─────────────────────────────────────────────────

async fn layout_live_ws(
    ws: WebSocketUpgrade,
    State(state): State<HttpState>,
    Query(params): Query<StreamParams>,
) -> Response {
    ws.on_upgrade(move |socket| handle_layout_ws(socket, state, params))
}

async fn handle_layout_ws(mut socket: WebSocket, state: HttpState, params: StreamParams) {
    let max_nodes = params.max_nodes.unwrap_or(5000);
    let want_packages: Option<Vec<String>> = params.packages
        .map(|s| s.split(',').map(|p| p.trim().to_string()).collect());

    // Load data and prepare SA in blocking task
    let manager = state.manager.clone();
    let (tx, mut rx) = tokio::sync::watch::channel(SaSnapshot::default());

    let sa_handle = tokio::task::spawn_blocking(move || {
        let db = manager.get_database("default").unwrap();
        let engine = db.engine.read().unwrap();

        // Fetch nodes
        let all_ids = engine.find_by_attr(&AttrQuery::default());
        let mut node_refs: Vec<NodeRef> = Vec::new();
        let mut id_to_idx: HashMap<u128, u32> = HashMap::new();

        for &nid in &all_ids {
            if node_refs.len() >= max_nodes { break; }
            let node = match engine.get_node(nid) {
                Some(n) => n,
                None => continue,
            };
            let file = node.file.as_deref().unwrap_or("").to_string();
            if let Some(ref pkgs) = want_packages {
                if !pkgs.iter().any(|p| file.starts_with(p.as_str())) { continue; }
            }
            let idx = node_refs.len() as u32;
            id_to_idx.insert(nid, idx);
            node_refs.push(NodeRef {
                idx,
                id: nid,
                node_type: node.node_type.as_deref().unwrap_or("UNKNOWN").to_string(),
                file,
                name: node.name.as_deref().unwrap_or("").to_string(),
                metadata: node.metadata.clone(),
            });
        }

        // Fetch edges
        let all_edges = engine.get_all_edges();
        let mut edge_refs: Vec<EdgeRef> = Vec::new();
        for edge in &all_edges {
            let si = match id_to_idx.get(&edge.src) { Some(&i) => i, None => continue };
            let di = match id_to_idx.get(&edge.dst) { Some(&i) => i, None => continue };
            edge_refs.push(EdgeRef {
                src_idx: si,
                dst_idx: di,
                edge_type: edge.edge_type.as_deref().unwrap_or("UNKNOWN").to_string(),
            });
        }

        // Build hierarchy + SA engine
        let hierarchy = default_hierarchy();
        let tree = ContainerTree::build(&hierarchy, &node_refs, &edge_refs);

        let layout_nodes: Vec<LayoutNode> = node_refs.iter().map(|n| LayoutNode {
            idx: n.idx,
            region: tree.sa_region(n.idx).to_string(),
            degree: 0,
        }).collect();

        let layout_edges: Vec<LayoutEdge> = edge_refs.iter().map(|e| LayoutEdge {
            src: e.src_idx,
            dst: e.dst_idx,
            edge_type: e.edge_type.clone(),
        }).collect();

        let mut engine = SaEngine::new(&layout_nodes, &layout_edges, &tree);
        let max_iters = engine.max_iterations();
        let batch_size = 10_000usize.max(layout_nodes.len() * 5);
        let snapshot_interval = std::time::Duration::from_millis(500);

        eprintln!("[http] layout-live: {} nodes, {} edges, {} max iters",
            layout_nodes.len(), layout_edges.len(), max_iters);

        // Send initial snapshot
        let _ = tx.send(SaSnapshot {
            positions: engine.snapshot(),
            cost: engine.total_cost(),
            iteration: 0,
            temperature: engine.temperature(),
            settled: false,
        });

        let mut last_snapshot = std::time::Instant::now();
        while engine.total_iterations < max_iters {
            let (cost, _accepted) = engine.run_batch(batch_size);

            if last_snapshot.elapsed() >= snapshot_interval || engine.total_iterations >= max_iters {
                let settled = engine.total_iterations >= max_iters;
                let snap = SaSnapshot {
                    positions: engine.snapshot(),
                    cost,
                    iteration: engine.total_iterations,
                    temperature: engine.temperature(),
                    settled,
                };
                if tx.send(snap).is_err() {
                    break; // Client disconnected
                }
                last_snapshot = std::time::Instant::now();
            }
        }

        // Final snapshot
        let _ = tx.send(SaSnapshot {
            positions: engine.snapshot(),
            cost: engine.total_cost(),
            iteration: engine.total_iterations,
            temperature: engine.temperature(),
            settled: true,
        });
    });

    // Send started message
    let _ = socket.send(Message::Text(
        serde_json::to_string(&serde_json::json!({
            "type": "started",
        })).unwrap().into()
    )).await;

    // Stream snapshots to client
    loop {
        if rx.changed().await.is_err() { break; }
        let snap = rx.borrow().clone();

        // Send progress as JSON text frame
        let _ = socket.send(Message::Text(
            serde_json::to_string(&serde_json::json!({
                "type": "progress",
                "iteration": snap.iteration,
                "cost": snap.cost,
                "temperature": snap.temperature,
                "settled": snap.settled,
            })).unwrap().into()
        )).await;

        // Send positions as binary frame: [u32 idx, i16 q, i16 r] × N = 8 bytes/node
        let mut buf = Vec::with_capacity(snap.positions.len() * 8);
        for &(idx, q, r) in &snap.positions {
            buf.extend_from_slice(&idx.to_le_bytes());
            buf.extend_from_slice(&q.to_le_bytes());
            buf.extend_from_slice(&r.to_le_bytes());
        }
        let _ = socket.send(Message::Binary(buf.into())).await;

        if snap.settled { break; }
    }

    // Send final settled message
    let _ = socket.send(Message::Text(
        serde_json::to_string(&serde_json::json!({
            "type": "settled",
        })).unwrap().into()
    )).await;

    let _ = sa_handle.await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::GraphEngineV2;
    use crate::storage::{EdgeRecord, NodeRecord};
    use tempfile::TempDir;

    fn make_node(id: u128, node_type: &str, metadata: Option<&str>) -> NodeRecord {
        NodeRecord {
            id,
            node_type: Some(node_type.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some(format!("n{id}")),
            file: Some(format!("<virtual>/layout-pack/{}", id)),
            metadata: metadata.map(|s| s.to_string()),
            semantic_id: Some(format!("{}::{}", node_type, id)),
        }
    }

    fn sym_node(id: u128, node_type: &str, file: &str) -> NodeRecord {
        NodeRecord {
            id,
            node_type: Some(node_type.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some(format!("sym{id}")),
            file: Some(file.to_string()),
            metadata: None,
            semantic_id: Some(format!("{}->{}::{}", file, node_type, id)),
        }
    }

    fn make_edge(src: u128, dst: u128, edge_type: &str, metadata: Option<&str>) -> EdgeRecord {
        EdgeRecord {
            src,
            dst,
            edge_type: Some(edge_type.to_string()),
            version: "main".to_string(),
            metadata: metadata.map(|s| s.to_string()),
            deleted: false,
        }
    }

    fn fresh_engine() -> (TempDir, GraphEngineV2) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.rfdb");
        let engine = GraphEngineV2::create(&db_path).unwrap();
        (dir, engine)
    }

    #[test]
    fn empty_db_produces_missing_source_and_no_positions() {
        let (_dir, mut engine) = fresh_engine();
        engine.flush().unwrap();
        let cached = load_layout_from_rfdb(&engine).unwrap();
        assert!(cached.positions.is_empty());
        assert!(cached.regions.is_empty());
        assert!(matches!(cached.source, LayoutSource::Missing));
    }

    #[test]
    fn layout_position_edges_are_loaded_with_q_r_from_metadata() {
        let (_dir, mut engine) = fresh_engine();
        // Two FUNCTION symbols that will have LAYOUT_POSITION edges.
        engine.add_nodes(vec![
            sym_node(10, "FUNCTION", "src/a.rs"),
            sym_node(11, "FUNCTION", "src/a.rs"),
            // dst hex nodes — we don't actually need real HEX nodes, only
            // the edge metadata is consulted, but we add them so the DB
            // is structurally complete.
            make_node(900, "HEX", None),
            make_node(901, "HEX", None),
        ]);
        engine.add_edges(
            vec![
                make_edge(
                    10,
                    900,
                    "LAYOUT_POSITION",
                    Some(r#"{"_source":"layout-pack","q":3,"r":-2,"committed_at":"2026-04-23T00:00:00Z"}"#),
                ),
                make_edge(
                    11,
                    901,
                    "LAYOUT_POSITION",
                    Some(r#"{"_source":"layout-pack","q":0,"r":1,"committed_at":"2026-04-23T00:00:00Z"}"#),
                ),
            ],
            true,
        );
        engine.flush().unwrap();

        let cached = load_layout_from_rfdb(&engine).unwrap();
        assert_eq!(cached.positions.len(), 2);
        assert_eq!(cached.positions[&10], HexCoord { q: 3, r: -2 });
        assert_eq!(cached.positions[&11], HexCoord { q: 0, r: 1 });
        match cached.source {
            LayoutSource::Committed { ref committed_at, symbol_count } => {
                assert_eq!(committed_at, "2026-04-23T00:00:00Z");
                assert_eq!(symbol_count, 2);
            }
            _ => panic!("expected Committed source"),
        }
    }

    #[test]
    fn layout_position_edges_without_layout_pack_source_are_skipped() {
        let (_dir, mut engine) = fresh_engine();
        engine.add_nodes(vec![
            sym_node(10, "FUNCTION", "src/a.rs"),
            make_node(900, "HEX", None),
        ]);
        engine.add_edges(
            vec![
                make_edge(
                    10,
                    900,
                    "LAYOUT_POSITION",
                    Some(r#"{"_source":"other-writer","q":7,"r":7}"#),
                ),
            ],
            true,
        );
        engine.flush().unwrap();

        let cached = load_layout_from_rfdb(&engine).unwrap();
        assert!(cached.positions.is_empty());
        assert!(matches!(cached.source, LayoutSource::Missing));
    }

    #[test]
    fn region_nodes_are_loaded_with_depth_path_kind_name() {
        let (_dir, mut engine) = fresh_engine();
        engine.add_nodes(vec![
            make_node(
                1,
                "REGION",
                Some(r#"{"_source":"layout-pack","depth":0,"path":".","kind":"folder","name":"/"}"#),
            ),
            make_node(
                2,
                "REGION",
                Some(r#"{"_source":"layout-pack","depth":1,"path":"src","kind":"folder","name":"src"}"#),
            ),
            make_node(
                3,
                "REGION",
                Some(r#"{"_source":"layout-pack","depth":2,"path":"src/a.rs","kind":"file","name":"a.rs","overflow_skipped":5,"hard_cap":500}"#),
            ),
        ]);
        engine.flush().unwrap();

        let cached = load_layout_from_rfdb(&engine).unwrap();
        assert_eq!(cached.regions.len(), 3);
        let file_region = cached
            .regions
            .iter()
            .find(|r| r.kind == "file")
            .expect("file region missing");
        assert_eq!(file_region.path, "src/a.rs");
        assert_eq!(file_region.name, "a.rs");
        assert_eq!(file_region.depth, 2);
        assert_eq!(
            cached.overflow_files.get("src/a.rs").copied(),
            Some((5usize, 500usize))
        );
    }

    #[test]
    fn layout_pack_contains_edges_feed_containment_other_contains_ignored() {
        let (_dir, mut engine) = fresh_engine();
        engine.add_nodes(vec![
            make_node(
                1,
                "REGION",
                Some(r#"{"_source":"layout-pack","depth":0,"path":".","kind":"folder","name":"/"}"#),
            ),
            make_node(
                2,
                "REGION",
                Some(r#"{"_source":"layout-pack","depth":1,"path":"src","kind":"folder","name":"src"}"#),
            ),
            sym_node(10, "FUNCTION", "src/a.rs"),
        ]);
        engine.add_edges(
            vec![
                make_edge(1, 2, "CONTAINS", Some(r#"{"_source":"layout-pack"}"#)),
                // Analyzer-emitted CONTAINS — must be ignored.
                make_edge(2, 10, "CONTAINS", None),
            ],
            true,
        );
        engine.flush().unwrap();

        let cached = load_layout_from_rfdb(&engine).unwrap();
        // Only the layout-pack CONTAINS feeds containment.
        assert_eq!(cached.containment.len(), 1);
        assert_eq!(cached.containment[&1], vec![2u128]);
    }

    #[test]
    fn region_containment_cycle_fails_loudly() {
        let (_dir, mut engine) = fresh_engine();
        engine.add_nodes(vec![
            make_node(
                1,
                "REGION",
                Some(r#"{"_source":"layout-pack","depth":0,"path":".","kind":"folder","name":"/"}"#),
            ),
            make_node(
                2,
                "REGION",
                Some(r#"{"_source":"layout-pack","depth":1,"path":"a","kind":"folder","name":"a"}"#),
            ),
        ]);
        // 1 -> 2 -> 1 (cycle)
        engine.add_edges(
            vec![
                make_edge(1, 2, "CONTAINS", Some(r#"{"_source":"layout-pack"}"#)),
                make_edge(2, 1, "CONTAINS", Some(r#"{"_source":"layout-pack"}"#)),
            ],
            true,
        );
        engine.flush().unwrap();

        let err = load_layout_from_rfdb(&engine).unwrap_err();
        assert!(matches!(err, LayoutLoadError::Cycle { .. }), "expected cycle error, got {:?}", err);
    }

    #[test]
    fn duplicate_positions_beyond_threshold_fail_loudly() {
        let (_dir, mut engine) = fresh_engine();
        engine.add_nodes(vec![sym_node(10, "FUNCTION", "src/a.rs"), make_node(900, "HEX", None)]);
        // Exceed DUP_POSITION_BAIL_THRESHOLD (1000) with conflicting edges.
        let mut edges = Vec::new();
        for i in 0..1010i32 {
            edges.push(make_edge(
                10,
                900 + i as u128,
                "LAYOUT_POSITION",
                Some(&format!(r#"{{"_source":"layout-pack","q":{i},"r":{i}}}"#)),
            ));
        }
        engine.add_edges(edges, true);
        engine.flush().unwrap();

        let err = load_layout_from_rfdb(&engine).unwrap_err();
        assert!(matches!(err, LayoutLoadError::ExcessiveDuplicates { .. }));
    }

    #[test]
    fn extract_json_helpers_parse_flat_metadata() {
        let meta = r#"{"_source":"layout-pack","q":42,"r":-7,"committed_at":"2026-04-23T00:00:00Z"}"#;
        assert_eq!(extract_json_str(meta, "_source"), Some("layout-pack"));
        assert_eq!(extract_json_i64(meta, "q"), Some(42));
        assert_eq!(extract_json_i64(meta, "r"), Some(-7));
        assert_eq!(
            extract_json_str(meta, "committed_at"),
            Some("2026-04-23T00:00:00Z"),
        );
        assert_eq!(extract_json_i64(meta, "missing"), None);
    }

    #[test]
    fn region_tree_json_emits_nested_children_for_layout_pack_only() {
        let cached = CachedLayout {
            positions: HashMap::new(),
            regions: vec![
                RegionInfo {
                    id: 1,
                    depth: 0,
                    path: ".".into(),
                    kind: "folder".into(),
                    name: "/".into(),
                },
                RegionInfo {
                    id: 2,
                    depth: 1,
                    path: "src".into(),
                    kind: "folder".into(),
                    name: "src".into(),
                },
                RegionInfo {
                    id: 3,
                    depth: 2,
                    path: "src/a.rs".into(),
                    kind: "file".into(),
                    name: "a.rs".into(),
                },
            ],
            containment: {
                let mut m: HashMap<u128, Vec<u128>> = HashMap::new();
                m.insert(1, vec![2]);
                m.insert(2, vec![3]);
                // Symbol attachment — not a region, filtered out.
                m.insert(3, vec![999]);
                m
            },
            overflow_files: HashMap::new(),
            source: LayoutSource::Missing,
        };

        let tree = build_region_tree_json(&cached);
        assert_eq!(tree.len(), 1);
        let root = &tree[0];
        assert_eq!(root["depth"], 0);
        let children = root["children"].as_array().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["name"], "src");
        let grand = children[0]["children"].as_array().unwrap();
        assert_eq!(grand.len(), 1);
        assert_eq!(grand[0]["kind"], "file");
        // Symbol child 999 is NOT a REGION → filtered from the tree.
        let file_children = grand[0]["children"].as_array().unwrap();
        assert!(file_children.is_empty());
    }
}
