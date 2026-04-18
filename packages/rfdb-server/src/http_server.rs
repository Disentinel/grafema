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

use std::collections::{BTreeMap, HashMap};
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

use crate::tectonic_layout::{
    preprocess as tectonic_preprocess, phase1_place, phase2_flood_fill, phase3_drift,
    phase4_refine_boundaries, DriftConfig, RefinementConfig,
};
use crate::container_hierarchy::{
    ContainerTree, HierarchyLevel, ContainerRule, NodeRef, EdgeRef, default_hierarchy,
    auto_hierarchy_from_nodes,
};
use crate::sa_layout::{HexCoord, SaEngine, LayoutNode, LayoutEdge, SaSnapshot};
use crate::database_manager::DatabaseManager;
use crate::graph::GraphStore;
use crate::storage::AttrQuery;

/// Cached file-level tectonic layout. Computed once per process on the first
/// `/api/graph-stream` request and reused for every subsequent request until
/// the server restarts. See `build_graph_stream_body` for rationale.
#[derive(Clone)]
pub struct CachedLayout {
    /// Per-atom centroid: node id → hex coord. Covers every primitive
    /// symbol that entered the tectonic pipeline.
    pub atom_positions: HashMap<u128, HexCoord>,
    /// Fallback: representative centroid per file (first atom in that
    /// file, determined by sorted traversal for determinism). Used for
    /// non-atom nodes (CALL, REFERENCE, PARAMETER, …) that still get
    /// emitted in the stream.
    pub file_fallback: HashMap<String, HexCoord>,
    pub atom_count: u32,
    pub phase3_initial_cost: f32,
    pub phase3_final_cost: f32,
    pub pipeline_ms: u128,
}

/// Shared state for all HTTP handlers.
#[derive(Clone)]
pub struct HttpState {
    pub manager: Arc<DatabaseManager>,
    /// Cached file-level tectonic layout (file path → hex centroid).
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

/// Primitive symbol node types that participate in the tectonic layout as
/// atoms. MODULE gives file containers a presence in the pipeline; the
/// rest are the primitive symbols worth placing individually. CALL,
/// REFERENCE, PARAMETER, LITERAL, BRANCH, PATTERN, SCOPE, PROPERTY_ACCESS,
/// IMPORT, CASE, EXPRESSION, DO_BLOCK, METRIC, EFFECT, CONSTRUCTOR are
/// intentionally excluded — too granular and noisy.
// File-level atoms only. Symbol-level primitives (FUNCTION, CLASS,
// METHOD, VARIABLE, ...) blew up hull construction on the client and
// made stream emit dominate build time. Roll back to one atom per
// file (MODULE node). 576 atoms on grafema self-analysis.
const ATOM_TYPES: &[&str] = &[
    "MODULE",
];

/// Build a file-aware hierarchy where the deepest level corresponds to a
/// FilePrefix with enough segments to distinguish every file. Because
/// `file_prefix` clamps to the full path when `segments >= parts.len()`,
/// the deepest level groups all atoms from the same file into one
/// container; shallower levels group by directory prefix.
fn build_atom_hierarchy(atoms: &[NodeRef]) -> Vec<HierarchyLevel> {
    let mut real_max_depth = 1usize;
    for a in atoms {
        if !a.file.is_empty() {
            let segs = a.file.split('/').count();
            if segs > real_max_depth {
                real_max_depth = segs;
            }
        }
    }
    // Cap like auto_hierarchy_from_nodes to avoid pathological depths.
    real_max_depth = real_max_depth.min(10);
    (1..=real_max_depth)
        .map(|k| HierarchyLevel::new(&format!("dir{}", k), ContainerRule::FilePrefix(k)))
        .collect()
}

/// Build or reuse the cached tectonic layout. Atoms are primitive symbol
/// nodes (see `ATOM_TYPES`): MODULE containers plus every FUNCTION,
/// METHOD, CLASS, VARIABLE, etc. Non-atom nodes (CALL, REFERENCE, …)
/// inherit the position of a representative atom from the same file at
/// emit time via `file_fallback`.
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

