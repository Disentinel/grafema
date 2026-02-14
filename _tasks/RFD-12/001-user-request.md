# RFD-12: T4.2 — Client Semantic ID Wire Format

## Source
Linear issue RFD-12: https://linear.app/reginaflow/issue/RFD-12/t42-client-semantic-id-wire-format

## Description

Client Phase B. Clean wire format with native semantic ID support.

~300 LOC, ~10 tests

### Subtasks

1. `WireNodeV3` / `WireEdgeV3` types with `semanticId`
2. Remove `originalId` / `_origSrc` / `_origDst` metadata hacks
3. Version handshake at connect time
4. RFDBServerBackend cleanup

### Validation

- Semantic ID roundtrip: client → server → client = same string
- No metadata hacks in wire format
- Backward compat: client v3 → server v2 (degraded mode)
- All existing TS integration tests pass with v3 wire format

### Dependencies

← T4.1 (Rust v3 protocol) — **DONE** (merged PR #28)
