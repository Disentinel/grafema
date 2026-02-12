# Rob Pike — Implementation Report for RFD-3

## Changes Made

### 1. Types: `packages/types/src/rfdb.ts`
- Added `requestId?: string` to `RFDBRequest` (line 82)
- Added `requestId?: string` to `RFDBResponse` (line 173)

### 2. Rust Server: `packages/rfdb-server/src/bin/rfdb_server.rs`
- Added `RequestEnvelope` struct with `#[serde(flatten)]` to deserialize requestId alongside the tagged Request enum in a single pass
- Added `ResponseEnvelope` struct with `#[serde(flatten)]` to wrap Response with optional requestId
- Modified `handle_client()`: single deserialization to `RequestEnvelope`, extract `request_id` and `request`, wrap response in `ResponseEnvelope` before serializing

### 3. TypeScript Client: `packages/rfdb/ts/client.ts`
- `_send()`: generates `requestId: \`r${id}\`` and includes it in every outgoing request (moved `id` generation before request construction)
- `_handleResponse()`: match by requestId if present (parse `r${number}` format), FIFO fallback when requestId absent
- Added `_parseRequestId()` private helper

### 4. Tests: `test/scenarios/rfdb-request-id.test.js`
4 new tests:
1. requestId echo (raw wire protocol) — sends `requestId: "r42"`, verifies echo
2. requestId omission — verifies no requestId in response when not sent
3. Concurrent requests — 10 parallel requests of different types, all matched correctly
4. Sequential after concurrent — 20 rapid pings after concurrent batch

## Test Results
- All 7 original tests pass (backward compatibility)
- All 4 new tests pass
- Rust: compiles with only pre-existing warnings
- TypeScript: compiles cleanly

## Design Notes
- Consistent envelope pattern: `RequestEnvelope` for deserialization, `ResponseEnvelope` for serialization
- Single deserialization on Rust side (no double-parse)
- `#[serde(flatten)]` works correctly with rmp_serde for both internally-tagged (`Request`) and untagged (`Response`) enums