    // Collect atoms for every primitive type, dedup by node id.
    let mut seen_ids: std::collections::HashSet<u128> = std::collections::HashSet::new();
    let mut atoms: Vec<NodeRef> = Vec::new();
    let mut atom_id_to_idx: HashMap<u128, u32> = HashMap::new();
    for &t in ATOM_TYPES {
        let ids = engine.find_by_type(t);
        for nid in ids {
            if !seen_ids.insert(nid) {
                continue;
            }
            let node = match engine.get_node(nid) {
                Some(n) => n,
                None => continue,
            };
            let file = node.file.as_deref().unwrap_or("").to_string();
            if file.is_empty() {
                continue;
            }
            // Skip DIRECTORY sentinel MODULEs (orchestrator emits nodes
            // with trailing-slash file paths that aren't real files).
            if file.ends_with('/') {
                continue;
            }
            let idx = atoms.len() as u32;
            let name = node
                .name
                .clone()
                .unwrap_or_else(|| {
                    if let Some(pos) = file.rfind('/') {
                        file[pos + 1..].to_string()
                    } else {
                        file.clone()
                    }
                });
            atom_id_to_idx.insert(nid, idx);
            atoms.push(NodeRef {
                idx,
                id: nid,
                node_type: t.to_string(),
                file,
                name,
                metadata: node.metadata.clone(),
            });
        }
    }

    // Warm the file_to_nodes cache so later callers (stream emission)
    // don't pay for the scan again. We don't need its contents here,
    // because we resolve edges directly through atom_id_to_idx.
    let _ = get_or_build_file_to_nodes(file_to_nodes_cache, engine);

    // Build cross-atom edges: for each liftable semantic edge, keep it
    // only if both endpoints are atoms (and distinct). Dedup by (src, dst).
    let liftable: [&str; 10] = [
        "CALLS", "READS_FROM", "IMPORTS_FROM", "WRITES_TO",
        "PASSES_ARGUMENT", "AWAITS", "RETURNS", "ITERATES_OVER",
        "DEPENDS_ON", "HAS_METHOD",
    ];
    let mut edge_refs: Vec<EdgeRef> = Vec::new();
    let mut seen_pair: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    for etype in &liftable {
        let bulk = engine.get_edges_by_type(etype);
        for e in bulk {
            let s = match atom_id_to_idx.get(&e.src) {
                Some(&i) => i,
                None => continue,
            };
            let d = match atom_id_to_idx.get(&e.dst) {
                Some(&i) => i,
                None => continue,
            };
            if s == d {
                continue;
            }
            if !seen_pair.insert((s, d)) {
                continue;
            }
            edge_refs.push(EdgeRef {
                src_idx: s,
                dst_idx: d,
                edge_type: etype.to_string(),
            });
        }
    }

    // File-aware hierarchy: dir1..dirN where dirN = full file path.
    let mut hierarchy = build_atom_hierarchy(&atoms);
    if hierarchy.is_empty() {
        hierarchy.push(HierarchyLevel::new("file", ContainerRule::FileDir));
    }
    let tree = ContainerTree::build(&hierarchy, &atoms, &edge_refs);

    let mut tstate = tectonic_preprocess(&tree, &atoms, &edge_refs);
    eprintln!("[tectonic] phase0 preprocess: {:.1}ms ({} atoms, {} edges)",
        tstate.metrics.phase0_ms, atoms.len(), edge_refs.len());
    let t_p1 = std::time::Instant::now();
    phase1_place(&mut tstate);
    eprintln!("[tectonic] phase1 place: {:.1}ms", t_p1.elapsed().as_secs_f64() * 1000.0);
    let t_p2 = std::time::Instant::now();
    phase2_flood_fill(&mut tstate);
    eprintln!("[tectonic] phase2 flood_fill: {:.1}ms (overflow {})",
        t_p2.elapsed().as_secs_f64() * 1000.0, tstate.metrics.phase2_overflow_regions);
    phase3_drift(&mut tstate, &DriftConfig::default());
    let t_p4 = std::time::Instant::now();
    phase4_refine_boundaries(&mut tstate, &RefinementConfig::default());
    eprintln!("[tectonic] phase4 refine: {:.1}ms (pass1 {}, pass2 swaps {})",
        t_p4.elapsed().as_secs_f64() * 1000.0,
        tstate.metrics.phase4_pass1_relocations,
        tstate.metrics.phase4_boundary_swaps);

