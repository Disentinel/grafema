mod hex_layout;
mod rfdb_client;
mod types;

use std::collections::HashMap;
use std::sync::Arc;
use axum::{
    Router,
    extract::{Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use tower_http::services::ServeDir;
use tower_http::cors::CorsLayer;
use clap::Parser;
use serde::Deserialize;

use crate::hex_layout::{compute_layout, compute_batches};
use crate::rfdb_client::{RfdbClient, WireNode};
use crate::types::*;

#[derive(Parser)]
#[command(name = "grafema-gui", about = "Hex topology map server")]
struct Args {
    /// Path to RFDB unix socket
    #[arg(short, long, default_value = ".grafema/rfdb.sock")]
    socket: String,

    /// HTTP server port
    #[arg(short, long, default_value = "3333")]
    port: u16,

    /// Path to static files directory
    #[arg(long, default_value = "packages/gui/public")]
    static_dir: String,

    /// Hex tile size
    #[arg(long, default_value = "1.0")]
    tile_size: f32,

    /// Filter nodes to a specific directory prefix (e.g. "packages/api/")
    #[arg(long)]
    filter: Option<String>,
}

struct AppState {
    layout: HexLayout,
    batches: Vec<StreamBatch>,
    wire_nodes: HashMap<String, WireNode>,
    node_count: usize,
    edge_count: usize,
    nodes_by_type: HashMap<String, usize>,
    edges_by_type: HashMap<String, usize>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "grafema_gui=info".parse().unwrap()),
        )
        .init();

    let args = Args::parse();

    tracing::info!("Connecting to RFDB at {}", args.socket);
    let mut client = RfdbClient::connect(&args.socket)?;

    let nc = client.node_count()?;
    let ec = client.edge_count()?;
    tracing::info!("Graph: {} nodes, {} edges", nc, ec);

    if nc == 0 {
        tracing::warn!("Empty graph — run `grafema analyze` first");
    }

    // Compute hex layout
    tracing::info!("Computing hex layout...");
    let layout = compute_layout(&mut client, args.tile_size, args.filter.as_deref())?;
    let batches = compute_batches(&layout);
    tracing::info!("Layout ready: {} tiles, {} batches", layout.tiles.len(), batches.len());

    // Load wire nodes for /api/node detail lookups
    let wire_nodes_vec = client.get_all_nodes()?;
    let wire_nodes: HashMap<String, WireNode> = wire_nodes_vec.into_iter()
        .map(|n| (n.id.clone(), n))
        .collect();

    let nodes_by_type = client.count_nodes_by_type()?;
    let edges_by_type = client.count_edges_by_type()?;

    let state = Arc::new(AppState {
        layout,
        batches,
        wire_nodes,
        node_count: nc,
        edge_count: ec,
        nodes_by_type,
        edges_by_type,
    });

    let app = Router::new()
        .route("/api/stats", get(api_stats))
        .route("/api/hex-stream", get(api_hex_stream))
        .route("/api/hex-batch/{batch_id}", get(api_hex_batch))
        .route("/api/node", get(api_node))
        .fallback_service(ServeDir::new(&args.static_dir))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = format!("0.0.0.0:{}", args.port);
    tracing::info!("Listening on http://localhost:{}", args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ── API Handlers ──────────────────────────────────────────────────

async fn api_stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let stats = serde_json::json!({
        "nodeCount": state.node_count,
        "edgeCount": state.edge_count,
        "tileCount": state.layout.tiles.len(),
        "regionCount": state.layout.regions.len(),
        "batchCount": state.batches.len(),
        "nodesByType": state.nodes_by_type,
        "edgesByType": state.edges_by_type,
    });

    axum::Json(stats)
}

/// Stream all batches as a single chunked response.
/// Wire format: [batchType:u8][batchLen:u32LE][payload...]
async fn api_hex_stream(State(state): State<Arc<AppState>>) -> Response {
    let mut body = Vec::new();

    for batch in &state.batches {
        body.push(batch.batch_type);
        body.extend_from_slice(&(batch.payload.len() as u32).to_le_bytes());
        body.extend_from_slice(&batch.payload);
    }

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    ).into_response()
}

/// Fetch a single batch by index (for retry / lazy loading)
async fn api_hex_batch(
    axum::extract::Path(batch_id): axum::extract::Path<u32>,
    State(state): State<Arc<AppState>>,
) -> Response {
    let idx = batch_id as usize;
    if idx >= state.batches.len() {
        return (StatusCode::NOT_FOUND, "batch not found").into_response();
    }

    let batch = &state.batches[idx];
    let mut body = Vec::new();
    body.push(batch.batch_type);
    body.extend_from_slice(&(batch.payload.len() as u32).to_le_bytes());
    body.extend_from_slice(&batch.payload);

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/octet-stream")],
        body,
    ).into_response()
}

/// Fetch node details by tile index or node id
#[derive(Deserialize)]
struct NodeQuery {
    index: Option<u32>,
    id: Option<String>,
}

async fn api_node(
    Query(query): Query<NodeQuery>,
    State(state): State<Arc<AppState>>,
) -> Response {
    let node_id = if let Some(idx) = query.index {
        if idx as usize >= state.layout.tiles.len() {
            return (StatusCode::NOT_FOUND, "tile index out of range").into_response();
        }
        state.layout.tiles[idx as usize].node_id.clone()
    } else if let Some(ref id_str) = query.id {
        id_str.clone()
    } else {
        return (StatusCode::BAD_REQUEST, "provide index or id").into_response();
    };

    match state.wire_nodes.get(&node_id) {
        Some(wn) => {
            let tile_idx = state.layout.node_to_tile.get(&node_id);
            let mut json = serde_json::json!({
                "id": wn.id,
                "type": wn.node_type,
                "name": wn.name,
                "file": wn.file,
                "exported": wn.exported,
            });
            if let Some(&ti) = tile_idx {
                let tile = &state.layout.tiles[ti as usize];
                json["tileIndex"] = serde_json::json!(ti);
                json["q"] = serde_json::json!(tile.coord.q);
                json["r"] = serde_json::json!(tile.coord.r);
                json["region"] = serde_json::json!(tile.region_idx);
                json["lodLevel"] = serde_json::json!(tile.lod_level);
            }
            if let Some(ref meta) = wn.metadata {
                json["metadata"] = meta.clone();
            }
            axum::Json(json).into_response()
        }
        None => (StatusCode::NOT_FOUND, "node not found").into_response(),
    }
}
