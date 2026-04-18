//! Integration test: `--http-port 0` → OS-assigned port + lockfile (DAI-15).
//!
//! Spawns `rfdb-server` with `--http-port 0`, then asserts:
//!   1. The server binds successfully on a free OS-picked port.
//!   2. A `rfdb-http.port` lockfile appears in the data dir containing that
//!      port number.
//!   3. The server's stderr includes `[rfdb-server] HTTP listening on port N`
//!      with the same N.
//!   4. Sending SIGTERM removes the lockfile on graceful shutdown.
//!
//! This protects the contract relied on by the VS Code extension: callers
//! discover the HTTP port from the lockfile rather than guessing 3335.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

fn binary_path() -> PathBuf {
    // `CARGO_BIN_EXE_<name>` is set by cargo for integration tests and
    // points at the freshly-built binary under target/{debug,release}/.
    PathBuf::from(env!("CARGO_BIN_EXE_rfdb-server"))
}

#[test]
fn http_port_zero_writes_lockfile_and_logs_actual_port() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let db_path = tempdir.path().join("graph.rfdb");
    std::fs::create_dir_all(&db_path).expect("create db dir");

    let data_dir = tempdir.path().to_path_buf();
    let lockfile = data_dir.join("rfdb-http.port");
    let socket_path = tempdir.path().join("rfdb.sock");

    let mut child = Command::new(binary_path())
        .arg(&db_path)
        .arg("--socket")
        .arg(&socket_path)
        .arg("--data-dir")
        .arg(&data_dir)
        .arg("--http-port")
        .arg("0")
        .arg("--no-ui")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn rfdb-server");

    // Stream stderr on a background thread so the child doesn't block on
    // a full pipe; capture lines via a channel so we can grep for the
    // "HTTP listening on port N" marker without dropping output.
    let stderr = child.stderr.take().expect("take stderr");
    let (tx, rx) = mpsc::channel::<String>();
    let stderr_thread = thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });

    // Poll for lockfile up to 30s — warmup + bind can be slow on cold runs.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut lockfile_port: Option<u16> = None;
    while Instant::now() < deadline {
        if lockfile.exists() {
            let txt = std::fs::read_to_string(&lockfile).unwrap_or_default();
            if let Ok(n) = txt.trim().parse::<u16>() {
                if n > 0 {
                    lockfile_port = Some(n);
                    break;
                }
            }
        }
        thread::sleep(Duration::from_millis(100));
    }

    let port = match lockfile_port {
        Some(p) => p,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "rfdb-http.port lockfile did not appear at {} within 30s",
                lockfile.display()
            );
        }
    };

    // Drain stderr messages captured so far and assert the canonical line.
    let mut seen_marker = false;
    let marker_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < marker_deadline && !seen_marker {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                if line.contains(&format!("HTTP listening on port {}", port)) {
                    seen_marker = true;
                }
            }
            Err(_) => {}
        }
    }

    // Graceful shutdown — unix-only; send SIGTERM and confirm the lockfile
    // is cleaned up.
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        let pid = child.id() as i32;
        unsafe { libc::kill(pid, libc::SIGTERM) };
        let status = child.wait().expect("wait child");
        // The signal handler calls std::process::exit(0); accept either a
        // clean exit code 0 or termination by SIGTERM as valid shutdown.
        assert!(
            status.success()
                || status.signal() == Some(libc::SIGTERM)
                || status.code() == Some(0),
            "unexpected exit: {:?}",
            status
        );

        assert!(
            !lockfile.exists(),
            "lockfile {} should be removed on graceful shutdown",
            lockfile.display()
        );
    }

    #[cfg(not(unix))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }

    let _ = stderr_thread.join();
    assert!(
        seen_marker,
        "stderr should include '[rfdb-server] HTTP listening on port {}'",
        port
    );
}
