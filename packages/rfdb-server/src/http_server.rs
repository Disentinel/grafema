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
use std::sync::Arc;

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
};
use crate::sa_layout::{SaEngine, LayoutNode, LayoutEdge, SaSnapshot};
use crate::database_manager::DatabaseManager;
use crate::graph::GraphStore;
use crate::storage::AttrQuery;

/// Shared state for all HTTP handlers.
#[derive(Clone)]
pub struct HttpState {
    pub manager: Arc<DatabaseManager>,
}

/// Start the HTTP server on the given port.
pub async fn start(manager: Arc<DatabaseManager>, port: u16) {
    let state = HttpState { manager };

    let app = Router::new()
        .route("/api/graph-stream", get(graph_stream))
        .route("/api/layout-live", get(layout_live_ws))
        .route("/api/stats", get(stats))
        .route("/api/node/{id}", get(node_by_id))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = format!("127.0.0.1:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    eprintln!("[rfdb-server] HTTP server listening on http://{}", addr);

    axum::serve(listener, app).await.unwrap();
}

// ── Query parameters ────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StreamParams {
    packages: Option<String>,
    node_types: Option<String>,
    edge_types: Option<String>,
    max_nodes: Option<usize>,
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

    // Load graph data from RFDB (blocking — graph engine is sync)
    let manager = state.manager.clone();
    let body = tokio::task::spawn_blocking(move || {
        build_graph_stream_body(manager, max_nodes, want_packages, want_node_types, want_edge_types)
    }).await.unwrap();

    Response::builder()
        .header("Content-Type", "application/x-ndjson")
        .header("Cache-Control", "no-cache")
        .body(axum::body::Body::from(body))
        .unwrap()
}

