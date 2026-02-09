//! Main GraphEngine implementation with real mmap

use std::path::{Path, PathBuf};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::env;
use std::sync::Mutex;
use std::time::{Instant, Duration};
use sysinfo::{System, RefreshKind, MemoryRefreshKind};
use crate::storage::{NodeRecord, EdgeRecord, AttrQuery, SegmentWriter, GraphMetadata};
use crate::storage::delta::{Delta, DeltaLog};
use crate::storage::segment::{NodesSegment, EdgesSegment};
use crate::error::Result;
use super::{GraphStore, traversal};
use super::index_set::IndexSet;

// Global system info singleton for memory monitoring
static SYSTEM_INFO: Mutex<Option<System>> = Mutex::new(None);

// Debug logging macro - enabled via NAVI_DEBUG=1
macro_rules! debug_log {
    ($($arg:tt)*) => {
        if env::var("NAVI_DEBUG").is_ok() {
            eprintln!("[RUST DEBUG] {}", format!($($arg)*));
        }
    };
}

/// Threshold for automatic flush (number of operations)
/// DISABLED: auto-flush slows down performance with small data volumes
/// Flush only happens on explicit call or database close
/// With 23GB RAM, millions of operations can be held in memory
const AUTO_FLUSH_THRESHOLD: usize = usize::MAX; // Effectively disabled

/// Memory usage threshold for automatic flush (80%)
const MEMORY_THRESHOLD_PERCENT: f32 = 80.0;

/// Checks system memory usage
fn check_memory_usage() -> f32 {
    let mut sys_guard = SYSTEM_INFO.lock().unwrap();
    if sys_guard.is_none() {
        *sys_guard = Some(System::new_with_specifics(
            RefreshKind::new().with_memory(MemoryRefreshKind::everything())
        ));
    }
    
    if let Some(ref mut sys) = *sys_guard {
        sys.refresh_memory();
        let total = sys.total_memory();
        let used = sys.used_memory();
        
        if total > 0 {
            (used as f32 / total as f32) * 100.0
        } else {
            0.0
        }
    } else {
        0.0
    }
}

/// Normalize database path ensuring .rfdb extension
///
/// Examples:
/// - `/path/to/db` -> `/path/to/db.rfdb`
/// - `/path/to/db.db` -> `/path/to/db.rfdb`
/// - `/path/to/db.rfdb` -> `/path/to/db.rfdb` (unchanged)
fn normalize_db_path<P: AsRef<Path>>(path: P) -> PathBuf {
    let path = path.as_ref();

    // If path already has .rfdb extension, return as is
    if path.extension().and_then(|s| s.to_str()) == Some("rfdb") {
        return path.to_path_buf();
    }

    // If there's another extension, replace with .rfdb
    if path.extension().is_some() {
        return path.with_extension("rfdb");
    }

    // If no extension, add .rfdb
    let mut new_path = path.to_path_buf();
    let new_filename = format!(
        "{}.rfdb",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("db")
    );
    new_path.set_file_name(new_filename);
    new_path
}

/// Main graph engine with real mmap + delta log
pub struct GraphEngine {
    path: PathBuf,

    // Immutable segments (mmap)
    nodes_segment: Option<NodesSegment>,
    edges_segment: Option<EdgesSegment>,

    // Delta log for new operations
    delta_log: DeltaLog,

    // In-memory cache for delta log (for fast access)
    delta_nodes: HashMap<u128, NodeRecord>,
    delta_edges: Vec<EdgeRecord>,

    // Adjacency list (built from segments + delta)
    adjacency: HashMap<u128, Vec<usize>>,

    // Reverse adjacency list for backward traversal (dst -> edge indices)
    reverse_adjacency: HashMap<u128, Vec<usize>>,

    // Metadata
    metadata: GraphMetadata,

    // Operation counter for auto-flush
    pub ops_since_flush: usize,

    // Timer for last memory check
    last_memory_check: Option<Instant>,

    // Track IDs deleted from segment (not in delta_nodes)
    // When a node in segment is deleted but not in delta_nodes,
    // we track it here until next flush
    deleted_segment_ids: HashSet<u128>,

    // Secondary indexes over segment data (rebuilt on open/flush)
    index_set: IndexSet,
}

impl GraphEngine {
    /// Create a new empty graph
    pub fn create<P: AsRef<Path>>(path: P) -> Result<Self> {
        let path = normalize_db_path(path);
        fs::create_dir_all(&path)?;

        debug_log!("GraphEngine::create() - path: {:?}", path);
        tracing::info!("Created new graph at {:?}", path);

        Ok(Self {
            path,
            nodes_segment: None,
            edges_segment: None,
            delta_log: DeltaLog::new(),
            delta_nodes: HashMap::new(),
            delta_edges: Vec::new(),
            adjacency: HashMap::new(),
            reverse_adjacency: HashMap::new(),
            metadata: GraphMetadata::default(),
            ops_since_flush: 0,
            last_memory_check: None,
            deleted_segment_ids: HashSet::new(),
            index_set: IndexSet::new(),
        })
    }

