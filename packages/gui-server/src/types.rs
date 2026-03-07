use serde::Serialize;
use std::collections::HashMap;

/// Hex cube coordinates (axial: q, r; flat-top orientation)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HexCoord {
    pub q: i32,
    pub r: i32,
}

impl HexCoord {
    pub fn new(q: i32, r: i32) -> Self {
        Self { q, r }
    }

    /// Six neighbors in flat-top hex grid
    pub fn neighbors(self) -> [HexCoord; 6] {
        [
            HexCoord::new(self.q + 1, self.r),
            HexCoord::new(self.q + 1, self.r - 1),
            HexCoord::new(self.q, self.r - 1),
            HexCoord::new(self.q - 1, self.r),
            HexCoord::new(self.q - 1, self.r + 1),
            HexCoord::new(self.q, self.r + 1),
        ]
    }

    /// Cube distance between two hexes
    pub fn distance(self, other: HexCoord) -> i32 {
        let dq = (self.q - other.q).abs();
        let dr = (self.r - other.r).abs();
        let ds = ((self.q + self.r) - (other.q + other.r)).abs();
        (dq + dr + ds) / 2
    }

    /// Convert to world coordinates (flat-top orientation)
    pub fn to_world(self, tile_size: f32) -> (f32, f32) {
        let x = tile_size * (3.0 / 2.0 * self.q as f32);
        let z = tile_size * (3.0_f32.sqrt() / 2.0 * self.q as f32 + 3.0_f32.sqrt() * self.r as f32);
        (x, z)
    }
}

/// A placed tile on the hex grid
#[derive(Debug, Clone)]
pub struct PlacedTile {
    pub node_id: String,
    pub coord: HexCoord,
    pub node_type: String,
    pub name: String,
    pub file: String,
    pub container_idx: u32,
    pub region_idx: u16,
    pub lod_level: u8,
}

/// Region = a group of tiles sharing a common ancestor container
#[derive(Debug, Clone, Serialize)]
pub struct Region {
    pub path: String,
    pub depth: u8,
    pub tile_count: u32,
    pub border: Vec<[f32; 2]>,
    pub center: [f32; 2],
    pub children: Vec<u16>,
    pub hue: f32,
}

/// Aggregated edge between regions
#[derive(Debug, Clone)]
pub struct AggEdge {
    pub src_region: u16,
    pub dst_region: u16,
    pub count: u16,
    pub dominant_type_idx: u8,
}

/// Complete layout result from the placement algorithm
pub struct HexLayout {
    pub tiles: Vec<PlacedTile>,
    pub regions: Vec<Region>,
    pub containers: Vec<ContainerInfo>,
    pub edges: Vec<LayoutEdge>,
    pub agg_edges: Vec<AggEdge>,
    pub type_table: Vec<String>,
    pub edge_type_table: Vec<String>,
    pub tile_size: f32,
    pub max_depth: u8,
    /// Mapping from node_id to tile index
    pub node_to_tile: HashMap<String, u32>,
}

/// An edge in the layout (indices into tiles vec)
#[derive(Debug, Clone)]
pub struct LayoutEdge {
    pub src_idx: u32,
    pub dst_idx: u32,
    pub edge_type_idx: u8,
}

/// A batch for streaming to the client
pub struct StreamBatch {
    pub batch_type: u8,
    pub payload: Vec<u8>,
}

/// Container info for LOD fill rendering
#[derive(Debug, Clone, Serialize)]
pub struct ContainerInfo {
    pub name: String,
    pub container_type: String,
    pub depth: u8,
    pub border: Vec<[f32; 2]>,
    pub center: [f32; 2],
    pub tile_count: u32,
    pub hue: f32,
}

/// Batch type 0: region metadata (JSON)
#[derive(Debug, Serialize)]
pub struct RegionMetaBatch {
    pub regions: Vec<Region>,
    pub containers: Vec<ContainerInfo>,
    pub type_table: Vec<String>,
    pub edge_type_table: Vec<String>,
    pub tile_size: f32,
    pub total_tiles: u32,
    pub total_edges: u32,
    pub max_depth: u8,
    pub agg_edges: Vec<AggEdgeSer>,
}

#[derive(Debug, Serialize)]
pub struct AggEdgeSer {
    pub src: u16,
    pub dst: u16,
    pub count: u16,
    #[serde(rename = "type")]
    pub type_idx: u8,
}
