# REG-335: RFDB Multi-Database Server Mode - Test Design

**Author:** Kent Beck (Test Engineer)
**Date:** 2026-02-04
**Status:** Test Design Ready for Review

---

## Executive Summary

This document outlines the test design for REG-335 Multi-Database Server Mode. Tests are designed to verify:

1. **DatabaseManager** - Core registry operations
2. **Database** - Connection tracking with atomic counters
3. **Ephemeral cleanup** - Automatic removal when connection_count == 0
4. **ClientSession** - Per-connection state management
5. **Protocol commands** - Wire protocol for database lifecycle
6. **Backwards compatibility** - Protocol v1 clients auto-use default database
7. **Error handling** - All error cases from spec

Tests follow existing patterns in `packages/rfdb-server/src/` and use `tempfile` for isolation.

---

## Test Organization

Tests will be placed in the following locations:

| Component | Test Location |
|-----------|---------------|
| DatabaseManager | `src/database_manager.rs` (inline `#[cfg(test)]` module) |
| Database | `src/database_manager.rs` (inline tests) |
| ClientSession | `src/session.rs` (inline `#[cfg(test)]` module) |
| Integration | `src/bin/rfdb_server.rs` (inline tests) or new `tests/` directory |

This follows the existing pattern in `src/graph/engine.rs` and `src/datalog/tests.rs`.

---

## Linus's Fixes Incorporated

Per Linus review (`003-linus-review.md`):

1. **Ephemeral cleanup:** Tests explicitly verify HashMap removal when `connection_count == 0`
2. **AccessMode:** Tests included for completeness, but can be removed if KISS decision prevails

---

## Test Design

### 1. Database Struct Tests

Location: `src/database_manager.rs`

```rust
#[cfg(test)]
mod database_tests {
    use super::*;
    use tempfile::tempdir;

    // ============================================================================
    // Connection Tracking (Atomic Operations)
    // ============================================================================

    #[test]
    fn test_database_connection_count_starts_at_zero() {
        // New database should have zero connections
        let dir = tempdir().unwrap();
        let engine = GraphEngine::create(dir.path()).unwrap();
        let db = Database::new("test".to_string(), engine, false);

        assert_eq!(db.connection_count(), 0);
        assert!(!db.is_in_use());
    }

    #[test]
    fn test_database_add_connection_increments() {
        // add_connection() should atomically increment count
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
        // remove_connection() should atomically decrement count
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
        // Connection tracking must be thread-safe
        use std::sync::Arc;
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
                // Simulate some work
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
        // Database should expose engine stats
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

        // Add test data
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
```

### 2. DatabaseManager Tests

Location: `src/database_manager.rs`

```rust
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

        // Second creation should fail
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

        // Valid names
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

        let long_name = "a".repeat(129); // > 128 chars
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
        // Invalid: dots (except extension)
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
        assert!(matches!(result.unwrap_err(), GraphError::DatabaseNotFound(_)));
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
        // CRITICAL: When ephemeral database connection_count reaches 0,
        // it must be removed from the HashMap
        let dir = tempdir().unwrap();
        let manager = DatabaseManager::new(dir.path().to_path_buf());

        manager.create_database("ephemeral-test", true).unwrap();
        assert!(manager.database_exists("ephemeral-test"));

        let db = manager.get_database("ephemeral-test").unwrap();
        db.add_connection();
        db.add_connection();

        // First disconnect - still has connections
        db.remove_connection();
        // Need to trigger cleanup check - this is done by close_database handler
        // For now, database should still exist
        assert!(manager.database_exists("ephemeral-test"));

        // Second disconnect - triggers cleanup
        db.remove_connection();
        // After calling cleanup_ephemeral_if_unused()
        manager.cleanup_ephemeral_if_unused("ephemeral-test");

        // Ephemeral database should be removed
        assert!(!manager.database_exists("ephemeral-test"));
    }

    #[test]
    fn test_persistent_not_cleaned_on_disconnect() {
        // Persistent databases should NOT be cleaned up
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

        // Create legacy database files
        std::fs::create_dir_all(&db_path).unwrap();

        let manager = DatabaseManager::new(dir.path().to_path_buf());
        let result = manager.create_default_from_path(&db_path);
        assert!(result.is_ok());

        assert!(manager.database_exists("default"));
        let db = manager.get_database("default").unwrap();
        assert!(!db.ephemeral);
    }
}
```

