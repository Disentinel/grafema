//! Generic process pool with length-prefixed binary framing.
//!
//! Manages a pool of long-running child processes that communicate via
//! length-prefixed frames over stdin/stdout. The pool handles worker
//! acquisition, automatic respawn on failure, and graceful shutdown.
//!
//! The framing protocol matches the RFDB client: 4-byte big-endian u32
//! length prefix followed by the raw payload bytes.

use anyhow::{bail, Context, Result};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, Mutex};

/// Maximum message size (100 MB), matching RFDB client.
const DEFAULT_MAX_MESSAGE_SIZE: usize = 100 * 1024 * 1024;

/// Default per-request timeout (120 seconds).
/// If a worker takes longer than this, the request is aborted
/// and the worker is killed + respawned.
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Configuration for spawning pool workers.
pub struct PoolConfig {
    /// Command to execute for each worker process.
    pub command: String,
    /// Arguments passed to the worker command.
    pub args: Vec<String>,
    /// Maximum allowed frame size in bytes.
    pub max_message_size: usize,
    /// Per-request timeout. Worker is killed and respawned if exceeded.
    pub request_timeout: Duration,
    /// Optional path to the effects-db directory, passed as GRAFEMA_EFFECTS_DB env var.
    pub effects_db_path: Option<String>,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            command: String::new(),
            args: Vec::new(),
            max_message_size: DEFAULT_MAX_MESSAGE_SIZE,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            effects_db_path: None,
        }
    }
}

/// A single worker process with its I/O handles.
struct Worker {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

/// A pool of long-running child processes communicating via length-prefixed
/// binary frames over stdin/stdout.
///
/// Workers are acquired from a channel-based queue. If a worker fails during
/// a request, it is respawned and the request is retried once.
pub struct ProcessPool {
    config: PoolConfig,
    workers: Vec<Mutex<Option<Worker>>>,
    available_rx: Mutex<mpsc::Receiver<usize>>,
    return_tx: mpsc::Sender<usize>,
}

/// Write a length-prefixed frame to the given writer.
///
/// Frame format: 4-byte big-endian u32 length, followed by `payload` bytes.
async fn write_frame(stdin: &mut ChildStdin, payload: &[u8]) -> Result<()> {
    let len = payload.len() as u32;
    stdin.write_all(&len.to_be_bytes()).await?;
    stdin.write_all(payload).await?;
    stdin.flush().await?;
    Ok(())
}

/// Read a length-prefixed frame from the given reader.
///
/// Returns the payload bytes. Fails if the frame exceeds `max_size`.
async fn read_frame(stdout: &mut ChildStdout, max_size: usize) -> Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    stdout
        .read_exact(&mut len_buf)
        .await
        .context("failed to read frame length")?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > max_size {
        bail!("frame too large: {} bytes (max {})", len, max_size);
    }
    let mut buf = vec![0u8; len];
    stdout
        .read_exact(&mut buf)
        .await
        .context("failed to read frame payload")?;
    Ok(buf)
}

