//! ClientSession - Per-connection state management
//!
//! Each client connection to the RFDB server has its own session
//! that tracks the currently selected database and access mode.

use std::sync::Arc;
use crate::database_manager::{Database, AccessMode, ClientId};

/// Session state for a client connection
///
/// Created when a client connects and destroyed when they disconnect.
/// Tracks which database the client is currently using and their access mode.
pub struct ClientSession {
    /// Unique client ID for this connection
    pub id: ClientId,
    /// Currently selected database (None if no database open)
    pub current_db: Option<Arc<Database>>,
    /// Access mode for current database (ReadOnly or ReadWrite)
    pub access_mode: AccessMode,
    /// Protocol version negotiated with client (1 = legacy, 2 = multi-db)
    pub protocol_version: u32,
}

impl ClientSession {
    /// Create a new session for a client connection
    ///
    /// # Arguments
    /// * `id` - Unique client ID
    pub fn new(id: ClientId) -> Self {
        Self {
            id,
            current_db: None,
            access_mode: AccessMode::ReadWrite,
            protocol_version: 1, // Default to v1 for backwards compatibility
        }
    }

    /// Set current database and access mode
    ///
    /// Called when client opens a database.
    pub fn set_database(&mut self, db: Arc<Database>, mode: AccessMode) {
        self.current_db = Some(db);
        self.access_mode = mode;
    }

    /// Clear current database
    ///
    /// Called when client closes database or disconnects.
    pub fn clear_database(&mut self) {
        self.current_db = None;
        self.access_mode = AccessMode::ReadWrite;
    }

    /// Get current database name
    pub fn current_db_name(&self) -> Option<&str> {
        self.current_db.as_ref().map(|db| db.name.as_str())
    }

    /// Check if write operations are allowed
    pub fn can_write(&self) -> bool {
        self.access_mode.is_write()
    }

    /// Check if a database is currently selected
    pub fn has_database(&self) -> bool {
        self.current_db.is_some()
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;
    use crate::database_manager::Database;
    use crate::graph::GraphEngine;
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
