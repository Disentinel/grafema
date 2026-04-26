# ADR: Persistent Daemon Processes for Haskell Analyzers

**Status**: Accepted
**Date**: 2026-03-04
**Context**: grafema-orchestrator performance on real codebases

## Problem

`grafema-orchestrator` spawns `grafema-analyzer` once per file — 286 spawns for the Grafema repo. Benchmark: **268s wall time, 10s CPU** — 96% is GHC runtime initialization overhead (~1s per spawn).

The same pattern exists for `grafema-resolve` (spawned per plugin invocation). While currently only a few invocations, this scales poorly for larger projects with more resolution plugins.

## Decision

Convert all Haskell processes (`grafema-analyzer`, `grafema-resolve`) to persistent daemon mode:

1. **`--daemon` flag**: When present, the process enters a request-response loop on stdin/stdout instead of one-shot execution.
2. **Process pool**: The orchestrator maintains a pool of N daemon processes (matching `--jobs`), dispatching work via the pool.
3. **Backward compatibility**: Without `--daemon`, current one-shot behavior is unchanged.

## Protocol

Length-prefixed MessagePack framing — identical to the existing RFDB protocol:

```
[4-byte BE u32 length][MessagePack payload]
```

### Why MessagePack over JSON

Target analysis time is <1s (M4 Pro), <10s (current Mac). At these scales, serialization overhead matters:
- MessagePack is 20-30% more compact than JSON
- Faster serialization/deserialization
- Full protocol unification with RFDB (same framing, same format)
- Haskell: `msgpack` library with aeson bridge (reuses existing FromJSON/ToJSON instances)
- Rust: `rmp-serde` already in Cargo.toml

### Analyzer request/response

```
→  {"file": "src/foo.ts", "ast": { ... ESTree AST ... }}
←  {"status": "ok", "result": { ... FileAnalysis ... }}
←  {"status": "error", "error": "Parse error: ..."}
```

### Plugin request/response

```
→  {"cmd": "imports", "nodes": [ ... GraphNode[] ... ]}
←  {"status": "ok", "commands": [ ... PluginCommand[] ... ]}
←  {"status": "error", "error": "..."}
```

Wire format is MessagePack binary. Logical structure shown as JSON for readability.

### No multiplexing

One request at a time per process. Parallelism achieved via N processes in the pool (matches `--jobs` semantics). This keeps the Haskell side simple — no concurrent request handling needed.

### Shutdown

EOF on stdin (orchestrator closes the pipe) → Haskell process exits cleanly. The orchestrator's `ProcessPool::shutdown()` drops all stdin handles and waits for child exits.

## Process Pool Design

```rust
pub struct ProcessPool {
    config: PoolConfig,
    workers: Vec<Mutex<Option<Worker>>>,
    available_rx: Mutex<mpsc::Receiver<usize>>,
    return_tx: mpsc::Sender<usize>,
}
```

- Channel-based worker acquisition (natural bounded concurrency)
- `request(&self)` takes shared reference — safe for multiple tokio tasks
- Worker death detection → respawn + retry once
- Separate pools for analyzer and resolve (different binaries, different protocols)

## Performance Target

| Metric | Current | Target |
|--------|---------|--------|
| Wall time (286 files) | 268s | <30s |
| CPU time | 10s | ~10s (same work) |
| GHC init overhead | ~260s (96%) | ~4s (N=4 pool workers) |

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Haskell space leaks in long-running loop | `StrictData` already used; `BangPatterns` in loop; RTS memory cap flag |
| Buffering: Haskell not flushing stdout | `writeFrame` includes explicit `hFlush` |
| Zombie processes on orchestrator crash | Haskell detects stdin EOF → exits; Rust pool has Drop/shutdown |
| Large ASTs (multi-MB ESTree) | 4-byte u32 supports up to 4GB; configurable 100MB limit |
| Worker crash mid-request | Pool respawns worker and retries once |

## Alternatives Considered

1. **HTTP server mode**: More complex, requires port management, unnecessary for stdin/stdout IPC.
2. **Unix socket per worker**: Additional socket management overhead, no benefit over piped stdin/stdout.
3. **Single Haskell process with internal parallelism**: Requires GHC green threads + STM, more complex, harder to control memory per-worker.
4. **JSON framing (not MessagePack)**: Simpler but slower serialization, doesn't unify with RFDB protocol.

## Implementation Plan

Independent tracks:
- **Track A** (Haskell): Framing primitives → Analyzer daemon + Resolve daemon
- **Track B** (Rust): ProcessPool implementation
- **Track C** (Integration): Wire analyzer to pool + Wire plugins to pool → Tests