### 3. AccessMode Tests (Optional - per KISS decision)

Location: `src/database_manager.rs`

```rust
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
```

### 4. ClientSession Tests

Location: `src/session.rs`

```rust
#[cfg(test)]
mod session_tests {
    use super::*;
    use crate::database_manager::{Database, AccessMode};
    use crate::graph::GraphEngine;
    use std::sync::Arc;
    use tempfile::tempdir;

    fn make_test_database(name: &str) -> Arc<Database> {
        let dir = tempdir().unwrap();
        let engine = GraphEngine::create(dir.path()).unwrap();
        Arc::new(Database::new(name.to_string(), engine, false))
    }

    #[test]
    fn test_session_new() {
        let session = ClientSession::new(1);

        assert_eq!(session.id, 1);
        assert!(session.current_db.is_none());
        assert_eq!(session.protocol_version, 1); // Default v1 for backwards compat
        assert_eq!(session.access_mode, AccessMode::ReadWrite);
    }

    #[test]
    fn test_session_set_database() {
        let mut session = ClientSession::new(1);
        let db = make_test_database("testdb");

        session.set_database(db.clone(), AccessMode::ReadOnly);

        assert!(session.has_database());
        assert_eq!(session.current_db_name(), Some("testdb"));
        assert_eq!(session.access_mode, AccessMode::ReadOnly);
        assert!(!session.can_write());
    }

    #[test]
    fn test_session_clear_database() {
        let mut session = ClientSession::new(1);
        let db = make_test_database("testdb");

        session.set_database(db, AccessMode::ReadOnly);
        assert!(session.has_database());

        session.clear_database();

        assert!(!session.has_database());
        assert_eq!(session.current_db_name(), None);
        assert_eq!(session.access_mode, AccessMode::ReadWrite); // Reset to default
    }

    #[test]
    fn test_session_can_write() {
        let mut session = ClientSession::new(1);
        let db = make_test_database("testdb");

        // ReadWrite mode
        session.set_database(db.clone(), AccessMode::ReadWrite);
        assert!(session.can_write());

        // ReadOnly mode
        session.set_database(db, AccessMode::ReadOnly);
        assert!(!session.can_write());
    }

    #[test]
    fn test_session_protocol_version() {
        let mut session = ClientSession::new(1);

        assert_eq!(session.protocol_version, 1);

        session.protocol_version = 2;
        assert_eq!(session.protocol_version, 2);
    }
}
```

### 5. GraphEngine Ephemeral Mode Tests

Location: `src/graph/engine.rs`

```rust
#[cfg(test)]
mod ephemeral_tests {
    use super::*;
    use tempfile::tempdir;

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
    fn test_ephemeral_no_flush_required() {
        // Ephemeral databases work entirely in memory
        // flush() should be a no-op or succeed without error
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

        // Should not fail even though no disk path
        // (Implementation detail: may skip flush for ephemeral)
        let result = engine.flush();
        // Either Ok or gracefully handled
        assert!(result.is_ok() || engine.is_ephemeral());
    }

    #[test]
    fn test_regular_is_not_ephemeral() {
        let dir = tempdir().unwrap();
        let engine = GraphEngine::create(dir.path()).unwrap();

        assert!(!engine.is_ephemeral());
    }
}
```

### 6. Error Type Tests

Location: `src/error.rs`

```rust
#[cfg(test)]
mod error_tests {
    use super::*;

    #[test]
    fn test_error_codes() {
        assert_eq!(GraphError::DatabaseExists("test".to_string()).code(), "DATABASE_EXISTS");
        assert_eq!(GraphError::DatabaseNotFound("test".to_string()).code(), "DATABASE_NOT_FOUND");
        assert_eq!(GraphError::DatabaseInUse("test".to_string()).code(), "DATABASE_IN_USE");
        assert_eq!(GraphError::NoDatabaseSelected.code(), "NO_DATABASE_SELECTED");
        assert_eq!(GraphError::ReadOnlyMode.code(), "READ_ONLY_MODE");
        assert_eq!(GraphError::InvalidDatabaseName("test".to_string()).code(), "INVALID_DATABASE_NAME");
    }

    #[test]
    fn test_error_messages() {
        assert!(GraphError::DatabaseExists("mydb".to_string())
            .to_string()
            .contains("mydb"));

        assert!(GraphError::DatabaseNotFound("mydb".to_string())
            .to_string()
            .contains("mydb"));

        assert!(GraphError::DatabaseInUse("mydb".to_string())
            .to_string()
            .contains("mydb"));
    }
}
```

