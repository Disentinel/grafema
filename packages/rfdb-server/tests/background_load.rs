//! Integration test: server responds to ping before database finishes loading.
//!
//! Validates that:
//! - Unix socket appears within 2 seconds regardless of DB size
//! - Ping returns immediately while DB is still loading
//! - NodeCount returns correct value once DB is loaded
//! - Server handles clients connecting before "default" DB is available
//!
//! Run: `cargo test --test background_load -- --nocapture`

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Helpers: message framing (matches rfdb-server protocol)
// ---------------------------------------------------------------------------

fn write_message(stream: &mut UnixStream, data: &[u8]) -> std::io::Result<()> {
    let len = data.len() as u32;
    stream.write_all(&len.to_be_bytes())?;
    stream.write_all(data)?;
    stream.flush()
}

fn read_message(stream: &mut UnixStream) -> std::io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_be_bytes(len_buf) as usize;
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf)?;
    Ok(buf)
}

fn send_request(stream: &mut UnixStream, request: serde_json::Value) -> serde_json::Value {
    let bytes = rmp_serde::to_vec_named(&request).expect("serialize request");
    write_message(stream, &bytes).expect("write message");
    let resp_bytes = read_message(stream).expect("read response");
    rmp_serde::from_slice(&resp_bytes).expect("deserialize response")
}

fn binary_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_rfdb-server"))
}

// ---------------------------------------------------------------------------
// Helpers: create a pre-populated database on disk
// ---------------------------------------------------------------------------

fn create_db_with_nodes(db_path: &std::path::Path, node_count: usize) {
    use rfdb::graph::GraphEngineV2;
    use rfdb::{GraphStore, NodeRecord};

    let mut engine = GraphEngineV2::create(db_path).unwrap();

    let batch_size = 5000;
    for start in (0..node_count).step_by(batch_size) {
        let end = (start + batch_size).min(node_count);
        let nodes: Vec<NodeRecord> = (start..end)
            .map(|i| NodeRecord {
                id: i as u128,
                node_type: Some("FUNCTION".to_string()),
                file_id: (i % 200) as u32,
                name_offset: i as u32,
                version: "main".to_string(),
                exported: false,
                replaces: None,
                deleted: false,
                name: Some(format!("fn_{}", i)),
                file: Some(format!("src/file_{}.js", i % 200)),
                metadata: None,
                semantic_id: None,
            })
            .collect();
        engine.add_nodes(nodes);
    }

    engine.flush().unwrap();
    assert_eq!(engine.node_count(), node_count);
}

fn wait_for_socket(socket_path: &std::path::Path, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if socket_path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Socket must appear quickly even with a pre-existing database.
///
/// Current behavior (before fix): socket only appears AFTER DB is loaded.
/// Expected behavior (after fix): socket appears within 2s, before DB load.
#[test]
fn socket_appears_before_db_load_completes() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let db_path = tempdir.path().join("graph.rfdb");
    let socket_path = tempdir.path().join("rfdb.sock");
    let data_dir = tempdir.path().to_path_buf();

    // Create a non-trivial DB (100k nodes) so loading takes measurable time
    create_db_with_nodes(&db_path, 100_000);

    let mut child = Command::new(binary_path())
        .arg(&db_path)
        .arg("--socket")
        .arg(&socket_path)
        .arg("--data-dir")
        .arg(&data_dir)
        .arg("--no-ui")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn rfdb-server");

    // Socket must appear within 2 seconds (well before any DB load completes)
    let appeared = wait_for_socket(&socket_path, Duration::from_secs(2));

    if !appeared {
        let _ = child.kill();
        let _ = child.wait();
        panic!("Socket did not appear within 2 seconds — server blocks on DB load before binding");
    }

    // Cleanup
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    let _ = child.wait();
}