    /// Create an ephemeral (in-memory only) database
    ///
    /// Ephemeral databases store all data in memory and never write to disk.
    /// They are ideal for testing scenarios where you want complete isolation
    /// between tests without any disk I/O overhead.
    ///
    /// # Example
    /// ```no_run
    /// use rfdb::GraphEngine;
    ///
    /// let engine = GraphEngine::create_ephemeral().unwrap();
    /// // Use engine normally - all data stays in memory
    /// // When engine drops, all data is lost
    /// ```
    pub fn create_ephemeral() -> Result<Self> {
        // Use a unique temp path for identification (never actually created)
        let temp_path = std::env::temp_dir()
            .join(format!("rfdb-ephemeral-{}", std::process::id()))
            .join(format!("{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()));

        debug_log!("GraphEngine::create_ephemeral() - path: {:?}", temp_path);

        Ok(Self {
            path: temp_path,
            nodes_segment: None,
            edges_segment: None,
            delta_log: DeltaLog::new(),
            delta_nodes: HashMap::new(),
            delta_edges: Vec::new(),
            adjacency: HashMap::new(),
            reverse_adjacency: HashMap::new(),
            metadata: GraphMetadata::default(),
            ops_since_flush: 0,
            last_memory_check: None,
            deleted_segment_ids: HashSet::new(),
            index_set: IndexSet::new(),
        })
    }

    /// Check if this is an ephemeral (in-memory only) database
    pub fn is_ephemeral(&self) -> bool {
        self.path.to_string_lossy().contains("rfdb-ephemeral")
    }

    /// Open an existing graph
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let path = normalize_db_path(path);
        debug_log!("GraphEngine::open() - path: {:?}", path);

        // Load mmap segments if they exist
        let nodes_path = path.join("nodes.bin");
        let edges_path = path.join("edges.bin");

        let nodes_segment = if nodes_path.exists() {
            debug_log!("  Loading nodes segment from {:?}", nodes_path);
            Some(NodesSegment::open(&nodes_path)?)
        } else {
            debug_log!("  No nodes segment found");
            None
        };

        let edges_segment = if edges_path.exists() {
            debug_log!("  Loading edges segment from {:?}", edges_path);
            Some(EdgesSegment::open(&edges_path)?)
        } else {
            debug_log!("  No edges segment found");
            None
        };

        // Load metadata
        let meta_path = path.join("metadata.json");
        let metadata = if meta_path.exists() {
            let file = fs::File::open(meta_path)?;
            serde_json::from_reader(file).unwrap_or_default()
        } else {
            GraphMetadata::default()
        };

        // Build adjacency and reverse_adjacency lists from segments
        let mut adjacency = HashMap::new();
        let mut reverse_adjacency = HashMap::new();
        if let Some(ref edges_seg) = edges_segment {
            for idx in 0..edges_seg.edge_count() {
                if edges_seg.is_deleted(idx) {
                    continue;
                }
                if let Some(src) = edges_seg.get_src(idx) {
                    adjacency.entry(src).or_insert_with(Vec::new).push(idx);
                }
                if let Some(dst) = edges_seg.get_dst(idx) {
                    reverse_adjacency.entry(dst).or_insert_with(Vec::new).push(idx);
                }
            }
        }

        // Build ID index from nodes segment
        let mut index_set = IndexSet::new();
        if let Some(ref nodes_seg) = nodes_segment {
            index_set.rebuild_from_segment(nodes_seg);
        }

        tracing::info!(
            "Opened graph at {:?}: {} nodes, {} edges",
            path,
            nodes_segment.as_ref().map_or(0, |s| s.node_count()),
            edges_segment.as_ref().map_or(0, |s| s.edge_count())
        );

        Ok(Self {
            path,
            nodes_segment,
            edges_segment,
            delta_log: DeltaLog::new(),
            delta_nodes: HashMap::new(),
            delta_edges: Vec::new(),
            adjacency,
            reverse_adjacency,
            metadata,
            ops_since_flush: 0,
            last_memory_check: None,
            deleted_segment_ids: HashSet::new(),
            index_set,
        })
    }

    /// Apply delta to current state
    fn apply_delta(&mut self, delta: &Delta) {
        match delta {
            Delta::AddNode(node) => {
                debug_log!("apply_delta (engine={:p}): AddNode id={}, type={:?}, name={:?}, delta_nodes before: {}",
                    self, node.id, node.node_type, node.name, self.delta_nodes.len());
                self.delta_nodes.insert(node.id, node.clone());
                debug_log!("  delta_nodes after: {}", self.delta_nodes.len());
            }
            Delta::DeleteNode { id } => {
                if let Some(node) = self.delta_nodes.get_mut(id) {
                    node.deleted = true;
                } else {
                    // Node is in segment (already flushed), track it for deletion
                    self.deleted_segment_ids.insert(*id);
                }
            }
            Delta::AddEdge(edge) => {
                let edge_idx = self.delta_edges.len();
                self.delta_edges.push(edge.clone());

                // Calculate the global edge index (segment + delta)
                let global_idx = edge_idx + self.edges_segment.as_ref().map_or(0, |s| s.edge_count());

                // Update forward adjacency list
                self.adjacency
                    .entry(edge.src)
                    .or_insert_with(Vec::new)
                    .push(global_idx);

                // Update reverse adjacency list
                self.reverse_adjacency
                    .entry(edge.dst)
                    .or_insert_with(Vec::new)
                    .push(global_idx);
            }
            Delta::DeleteEdge { src, dst, edge_type } => {
                for edge in &mut self.delta_edges {
                    let matches = edge.src == *src && edge.dst == *dst &&
                        edge.edge_type.as_deref() == Some(edge_type.as_str());
                    if matches {
                        edge.deleted = true;
                    }
                }
            }
            Delta::UpdateNodeVersion { id, version } => {
                if let Some(node) = self.delta_nodes.get_mut(id) {
                    node.version = version.clone();
                }
            }
        }
    }

    /// Get node (from segment or delta)
    fn get_node_internal(&self, id: u128) -> Option<NodeRecord> {
        // First check delta
        if let Some(node) = self.delta_nodes.get(&id) {
            if !node.deleted {
                return Some(node.clone());
            }
            // If deleted in delta, return None
            return None;
        }

        // Check if deleted from segment
        if self.deleted_segment_ids.contains(&id) {
            return None;
        }

        // Then look in segment via index (O(1) instead of O(n) linear scan)
        if let Some(ref segment) = self.nodes_segment {
            if let Some(idx) = self.index_set.find_node_index(id) {
                if !segment.is_deleted(idx) {
                    // Reconstruct NodeRecord from segment
                    return Some(NodeRecord {
                        id: segment.get_id(idx)?,
                        node_type: segment.get_node_type(idx).map(|s| s.to_string()),
                        file_id: segment.get_file_id(idx).unwrap_or(0),
                        name_offset: segment.get_name_offset(idx).unwrap_or(0),
                        version: segment.get_version(idx).unwrap_or("main").to_string(),
                        exported: segment.get_exported(idx).unwrap_or(false),
                        replaces: None,
                        deleted: false,
                        name: segment.get_name(idx).map(|s| s.to_string()),
                        file: segment.get_file_path(idx).map(|s| s.to_string()),
                        metadata: segment.get_metadata(idx).map(|s| s.to_string()),
                    });
                }
            }
        }

        None
    }

    /// Clear all data (delta and segments)
    pub fn clear(&mut self) {
        self.delta_log.clear();
        self.delta_nodes.clear();
        self.delta_edges.clear();
        self.adjacency.clear();
        self.reverse_adjacency.clear();
        self.nodes_segment = None;
        self.edges_segment = None;
        self.metadata = GraphMetadata::default();
        self.ops_since_flush = 0;
        self.deleted_segment_ids.clear();
        self.index_set.clear();
        tracing::info!("Graph cleared");
    }

    /// Check if a node is an endpoint (for PathValidator)
    pub fn is_endpoint(&self, id: u128) -> bool {
        if let Some(node) = self.get_node_internal(id) {
            let node_type = node.node_type.as_deref().unwrap_or("UNKNOWN");

            // Endpoint types: db:query, http:request, http:endpoint, EXTERNAL, fs:operation, SIDE_EFFECT
            if matches!(node_type,
                "db:query" | "http:request" | "http:endpoint" |
                "EXTERNAL" | "fs:operation" | "SIDE_EFFECT"
            ) {
                return true;
            }

            // Exported FUNCTION
            if node_type == "FUNCTION" && node.exported {
                return true;
            }
        }
        false
    }

    /// Version-aware operations
    pub fn get_nodes_by_version(&self, version: &str) -> Vec<u128> {
        let mut result = Vec::new();

        // From delta
        for (id, node) in &self.delta_nodes {
            if node.version == version && !node.deleted {
                result.push(*id);
            }
        }

        // TODO: from segment (when we add version to segment)

        result
    }

    pub fn delete_version(&mut self, version: &str) {
        for (_, node) in self.delta_nodes.iter_mut() {
            if node.version == version {
                node.deleted = true;
            }
        }

        for edge in &mut self.delta_edges {
            if edge.version == version {
                edge.deleted = true;
            }
        }
    }

    /// Автоматический flush если достигнут порог операций или памяти
    fn maybe_auto_flush(&mut self) {
        // Проверка по количеству операций (отключена)
        if self.ops_since_flush >= AUTO_FLUSH_THRESHOLD {
            debug_log!("Auto-flush triggered: {} ops >= threshold {}", self.ops_since_flush, AUTO_FLUSH_THRESHOLD);
            if let Err(e) = self.flush() {
                tracing::error!("Auto-flush failed: {}", e);
            }
            return;
        }
        
        // Проверка памяти не чаще раза в 5 секунд
        let now = Instant::now();
        let should_check = match self.last_memory_check {
            None => true,
            Some(last) => now.duration_since(last) >= Duration::from_secs(5),
        };
        
        if should_check {
            self.last_memory_check = Some(now);
            let mem_usage = check_memory_usage();
            
            if mem_usage >= MEMORY_THRESHOLD_PERCENT {
                eprintln!("[RUST MEMORY FLUSH] Memory usage: {:.1}% >= {:.1}%, flushing {} operations", 
                         mem_usage, MEMORY_THRESHOLD_PERCENT, self.ops_since_flush);
                if let Err(e) = self.flush() {
                    tracing::error!("Memory-triggered flush failed: {}", e);
                }
            }
        }
    }

    pub fn promote_local_to_main(&mut self) {
        // Удалить old main ноды которые заменены
        let to_delete: Vec<u128> = self
            .delta_nodes
            .iter()
            .filter(|(_, n)| n.version == "__local" && n.replaces.is_some())
            .filter_map(|(_, n)| n.replaces)
            .collect();

        for id in to_delete {
            if let Some(node) = self.delta_nodes.get_mut(&id) {
                node.deleted = true;
            }
        }

        // Промотировать __local -> main
        for (_, node) in self.delta_nodes.iter_mut() {
            if node.version == "__local" {
                node.version = "main".to_string();
                node.replaces = None;
            }
        }

        // Обновить версии рёбер
        for edge in &mut self.delta_edges {
            if edge.version == "__local" {
                edge.version = "main".to_string();
            }
        }
    }

    /// Получить строковые атрибуты ноды (file_path, name) из segment
    pub fn get_node_strings(&self, id: u128) -> Option<(Option<String>, Option<String>)> {
        // First check delta (новые ноды)
        if let Some(node) = self.delta_nodes.get(&id) {
            if !node.deleted {
                return Some((node.file.clone(), node.name.clone()));
            }
        }

        // Then check segment via index (O(1))
        if let Some(ref segment) = self.nodes_segment {
            if let Some(idx) = self.index_set.find_node_index(id) {
                let file_path = segment.get_file_path(idx)
                    .map(|s| if s.is_empty() { None } else { Some(s.to_string()) })
                    .unwrap_or(None);

                let name = segment.get_name(idx)
                    .map(|s| if s.is_empty() { None } else { Some(s.to_string()) })
                    .unwrap_or(None);

                return Some((file_path, name));
            }
        }
        Some((None, None))
    }

    /// Получить строковые атрибуты ноды (file, name, metadata)
    pub fn get_node_strings_with_metadata(&self, id: u128) -> Option<(Option<String>, Option<String>, Option<String>)> {
        // First check delta (новые ноды)
        if let Some(node) = self.delta_nodes.get(&id) {
            if !node.deleted {
                return Some((node.file.clone(), node.name.clone(), node.metadata.clone()));
            }
        }

        // Then check segment via index (O(1))
        if let Some(ref segment) = self.nodes_segment {
            if let Some(idx) = self.index_set.find_node_index(id) {
                let file_path = segment.get_file_path(idx)
                    .map(|s| if s.is_empty() { None } else { Some(s.to_string()) })
                    .unwrap_or(None);

                let name = segment.get_name(idx)
                    .map(|s| if s.is_empty() { None } else { Some(s.to_string()) })
                    .unwrap_or(None);

                let metadata = segment.get_metadata(idx)
                    .map(|s| if s.is_empty() { None } else { Some(s.to_string()) })
                    .unwrap_or(None);

                return Some((file_path, name, metadata));
            }
        }
        Some((None, None, None))
    }

    /// Get reverse neighbors (sources of incoming edges) for a node
    /// Returns node IDs that have edges pointing TO this node
    /// O(degree) complexity using reverse_adjacency
    pub fn reverse_neighbors(&self, id: u128, edge_types: &[&str]) -> Vec<u128> {
        let mut result = Vec::new();
        let segment_edge_count = self.edges_segment.as_ref().map_or(0, |s| s.edge_count());

        // From segment edges via reverse_adjacency
        if let Some(ref edges_seg) = self.edges_segment {
            if let Some(edge_indices) = self.reverse_adjacency.get(&id) {
                for &idx in edge_indices {
                    // Only process segment edges (idx < segment_edge_count)
                    if idx >= segment_edge_count {
                        continue;
                    }
                    if edges_seg.is_deleted(idx) {
                        continue;
                    }
                    if let Some(src) = edges_seg.get_src(idx) {
                        let edge_type = edges_seg.get_edge_type(idx);
                        if edge_types.is_empty() || edge_type.map_or(false, |et| edge_types.contains(&et)) {
                            result.push(src);
                        }
                    }
                }
            }
        }

        // From delta edges via reverse_adjacency
        if let Some(edge_indices) = self.reverse_adjacency.get(&id) {
            for &idx in edge_indices {
                // Only process delta edges (idx >= segment_edge_count)
                if idx < segment_edge_count {
                    continue;
                }
                let delta_idx = idx - segment_edge_count;
                if delta_idx < self.delta_edges.len() {
                    let edge = &self.delta_edges[delta_idx];
                    if edge.deleted || edge.dst != id {
                        continue;
                    }
                    let matches = edge_types.is_empty() ||
                        edge.edge_type.as_deref().map_or(false, |et| edge_types.contains(&et));
                    if matches {
                        result.push(edge.src);
                    }
                }
            }
        }

        result
    }

    /// Transitive reachability query using BFS
    /// Returns all nodes reachable from start nodes within max_depth
    /// If backward=true, traverses edges in reverse direction (find sources)
    pub fn reachability(&self, start: &[u128], max_depth: usize, edge_types: &[&str], backward: bool) -> Vec<u128> {
        if backward {
            traversal::bfs(start, max_depth, |node_id| {
                self.reverse_neighbors(node_id, edge_types)
            })
        } else {
            traversal::bfs(start, max_depth, |node_id| {
                self.neighbors(node_id, edge_types)
            })
        }
    }
}

impl GraphStore for GraphEngine {
    fn add_nodes(&mut self, nodes: Vec<NodeRecord>) {
        let count = nodes.len();
        for node in nodes {
            self.delta_log.push(Delta::AddNode(node.clone()));
            self.apply_delta(&Delta::AddNode(node));
        }
        self.ops_since_flush += count;
        self.maybe_auto_flush();
    }