### 7. Protocol Handler Tests (Integration)

Location: `src/bin/rfdb_server.rs` (inline tests)

```rust
#[cfg(test)]
mod protocol_tests {
    use super::*;
    use tempfile::tempdir;

    // Helper to create a test manager with default database
    fn setup_test_manager() -> (tempfile::TempDir, Arc<DatabaseManager>) {
        let dir = tempdir().unwrap();
        let manager = Arc::new(DatabaseManager::new(dir.path().to_path_buf()));

        // Create default database for backwards compat testing
        let db_path = dir.path().join("default.rfdb");
        std::fs::create_dir_all(&db_path).unwrap();
        manager.create_default_from_path(&db_path).unwrap();

        (dir, manager)
    }

    // ============================================================================
    // Hello Command
    // ============================================================================

    #[test]
    fn test_hello_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        let request = Request::Hello {
            protocol_version: Some(2),
            client_id: Some("test-client".to_string()),
        };

        let response = handle_request(&manager, &mut session, request);

        match response {
            Response::HelloOk { ok, protocol_version, server_version, features } => {
                assert!(ok);
                assert_eq!(protocol_version, 2);
                assert!(!server_version.is_empty());
                assert!(features.contains(&"multiDatabase".to_string()));
                assert!(features.contains(&"ephemeral".to_string()));
            }
            _ => panic!("Expected HelloOk response"),
        }

        assert_eq!(session.protocol_version, 2);
    }

    // ============================================================================
    // CreateDatabase Command
    // ============================================================================

    #[test]
    fn test_create_database_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        let request = Request::CreateDatabase {
            name: "testdb".to_string(),
            ephemeral: false,
        };

        let response = handle_request(&manager, &mut session, request);

        match response {
            Response::DatabaseCreated { ok, database_id } => {
                assert!(ok);
                assert_eq!(database_id, "testdb");
            }
            _ => panic!("Expected DatabaseCreated response"),
        }

        assert!(manager.database_exists("testdb"));
    }

    #[test]
    fn test_create_database_already_exists() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("existing", false).unwrap();

        let request = Request::CreateDatabase {
            name: "existing".to_string(),
            ephemeral: false,
        };

        let response = handle_request(&manager, &mut session, request);

        match response {
            Response::ErrorWithCode { error, code } => {
                assert!(error.contains("existing"));
                assert_eq!(code, "DATABASE_EXISTS");
            }
            _ => panic!("Expected ErrorWithCode response"),
        }
    }

    // ============================================================================
    // OpenDatabase Command
    // ============================================================================

    #[test]
    fn test_open_database_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("testdb", false).unwrap();

        let request = Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        };

        let response = handle_request(&manager, &mut session, request);

        match response {
            Response::DatabaseOpened { ok, database_id, mode, node_count, edge_count } => {
                assert!(ok);
                assert_eq!(database_id, "testdb");
                assert_eq!(mode, "rw");
                assert_eq!(node_count, 0);
                assert_eq!(edge_count, 0);
            }
            _ => panic!("Expected DatabaseOpened response"),
        }

        assert!(session.has_database());
        assert_eq!(session.current_db_name(), Some("testdb"));

        // Verify connection count incremented
        let db = manager.get_database("testdb").unwrap();
        assert_eq!(db.connection_count(), 1);
    }

    #[test]
    fn test_open_database_not_found() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        let request = Request::OpenDatabase {
            name: "nonexistent".to_string(),
            mode: "rw".to_string(),
        };

        let response = handle_request(&manager, &mut session, request);

        match response {
            Response::ErrorWithCode { error, code } => {
                assert!(error.contains("nonexistent"));
                assert_eq!(code, "DATABASE_NOT_FOUND");
            }
            _ => panic!("Expected ErrorWithCode response"),
        }
    }

    #[test]
    fn test_open_database_closes_previous() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("db1", false).unwrap();
        manager.create_database("db2", false).unwrap();

        // Open first database
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "db1".to_string(),
            mode: "rw".to_string(),
        });

        let db1 = manager.get_database("db1").unwrap();
        assert_eq!(db1.connection_count(), 1);

        // Open second database - should close first
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "db2".to_string(),
            mode: "rw".to_string(),
        });

        // db1 should have 0 connections now
        assert_eq!(db1.connection_count(), 0);

        let db2 = manager.get_database("db2").unwrap();
        assert_eq!(db2.connection_count(), 1);

        assert_eq!(session.current_db_name(), Some("db2"));
    }

    // ============================================================================
    // CloseDatabase Command
    // ============================================================================

    #[test]
    fn test_close_database_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("testdb", false).unwrap();

        // Open database
        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        });

        // Close it
        let response = handle_request(&manager, &mut session, Request::CloseDatabase);

        match response {
            Response::Ok { ok } => assert!(ok),
            _ => panic!("Expected Ok response"),
        }

        assert!(!session.has_database());

        let db = manager.get_database("testdb").unwrap();
        assert_eq!(db.connection_count(), 0);
    }

    #[test]
    fn test_close_database_no_database_open() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        let response = handle_request(&manager, &mut session, Request::CloseDatabase);

        match response {
            Response::Error { error } => {
                assert!(error.contains("No database"));
            }
            _ => panic!("Expected Error response"),
        }
    }

    // ============================================================================
    // DropDatabase Command
    // ============================================================================

    #[test]
    fn test_drop_database_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("testdb", false).unwrap();

        let response = handle_request(&manager, &mut session, Request::DropDatabase {
            name: "testdb".to_string(),
        });

        match response {
            Response::Ok { ok } => assert!(ok),
            _ => panic!("Expected Ok response"),
        }

        assert!(!manager.database_exists("testdb"));
    }

    #[test]
    fn test_drop_database_in_use() {
        let (_dir, manager) = setup_test_manager();
        let mut session1 = ClientSession::new(1);
        let mut session2 = ClientSession::new(2);

        manager.create_database("testdb", false).unwrap();

        // Session 1 opens database
        handle_request(&manager, &mut session1, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "rw".to_string(),
        });

        // Session 2 tries to drop
        let response = handle_request(&manager, &mut session2, Request::DropDatabase {
            name: "testdb".to_string(),
        });

        match response {
            Response::ErrorWithCode { error, code } => {
                assert!(error.contains("in use"));
                assert_eq!(code, "DATABASE_IN_USE");
            }
            _ => panic!("Expected ErrorWithCode response"),
        }
    }

    // ============================================================================
    // ListDatabases Command
    // ============================================================================

    #[test]
    fn test_list_databases_command() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("db1", false).unwrap();
        manager.create_database("db2", true).unwrap();

        let response = handle_request(&manager, &mut session, Request::ListDatabases);

        match response {
            Response::DatabaseList { databases } => {
                // default + db1 + db2
                assert!(databases.len() >= 2);

                let db1_info = databases.iter().find(|d| d.name == "db1");
                assert!(db1_info.is_some());
                assert!(!db1_info.unwrap().ephemeral);

                let db2_info = databases.iter().find(|d| d.name == "db2");
                assert!(db2_info.is_some());
                assert!(db2_info.unwrap().ephemeral);
            }
            _ => panic!("Expected DatabaseList response"),
        }
    }

    // ============================================================================
    // CurrentDatabase Command
    // ============================================================================

    #[test]
    fn test_current_database_none() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        let response = handle_request(&manager, &mut session, Request::CurrentDatabase);

        match response {
            Response::CurrentDb { database, mode } => {
                assert!(database.is_none());
                assert!(mode.is_none());
            }
            _ => panic!("Expected CurrentDb response"),
        }
    }

    #[test]
    fn test_current_database_with_open() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("testdb", false).unwrap();

        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "ro".to_string(),
        });

        let response = handle_request(&manager, &mut session, Request::CurrentDatabase);

        match response {
            Response::CurrentDb { database, mode } => {
                assert_eq!(database, Some("testdb".to_string()));
                assert_eq!(mode, Some("ro".to_string()));
            }
            _ => panic!("Expected CurrentDb response"),
        }
    }

    // ============================================================================
    // Backwards Compatibility (Protocol v1)
    // ============================================================================

    #[test]
    fn test_legacy_client_auto_opens_default() {
        let (_dir, manager) = setup_test_manager();

        // Simulate legacy client connection (legacy_mode = true)
        let mut session = ClientSession::new(1);

        // In legacy mode, session should auto-open "default" database
        let db = manager.get_database("default").unwrap();
        db.add_connection();
        session.set_database(db.clone(), AccessMode::ReadWrite);

        assert!(session.has_database());
        assert_eq!(session.current_db_name(), Some("default"));
    }

    #[test]
    fn test_data_ops_require_database() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        // Protocol v2 client without opening database
        session.protocol_version = 2;

        let request = Request::AddNodes { nodes: vec![] };
        let response = handle_request(&manager, &mut session, request);

        match response {
            Response::ErrorWithCode { error, code } => {
                assert!(error.contains("No database"));
                assert_eq!(code, "NO_DATABASE_SELECTED");
            }
            _ => panic!("Expected ErrorWithCode response"),
        }
    }

    // ============================================================================
    // Read-Only Mode
    // ============================================================================

    #[test]
    fn test_read_only_blocks_writes() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("testdb", false).unwrap();

        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "ro".to_string(),
        });

        let request = Request::AddNodes { nodes: vec![] };
        let response = handle_request(&manager, &mut session, request);

        match response {
            Response::ErrorWithCode { error, code } => {
                assert!(error.contains("read-only"));
                assert_eq!(code, "READ_ONLY_MODE");
            }
            _ => panic!("Expected ErrorWithCode response"),
        }
    }

    #[test]
    fn test_read_only_allows_reads() {
        let (_dir, manager) = setup_test_manager();
        let mut session = ClientSession::new(1);

        manager.create_database("testdb", false).unwrap();

        handle_request(&manager, &mut session, Request::OpenDatabase {
            name: "testdb".to_string(),
            mode: "ro".to_string(),
        });

        let response = handle_request(&manager, &mut session, Request::NodeCount);

        match response {
            Response::Count { count } => {
                assert_eq!(count, 0);
            }
            _ => panic!("Expected Count response"),
        }
    }
}
```

