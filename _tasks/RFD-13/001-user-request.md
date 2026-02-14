# RFD-13: T4.3 Client Streaming

## Linear Issue
https://linear.app/reginaflow/issue/RFD-13/t43-client-streaming

## Description

Client Phase D. Streaming response support for large query results.

**~250 LOC, ~12 tests**

### Subtasks

1. Streaming response parser (chunk accumulation)
2. `queryNodesStream()` async generator
3. Auto-fallback: server-initiated streaming detection
4. Backpressure via async iteration

### Validation

* Small result (<100) → non-streaming
* Large result (>1000) → chunked
* Backpressure: slow consumer → server doesn't OOM
* Stream abort: client cancels → server stops
* **Streaming result = non-streaming result (equivalence)**

### Dependencies

← T4.1 (Rust streaming) — **DONE** (RFD-11 merged)

### Context

Current `queryNodes()` is a fake async generator — sends one request, gets ALL results in a single response, yields them one by one. Server now supports true streaming (chunked EdgesChunk/NodesChunk responses via Wire Protocol v3). Client needs to consume those chunks properly.