    fn delete_node(&mut self, id: u128) {
        self.delta_log.push(Delta::DeleteNode { id });
        self.apply_delta(&Delta::DeleteNode { id });
    }

    fn get_node(&self, id: u128) -> Option<NodeRecord> {
        self.get_node_internal(id)
    }

    fn node_exists(&self, id: u128) -> bool {
        self.get_node_internal(id).is_some()
    }

    /// Получить readable identifier для ноды (TYPE:name@file)
    ///
    /// Формат:
    /// - FUNCTION: "FUNCTION:functionName@path/to/file.js"
    /// - CLASS: "CLASS:ClassName@path/to/file.js"
    /// - MODULE: "MODULE:path/to/file.js"
    /// - SERVICE: "SERVICE:serviceName"
    fn get_node_identifier(&self, id: u128) -> Option<String> {
        let node = self.get_node_internal(id)?;

        // Получить имя типа напрямую из node_type (теперь это строка)
        let type_name = node.node_type.as_deref().unwrap_or("UNKNOWN");

        // Получить file_path и name из node или segment
        let (file_path, name) = if node.file.is_some() || node.name.is_some() {
            (
                node.file.as_deref().unwrap_or("").to_string(),
                node.name.as_deref().unwrap_or("").to_string()
            )
        } else if let Some(ref segment) = self.nodes_segment {
            if let Some(idx) = self.index_set.find_node_index(id) {
                let fp = segment.get_file_path(idx).unwrap_or("");
                let n = segment.get_name(idx).unwrap_or("");
                (fp.to_string(), n.to_string())
            } else {
                (String::new(), String::new())
            }
        } else {
            (String::new(), String::new())
        };

        // Формат в зависимости от типа
        let identifier = if !name.is_empty() && !file_path.is_empty() {
            format!("{}:{}@{}", type_name, name, file_path)
        } else if !file_path.is_empty() {
            format!("{}:{}", type_name, file_path)
        } else if !name.is_empty() {
            format!("{}:{}", type_name, name)
        } else {
            format!("{}:{}", type_name, id)
        };

        Some(identifier)
    }

    fn find_by_attr(&self, query: &AttrQuery) -> Vec<u128> {
        // Reduced logging - only log summary, not every node
        let mut result = Vec::new();

        // Проверка wildcard в node_type (e.g., "http:*")
        let (type_prefix, is_wildcard) = if let Some(ref t) = query.node_type {
            if t.ends_with('*') {
                (Some(t.trim_end_matches('*').to_string()), true)
            } else {
                (Some(t.clone()), false)
            }
        } else {
            (None, false)
        };

        // Поиск в delta
        for (&id, node) in &self.delta_nodes {
            if node.deleted {
                continue;
            }

            let version_match = query.version.as_ref().map_or(true, |v| &node.version == v);
            let type_match = match (&type_prefix, is_wildcard) {
                (Some(prefix), true) => node.node_type.as_ref().map_or(false, |t| t.starts_with(prefix)),
                (Some(exact), false) => node.node_type.as_ref().map_or(false, |t| t == exact),
                (None, _) => true,
            };
            let file_id_match = query.file_id.map_or(true, |f| node.file_id == f);
            // File path match (alternative to file_id)
            let file_path_match = query.file.as_ref().map_or(true, |f| {
                node.file.as_ref().map_or(false, |node_file| node_file == f)
            });
            let exported_match = query.exported.map_or(true, |e| node.exported == e);
            let name_match = query.name.as_ref().map_or(true, |n| node.name.as_ref().map_or(false, |node_name| node_name == n));

            let matches = version_match && type_match && file_id_match && file_path_match && exported_match && name_match;

            if matches {
                result.push(id);
            }
        }

        let delta_count = result.len();

        // Поиск в segment (после flush)
        // Segment теперь хранит все поля включая version и exported
        if let Some(ref segment) = self.nodes_segment {
            for idx in segment.iter_indices() {
                if segment.is_deleted(idx) {
                    continue;
                }

                let Some(id) = segment.get_id(idx) else { continue };

                // Пропустить если уже есть в delta (приоритет delta)
                if self.delta_nodes.contains_key(&id) {
                    continue;
                }

                // Пропустить если удалён (tracked in deleted_segment_ids)
                if self.deleted_segment_ids.contains(&id) {
                    continue;
                }

                // Проверка node_type с поддержкой wildcard
                let type_match = match (&type_prefix, is_wildcard) {
                    (Some(prefix), true) => segment.get_node_type(idx).map_or(false, |t| t.starts_with(prefix)),
                    (Some(exact), false) => segment.get_node_type(idx).map_or(false, |t| t == exact),
                    (None, _) => true,
                };
                if !type_match {
                    continue;
                }

                let file_id_match = query.file_id.map_or(true, |f| {
                    segment.get_file_id(idx).map_or(false, |fid| fid == f)
                });
                if !file_id_match {
                    continue;
                }

                // File path match (alternative to file_id)
                let file_path_match = query.file.as_ref().map_or(true, |f| {
                    segment.get_file_path(idx).map_or(false, |path| path == f)
                });
                if !file_path_match {
                    continue;
                }

                let name_match = query.name.as_ref().map_or(true, |n| {
                    segment.get_name(idx).map_or(false, |name| name == n)
                });
                if !name_match {
                    continue;
                }

                // Проверка version
                let version_match = query.version.as_ref().map_or(true, |v| {
                    segment.get_version(idx).map_or(false, |ver| ver == v)
                });
                if !version_match {
                    continue;
                }

                // Проверка exported
                let exported_match = query.exported.map_or(true, |e| {
                    segment.get_exported(idx).map_or(false, |exp| exp == e)
                });
                if !exported_match {
                    continue;
                }

                result.push(id);
            }
        }

        // Log summary only (not every node)
        debug_log!("find_by_attr: node_type={:?} -> {} results ({} from delta, {} from segment)",
            query.node_type, result.len(), delta_count, result.len() - delta_count);

        result
    }