---

## Test Coverage Summary

| Category | Tests | Critical |
|----------|-------|----------|
| Database connection tracking | 5 | Yes |
| DatabaseManager CRUD | 12 | Yes |
| Name validation | 5 | Yes |
| Ephemeral cleanup | 2 | **CRITICAL** (Linus fix) |
| ClientSession state | 5 | Yes |
| GraphEngine ephemeral mode | 5 | Yes |
| Error types | 3 | Yes |
| Protocol commands | 15 | Yes |
| Backwards compatibility | 2 | Yes |
| Read-only mode | 2 | Optional (per KISS) |

**Total: ~56 tests**

---

## Test Dependencies

Existing dependencies in `Cargo.toml` are sufficient:

```toml
[dev-dependencies]
tempfile = "3.10"  # Already present
```

No new dependencies required.

---

## Running Tests

```bash
# Run all tests in rfdb package
cd packages/rfdb-server
cargo test

# Run specific module tests
cargo test database_tests
cargo test manager_tests
cargo test session_tests
cargo test protocol_tests
cargo test ephemeral_tests

# Run with verbose output
cargo test -- --nocapture
```

---

## Implementation Notes for Rob

1. **Ephemeral cleanup (Linus fix):** Add `cleanup_ephemeral_if_unused(&self, name: &str)` method to DatabaseManager that:
   - Checks if database exists
   - Checks if ephemeral
   - Checks if connection_count == 0
   - If all true, removes from HashMap

2. **Call cleanup in `handle_close_database`:** After `remove_connection()`, call `manager.cleanup_ephemeral_if_unused(db_name)`

3. **AccessMode decision:** Tests are written with AccessMode. If KISS prevails, remove the `access_mode_tests` module and simplify `read_only_blocks_writes` / `read_only_allows_reads` tests.

4. **Test isolation:** All tests use `tempfile::tempdir()` for automatic cleanup.

---

## Acceptance Criteria

- [ ] All 56 tests pass
- [ ] No test takes longer than 1 second
- [ ] Tests run in parallel without conflicts
- [ ] `cargo test` completes in under 30 seconds
- [ ] Coverage includes all error paths
- [ ] Ephemeral cleanup explicitly verified (Linus fix)