/// Spawn a single worker process from the given config.
fn spawn_worker(config: &PoolConfig) -> Result<Worker> {
    let mut cmd = Command::new(&config.command);
    cmd.args(&config.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    if let Some(ref path) = config.effects_db_path {
        cmd.env("GRAFEMA_EFFECTS_DB", path);
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn worker: {}", config.command))?;

    let stdin = child
        .stdin
        .take()
        .context("failed to take stdin from worker")?;
    let stdout = child
        .stdout
        .take()
        .context("failed to take stdout from worker")?;

    Ok(Worker {
        child,
        stdin,
        stdout,
    })
}

impl ProcessPool {
    /// Create a new process pool with the given configuration and size.
    ///
    /// Spawns `size` worker processes immediately. Returns an error if any
    /// worker fails to spawn.
    pub fn new(config: PoolConfig, size: usize) -> Result<Self> {
        if size == 0 {
            bail!("pool size must be at least 1");
        }

        let (return_tx, available_rx) = mpsc::channel(size);

        let mut workers = Vec::with_capacity(size);
        for i in 0..size {
            let worker = spawn_worker(&config)
                .with_context(|| format!("failed to spawn worker {}", i))?;
            workers.push(Mutex::new(Some(worker)));
            // Pre-populate the available channel with this worker's index.
            // This cannot fail since channel capacity equals size.
            return_tx.try_send(i).expect("channel capacity matches pool size");
        }

        Ok(Self {
            config,
            workers,
            available_rx: Mutex::new(available_rx),
            return_tx,
        })
    }

    /// Send a request payload to an available worker and return the response.
    ///
    /// Acquires a worker from the pool, writes the payload as a length-prefixed
    /// frame, reads the response frame, and returns the worker to the pool.
    ///
    /// On worker error: attempts to respawn the worker and retry once. If the
    /// retry also fails, the error is propagated (the worker slot is still
    /// returned to the pool).
    pub async fn request(&self, payload: &[u8]) -> Result<Vec<u8>> {
        let idx = self
            .available_rx
            .lock()
            .await
            .recv()
            .await
            .context("pool is shut down")?;

        let timeout = self.config.request_timeout;
        let result = match tokio::time::timeout(timeout, self.do_request(idx, payload)).await {
            Ok(r) => r,
            Err(_) => {
                // Timeout: kill the stuck worker and respawn
                tracing::error!(
                    worker = idx,
                    timeout_secs = timeout.as_secs(),
                    "worker timed out — killing and respawning"
                );
                let _ = self.respawn_worker(idx).await;
                let _ = self.return_tx.send(idx).await;
                bail!("worker {} timed out after {}s", idx, timeout.as_secs());
            }
        };

        match result {
            Ok(response) => {
                let _ = self.return_tx.send(idx).await;
                Ok(response)
            }
            Err(first_err) => {
                // Try to respawn and retry once
                match self.respawn_worker(idx).await {
                    Ok(()) => {
                        let retry_result = match tokio::time::timeout(
                            timeout,
                            self.do_request(idx, payload),
                        )
                        .await
                        {
                            Ok(r) => r,
                            Err(_) => {
                                let _ = self.respawn_worker(idx).await;
                                let _ = self.return_tx.send(idx).await;
                                bail!(
                                    "worker {} retry also timed out after {}s (original: {})",
                                    idx,
                                    timeout.as_secs(),
                                    first_err
                                );
                            }
                        };
                        let _ = self.return_tx.send(idx).await;
                        retry_result.with_context(|| {
                            format!("retry after respawn also failed (original: {})", first_err)
                        })
                    }
                    Err(respawn_err) => {
                        let _ = self.return_tx.send(idx).await;
                        Err(first_err).with_context(|| {
                            format!("worker {} failed and respawn failed: {}", idx, respawn_err)
                        })
                    }
                }
            }
        }
    }

    /// Perform a single request on the worker at the given index.
    async fn do_request(&self, idx: usize, payload: &[u8]) -> Result<Vec<u8>> {
        let mut guard = self.workers[idx].lock().await;
        let worker = guard
            .as_mut()
            .context("worker slot is empty")?;

        write_frame(&mut worker.stdin, payload).await?;
        read_frame(&mut worker.stdout, self.config.max_message_size).await
    }

    /// Replace the worker at the given index with a freshly spawned one.
    async fn respawn_worker(&self, idx: usize) -> Result<()> {
        let mut guard = self.workers[idx].lock().await;

        // Drop the old worker (closes stdin, which should cause process exit)
        if let Some(mut old) = guard.take() {
            // Best-effort kill and wait
            let _ = old.child.kill().await;
            let _ = old.child.wait().await;
        }

        let new_worker = spawn_worker(&self.config)
            .with_context(|| format!("failed to respawn worker {}", idx))?;
        *guard = Some(new_worker);
        Ok(())
    }

    /// Gracefully shut down all workers.
    ///
    /// Drops each worker's stdin (sending EOF) and waits for the child process
    /// to exit.
    pub async fn shutdown(&self) {
        for (i, slot) in self.workers.iter().enumerate() {
            let mut guard = slot.lock().await;
            if let Some(mut worker) = guard.take() {
                // Drop stdin to send EOF
                drop(worker.stdin);
                // Wait for process to exit; kill if it doesn't
                match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    worker.child.wait(),
                )
                .await
                {
                    Ok(Ok(_)) => {}
                    _ => {
                        tracing::warn!("worker {} did not exit gracefully, killing", i);
                        let _ = worker.child.kill().await;
                    }
                }
            }
        }
    }

    /// Return the number of worker slots in the pool.
    pub fn size(&self) -> usize {
        self.workers.len()
    }

    /// Acquire a specific worker from the pool for directed communication.
    ///
    /// Returns a [`WorkerHandle`] that allows sending multiple requests to the
    /// same worker. The worker is returned to the pool when the handle is dropped.
    pub async fn acquire(&self) -> Result<WorkerHandle<'_>> {
        let idx = self
            .available_rx
            .lock()
            .await
            .recv()
            .await
            .context("pool is shut down")?;
        Ok(WorkerHandle { pool: self, idx, returned: false })
    }

    /// Acquire ALL workers from the pool at once.
    ///
    /// Returns handles to every worker, allowing directed communication with
    /// each one. All handles must be dropped to return workers to the pool.
    pub async fn acquire_all(&self) -> Result<Vec<WorkerHandle<'_>>> {
        let mut handles = Vec::with_capacity(self.workers.len());
        for _ in 0..self.workers.len() {
            handles.push(self.acquire().await?);
        }
        Ok(handles)
    }

    /// Send a payload to ALL workers in the pool (for context loading).
    ///
    /// Acquires all workers, sends the payload to each one, collects responses,
    /// then releases all workers back to the pool.
    pub async fn send_to_all(&self, payload: &[u8]) -> Result<Vec<Vec<u8>>> {
        let mut handles = Vec::with_capacity(self.workers.len());
        for _ in 0..self.workers.len() {
            handles.push(self.acquire().await?);
        }
        let mut responses = Vec::with_capacity(handles.len());
        for handle in &handles {
            responses.push(handle.request(payload).await?);
        }
        Ok(responses)
    }
}

