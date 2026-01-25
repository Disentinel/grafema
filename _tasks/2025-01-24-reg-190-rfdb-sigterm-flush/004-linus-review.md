# Linus Torvalds Review: REG-190 SIGTERM/SIGINT Handler

## Verdict: APPROVE ✓

This is correct, pragmatic, and right for the architecture.

## What's Right

1. **Correct crate choice**: `signal-hook` is the standard for synchronous Rust servers. Deliberately avoided tokio::signal (which would require async runtime restructuring). Right decision.

2. **Correct synchronization**: RwLock write lock before flush ensures data consistency with concurrent client threads. No race conditions.

3. **Both signals handled**: SIGINT (Ctrl+C) and SIGTERM—critical for production deployments where processes get killed by supervisors.

4. **Resource cleanup**: Socket file removal prevents stale socket on restart. This is important.

5. **Defensive error handling**:
   - `if let Ok(mut guard)` handles RwLock poisoning gracefully
   - Flush failure still exits (correct—data already lost if flush fails)
   - No unwraps that could panic in shutdown path

6. **Simple, focused change**: ~18 LOC, 1 dependency, no architectural disruption. Clean.

## Potential Issues (All Acceptable)

### Lock Acquisition Has No Timeout (Line 728)
```rust
if let Ok(mut guard) = engine_for_signal.write() {
```

If a client thread is stuck in `handle_client()` (infinite operation), the signal handler blocks waiting for the lock. Ctrl+C becomes unresponsive.

**Why it's acceptable**:
- The server is single-threaded per connection
- `handle_client()` should complete in bounded time
- A truly stuck handler is a bug elsewhere
- Adding timeouts would make the code more complex for a pathological case

**Action**: Monitor this in production. If clients ever hang, that's the real bug to fix.

### RwLock Poisoning Scenario (Line 728)
If a client thread panics while holding write lock, subsequent writes fail (Err). We skip the flush.

**Why it's acceptable**:
- This is a pre-existing architectural issue, not introduced here
- If a client panicked, the database is already in a bad state
- Attempting to continue would be worse than exiting
- Future work: add client isolation / panic handlers

### No Client Warning Before Shutdown
Connected clients don't receive a "server shutting down" message. They get disconnected abruptly.

**Why it's acceptable**:
- Clients should handle disconnection anyway
- This is signal-based shutdown (not graceful close)
- Adding broadcast messages is nice-to-have, not critical
- Out of scope for this task

## Architecture Alignment

The server is synchronous multi-threaded:
```
main thread: accept loop (blocking, infinite)
signal thread: signal handler (spawned, waits on signals)
client threads: handle_client() (spawned per connection)
```

This implementation fits perfectly:
- Signal handler is isolated in its own thread
- Doesn't interfere with accept loop or clients
- Uses RwLock to coordinate with client threads
- Clean shutdown without restructuring

This is exactly what you'd do in production.

## Acceptance Criteria Met

- [x] Server flushes on SIGTERM
- [x] Server flushes on SIGINT (Ctrl+C)
- [x] Clean exit after flush
- [x] Logs indicate shutdown progress
- [x] Socket file cleaned up

## Tech Debt to Track

Add to backlog for future:
1. **Graceful client disconnect**: Broadcast "server shutting down" to clients, wait for disconnect
2. **RwLock poisoning recovery**: Handle case where client panics during write
3. **Signal handler timeout**: If lock acquisition takes >Ns, force exit
4. **Client request deadlines**: Allow clients to be interrupted mid-operation

These are architectural improvements, not problems with this implementation.

## Final Note

This is shipping-quality code. Simple, correct, defensive. Would approve for production.

The only regret is we didn't do this 6 months ago—ungraceful shutdown is a sneaky way to lose data.