    fn find_by_type(&self, node_type: &str) -> Vec<u128> {
        // Используем find_by_attr с поддержкой wildcard
        let query = AttrQuery::new().node_type(node_type.to_string());
        self.find_by_attr(&query)
    }

    fn add_edges(&mut self, edges: Vec<EdgeRecord>, skip_validation: bool) {
        let mut added = 0;
        for edge in edges {
            // Валидация: проверяем что обе ноды существуют (если не отключена)
            if !skip_validation {
                if !self.node_exists(edge.src) {
                    tracing::warn!("Edge src node not found: {}", edge.src);
                    continue;
                }
                if !self.node_exists(edge.dst) {
                    tracing::warn!("Edge dst node not found: {}", edge.dst);
                    continue;
                }
            }

            self.delta_log.push(Delta::AddEdge(edge.clone()));
            self.apply_delta(&Delta::AddEdge(edge));
            added += 1;
        }
        self.ops_since_flush += added;
        self.maybe_auto_flush();
    }

    fn delete_edge(&mut self, src: u128, dst: u128, edge_type: &str) {
        let delta = Delta::DeleteEdge { src, dst, edge_type: edge_type.to_string() };
        self.delta_log.push(delta.clone());
        self.apply_delta(&delta);
    }

    fn neighbors(&self, id: u128, edge_types: &[&str]) -> Vec<u128> {
        let mut result = Vec::new();

        // Из segment edges
        if let Some(ref edges_seg) = self.edges_segment {
            if let Some(edge_indices) = self.adjacency.get(&id) {
                for &idx in edge_indices {
                    if idx < edges_seg.edge_count() {
                        if let (Some(dst), false) = (
                            edges_seg.get_dst(idx),
                            edges_seg.is_deleted(idx),
                        ) {
                            let edge_type = edges_seg.get_edge_type(idx);
                            if edge_types.is_empty() || edge_type.map_or(false, |et| edge_types.contains(&et)) {
                                result.push(dst);
                            }
                        }
                    }
                }
            }
        }

        // From delta edges
        for edge in &self.delta_edges {
            if edge.src == id && !edge.deleted {
                let matches = edge_types.is_empty() ||
                    edge.edge_type.as_deref().map_or(false, |et| edge_types.contains(&et));
                if matches {
                    result.push(edge.dst);
                }
            }
        }

        result
    }

    fn bfs(&self, start: &[u128], max_depth: usize, edge_types: &[&str]) -> Vec<u128> {
        traversal::bfs(start, max_depth, |node_id| {
            self.neighbors(node_id, edge_types)
        })
    }

    fn flush(&mut self) -> Result<()> {
        if self.delta_log.is_empty() {
            return Ok(());
        }

        // Ephemeral databases don't write to disk - just clear the log
        if self.is_ephemeral() {
            self.delta_log.clear();
            return Ok(());
        }

        eprintln!("[RUST FLUSH] Flushing {} operations to disk", self.delta_log.len());
        eprintln!("[RUST FLUSH] Delta has {} nodes before flush", self.delta_nodes.len());

        // Собираем все ноды (segment + delta)
        let mut all_nodes = Vec::new();

        // Из segment
        // Из segment - сохраняем строки чтобы они не потерялись
        if let Some(ref segment) = self.nodes_segment {
            for idx in segment.iter_indices() {
                if !segment.is_deleted(idx) {
                    if let Some(id) = segment.get_id(idx) {
                        // Skip nodes that were deleted (tracked in deleted_segment_ids)
                        if self.deleted_segment_ids.contains(&id) {
                            continue;
                        }

                        // Читаем строковые данные из StringTable если есть
                        let node_type = segment.get_node_type(idx).map(|s| s.to_string());
                        let name = segment.get_name(idx).map(|s| s.to_string());
                        let file = segment.get_file_path(idx).map(|s| s.to_string());
                        let metadata = segment.get_metadata(idx).map(|s| s.to_string());
                        let version = segment.get_version(idx).unwrap_or("main");
                        let exported = segment.get_exported(idx).unwrap_or(false);

                        all_nodes.push(NodeRecord {
                            id,
                            node_type,
                            file_id: 0, // Будет пересчитано в writer
                            name_offset: 0, // Будет пересчитано в writer
                            version: version.to_string(),
                            exported,
                            replaces: None,
                            deleted: false,
                            name,
                            file,
                            metadata,
                        });
                    }
                }
            }
        }

        let nodes_from_segment = all_nodes.len();
        eprintln!("[RUST FLUSH] Collected {} nodes from segment", nodes_from_segment);

        // From delta
        let mut seen_ids = std::collections::HashSet::new();
        for node in &all_nodes {
            seen_ids.insert(node.id);
        }

        let mut delta_added = 0;
        let mut delta_duplicates = 0;
        for node in self.delta_nodes.values() {
            if !node.deleted {
                if seen_ids.contains(&node.id) {
                    eprintln!("[RUST FLUSH] !!! Duplicate ID {} in flush - delta overwrites segment", node.id);
                    delta_duplicates += 1;
                }
                all_nodes.push(node.clone());
                delta_added += 1;
            }
        }

        eprintln!("[RUST FLUSH] Added {} nodes from delta ({} duplicates)", delta_added, delta_duplicates);
        eprintln!("[RUST FLUSH] Total nodes to write: {}", all_nodes.len());

        // Собираем все рёбра
        let mut all_edges = Vec::new();

        // Из segment
        if let Some(ref segment) = self.edges_segment {
            for idx in 0..segment.edge_count() {
                if !segment.is_deleted(idx) {
                    if let (Some(src), Some(dst)) = (
                        segment.get_src(idx),
                        segment.get_dst(idx),
                    ) {
                        let edge_type = segment.get_edge_type(idx).map(|s| s.to_string());
                        let metadata = segment.get_metadata(idx).map(|s| s.to_string());
                        all_edges.push(EdgeRecord {
                            src,
                            dst,
                            edge_type,
                            version: "main".to_string(),
                            metadata,
                            deleted: false,
                        });
                    }
                }
            }
        }

        // From delta
        for edge in &self.delta_edges {
            if !edge.deleted {
                all_edges.push(edge.clone());
            }
        }

        // Закрываем старые segments перед перезаписью
        self.nodes_segment = None;
        self.edges_segment = None;

        // Debug: count nodes with metadata containing "isClassMethod"
        let class_methods = all_nodes.iter().filter(|n| {
            n.metadata.as_ref().map_or(false, |m| m.contains("isClassMethod"))
        }).count();
        eprintln!("[RUST FLUSH] Nodes with isClassMethod metadata: {}", class_methods);

        // Записываем на диск
        let writer = SegmentWriter::new(&self.path);
        writer.write_nodes(&all_nodes)?;
        writer.write_edges(&all_edges)?;

        // Обновляем metadata
        self.metadata.node_count = all_nodes.len();
        self.metadata.edge_count = all_edges.len();
        self.metadata.updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        writer.write_metadata(&self.metadata)?;

        // Очищаем delta log и deleted_segment_ids (nodes are now written to new segment)
        self.delta_log.clear();
        self.delta_nodes.clear();
        self.delta_edges.clear();
        self.deleted_segment_ids.clear();

        // Перезагружаем segments
        self.nodes_segment = Some(NodesSegment::open(&self.path.join("nodes.bin"))?);
        self.edges_segment = Some(EdgesSegment::open(&self.path.join("edges.bin"))?);

        // Rebuild ID index from new segment
        self.index_set.clear();
        if let Some(ref nodes_seg) = self.nodes_segment {
            self.index_set.rebuild_from_segment(nodes_seg);
        }

        // Rebuild adjacency and reverse_adjacency
        self.adjacency.clear();
        self.reverse_adjacency.clear();
        if let Some(ref edges_seg) = self.edges_segment {
            for idx in 0..edges_seg.edge_count() {
                if edges_seg.is_deleted(idx) {
                    continue;
                }
                if let Some(src) = edges_seg.get_src(idx) {
                    self.adjacency.entry(src).or_insert_with(Vec::new).push(idx);
                }
                if let Some(dst) = edges_seg.get_dst(idx) {
                    self.reverse_adjacency.entry(dst).or_insert_with(Vec::new).push(idx);
                }
            }
        }

        tracing::info!("Flush complete: {} nodes, {} edges", all_nodes.len(), all_edges.len());

        // Сбросить счётчик операций
        self.ops_since_flush = 0;

        Ok(())
    }

