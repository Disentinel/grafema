//! DatabaseManager - Thread-safe registry of open databases
//!
//! This module provides multi-database support for the RFDB server,
//! allowing multiple isolated databases to be managed by a single server instance.
//!
//! # Architecture
//!
//! - `DatabaseManager` holds a thread-safe HashMap of databases
//! - Each `Database` wraps a `GraphEngine` with `RwLock` for concurrent access
//! - Connection tracking via atomic counters enables safe cleanup
//! - Ephemeral databases are automatically removed when all connections close
//!
//! # Usage
//!
//! ```no_run
//! use rfdb::database_manager::{DatabaseManager, AccessMode};
//! use std::path::PathBuf;
//!
//! let manager = DatabaseManager::new(PathBuf::from("/data"));
//!
//! // Create a persistent database
//! manager.create_database("production", false).unwrap();
//!
//! // Create an ephemeral (in-memory) database for testing
//! manager.create_database("test-123", true).unwrap();
//!
//! // Get database and track connection
//! let db = manager.get_database("test-123").unwrap();
//! db.add_connection();
//!
//! // When done
//! db.remove_connection();
//! manager.cleanup_ephemeral_if_unused("test-123");
//! ```

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::graph::{GraphEngine, GraphStore};
use crate::error::{GraphError, Result};

/// Unique identifier for a client connection
pub type ClientId = usize;

/// Access mode for database sessions
///
/// This is per-session state (not database-level locking).
/// Multiple read-write sessions can access the same database concurrently.
/// The `RwLock<GraphEngine>` handles actual request-level serialization.
///
/// Use `ReadOnly` for visualization tools that shouldn't accidentally mutate data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessMode {
    /// Read-only access - write operations will be rejected
    ReadOnly,
    /// Read-write access (default)
    ReadWrite,
}

impl AccessMode {
    /// Parse access mode from string
    pub fn from_str(s: &str) -> Self {
        match s {
            "ro" | "readonly" | "read-only" => AccessMode::ReadOnly,
            _ => AccessMode::ReadWrite,
        }
    }

    /// Convert to wire protocol string
    pub fn as_str(&self) -> &'static str {
        match self {
            AccessMode::ReadOnly => "ro",
            AccessMode::ReadWrite => "rw",
        }
    }

    /// Check if write operations are allowed
    pub fn is_write(&self) -> bool {
        matches!(self, AccessMode::ReadWrite)
    }
}

/// Database entry in the manager
pub struct Database {
    /// Database name (for identification)
    pub name: String,
    /// The graph engine with RwLock for concurrent access
    pub engine: RwLock<GraphEngine>,
    /// Whether this is an ephemeral (in-memory) database
    pub ephemeral: bool,
    /// Number of active connections to this database
    connection_count: AtomicUsize,
}

impl Database {
    /// Create a new database entry
    pub fn new(name: String, engine: GraphEngine, ephemeral: bool) -> Self {
        Self {
            name,
            engine: RwLock::new(engine),
            ephemeral,
            connection_count: AtomicUsize::new(0),
        }
    }

    /// Increment connection count when client opens database
    pub fn add_connection(&self) {
        self.connection_count.fetch_add(1, Ordering::SeqCst);
    }

    /// Decrement connection count when client closes database
    pub fn remove_connection(&self) {
        self.connection_count.fetch_sub(1, Ordering::SeqCst);
    }

    /// Get current connection count
    pub fn connection_count(&self) -> usize {
        self.connection_count.load(Ordering::SeqCst)
    }

    /// Check if database is in use (has any connections)
    pub fn is_in_use(&self) -> bool {
        self.connection_count() > 0
    }

    /// Get node count (for stats)
    pub fn node_count(&self) -> usize {
        self.engine.read().unwrap().node_count()
    }

    /// Get edge count (for stats)
    pub fn edge_count(&self) -> usize {
        self.engine.read().unwrap().edge_count()
    }
}

/// Database information for ListDatabases response
#[derive(Debug, Clone)]
pub struct DatabaseInfo {
    pub name: String,
    pub ephemeral: bool,
    pub node_count: usize,
    pub edge_count: usize,
    pub connection_count: usize,
}

/// DatabaseManager - manages multiple databases
///
/// Thread-safe registry of open databases. Supports both persistent
/// and ephemeral (in-memory) databases.
pub struct DatabaseManager {
    /// All open databases
    databases: RwLock<HashMap<String, Arc<Database>>>,
    /// Base path for persistent databases
    base_path: PathBuf,
}

impl DatabaseManager {
    /// Create a new DatabaseManager
    ///
    /// # Arguments
    /// * `base_path` - Directory where persistent databases are stored
    pub fn new(base_path: PathBuf) -> Self {
        Self {
            databases: RwLock::new(HashMap::new()),
            base_path,
        }
    }