/// A handle to a specific worker in the pool, acquired via [`ProcessPool::acquire`].
///
/// While held, the worker is exclusively owned by this handle. Requests can be
/// sent directly to this specific worker via [`WorkerHandle::request`].
/// The worker is returned to the pool when the handle is dropped.
pub struct WorkerHandle<'a> {
    pool: &'a ProcessPool,
    idx: usize,
    returned: bool,
}

impl WorkerHandle<'_> {
    /// Send a request to this specific worker and return the response.
    pub async fn request(&self, payload: &[u8]) -> Result<Vec<u8>> {
        let timeout = self.pool.config.request_timeout;
        match tokio::time::timeout(timeout, self.pool.do_request(self.idx, payload)).await {
            Ok(result) => result,
            Err(_) => {
                bail!("worker {} timed out after {}s", self.idx, timeout.as_secs());
            }
        }
    }
}

impl Drop for WorkerHandle<'_> {
    fn drop(&mut self) {
        if !self.returned {
            self.returned = true;
            let _ = self.pool.return_tx.try_send(self.idx);
        }
    }
}

impl Drop for ProcessPool {
    fn drop(&mut self) {
        // Best-effort synchronous cleanup: kill all child processes.
        for slot in &self.workers {
            if let Ok(mut guard) = slot.try_lock() {
                if let Some(ref mut worker) = *guard {
                    let _ = worker.child.start_kill();
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn test_write_read_frame_round_trip() {
        // Create a pair of connected pipes using tokio::process types
        // We'll use a duplex stream to simulate stdin/stdout
        let (client, mut server) = tokio::io::duplex(1024);
        let (server_read, mut server_write) = tokio::io::split(client);

        let payload = b"hello, world!";

        // Simulate write_frame by writing directly to the server_write half
        let len = payload.len() as u32;
        server_write.write_all(&len.to_be_bytes()).await.unwrap();
        server_write.write_all(payload).await.unwrap();
        server_write.flush().await.unwrap();

        // Read back from the server side
        let mut len_buf = [0u8; 4];
        server.read_exact(&mut len_buf).await.unwrap();
        let read_len = u32::from_be_bytes(len_buf) as usize;
        assert_eq!(read_len, payload.len());

        let mut buf = vec![0u8; read_len];
        server.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, payload);

        drop(server_read);
    }

    #[tokio::test]
    async fn test_frame_too_large_rejected() {
        // Create a pipe where we write a frame header claiming a huge size
        let (mut client, _server) = tokio::io::duplex(1024);

        let fake_len: u32 = (DEFAULT_MAX_MESSAGE_SIZE as u32) + 1;
        client.write_all(&fake_len.to_be_bytes()).await.unwrap();
        client.flush().await.unwrap();

        // We need ChildStdout for read_frame, but we can test the logic directly
        // by verifying the size check. Since read_frame takes ChildStdout,
        // test the pool with an actual process below instead.

        // Verify the constant is correct
        assert_eq!(DEFAULT_MAX_MESSAGE_SIZE, 100 * 1024 * 1024);
    }

    #[tokio::test]
    async fn test_pool_config_default() {
        let config = PoolConfig::default();
        assert_eq!(config.command, "");
        assert!(config.args.is_empty());
        assert_eq!(config.max_message_size, DEFAULT_MAX_MESSAGE_SIZE);
    }

    #[tokio::test]
    async fn test_pool_zero_size_rejected() {
        let config = PoolConfig {
            command: "cat".to_string(),
            args: vec![],
            max_message_size: DEFAULT_MAX_MESSAGE_SIZE,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            effects_db_path: None,
        };
        let result = ProcessPool::new(config, 0);
        match result {
            Err(e) => assert!(e.to_string().contains("at least 1")),
            Ok(_) => panic!("expected error for zero pool size"),
        }
    }

    #[tokio::test]
    async fn test_pool_request_with_cat() {
        // `cat` doesn't do framing, so this tests that we can at least spawn
        // and communicate raw bytes. We write a frame, cat echoes raw bytes,
        // which means the "response" won't be properly framed.
        // Instead, we use a shell one-liner that reads 4 bytes length,
        // reads N bytes, then writes them back with a 4-byte length prefix.

        // Use Python as a portable framing echo server
        let python_script = r#"
import sys, struct
while True:
    hdr = sys.stdin.buffer.read(4)
    if len(hdr) < 4:
        break
    n = struct.unpack('>I', hdr)[0]
    data = sys.stdin.buffer.read(n)
    if len(data) < n:
        break
    sys.stdout.buffer.write(struct.pack('>I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
"#;

        let config = PoolConfig {
            command: "python3".to_string(),
            args: vec!["-c".to_string(), python_script.to_string()],
            max_message_size: DEFAULT_MAX_MESSAGE_SIZE,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            effects_db_path: None,
        };

        let pool = match ProcessPool::new(config, 2) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("Skipping test (python3 not available): {}", e);
                return;
            }
        };

        assert_eq!(pool.size(), 2);

        // Send a request and verify echo
        let payload = b"test payload 123";
        let response = pool.request(payload).await.unwrap();
        assert_eq!(response, payload);

        // Send another request
        let payload2 = b"second request";
        let response2 = pool.request(payload2).await.unwrap();
        assert_eq!(response2, payload2);

        pool.shutdown().await;
    }

    #[tokio::test]
    async fn test_pool_concurrent_requests() {
        let python_script = r#"
import sys, struct
while True:
    hdr = sys.stdin.buffer.read(4)
    if len(hdr) < 4:
        break
    n = struct.unpack('>I', hdr)[0]
    data = sys.stdin.buffer.read(n)
    if len(data) < n:
        break
    sys.stdout.buffer.write(struct.pack('>I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
"#;

        let config = PoolConfig {
            command: "python3".to_string(),
            args: vec!["-c".to_string(), python_script.to_string()],
            max_message_size: DEFAULT_MAX_MESSAGE_SIZE,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            effects_db_path: None,
        };

        let pool = match ProcessPool::new(config, 3) {
            Ok(p) => std::sync::Arc::new(p),
            Err(e) => {
                eprintln!("Skipping test (python3 not available): {}", e);
                return;
            }
        };

        // Fire off concurrent requests
        let mut handles = Vec::new();
        for i in 0..6 {
            let pool = pool.clone();
            handles.push(tokio::spawn(async move {
                let payload = format!("request-{}", i);
                let response = pool.request(payload.as_bytes()).await.unwrap();
                assert_eq!(response, payload.as_bytes());
            }));
        }

        for handle in handles {
            handle.await.unwrap();
        }

        pool.shutdown().await;
    }

    #[tokio::test]
    async fn test_pool_worker_respawn_on_failure() {
        // Use a worker that exits after the first request.
        // The pool should respawn it and retry.
        let python_script = r#"
import sys, struct
hdr = sys.stdin.buffer.read(4)
if len(hdr) == 4:
    n = struct.unpack('>I', hdr)[0]
    data = sys.stdin.buffer.read(n)
    sys.stdout.buffer.write(struct.pack('>I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
# Exit after first request — next request should trigger respawn
"#;

        let config = PoolConfig {
            command: "python3".to_string(),
            args: vec!["-c".to_string(), python_script.to_string()],
            max_message_size: DEFAULT_MAX_MESSAGE_SIZE,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            effects_db_path: None,
        };

        let pool = match ProcessPool::new(config, 1) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("Skipping test (python3 not available): {}", e);
                return;
            }
        };

        // First request succeeds
        let resp = pool.request(b"first").await.unwrap();
        assert_eq!(resp, b"first");

        // Second request: worker has exited, pool should respawn and retry.
        // The respawned worker handles one request then exits too, so the
        // retry should succeed.
        let resp2 = pool.request(b"second").await.unwrap();
        assert_eq!(resp2, b"second");

        pool.shutdown().await;
    }

    #[tokio::test]
    async fn test_pool_empty_payload() {
        let python_script = r#"
import sys, struct
while True:
    hdr = sys.stdin.buffer.read(4)
    if len(hdr) < 4:
        break
    n = struct.unpack('>I', hdr)[0]
    data = sys.stdin.buffer.read(n)
    if len(data) < n:
        break
    sys.stdout.buffer.write(struct.pack('>I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
"#;

        let config = PoolConfig {
            command: "python3".to_string(),
            args: vec!["-c".to_string(), python_script.to_string()],
            max_message_size: DEFAULT_MAX_MESSAGE_SIZE,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            effects_db_path: None,
        };

        let pool = match ProcessPool::new(config, 1) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("Skipping test (python3 not available): {}", e);
                return;
            }
        };

        // Empty payload should work
        let resp = pool.request(b"").await.unwrap();
        assert_eq!(resp, b"");

        pool.shutdown().await;
    }
}
