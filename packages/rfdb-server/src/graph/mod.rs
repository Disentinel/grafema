//! Граф API и реализация

pub mod engine;
pub mod engine_v2;
pub mod index_set;
pub mod traversal;
pub mod id_gen;

pub use engine::GraphEngine;
pub use engine_v2::GraphEngineV2;
pub use id_gen::{compute_node_id, string_id_to_u128};

use crate::storage::{NodeRecord, EdgeRecord, AttrQuery};
use crate::error::Result;

/// Основной trait для graph storage
pub trait GraphStore {
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

    /// Количество нод (включая deleted)
    fn node_count(&self) -> usize;

    /// Количество рёбер (включая deleted)
    fn edge_count(&self) -> usize;
}
