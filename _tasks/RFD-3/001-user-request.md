# RFD-3: Client Request IDs

## Client Request IDs (Track 3, TS)

Client Phase A. Request IDs in wire protocol — foundation for streaming and multiplexing.

**~150 LOC (TS) + ~30 LOC (Rust), ~10 tests**

### Subtasks

1. `requestId` field in every outgoing request (string, `r${counter}`)
2. `pending` Map: FIFO matching → match-by-requestId
3. FIFO fallback if response without requestId (backward compat with v2 server)
4. Trivial Rust server change: echo requestId if present

### Validation

* Request ID echo: send with requestId → response has same requestId
* FIFO fallback: response without requestId → matched to oldest pending
* Concurrent requests: 10 parallel sends → all responses matched correctly
* Timeout: request with requestId times out → only that request fails
* **All existing client tests pass (FIFO mode)**

### Deliverables

Updated `RFDBClient`, minor server change

### Dependencies

None