    /// Validate database name
    ///
    /// Allowed characters: [a-zA-Z0-9_-]
    /// Length: 1-128 characters
    fn validate_name(name: &str) -> Result<()> {
        if name.is_empty() || name.len() > 128 {
            return Err(GraphError::InvalidDatabaseName(
                "Name must be 1-128 characters".to_string()
            ));
        }

        let valid = name.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == '_' || c == '-'
        });

        if !valid {
            return Err(GraphError::InvalidDatabaseName(
                "Name can only contain a-z, A-Z, 0-9, _, -".to_string()
            ));
        }

        Ok(())
    }

    /// Create a new database
    ///
    /// # Arguments
    /// * `name` - Database name (alphanumeric, _, -)
    /// * `ephemeral` - If true, database is in-memory only and never persisted
    pub fn create_database(&self, name: &str, ephemeral: bool) -> Result<()> {
        Self::validate_name(name)?;

        let mut databases = self.databases.write().unwrap();

        if databases.contains_key(name) {
            return Err(GraphError::DatabaseExists(name.to_string()));
        }

        let engine = if ephemeral {
            GraphEngine::create_ephemeral()?
        } else {
            let db_path = self.base_path.join(format!("{}.rfdb", name));
            GraphEngine::create(&db_path)?
        };

        let database = Arc::new(Database::new(name.to_string(), engine, ephemeral));
        databases.insert(name.to_string(), database);

        Ok(())
    }

    /// Get a database by name
    pub fn get_database(&self, name: &str) -> Result<Arc<Database>> {
        let databases = self.databases.read().unwrap();
        databases.get(name)
            .cloned()
            .ok_or_else(|| GraphError::DatabaseNotFound(name.to_string()))
    }

    /// Check if a database exists
    pub fn database_exists(&self, name: &str) -> bool {
        self.databases.read().unwrap().contains_key(name)
    }

    /// Drop a database (must not be in use)
    pub fn drop_database(&self, name: &str) -> Result<()> {
        let mut databases = self.databases.write().unwrap();

        let db = databases.get(name)
            .ok_or_else(|| GraphError::DatabaseNotFound(name.to_string()))?;

        if db.is_in_use() {
            return Err(GraphError::DatabaseInUse(name.to_string()));
        }

        // For persistent databases, delete files
        if !db.ephemeral {
            let db_path = self.base_path.join(format!("{}.rfdb", name));
            if db_path.exists() {
                std::fs::remove_dir_all(&db_path)?;
            }
        }

        databases.remove(name);
        Ok(())
    }

    /// List all databases
    pub fn list_databases(&self) -> Vec<DatabaseInfo> {
        let databases = self.databases.read().unwrap();
        databases.values()
            .map(|db| DatabaseInfo {
                name: db.name.clone(),
                ephemeral: db.ephemeral,
                node_count: db.node_count(),
                edge_count: db.edge_count(),
                connection_count: db.connection_count(),
            })
            .collect()
    }

    /// Cleanup ephemeral database if it has no connections
    ///
    /// Called after `remove_connection()` to automatically clean up
    /// ephemeral databases when the last client disconnects.
    pub fn cleanup_ephemeral_if_unused(&self, name: &str) {
        let mut databases = self.databases.write().unwrap();

        if let Some(db) = databases.get(name) {
            if db.ephemeral && !db.is_in_use() {
                databases.remove(name);
            }
        }
    }

    /// Create default database from legacy db_path
    ///
    /// Called during server startup for backwards compatibility.
    /// Legacy clients that don't use the new protocol automatically
    /// connect to this "default" database.
    pub fn create_default_from_path(&self, db_path: &PathBuf) -> Result<()> {
        let engine = if db_path.join("nodes.bin").exists() {
            GraphEngine::open(db_path)?
        } else {
            GraphEngine::create(db_path)?
        };

        let database = Arc::new(Database::new("default".to_string(), engine, false));

        let mut databases = self.databases.write().unwrap();
        databases.insert("default".to_string(), database);

        Ok(())
    }
}

#[cfg(test)]
mod database_tests {
    use super::*;
    use tempfile::tempdir;
    use crate::storage::NodeRecord;
    use crate::graph::GraphStore;

    // ============================================================================
    // Connection Tracking (Atomic Operations)
    // ============================================================================

    #[test]
    fn test_database_connection_count_starts_at_zero() {
        let dir = tempdir().unwrap();
        let engine = GraphEngine::create(dir.path()).unwrap();
        let db = Database::new("test".to_string(), engine, false);

        assert_eq!(db.connection_count(), 0);
        assert!(!db.is_in_use());
    }

    #[test]
    fn test_database_add_connection_increments() {
        let dir = tempdir().unwrap();
        let engine = GraphEngine::create(dir.path()).unwrap();
        let db = Database::new("test".to_string(), engine, false);

        db.add_connection();
        assert_eq!(db.connection_count(), 1);
        assert!(db.is_in_use());

        db.add_connection();
        assert_eq!(db.connection_count(), 2);
    }

