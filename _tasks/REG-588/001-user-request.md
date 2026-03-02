# User Request: REG-588

**Task:** RFDB server-side substring matching for find_by_attr name/file fields

**Source:** Linear REG-588

## Goal

`find_by_attr` in RFDB server (Rust) uses exact match for `name` and `file` fields (`shard.rs:946`, `shard.rs:951`). This forces MCP `find_nodes` to do client-side substring matching (fetching all nodes of a type, then filtering).

## Current workaround

MCP handler (`query-handlers.ts:handleFindNodes`) removes `name`/`file` from server filter and does `.includes()` client-side. Works but wastes bandwidth for large graphs.

## Acceptance criteria

* `matches_attr_filters` in `shard.rs` uses `.contains()` for name and file fields
* Zone map pruning in `find_node_ids_by_attr` updated to handle substring (or disabled for substring queries)
* MCP handler can delegate filtering back to server
* Existing exact-match callers (e.g., `findDependentFiles`) still work