    // Extract per-atom centroids.
    let mut atom_positions: HashMap<u128, HexCoord> = HashMap::new();
    for atom in &atoms {
        if let Some(n) = tstate.tree.nodes.get(atom.idx as usize) {
            if let Some(c) = n.centroid {
                atom_positions.insert(atom.id, c);
            }
        }
    }
    // File-level fallback for non-atom nodes. Determinism: iterate atoms
    // via a sorted view keyed by (file, idx) so the "first atom per file"
    // picked is stable across runs regardless of HashMap ordering.
    let mut by_file: BTreeMap<String, u32> = BTreeMap::new();
    for atom in &atoms {
        by_file
            .entry(atom.file.clone())
            .and_modify(|cur| {
                if atom.idx < *cur {
                    *cur = atom.idx;
                }
            })
            .or_insert(atom.idx);
    }
    let mut file_fallback: HashMap<String, HexCoord> = HashMap::new();
    for (file, idx) in &by_file {
        if let Some(n) = tstate.tree.nodes.get(*idx as usize) {
            if let Some(c) = n.centroid {
                file_fallback.insert(file.clone(), c);
            }
        }
    }

    let cached = CachedLayout {
        atom_positions,
        file_fallback,
        atom_count: atoms.len() as u32,
        phase3_initial_cost: tstate.metrics.phase3_initial_cost,
        phase3_final_cost: tstate.metrics.phase3_final_cost,
        pipeline_ms: t0.elapsed().as_millis(),
    };
    eprintln!(
        "[tectonic] atom-level pipeline: {} atoms, {} edges, {}ms, phase3_cost {} -> {}",
        cached.atom_count, edge_refs.len(), cached.pipeline_ms,
        cached.phase3_initial_cost, cached.phase3_final_cost,
    );
    *guard = Some(cached.clone());
    cached
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

    // Header
    let regions: Vec<serde_json::Value> = tree.containers_at_level(region_level)
        .values()
        .map(|c| serde_json::json!({
            "path": c.id,
            "depth": c.level,
            "tileCount": c.child_count,
        }))
        .collect();

    lines.push(serde_json::to_string(&serde_json::json!({
        "type": "header",
        "typeTable": type_table,
        "edgeTypeTable": edge_type_table,
        "regions": regions,
    })).unwrap());

    // Nodes. Every node inherits its containing file's centroid from
    // the cached file-level layout. Non-MODULE symbols collapse onto
    // the same tile as their file (acceptable for the file-LOD demo).
    let mut missing_centroid_warned = 0usize;
    for nr in &node_refs {
        let ti = type_idx.get(&nr.node_type).copied().unwrap_or(0);
        let region = tree.sa_region(nr.idx).to_string();
        let pos = match cached_layout
            .atom_positions
            .get(&nr.id)
            .or_else(|| cached_layout.file_fallback.get(&nr.file))
        {
            Some(c) => serde_json::json!({ "q": c.q, "r": c.r }),
            None => {
                if missing_centroid_warned < 3 {
                    eprintln!(
                        "[tectonic] WARN: node {} ({}) has no cached centroid (file {})",
                        nr.idx, nr.name, nr.file
                    );
                }
                missing_centroid_warned += 1;
                serde_json::Value::Null
            }
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
        })).unwrap());
    }
    if missing_centroid_warned > 0 {
        eprintln!(
            "[tectonic] WARN: {} leaves missing centroid after pipeline",
            missing_centroid_warned
        );
    }

    lines.push(serde_json::to_string(&serde_json::json!({
        "type": "nodes_done",
        "count": node_count,
    })).unwrap());

    // Edges
    for (i, e) in edge_refs.iter().enumerate() {
        let eti = edge_type_idx.get(&e.edge_type).copied().unwrap_or(0);
        lines.push(serde_json::to_string(&serde_json::json!({
            "type": "edge",
            "s": e.src_idx,
            "d": e.dst_idx,
            "t": eti,
        })).unwrap());
    }

    // Tectonic pipeline summary (Phase G). Clients that don't know this
    // message type ignore it via the unknown-msg fallthrough in loadStream.ts.
    lines.push(serde_json::to_string(&serde_json::json!({
        "type": "tectonic_meta",
        "num_atoms": cached_layout.atom_count,
        "phase3_initial_cost": cached_layout.phase3_initial_cost,
        "phase3_final_cost": cached_layout.phase3_final_cost,
        "pipeline_ms": cached_layout.pipeline_ms,
    })).unwrap());

    let elapsed = start.elapsed().as_millis();
    lines.push(serde_json::to_string(&serde_json::json!({
        "type": "done",
        "nodeCount": node_count,
        "edgeCount": edge_refs.len(),
        "elapsed": elapsed,
    })).unwrap());

    eprintln!("[http] graph-stream: {} nodes, {} edges, {} regions, {}ms (emit: {}ms)",
        node_count, edge_refs.len(), regions.len(), elapsed,
        t_emit.elapsed().as_millis());

    lines.join("\n") + "\n"
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
