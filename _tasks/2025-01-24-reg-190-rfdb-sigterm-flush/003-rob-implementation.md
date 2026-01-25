# Rob Pike Implementation Report: REG-190 SIGTERM/SIGINT Handler

## Summary

Implemented graceful shutdown with flush for RFDB server. On SIGINT (Ctrl+C) or SIGTERM, the server now flushes all in-memory data to disk before exiting.

## Changes Made

### 1. Added dependency: `rust-engine/Cargo.toml`

```toml
# Signal handling for graceful shutdown
signal-hook = "0.3"
```

### 2. Added signal handler: `rust-engine/src/bin/rfdb_server.rs`

Added 18 lines of code before the accept loop:

```rust
// Set up signal handler for graceful shutdown
let engine_for_signal = Arc::clone(&engine);
let socket_path_for_signal = socket_path.to_string();
let mut signals = signal_hook::iterator::Signals::new(&[
    signal_hook::consts::SIGINT,
    signal_hook::consts::SIGTERM,
]).expect("Failed to register signal handlers");

thread::spawn(move || {
    for sig in signals.forever() {
        eprintln!("[rfdb-server] Received signal {}, flushing...", sig);

        if let Ok(mut guard) = engine_for_signal.write() {
            match guard.flush() {
                Ok(()) => eprintln!("[rfdb-server] Flush complete"),
                Err(e) => eprintln!("[rfdb-server] Flush failed: {}", e),
            }
        }

        let _ = std::fs::remove_file(&socket_path_for_signal);
        eprintln!("[rfdb-server] Exiting");
        std::process::exit(0);
    }
});
```

## Build Verification

```
$ cd rust-engine && cargo build --release
    Finished `release` profile [optimized] target(s) in 3m 50s
```

Binary size: 1,200,652 bytes (was 1,118,260 bytes - ~82KB increase from signal-hook)

## Behavior

1. **SIGINT (Ctrl+C)**: Triggers graceful shutdown
2. **SIGTERM**: Triggers graceful shutdown
3. **Shutdown sequence**:
   - Log: `[rfdb-server] Received signal N, flushing...`
   - Acquire write lock on engine
   - Call `engine.flush()`
   - Log: `[rfdb-server] Flush complete` (or error)
   - Remove socket file
   - Log: `[rfdb-server] Exiting`
   - Exit with code 0

## Edge Cases Handled

- **Signal during active operation**: RwLock ensures signal handler waits for current write to complete
- **Empty delta**: `flush()` is a no-op if delta is empty (cheap)
- **Multiple signals**: First signal triggers exit, subsequent ignored
- **Socket cleanup**: Socket file removed on shutdown (prevents "address already in use" on restart)

## Not Implemented

- Integration test for signal handling (requires spawning server process, sending signal, checking data)
- This can be added as a follow-up task if needed

## Files Modified

- `/Users/vadimr/grafema/rust-engine/Cargo.toml` - Added signal-hook dependency
- `/Users/vadimr/grafema/rust-engine/src/bin/rfdb_server.rs` - Added signal handler (~18 LOC)
