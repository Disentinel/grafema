//! Граф API и реализация

pub mod engine;
pub mod engine_v2;
pub mod index_set;
pub mod traversal;
pub mod id_gen;

pub use engine::GraphEngine;
pub use engine_v2::GraphEngineV2;
pub use id_gen::{compute_node_id, string_id_to_u128};

use std::any::Any;
use crate::storage::{NodeRecord, EdgeRecord, AttrQuery, FieldDecl};
use crate::error::Result;

/// Основной trait для graph storage
///
/// Send + Sync required for use behind RwLock<Box<dyn GraphStore>> in Database
pub trait GraphStore: Send + Sync {
    // === NODE OPERATIONS ===

    /// Добавить ноды batch'ом
    fn add_nodes(&mut self, nodes: Vec<NodeRecord>);

    /// Удалить ноду (soft delete через tombstone)
    fn delete_node(&mut self, id: u128);

    /// Получить ноду по ID
    fn get_node(&self, id: u128) -> Option<NodeRecord>;

    /// Проверить существование ноды
    fn node_exists(&self, id: u128) -> bool;

    /// Получить readable identifier для ноды (TYPE:name@file)
    fn get_node_identifier(&self, id: u128) -> Option<String>;

    /// Найти ноды по атрибутам
    fn find_by_attr(&self, query: &AttrQuery) -> Vec<u128>;

    /// Найти ноды по типу (поддерживает wildcard, e.g., "http:*")
    fn find_by_type(&self, node_type: &str) -> Vec<u128>;

    // === EDGE OPERATIONS ===

    /// Добавить рёбра batch'ом
    fn add_edges(&mut self, edges: Vec<EdgeRecord>, skip_validation: bool);

    /// Удалить ребро
    fn delete_edge(&mut self, src: u128, dst: u128, edge_type: &str);

    /// Найти соседей (outgoing edges)
    fn neighbors(&self, id: u128, edge_types: &[&str]) -> Vec<u128>;

    /// Получить исходящие рёбра от ноды
    fn get_outgoing_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecord>;

    /// Получить входящие рёбра к ноде
    fn get_incoming_edges(&self, node_id: u128, edge_types: Option<&[&str]>) -> Vec<EdgeRecord>;

    /// Получить ВСЕ рёбра из графа
    fn get_all_edges(&self) -> Vec<EdgeRecord>;

    /// Подсчитать ноды по типам
    /// Возвращает HashMap<node_type, count>
    /// Поддерживает wildcard в filter (e.g., "http:*")
    fn count_nodes_by_type(&self, types: Option<&[String]>) -> std::collections::HashMap<String, usize>;

    /// Подсчитать рёбра по типам
    /// Возвращает HashMap<edge_type, count>
    /// Поддерживает wildcard в filter (e.g., "http:*")
    fn count_edges_by_type(&self, edge_types: Option<&[String]>) -> std::collections::HashMap<String, usize>;

    // === TRAVERSAL ===

    /// BFS от start нод до глубины max_depth по указанным типам рёбер
    fn bfs(&self, start: &[u128], max_depth: usize, edge_types: &[&str]) -> Vec<u128>;

    // === MAINTENANCE ===

    /// Flush delta log на диск
    fn flush(&mut self) -> Result<()>;

    /// Компактировать delta log в immutable segments
    fn compact(&mut self) -> Result<()>;

    // === STATS ===

    /// Количество живых нод (без deleted, с дедупликацией segment/delta)
    fn node_count(&self) -> usize;

    /// Количество живых рёбер (без deleted, с дедупликацией segment/delta)
    fn edge_count(&self) -> usize;

    // === ENGINE-SPECIFIC ===

    /// Clear all data (reset engine to empty state)
    fn clear(&mut self);

    /// Declare metadata fields for secondary indexing
    fn declare_fields(&mut self, fields: Vec<FieldDecl>);

    // === DOWNCAST SUPPORT ===

    /// Downcast to concrete engine type (for engine-specific operations)
    fn as_any(&self) -> &dyn Any;

    /// Downcast to concrete engine type (mutable, for engine-specific operations)
    fn as_any_mut(&mut self) -> &mut dyn Any;
}

/// Check if a node is an API endpoint (application logic, not storage)
///
/// This is a free function rather than a GraphStore method because it's
/// Grafema-specific business logic, not a storage operation.
pub fn is_endpoint(engine: &dyn GraphStore, id: u128) -> bool {
    const ENDPOINT_TYPES: &[&str] = &[
        "db:query", "http:request", "http:route", "http:endpoint",
        "graphql:query", "graphql:mutation", "graphql:subscription",
        "grpc:method", "websocket:handler",
    ];

    match engine.get_node(id) {
        Some(node) => {
            if let Some(ref nt) = node.node_type {
                ENDPOINT_TYPES.contains(&nt.as_str())
            } else {
                false
            }
        }
        None => false,
    }
}

/// BFS reachability with optional backward direction (application logic)
///
/// Forward: follows outgoing edges. Backward: follows incoming edges.
/// Free function because direction-aware traversal is application logic
/// built on top of storage primitives.
pub fn reachability(
    engine: &dyn GraphStore,
    start: &[u128],
    max_depth: usize,
    edge_types: &[&str],
    backward: bool,
) -> Vec<u128> {
    if backward {
        traversal::bfs(start, max_depth, |id| {
            engine.get_incoming_edges(id, Some(edge_types))
                .into_iter()
                .map(|e| e.src)
                .collect()
        })
    } else {
        engine.bfs(start, max_depth, edge_types)
    }
}