    fn compact(&mut self) -> Result<()> {
        tracing::info!("Compacting graph...");
        // Compaction = flush в данной реализации
        self.flush()
    }

    fn node_count(&self) -> usize {
        self.nodes_segment.as_ref().map_or(0, |s| s.node_count()) + self.delta_nodes.len()
    }

    fn edge_count(&self) -> usize {
        self.edges_segment.as_ref().map_or(0, |s| s.edge_count()) + self.delta_edges.len()
    }

    /// Get all outgoing edges from a node
    /// Returns Vec<EdgeRecord> with edges where src == node_id
    fn get_outgoing_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecord> {
        let start = std::time::Instant::now();
        let mut result = Vec::new();

        // From delta_edges
        for edge in &self.delta_edges {
            if edge.deleted || edge.src != node_id {
                continue;
            }

            // Filter by edge type if specified
            if let Some(types) = edge_types {
                if !edge.edge_type.as_deref().map_or(false, |et| types.contains(&et)) {
                    continue;
                }
            }

            result.push(edge.clone());
        }

        // From edges_segment using adjacency list
        if let Some(edge_indices) = self.adjacency.get(&node_id) {
            if let Some(ref edges_seg) = self.edges_segment {
                for &idx in edge_indices {
                    if edges_seg.is_deleted(idx) {
                        continue;
                    }

                    if let (Some(src), Some(dst)) = (
                        edges_seg.get_src(idx),
                        edges_seg.get_dst(idx),
                    ) {
                        let edge_type = edges_seg.get_edge_type(idx);

                        // Filter by edge type if specified
                        if let Some(types) = edge_types {
                            if !edge_type.map_or(false, |et| types.contains(&et)) {
                                continue;
                            }
                        }

                        let metadata = edges_seg.get_metadata(idx);
                        result.push(EdgeRecord {
                            src,
                            dst,
                            edge_type: edge_type.map(|s| s.to_string()),
                            version: "main".to_string(), // TODO: Store version in segment
                            metadata: metadata.map(|s| s.to_string()),
                            deleted: false,
                        });
                    }
                }
            }
        }

        let elapsed = start.elapsed();
        if elapsed.as_millis() > 50 {
            eprintln!("[RUST SLOW] get_outgoing_edges: {}ms, found {} edges", 
                     elapsed.as_millis(), result.len());
        }

        result
    }

    /// Get all incoming edges to a node
    /// Returns Vec<EdgeRecord> with edges where dst == node_id
    /// O(degree) complexity using reverse_adjacency
    fn get_incoming_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecord> {
        let mut result = Vec::new();
        let segment_edge_count = self.edges_segment.as_ref().map_or(0, |s| s.edge_count());

        // Use reverse_adjacency for O(degree) lookup
        if let Some(edge_indices) = self.reverse_adjacency.get(&node_id) {
            for &idx in edge_indices {
                if idx < segment_edge_count {
                    // Edge is in segment
                    if let Some(ref edges_seg) = self.edges_segment {
                        if edges_seg.is_deleted(idx) {
                            continue;
                        }

                        if let (Some(src), Some(dst)) = (
                            edges_seg.get_src(idx),
                            edges_seg.get_dst(idx),
                        ) {
                            let edge_type = edges_seg.get_edge_type(idx);

                            // Filter by edge type if specified
                            if let Some(types) = edge_types {
                                if !edge_type.map_or(false, |et| types.contains(&et)) {
                                    continue;
                                }
                            }

                            let metadata = edges_seg.get_metadata(idx);
                            result.push(EdgeRecord {
                                src,
                                dst,
                                edge_type: edge_type.map(|s| s.to_string()),
                                version: "main".to_string(),
                                metadata: metadata.map(|s| s.to_string()),
                                deleted: false,
                            });
                        }
                    }
                } else {
                    // Edge is in delta
                    let delta_idx = idx - segment_edge_count;
                    if delta_idx < self.delta_edges.len() {
                        let edge = &self.delta_edges[delta_idx];
                        if edge.deleted || edge.dst != node_id {
                            continue;
                        }

                        // Filter by edge type if specified
                        if let Some(types) = edge_types {
                            if !edge.edge_type.as_deref().map_or(false, |et| types.contains(&et)) {
                                continue;
                            }
                        }

                        result.push(edge.clone());
                    }
                }
            }
        }

        result
    }

    /// Get ALL edges from the graph (delta + segment)
    /// Returns Vec<EdgeRecord> with all edges
    fn get_all_edges(&self) -> Vec<EdgeRecord> {
        let mut edges_map: std::collections::HashMap<(u128, u128, String), EdgeRecord> =
            std::collections::HashMap::new();

        // From delta_edges
        for edge in &self.delta_edges {
            if !edge.deleted {
                let edge_type_key = edge.edge_type.clone().unwrap_or_default();
                let key = (edge.src, edge.dst, edge_type_key);
                edges_map.insert(key, edge.clone());
            }
        }

        // From edges_segment
        if let Some(ref edges_seg) = self.edges_segment {
            for idx in 0..edges_seg.edge_count() {
                if edges_seg.is_deleted(idx) {
                    continue;
                }

                if let (Some(src), Some(dst)) = (
                    edges_seg.get_src(idx),
                    edges_seg.get_dst(idx),
                ) {
                    let edge_type = edges_seg.get_edge_type(idx);
                    let edge_type_key = edge_type.unwrap_or("").to_string();
                    let key = (src, dst, edge_type_key.clone());

                    // Don't overwrite delta edges (they are more recent)
                    if !edges_map.contains_key(&key) {
                        let metadata = edges_seg.get_metadata(idx);
                        edges_map.insert(key, EdgeRecord {
                            src,
                            dst,
                            edge_type: if edge_type_key.is_empty() { None } else { Some(edge_type_key) },
                            version: "main".to_string(), // TODO: Store version in segment
                            metadata: metadata.map(|s| s.to_string()),
                            deleted: false,
                        });
                    }
                }
            }
        }

        edges_map.into_values().collect()
    }

    /// Count nodes by type (efficient - doesn't load all data)
    /// types: optional filter, supports wildcards (e.g., "http:*")
    fn count_nodes_by_type(&self, types: Option<&[String]>) -> std::collections::HashMap<String, usize> {
        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut seen_ids: std::collections::HashSet<u128> = std::collections::HashSet::new();

        // Helper to check if type matches filter (with wildcard support)
        let matches_filter = |node_type: &str, filter: Option<&[String]>| -> bool {
            match filter {
                None => true,
                Some(types) => types.iter().any(|t| {
                    if t.ends_with('*') {
                        node_type.starts_with(t.trim_end_matches('*'))
                    } else {
                        node_type == t
                    }
                })
            }
        };

        // Count from delta_nodes first (they override segment)
        for (id, node) in &self.delta_nodes {
            if node.deleted {
                continue;
            }

            let node_type = node.node_type.as_deref().unwrap_or("UNKNOWN");

            // Filter by types if specified
            if !matches_filter(node_type, types) {
                continue;
            }

            *counts.entry(node_type.to_string()).or_insert(0) += 1;
            seen_ids.insert(*id);
        }

        // Count from segment (skip if already in delta)
        if let Some(ref nodes_seg) = self.nodes_segment {
            for idx in nodes_seg.iter_indices() {
                if nodes_seg.is_deleted(idx) {
                    continue;
                }

                if let Some(id) = nodes_seg.get_id(idx) {
                    // Skip if already counted from delta
                    if seen_ids.contains(&id) {
                        continue;
                    }

                    let node_type = nodes_seg.get_node_type(idx).unwrap_or("UNKNOWN");

                    // Filter by types if specified
                    if !matches_filter(node_type, types) {
                        continue;
                    }

                    *counts.entry(node_type.to_string()).or_insert(0) += 1;
                }
            }
        }

        counts
    }

