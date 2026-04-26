# Uncle Bob Re-Review — REG-588 (Round 2)

**Reviewer:** Robert C. Martin (Uncle Bob)
**Date:** 2026-03-01
**Verdict:** APPROVE

---

## Previous Rejection

DRY violation: `WireAttrQuery → AttrQuery` conversion duplicated in 3 handler sites.

---

## Findings

### 1. Helper Function — Extracted and Well-Formed

`wire_to_attr_query` lives at line 793 of `rfdb_server.rs`:

```rust
fn wire_to_attr_query(query: WireAttrQuery) -> AttrQuery {
    let metadata_filters: Vec<(String, String)> = query.extra.into_iter()
        .filter_map(|(k, v)| {
            match v {
                serde_json::Value::String(s) => Some((k, s)),
                serde_json::Value::Bool(b) => Some((k, b.to_string())),
                serde_json::Value::Number(n) => Some((k, n.to_string())),
                _ => None,
            }
        })
        .collect();

    AttrQuery {
        version: None,
        node_type: query.node_type,
        file_id: None,
        file: query.file,
        exported: query.exported,
        name: query.name,
        metadata_filters,
        substring_match: query.substring_match,
    }
}
```

The doc-comment correctly describes the two responsibilities: known-field mapping and extra-key conversion. The function is pure, single-purpose, and takes ownership — idiomatic Rust.

### 2. All 3 Call Sites Verified

All three handler sites now delegate to the helper with no inline conversion:

- `Request::FindByAttr` handler (line 1040): `let attr_query = wire_to_attr_query(query);`
- `Request::QueryNodes` handler (line 1206): `let attr_query = wire_to_attr_query(query);`
- `handle_query_nodes_streaming` (line 1975): `let attr_query = wire_to_attr_query(query);`

No residual duplicate conversion logic found.

### 3. The AttrQuery Literal at Line 1584 is Not a Violation

There is one other `AttrQuery { ... }` construction in the codebase (lines 1584–1593), inside the file-based node eviction path. This constructs an engine-level `AttrQuery` directly — it does not convert from `WireAttrQuery`. It is a distinct code path (no wire input), correctly kept inline, and is not a DRY issue.

### 4. TypeScript — `base-client.ts` `_buildServerQuery` (line 318)

The extracted `_buildServerQuery` method consolidates query-building for `queryNodes` (line 335) and `queryNodesStream` (via `client.ts` overrides at lines 371, 394). The method is properly `protected` for subclass use. This is clean.

### 5. TypeScript — `RFDBServerBackend.ts` `queryNodes` (line 505–510)

This layer has its own inline query-building, but it operates on `NodeQuery` (a simpler, different interface without `exported`) and is in a different package (`@grafema/core`) than `base-client.ts` (`@grafema/rfdb`). These are separate concerns at different abstraction levels — not a DRY violation.

---

## Summary

The original rejection is fully addressed. The `wire_to_attr_query` helper is properly extracted, well-documented, and used consistently at all three call sites. No residual duplication of the conversion logic exists. The TS files are clean and do not introduce quality issues.

**APPROVE**