    #[test]
    fn test_database_remove_connection_decrements() {
        let dir = tempdir().unwrap();
        let engine = GraphEngine::create(dir.path()).unwrap();
        let db = Database::new("test".to_string(), engine, false);

        db.add_connection();
        db.add_connection();
        assert_eq!(db.connection_count(), 2);

        db.remove_connection();
        assert_eq!(db.connection_count(), 1);

        db.remove_connection();
        assert_eq!(db.connection_count(), 0);
        assert!(!db.is_in_use());
    }

    #[test]
    fn test_database_concurrent_connection_tracking() {
        use std::thread;

        let dir = tempdir().unwrap();
        let engine = GraphEngine::create(dir.path()).unwrap();
        let db = Arc::new(Database::new("test".to_string(), engine, false));

        let mut handles = vec![];

        // Spawn 10 threads that each add then remove a connection
        for _ in 0..10 {
            let db_clone = Arc::clone(&db);
            handles.push(thread::spawn(move || {
                db_clone.add_connection();
                thread::sleep(std::time::Duration::from_millis(1));
                db_clone.remove_connection();
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        // After all threads complete, count should be 0
        assert_eq!(db.connection_count(), 0);
    }

    #[test]
    fn test_database_node_and_edge_count() {
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let db = Database::new("test".to_string(), engine, false);

        assert_eq!(db.node_count(), 1);
        assert_eq!(db.edge_count(), 0);
    }

    #[test]
    fn test_database_ephemeral_flag() {
        let dir = tempdir().unwrap();
        let engine = GraphEngine::create(dir.path()).unwrap();

        let persistent_db = Database::new("persistent".to_string(), engine, false);
        assert!(!persistent_db.ephemeral);

        let dir2 = tempdir().unwrap();
        let engine2 = GraphEngine::create(dir2.path()).unwrap();
        let ephemeral_db = Database::new("ephemeral".to_string(), engine2, true);
        assert!(ephemeral_db.ephemeral);
    }
}

#[cfg(test)]
mod manager_tests {
    use super::*;
    use tempfile::tempdir;

    // ============================================================================
    // Database Creation
    // ============================================================================

    #[test]
    fn test_create_database_persistent() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        let result = manager.create_database("mydb", false);
        assert!(result.is_ok());
        assert!(manager.database_exists("mydb"));
    }

    #[test]
    fn test_create_database_ephemeral() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        let result = manager.create_database("testdb", true);
        assert!(result.is_ok());

        let db = manager.get_database("testdb").unwrap();
        assert!(db.ephemeral);
    }

    #[test]
    fn test_create_database_already_exists() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        manager.create_database("mydb", false).unwrap();

        let result = manager.create_database("mydb", false);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), GraphError::DatabaseExists(_)));
    }

    // ============================================================================
    // Name Validation
    // ============================================================================

    #[test]
    fn test_validate_name_valid() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        assert!(manager.create_database("test", false).is_ok());
        assert!(manager.create_database("test-123", false).is_ok());
        assert!(manager.create_database("test_abc", false).is_ok());
        assert!(manager.create_database("Test123", false).is_ok());
        assert!(manager.create_database("a", false).is_ok()); // min length
    }

    #[test]
    fn test_validate_name_empty() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        let result = manager.create_database("", false);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), GraphError::InvalidDatabaseName(_)));
    }

    #[test]
    fn test_validate_name_too_long() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        let long_name = "a".repeat(129);
        let result = manager.create_database(&long_name, false);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), GraphError::InvalidDatabaseName(_)));
    }

    #[test]
    fn test_validate_name_invalid_chars() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        // Invalid: spaces
        assert!(manager.create_database("test db", false).is_err());
        // Invalid: slashes
        assert!(manager.create_database("test/db", false).is_err());
        // Invalid: dots
        assert!(manager.create_database("test.db", false).is_err());
        // Invalid: special chars
        assert!(manager.create_database("test@db", false).is_err());
    }

    // ============================================================================
    // Database Retrieval
    // ============================================================================

    #[test]
    fn test_get_database_exists() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        manager.create_database("mydb", false).unwrap();

        let db = manager.get_database("mydb");
        assert!(db.is_ok());
        assert_eq!(db.unwrap().name, "mydb");
    }

    #[test]
    fn test_get_database_not_found() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        let result = manager.get_database("nonexistent");
        assert!(result.is_err());
        match result.err().unwrap() {
            GraphError::DatabaseNotFound(name) => assert_eq!(name, "nonexistent"),
            e => panic!("Expected DatabaseNotFound error, got: {:?}", e),
        }
    }

    // ============================================================================
    // Database Dropping
    // ============================================================================

    #[test]
    fn test_drop_database_not_in_use() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        manager.create_database("mydb", false).unwrap();
        assert!(manager.database_exists("mydb"));

        let result = manager.drop_database("mydb");
        assert!(result.is_ok());
        assert!(!manager.database_exists("mydb"));
    }

    #[test]
    fn test_drop_database_in_use() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        manager.create_database("mydb", false).unwrap();

        // Simulate a connection
        let db = manager.get_database("mydb").unwrap();
        db.add_connection();

        // Should fail - database in use
        let result = manager.drop_database("mydb");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), GraphError::DatabaseInUse(_)));

        // After releasing connection, should succeed
        db.remove_connection();
        let result = manager.drop_database("mydb");
        assert!(result.is_ok());
    }

    #[test]
    fn test_drop_database_not_found() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        let result = manager.drop_database("nonexistent");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), GraphError::DatabaseNotFound(_)));
    }

    // ============================================================================
    // Database Listing
    // ============================================================================

    #[test]
    fn test_list_databases_empty() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        let list = manager.list_databases();
        assert!(list.is_empty());
    }

    #[test]
    fn test_list_databases_multiple() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        manager.create_database("db1", false).unwrap();
        manager.create_database("db2", true).unwrap();
        manager.create_database("db3", false).unwrap();

        let list = manager.list_databases();
        assert_eq!(list.len(), 3);

        let names: Vec<&str> = list.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"db1"));
        assert!(names.contains(&"db2"));
        assert!(names.contains(&"db3"));
    }

    #[test]
    fn test_list_databases_info_correct() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        manager.create_database("testdb", true).unwrap();

        let db = manager.get_database("testdb").unwrap();
        db.add_connection();
        db.add_connection();

        let list = manager.list_databases();
        let info = list.iter().find(|d| d.name == "testdb").unwrap();

        assert!(info.ephemeral);
        assert_eq!(info.connection_count, 2);
        assert_eq!(info.node_count, 0);
        assert_eq!(info.edge_count, 0);
    }

    // ============================================================================
    // Ephemeral Database Cleanup (Linus Fix #2)
    // ============================================================================

    #[test]
    fn test_ephemeral_cleanup_on_last_disconnect() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        manager.create_database("ephemeral-test", true).unwrap();
        assert!(manager.database_exists("ephemeral-test"));

        let db = manager.get_database("ephemeral-test").unwrap();
        db.add_connection();
        db.add_connection();

        // First disconnect - still has connections
        db.remove_connection();
        manager.cleanup_ephemeral_if_unused("ephemeral-test");
        assert!(manager.database_exists("ephemeral-test"));

        // Second disconnect - triggers cleanup
        db.remove_connection();
        manager.cleanup_ephemeral_if_unused("ephemeral-test");

        // Ephemeral database should be removed
        assert!(!manager.database_exists("ephemeral-test"));
    }

    #[test]
    fn test_persistent_not_cleaned_on_disconnect() {
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        manager.create_database("persistent-test", false).unwrap();

        let db = manager.get_database("persistent-test").unwrap();
        db.add_connection();
        db.remove_connection();

        // Cleanup check should not remove persistent database
        manager.cleanup_ephemeral_if_unused("persistent-test");
        assert!(manager.database_exists("persistent-test"));
    }

    // ============================================================================
    // Default Database (Backwards Compatibility)
    // ============================================================================

    #[test]
    fn test_create_default_from_path() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("legacy.rfdb");

        // Create legacy database directory
        std::fs::create_dir_all(&db_path).unwrap();

        let manager = DatabaseManager::new(dir.path().to_path_buf());
        let result = manager.create_default_from_path(&db_path);
        assert!(result.is_ok());

        assert!(manager.database_exists("default"));
        let db = manager.get_database("default").unwrap();
        assert!(!db.ephemeral);
    }
}

#[cfg(test)]
mod access_mode_tests {
    use super::*;

    #[test]
    fn test_access_mode_from_str() {
        assert_eq!(AccessMode::from_str("rw"), AccessMode::ReadWrite);
        assert_eq!(AccessMode::from_str("ro"), AccessMode::ReadOnly);
        assert_eq!(AccessMode::from_str("readonly"), AccessMode::ReadOnly);
        assert_eq!(AccessMode::from_str("read-only"), AccessMode::ReadOnly);
        assert_eq!(AccessMode::from_str("anything-else"), AccessMode::ReadWrite);
    }

    #[test]
    fn test_access_mode_as_str() {
        assert_eq!(AccessMode::ReadOnly.as_str(), "ro");
        assert_eq!(AccessMode::ReadWrite.as_str(), "rw");
    }

    #[test]
    fn test_access_mode_is_write() {
        assert!(AccessMode::ReadWrite.is_write());
        assert!(!AccessMode::ReadOnly.is_write());
    }
}