/// Ping must respond immediately, even if DB hasn't loaded yet.
#[test]
fn ping_responds_while_db_loading() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let db_path = tempdir.path().join("graph.rfdb");
    let socket_path = tempdir.path().join("rfdb.sock");
    let data_dir = tempdir.path().to_path_buf();

    create_db_with_nodes(&db_path, 100_000);

    let mut child = Command::new(binary_path())
        .arg(&db_path)
        .arg("--socket")
        .arg(&socket_path)
        .arg("--data-dir")
        .arg(&data_dir)
        .arg("--no-ui")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn rfdb-server");

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(30)),
        "Socket must appear within 30s"
    );

    // Connect and send Ping — must respond within 1 second
    let mut stream = UnixStream::connect(&socket_path).expect("connect to socket");
    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();

    let ping_start = Instant::now();
    let response = send_request(&mut stream, serde_json::json!({
        "requestId": "r1",
        "cmd": "ping"
    }));
    let ping_duration = ping_start.elapsed();

    assert!(
        response.get("pong").and_then(|v| v.as_bool()) == Some(true),
        "Expected Pong response, got: {:?}",
        response
    );
    assert!(
        ping_duration < Duration::from_secs(1),
        "Ping took {:?} — should respond immediately, not wait for DB load",
        ping_duration
    );

    drop(stream);

    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    let _ = child.wait();
}

/// After DB finishes loading, NodeCount must return the correct value.
#[test]
fn node_count_correct_after_load() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let db_path = tempdir.path().join("graph.rfdb");
    let socket_path = tempdir.path().join("rfdb.sock");
    let data_dir = tempdir.path().to_path_buf();

    let expected_nodes: usize = 10_000;
    create_db_with_nodes(&db_path, expected_nodes);

    let mut child = Command::new(binary_path())
        .arg(&db_path)
        .arg("--socket")
        .arg(&socket_path)
        .arg("--data-dir")
        .arg(&data_dir)
        .arg("--no-ui")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn rfdb-server");

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(30)),
        "Socket must appear"
    );

    // Wait a bit for DB to load, then query
    // (In background-load mode, we may need to retry until DB is ready)
    let mut stream = UnixStream::connect(&socket_path).expect("connect to socket");
    stream.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();

    // NodeCount via legacy mode (server auto-opens "default" DB in legacy mode).
    // With background loading, the server should either:
    // (a) wait until DB is ready and return the count, or
    // (b) return 0/error initially, then correct count once loaded
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut got_count = false;

    while Instant::now() < deadline {
        let response = send_request(&mut stream, serde_json::json!({
            "requestId": "r1",
            "cmd": "nodeCount"
        }));

        if let Some(count) = response.get("count").and_then(|v| v.as_u64()) {
            if count == expected_nodes as u64 {
                got_count = true;
                break;
            }
        }

        // If we got an error (DB not ready yet), wait and retry
        std::thread::sleep(Duration::from_millis(200));

        // Reconnect since legacy mode may not have DB set
        drop(stream);
        stream = UnixStream::connect(&socket_path).expect("reconnect");
        stream.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
    }

    assert!(
        got_count,
        "NodeCount must return {} within 30 seconds after server start",
        expected_nodes
    );

    drop(stream);

    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    let _ = child.wait();
}

/// Empty database (first start): server should start instantly and respond.
#[test]
fn empty_db_starts_instantly() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let db_path = tempdir.path().join("graph.rfdb");
    let socket_path = tempdir.path().join("rfdb.sock");
    let data_dir = tempdir.path().to_path_buf();

    // Don't create any DB — first start creates an empty one

    let start = Instant::now();

    let mut child = Command::new(binary_path())
        .arg(&db_path)
        .arg("--socket")
        .arg(&socket_path)
        .arg("--data-dir")
        .arg(&data_dir)
        .arg("--no-ui")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn rfdb-server");

    assert!(
        wait_for_socket(&socket_path, Duration::from_secs(5)),
        "Socket must appear for empty DB"
    );

    let startup_time = start.elapsed();

    // Connect, ping, and check node count = 0
    let mut stream = UnixStream::connect(&socket_path).expect("connect");
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();

    let response = send_request(&mut stream, serde_json::json!({
        "requestId": "r1",
        "cmd": "ping"
    }));
    assert_eq!(response.get("pong").and_then(|v| v.as_bool()), Some(true));

    let response = send_request(&mut stream, serde_json::json!({
        "requestId": "r2",
        "cmd": "nodeCount"
    }));
    assert_eq!(
        response.get("count").and_then(|v| v.as_u64()),
        Some(0),
        "Empty DB must have 0 nodes"
    );

    eprintln!("[test] Empty DB startup time: {:?}", startup_time);

    drop(stream);

    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    let _ = child.wait();
}