    /// Count edges by type (efficient - doesn't load all data)
    /// edge_types: optional filter, supports wildcards (e.g., "http:*")
    fn count_edges_by_type(&self, edge_types: Option<&[String]>) -> std::collections::HashMap<String, usize> {
        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut seen_edges: std::collections::HashSet<(u128, u128, String)> = std::collections::HashSet::new();

        // Helper to check if type matches filter (with wildcard support)
        let matches_filter = |edge_type: &str, filter: Option<&[String]>| -> bool {
            match filter {
                None => true,
                Some(types) => types.iter().any(|t| {
                    if t.ends_with('*') {
                        edge_type.starts_with(t.trim_end_matches('*'))
                    } else {
                        edge_type == t
                    }
                })
            }
        };

        // Count from delta_edges first
        for edge in &self.delta_edges {
            if edge.deleted {
                continue;
            }

            let edge_type = edge.edge_type.as_deref().unwrap_or("UNKNOWN");

            // Filter by edge_types if specified
            if !matches_filter(edge_type, edge_types) {
                continue;
            }

            *counts.entry(edge_type.to_string()).or_insert(0) += 1;
            seen_edges.insert((edge.src, edge.dst, edge_type.to_string()));
        }

        // Count from segment (skip duplicates)
        if let Some(ref edges_seg) = self.edges_segment {
            for idx in 0..edges_seg.edge_count() {
                if edges_seg.is_deleted(idx) {
                    continue;
                }

                if let (Some(src), Some(dst)) = (
                    edges_seg.get_src(idx),
                    edges_seg.get_dst(idx),
                ) {
                    let edge_type = edges_seg.get_edge_type(idx).unwrap_or("UNKNOWN");
                    let key = (src, dst, edge_type.to_string());

                    if seen_edges.contains(&key) {
                        continue;
                    }

                    // Filter by edge_types if specified
                    if !matches_filter(edge_type, edge_types) {
                        continue;
                    }

                    *counts.entry(edge_type.to_string()).or_insert(0) += 1;
                    // Mark as seen to avoid counting duplicates within segment
                    seen_edges.insert(key);
                }
            }
        }

        counts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_db_path_no_extension() {
        let path = normalize_db_path("/path/to/db");
        assert_eq!(path, PathBuf::from("/path/to/db.rfdb"));
    }

    #[test]
    fn test_normalize_db_path_with_rfdb_extension() {
        let path = normalize_db_path("/path/to/db.rfdb");
        assert_eq!(path, PathBuf::from("/path/to/db.rfdb"));
    }

    #[test]
    fn test_normalize_db_path_with_other_extension() {
        let path = normalize_db_path("/path/to/db.db");
        assert_eq!(path, PathBuf::from("/path/to/db.rfdb"));
    }

    #[test]
    fn test_normalize_db_path_with_json_extension() {
        let path = normalize_db_path("/path/to/database.json");
        assert_eq!(path, PathBuf::from("/path/to/database.rfdb"));
    }

    #[test]
    fn test_normalize_db_path_relative() {
        let path = normalize_db_path("mydb");
        assert_eq!(path, PathBuf::from("mydb.rfdb"));
    }

    #[test]
    fn test_normalize_db_path_relative_with_extension() {
        let path = normalize_db_path("mydb.sqlite");
        assert_eq!(path, PathBuf::from("mydb.rfdb"));
    }

    #[test]
    fn test_create_database_with_extension_normalization() {
        use tempfile::tempdir;

        // Create a temporary directory
        let temp_dir = tempdir().unwrap();
        let db_path_without_ext = temp_dir.path().join("testdb");
        let db_path_with_wrong_ext = temp_dir.path().join("testdb2.db");

        // Test 1: Create without extension
        {
            let engine = GraphEngine::create(&db_path_without_ext).unwrap();
            assert_eq!(engine.path.extension().and_then(|s| s.to_str()), Some("rfdb"));
            assert!(engine.path.to_str().unwrap().ends_with("testdb.rfdb"));
        }

        // Test 2: Create with wrong extension
        {
            let engine = GraphEngine::create(&db_path_with_wrong_ext).unwrap();
            assert_eq!(engine.path.extension().and_then(|s| s.to_str()), Some("rfdb"));
            assert!(engine.path.to_str().unwrap().ends_with("testdb2.rfdb"));
        }

        // Test 3: Open database that was created without extension
        {
            let engine = GraphEngine::open(&db_path_without_ext).unwrap();
            assert_eq!(engine.path.extension().and_then(|s| s.to_str()), Some("rfdb"));
        }

        // Cleanup is automatic via tempdir
    }

    #[test]
    fn test_open_database_with_extension_normalization() {
        use tempfile::tempdir;

        // Create a temporary directory
        let temp_dir = tempdir().unwrap();
        let db_path_no_ext = temp_dir.path().join("opentest");
        let db_path_with_ext = temp_dir.path().join("opentest.rfdb");

        // Create a database with the correct extension
        {
            let mut engine = GraphEngine::create(&db_path_with_ext).unwrap();
            // Add a node and flush to create actual files
            let node = NodeRecord {
                id: 1,
                node_type: Some("TEST".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: Some("test_node".to_string()),
                file: None,
                metadata: None,
            };
            engine.add_nodes(vec![node]);
            engine.flush().unwrap();
        }

        // Test opening with path without extension
        {
            let engine = GraphEngine::open(&db_path_no_ext).unwrap();
            assert_eq!(engine.path.extension().and_then(|s| s.to_str()), Some("rfdb"));
            assert_eq!(engine.node_count(), 1);
        }

        // Test opening with path with correct extension
        {
            let engine = GraphEngine::open(&db_path_with_ext).unwrap();
            assert_eq!(engine.path.extension().and_then(|s| s.to_str()), Some("rfdb"));
            assert_eq!(engine.node_count(), 1);
        }
    }

    // ============================================================
    // REG-115: Reachability Queries Tests
    // ============================================================

    /// Helper function to create a test node
    fn make_test_node(id: u128, name: &str, node_type: &str) -> NodeRecord {
        NodeRecord {
            id,
            node_type: Some(node_type.to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some(name.to_string()),
            file: Some("test.js".to_string()),
            metadata: None,
        }
    }

    /// Helper function to create a test edge
    fn make_test_edge(src: u128, dst: u128, edge_type: &str) -> EdgeRecord {
        EdgeRecord {
            src,
            dst,
            edge_type: Some(edge_type.to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        }
    }

    #[test]
    fn test_reverse_adjacency_basic() {
        // Graph: A --CALLS--> B, C --CALLS--> B, D --IMPORTS--> B
        // reverse_neighbors(B, ["CALLS"]) should return [A, C] (not D)

        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join("test_reverse_adj");

        let mut engine = GraphEngine::create(&db_path).unwrap();

        let [a, b, c, d]: [u128; 4] = [1, 2, 3, 4];

        engine.add_nodes(vec![
            make_test_node(a, "funcA", "FUNCTION"),
            make_test_node(b, "funcB", "FUNCTION"),
            make_test_node(c, "funcC", "FUNCTION"),
            make_test_node(d, "moduleD", "MODULE"),
        ]);

        engine.add_edges(vec![
            make_test_edge(a, b, "CALLS"),
            make_test_edge(c, b, "CALLS"),
            make_test_edge(d, b, "IMPORTS"),
        ], false);

        let callers = engine.reverse_neighbors(b, &["CALLS"]);

        assert_eq!(callers.len(), 2);
        assert!(callers.contains(&a));
        assert!(callers.contains(&c));
        assert!(!callers.contains(&d));

        // Empty filter returns all
        let all_sources = engine.reverse_neighbors(b, &[]);
        assert_eq!(all_sources.len(), 3);
    }

    #[test]
    fn test_reachability_forward() {
        // Graph: A -> B -> C -> D -> E
        // reachability([A], 2, [], false) = [A, B, C]

        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

        let [a, b, c, d, e]: [u128; 5] = [1, 2, 3, 4, 5];

        engine.add_nodes(vec![
            make_test_node(a, "A", "FUNCTION"),
            make_test_node(b, "B", "FUNCTION"),
            make_test_node(c, "C", "FUNCTION"),
            make_test_node(d, "D", "FUNCTION"),
            make_test_node(e, "E", "FUNCTION"),
        ]);

        engine.add_edges(vec![
            make_test_edge(a, b, "CALLS"),
            make_test_edge(b, c, "CALLS"),
            make_test_edge(c, d, "CALLS"),
            make_test_edge(d, e, "CALLS"),
        ], false);

        let result_2 = engine.reachability(&[a], 2, &[], false);
        assert_eq!(result_2.len(), 3);
        assert!(result_2.contains(&a) && result_2.contains(&b) && result_2.contains(&c));

        let result_10 = engine.reachability(&[a], 10, &[], false);
        assert_eq!(result_10.len(), 5);
    }

    #[test]
    fn test_reachability_backward() {
        // Graph: A -> D, B -> D, C -> D
        // reachability([D], 1, [], true) = [D, A, B, C]

        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

        let [a, b, c, d]: [u128; 4] = [1, 2, 3, 4];

        engine.add_nodes(vec![
            make_test_node(a, "A", "FUNCTION"),
            make_test_node(b, "B", "FUNCTION"),
            make_test_node(c, "C", "FUNCTION"),
            make_test_node(d, "D", "FUNCTION"),
        ]);

        engine.add_edges(vec![
            make_test_edge(a, d, "CALLS"),
            make_test_edge(b, d, "CALLS"),
            make_test_edge(c, d, "CALLS"),
        ], false);

        let result = engine.reachability(&[d], 1, &[], true);
        assert_eq!(result.len(), 4);
        assert!(result.contains(&d) && result.contains(&a) && result.contains(&b) && result.contains(&c));
    }

    #[test]
    fn test_reachability_with_cycles() {
        // Diamond: A->B, A->C, B->D, C->D
        // Each node should appear exactly once

        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

        let [a, b, c, d]: [u128; 4] = [1, 2, 3, 4];

        engine.add_nodes(vec![
            make_test_node(a, "A", "FUNCTION"),
            make_test_node(b, "B", "FUNCTION"),
            make_test_node(c, "C", "FUNCTION"),
            make_test_node(d, "D", "FUNCTION"),
        ]);

        engine.add_edges(vec![
            make_test_edge(a, b, "CALLS"),
            make_test_edge(a, c, "CALLS"),
            make_test_edge(b, d, "CALLS"),
            make_test_edge(c, d, "CALLS"),
        ], false);

        let forward = engine.reachability(&[a], 10, &[], false);
        assert_eq!(forward.len(), 4);

        let backward = engine.reachability(&[d], 10, &[], true);
        assert_eq!(backward.len(), 4);
    }

    #[test]
    fn test_reverse_adjacency_persists_after_flush() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join("test");

        let [a, b, c]: [u128; 3] = [1, 2, 3];

        {
            let mut engine = GraphEngine::create(&db_path).unwrap();
            engine.add_nodes(vec![
                make_test_node(a, "A", "FUNCTION"),
                make_test_node(b, "B", "FUNCTION"),
                make_test_node(c, "C", "FUNCTION"),
            ]);
            engine.add_edges(vec![
                make_test_edge(a, c, "CALLS"),
                make_test_edge(b, c, "CALLS"),
            ], false);
            engine.flush().unwrap();
        }

        {
            let engine = GraphEngine::open(&db_path).unwrap();
            let callers = engine.reverse_neighbors(c, &["CALLS"]);
            assert_eq!(callers.len(), 2);
        }
    }

    #[test]
    fn test_reachability_edge_type_filter() {
        // A --CALLS--> B, A --IMPORTS--> C, B --CALLS--> D
        // reachability([A], 10, ["CALLS"], false) = [A, B, D] (not C)

        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

        let [a, b, c, d]: [u128; 4] = [1, 2, 3, 4];

        engine.add_nodes(vec![
            make_test_node(a, "A", "FUNCTION"),
            make_test_node(b, "B", "FUNCTION"),
            make_test_node(c, "C", "MODULE"),
            make_test_node(d, "D", "FUNCTION"),
        ]);

        engine.add_edges(vec![
            make_test_edge(a, b, "CALLS"),
            make_test_edge(a, c, "IMPORTS"),
            make_test_edge(b, d, "CALLS"),
        ], false);

        let result = engine.reachability(&[a], 10, &["CALLS"], false);
        assert_eq!(result.len(), 3);
        assert!(!result.contains(&c));
    }

    #[test]
    fn test_reachability_backward_with_filter() {
        // Test: Backward traversal with edge type filtering
        //
        // Graph: A --PASSES_ARGUMENT--> Z
        //        B --CALLS--> Z
        //
        // reachability([Z], 1, ["PASSES_ARGUMENT"], backward=true)
        //   should return [Z, A] (not B because edge type differs)

        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

        let [a, b, z]: [u128; 3] = [1, 2, 3];

        engine.add_nodes(vec![
            make_test_node(a, "A", "FUNCTION"),
            make_test_node(b, "B", "FUNCTION"),
            make_test_node(z, "Z", "FUNCTION"),
        ]);

        engine.add_edges(vec![
            make_test_edge(a, z, "PASSES_ARGUMENT"),
            make_test_edge(b, z, "CALLS"),
        ], false);

        // Backward from Z, filtering only PASSES_ARGUMENT edges
        let result = engine.reachability(&[z], 10, &["PASSES_ARGUMENT"], true);

        assert_eq!(result.len(), 2, "Should find Z and A only");
        assert!(result.contains(&z), "Z (start) should be included");
        assert!(result.contains(&a), "A should be found (PASSES_ARGUMENT edge)");
        assert!(!result.contains(&b), "B should NOT be found (CALLS edge filtered out)");
    }

    #[test]
    fn test_reachability_empty_start() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

        let forward = engine.reachability(&[], 10, &[], false);
        assert!(forward.is_empty());

        let backward = engine.reachability(&[], 10, &[], true);
        assert!(backward.is_empty());
    }

    #[test]
    fn test_reachability_depth_zero() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

        let [a, b]: [u128; 2] = [1, 2];

        engine.add_nodes(vec![
            make_test_node(a, "A", "FUNCTION"),
            make_test_node(b, "B", "FUNCTION"),
        ]);
        engine.add_edges(vec![make_test_edge(a, b, "CALLS")], false);

        let result = engine.reachability(&[a], 0, &[], false);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&a));
    }