fn build_graph_stream_body(
    manager: Arc<DatabaseManager>,
    max_nodes: usize,
    want_packages: Option<Vec<String>>,
    want_node_types: Option<Vec<String>>,
    want_edge_types: Option<Vec<String>>,
) -> String {
    let start = std::time::Instant::now();
    let db = manager.get_database("default").unwrap();
    let engine = db.engine.read().unwrap();

    // Fetch all nodes, filter by packages/types, up to max_nodes
    let all_ids = engine.find_by_attr(&AttrQuery::default());
    let mut node_refs: Vec<NodeRef> = Vec::new();
    let mut id_to_idx: HashMap<u128, u32> = HashMap::new();
    let mut type_table: Vec<String> = Vec::new();
    let mut type_idx: HashMap<String, usize> = HashMap::new();

    for &nid in &all_ids {
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

    // Build CONTAINS parent map for edge lifting:
    // For nodes NOT in our visible set, find their nearest visible ancestor.
    // This lets us create aggregated edges: if CALL_X -CALLS-> getUser
    // and CALL_X is CONTAINS-child of handleGetUser, we lift to handleGetUser → getUser.
    let all_edges = engine.get_all_edges();

    // Build parent map for edge lifting. Each node maps to its most specific
    // (deepest) parent. Priority: CONTAINS > DECLARES > HAS_SCOPE > HAS_BODY
    // This ensures CALL nodes lift to their enclosing FUNCTION, not MODULE.
    let mut contains_parent: HashMap<u128, u128> = HashMap::new();
    let parent_priority = |etype: &str| -> u8 {
        match etype {
            "CONTAINS" => 4,
            "DECLARES" => 3,
            "HAS_SCOPE" => 2,
            "HAS_BODY" => 1,
            _ => 0,
        }
    };
    let mut parent_prio: HashMap<u128, u8> = HashMap::new();

    for edge in &all_edges {
        let etype = edge.edge_type.as_deref().unwrap_or("");
        let prio = parent_priority(etype);
        if prio == 0 { continue; }

        // Prefer higher priority, or non-MODULE over MODULE for same priority
        let existing_prio = parent_prio.get(&edge.dst).copied().unwrap_or(0);
        let src_is_module = engine.get_node(edge.src)
            .and_then(|n| n.node_type.as_ref().map(|t| t == "MODULE"))
            .unwrap_or(false);

        if prio > existing_prio || (prio == existing_prio && !src_is_module) {
            contains_parent.insert(edge.dst, edge.src);
            parent_prio.insert(edge.dst, prio);
        }
    }

    // Lift a node ID to its nearest visible ancestor (max 10 levels)
    let lift_to_visible = |mut nid: u128| -> Option<u32> {
        for _ in 0..10 {
            if let Some(&idx) = id_to_idx.get(&nid) {
                return Some(idx);
            }
            nid = *contains_parent.get(&nid)?;
        }
        None
    };

    // Fetch edges with lifting
    let mut edge_refs: Vec<EdgeRef> = Vec::new();
    let mut edge_type_table: Vec<String> = Vec::new();
    let mut edge_type_idx: HashMap<String, usize> = HashMap::new();
    let mut seen_edges: std::collections::HashSet<(u32, u32, String)> = std::collections::HashSet::new();

    // Edges to lift: CALLS, READS_FROM, IMPORTS_FROM, WRITES_TO, PASSES_ARGUMENT, AWAITS, RETURNS
    let liftable_types: std::collections::HashSet<&str> = [
        "CALLS", "READS_FROM", "IMPORTS_FROM", "WRITES_TO",
        "PASSES_ARGUMENT", "AWAITS", "RETURNS", "ITERATES_OVER",
    ].into_iter().collect();

    for edge in &all_edges {
        let etype = edge.edge_type.as_deref().unwrap_or("UNKNOWN").to_string();

        if let Some(ref types) = want_edge_types {
            if !types.iter().any(|t| t == &etype) { continue; }
        }

        // Try direct match first
        let si = id_to_idx.get(&edge.src).copied();
        let di = id_to_idx.get(&edge.dst).copied();

        let (final_si, final_di) = if si.is_some() && di.is_some() {
            (si.unwrap(), di.unwrap())
        } else if liftable_types.contains(etype.as_str()) {
            // Lift: find nearest visible ancestor for missing endpoint(s)
            let lifted_si = si.or_else(|| lift_to_visible(edge.src));
            let lifted_di = di.or_else(|| lift_to_visible(edge.dst));
            match (lifted_si, lifted_di) {
                (Some(s), Some(d)) => (s, d),
                _ => continue,
            }
        } else {
            continue;
        };

        // Skip self-loops and structural edges in output
        if final_si == final_di { continue; }

        // Dedup lifted edges
        let edge_key = (final_si, final_di, etype.clone());
        if !seen_edges.insert(edge_key) { continue; }

        let _eti = *edge_type_idx.entry(etype.clone()).or_insert_with(|| {
            let idx = edge_type_table.len();
            edge_type_table.push(etype.clone());
            idx
        });

        edge_refs.push(EdgeRef {
            src_idx: final_si,
            dst_idx: final_di,
            edge_type: etype,
        });
    }

    // Compute degrees
    let mut degrees = vec![0u32; node_count];
    for e in &edge_refs {
        degrees[e.src_idx as usize] += 1;
        degrees[e.dst_idx as usize] += 1;
    }

    // Build container hierarchy
    let hierarchy = default_hierarchy();
    let tree = ContainerTree::build(&hierarchy, &node_refs, &edge_refs);

    // Build JSONL output
    let mut lines: Vec<String> = Vec::new();

    // Header
    let regions: Vec<serde_json::Value> = tree.containers_at_level(tree.sa_region_level)
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

    // Nodes
    for nr in &node_refs {
        let ti = type_idx.get(&nr.node_type).copied().unwrap_or(0);
        let region = tree.sa_region(nr.idx).to_string();
        lines.push(serde_json::to_string(&serde_json::json!({
            "type": "node",
            "i": nr.idx,
            "t": ti,
            "id": nr.id.to_string(),
            "name": nr.name,
            "file": nr.file,
            "region": region,
            "degree": degrees[nr.idx as usize],
        })).unwrap());
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

    let elapsed = start.elapsed().as_millis();
    lines.push(serde_json::to_string(&serde_json::json!({
        "type": "done",
        "nodeCount": node_count,
        "edgeCount": edge_refs.len(),
        "elapsed": elapsed,
    })).unwrap());

    eprintln!("[http] graph-stream: {} nodes, {} edges, {} regions, {}ms",
        node_count, edge_refs.len(), regions.len(), elapsed);

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