    #[test]
    fn test_reachability_nonexistent_start() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

        // Non-existent node ID should still be returned (start node included)
        // but no neighbors
        let result = engine.reachability(&[999], 10, &[], false);
        assert_eq!(result.len(), 1);
        assert!(result.contains(&999));
    }

    // ============================================================
    // REG-308: File Filtering in find_by_attr Tests
    // ============================================================

    #[test]
    fn test_find_by_attr_file_filter_delta() {
        // Test: find_by_attr with file filter works for delta (unflushed) nodes
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

        // Create nodes in different files
        engine.add_nodes(vec![
            make_test_node(1, "funcA", "FUNCTION"),
            make_test_node(2, "funcB", "FUNCTION"),
            make_test_node(3, "funcC", "FUNCTION"),
        ]);

        // Manually set different files for testing
        if let Some(node) = engine.delta_nodes.get_mut(&1) {
            node.file = Some("src/utils.js".to_string());
        }
        if let Some(node) = engine.delta_nodes.get_mut(&2) {
            node.file = Some("src/utils.js".to_string());
        }
        if let Some(node) = engine.delta_nodes.get_mut(&3) {
            node.file = Some("src/other.js".to_string());
        }

        // Query for nodes in src/utils.js
        let query = AttrQuery {
            file: Some("src/utils.js".to_string()),
            ..Default::default()
        };
        let result = engine.find_by_attr(&query);

        assert_eq!(result.len(), 2, "Should find exactly 2 nodes in src/utils.js");
        assert!(result.contains(&1));
        assert!(result.contains(&2));
        assert!(!result.contains(&3), "Node 3 is in a different file");
    }

    #[test]
    fn test_find_by_attr_file_filter_segment() {
        // Test: find_by_attr with file filter works for persisted (segment) nodes
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join("test");

        // Create and flush nodes
        {
            let mut engine = GraphEngine::create(&db_path).unwrap();

            engine.add_nodes(vec![
                NodeRecord {
                    id: 1,
                    node_type: Some("FUNCTION".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".to_string(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    name: Some("funcA".to_string()),
                    file: Some("src/utils.js".to_string()),
                    metadata: None,
                },
                NodeRecord {
                    id: 2,
                    node_type: Some("FUNCTION".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".to_string(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    name: Some("funcB".to_string()),
                    file: Some("src/utils.js".to_string()),
                    metadata: None,
                },
                NodeRecord {
                    id: 3,
                    node_type: Some("FUNCTION".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".to_string(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    name: Some("funcC".to_string()),
                    file: Some("src/other.js".to_string()),
                    metadata: None,
                },
            ]);

            engine.flush().unwrap();
        }

        // Reopen and test file filtering on segment data
        {
            let engine = GraphEngine::open(&db_path).unwrap();

            // Query for nodes in src/utils.js
            let query = AttrQuery {
                file: Some("src/utils.js".to_string()),
                ..Default::default()
            };
            let result = engine.find_by_attr(&query);

            assert_eq!(result.len(), 2, "Should find exactly 2 nodes in src/utils.js from segment");
            assert!(result.contains(&1));
            assert!(result.contains(&2));
            assert!(!result.contains(&3), "Node 3 is in a different file");
        }
    }

    #[test]
    fn test_find_by_attr_file_and_type_combined() {
        // Test: find_by_attr with both file and type filters
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(temp_dir.path().join("test")).unwrap();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("FUNCTION".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: Some("funcA".to_string()),
                file: Some("src/utils.js".to_string()),
                metadata: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("CLASS".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: Some("ClassB".to_string()),
                file: Some("src/utils.js".to_string()),
                metadata: None,
            },
            NodeRecord {
                id: 3,
                node_type: Some("FUNCTION".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: Some("funcC".to_string()),
                file: Some("src/other.js".to_string()),
                metadata: None,
            },
        ]);

        // Query for FUNCTION nodes in src/utils.js
        let query = AttrQuery {
            node_type: Some("FUNCTION".to_string()),
            file: Some("src/utils.js".to_string()),
            ..Default::default()
        };
        let result = engine.find_by_attr(&query);

        assert_eq!(result.len(), 1, "Should find exactly 1 FUNCTION in src/utils.js");
        assert!(result.contains(&1));
        assert!(!result.contains(&2), "Node 2 is CLASS, not FUNCTION");
        assert!(!result.contains(&3), "Node 3 is in different file");
    }

    // ============================================================
    // REG-335: Ephemeral Database Tests
    // ============================================================

    #[test]
    fn test_create_ephemeral_database() {
        let engine = GraphEngine::create_ephemeral();
        assert!(engine.is_ok());

        let engine = engine.unwrap();
        assert!(engine.is_ephemeral());
        assert_eq!(engine.node_count(), 0);
        assert_eq!(engine.edge_count(), 0);
    }

    #[test]
    fn test_ephemeral_add_nodes() {
        let mut engine = GraphEngine::create_ephemeral().unwrap();

        engine.add_nodes(vec![NodeRecord {
            id: 1,
            node_type: Some("TEST".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some("test".to_string()),
            file: None,
            metadata: None,
        }]);

        assert_eq!(engine.node_count(), 1);
        assert!(engine.node_exists(1));
    }

    #[test]
    fn test_ephemeral_add_edges() {
        let mut engine = GraphEngine::create_ephemeral().unwrap();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("FUNC".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: Some("foo".to_string()),
                file: None,
                metadata: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("FUNC".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: Some("bar".to_string()),
                file: None,
                metadata: None,
            },
        ]);

        engine.add_edges(vec![EdgeRecord {
            src: 1,
            dst: 2,
            edge_type: Some("CALLS".to_string()),
            version: "main".to_string(),
            metadata: None,
            deleted: false,
        }], false);

        assert_eq!(engine.edge_count(), 1);
        let neighbors = engine.neighbors(1, &["CALLS"]);
        assert_eq!(neighbors, vec![2]);
    }

    #[test]
    fn test_regular_is_not_ephemeral() {
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let engine = GraphEngine::create(dir.path()).unwrap();

        assert!(!engine.is_ephemeral());
    }

    #[test]
    fn test_ephemeral_find_by_type() {
        let mut engine = GraphEngine::create_ephemeral().unwrap();

        engine.add_nodes(vec![
            make_test_node(1, "funcA", "FUNCTION"),
            make_test_node(2, "funcB", "FUNCTION"),
            make_test_node(3, "classC", "CLASS"),
        ]);

        let functions = engine.find_by_type("FUNCTION");
        assert_eq!(functions.len(), 2);
        assert!(functions.contains(&1));
        assert!(functions.contains(&2));
    }

    #[test]
    fn test_ephemeral_bfs() {
        let mut engine = GraphEngine::create_ephemeral().unwrap();

        let [a, b, c]: [u128; 3] = [1, 2, 3];

        engine.add_nodes(vec![
            make_test_node(a, "A", "FUNCTION"),
            make_test_node(b, "B", "FUNCTION"),
            make_test_node(c, "C", "FUNCTION"),
        ]);

        engine.add_edges(vec![
            make_test_edge(a, b, "CALLS"),
            make_test_edge(b, c, "CALLS"),
        ], false);

        let result = engine.bfs(&[a], 2, &["CALLS"]);
        assert_eq!(result.len(), 3);
        assert!(result.contains(&a));
        assert!(result.contains(&b));
        assert!(result.contains(&c));
    }

    // ============================================================
    // REG-398: ID Index Tests
    // ============================================================

    #[test]
    fn test_index_get_node_after_flush() {
        // Verify ID index works correctly after flush:
        // add nodes → flush → get_node() uses index instead of linear scan
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join("test");

        let mut engine = GraphEngine::create(&db_path).unwrap();

        engine.add_nodes(vec![
            make_test_node(100, "funcA", "FUNCTION"),
            make_test_node(200, "funcB", "FUNCTION"),
            make_test_node(300, "classC", "CLASS"),
        ]);

        engine.flush().unwrap();

        // After flush, nodes are in segment — lookups go through index
        let node = engine.get_node(100).unwrap();
        assert_eq!(node.name.as_deref(), Some("funcA"));

        let node = engine.get_node(200).unwrap();
        assert_eq!(node.name.as_deref(), Some("funcB"));

        let node = engine.get_node(300).unwrap();
        assert_eq!(node.name.as_deref(), Some("classC"));

        // Non-existent node
        assert!(engine.get_node(999).is_none());
    }

    #[test]
    fn test_index_survives_reopen() {
        // Verify index is rebuilt correctly on open()
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join("test");

        {
            let mut engine = GraphEngine::create(&db_path).unwrap();
            engine.add_nodes(vec![
                make_test_node(10, "A", "FUNCTION"),
                make_test_node(20, "B", "FUNCTION"),
            ]);
            engine.flush().unwrap();
        }

        // Reopen — index rebuilt from segment
        {
            let engine = GraphEngine::open(&db_path).unwrap();
            let node = engine.get_node(10).unwrap();
            assert_eq!(node.name.as_deref(), Some("A"));

            let node = engine.get_node(20).unwrap();
            assert_eq!(node.name.as_deref(), Some("B"));

            assert!(engine.get_node(999).is_none());
        }
    }

    #[test]
    fn test_index_delta_takes_priority_over_segment() {
        // Delta nodes must be found before index is consulted
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join("test");

        let mut engine = GraphEngine::create(&db_path).unwrap();

        engine.add_nodes(vec![make_test_node(1, "original", "FUNCTION")]);
        engine.flush().unwrap();

        // Add a new node with same ID to delta (overwrites segment version)
        engine.add_nodes(vec![make_test_node(1, "updated", "FUNCTION")]);

        // Delta should take priority
        let node = engine.get_node(1).unwrap();
        assert_eq!(node.name.as_deref(), Some("updated"));
    }

    #[test]
    fn test_index_deleted_segment_node_not_returned() {
        // Delete a segment node → deleted_segment_ids blocks lookup
        // even though index still has the entry
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join("test");

        let mut engine = GraphEngine::create(&db_path).unwrap();
        engine.add_nodes(vec![
            make_test_node(1, "keep", "FUNCTION"),
            make_test_node(2, "delete_me", "FUNCTION"),
        ]);
        engine.flush().unwrap();

        // Both exist after flush
        assert!(engine.get_node(1).is_some());
        assert!(engine.get_node(2).is_some());

        // Delete node 2
        engine.delete_node(2);

        // Node 2 should not be found (deleted_segment_ids blocks before index)
        assert!(engine.get_node(2).is_none());
        // Node 1 still accessible via index
        assert!(engine.get_node(1).is_some());
    }

    #[test]
    fn test_index_get_node_strings_after_flush() {
        // Verify get_node_strings() uses index for segment lookup
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join("test");

        let mut engine = GraphEngine::create(&db_path).unwrap();
        engine.add_nodes(vec![NodeRecord {
            id: 42,
            node_type: Some("FUNCTION".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".to_string(),
            exported: false,
            replaces: None,
            deleted: false,
            name: Some("myFunc".to_string()),
            file: Some("src/app.js".to_string()),
            metadata: Some("{\"async\":true}".to_string()),
        }]);
        engine.flush().unwrap();

        // get_node_strings uses index
        let (file, name) = engine.get_node_strings(42).unwrap();
        assert_eq!(file.as_deref(), Some("src/app.js"));
        assert_eq!(name.as_deref(), Some("myFunc"));

        // get_node_strings_with_metadata uses index
        let (file, name, meta) = engine.get_node_strings_with_metadata(42).unwrap();
        assert_eq!(file.as_deref(), Some("src/app.js"));
        assert_eq!(name.as_deref(), Some("myFunc"));
        assert_eq!(meta.as_deref(), Some("{\"async\":true}"));
    }

    #[test]
    fn test_index_rebuilt_after_flush_with_new_nodes() {
        // Flush twice: index must reflect the merged segment
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let db_path = temp_dir.path().join("test");

        let mut engine = GraphEngine::create(&db_path).unwrap();

        // First batch
        engine.add_nodes(vec![make_test_node(1, "A", "FUNCTION")]);
        engine.flush().unwrap();

        // Second batch
        engine.add_nodes(vec![make_test_node(2, "B", "FUNCTION")]);
        engine.flush().unwrap();

        // Both should be findable via index
        assert!(engine.get_node(1).is_some());
        assert!(engine.get_node(2).is_some());
    }
}
