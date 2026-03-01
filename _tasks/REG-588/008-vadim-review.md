# Вадим auto — Completeness Review — REG-588

**Verdict: REJECT**

---

## Summary

The Rust/RFDB server implementation is complete and correct. The acceptance criteria for `shard.rs` and `WireAttrQuery` are fully met. However, the MCP-layer change is **broken** at the integration boundary: `substringMatch: true` never reaches the server. The previous client-side filtering was removed but the replacement does not work.

---

## Acceptance Criteria Status

### 1. `matches_attr_filters` uses `.contains()` for name and file — PASS

`shard.rs` lines 946-963 implement the correct conditional logic:

```rust
if let Some(f) = file {
    if substring_match {
        if !f.is_empty() && !file_value.contains(f) {
            return false;
        }
    } else if file_value != f {
        return false;
    }
}
```

Identical pattern for `name`. Correct.

### 2. Zone map pruning disabled for substring queries — PASS

`shard.rs` line 1255:

```rust
let prune_file = if substring_match { None } else { file };
```

`prune_file` is used for all descriptor-level and segment-level zone map checks (lines 1291, 1294, 1309). Zone map bypass is correct for both L0 descriptor and L0 segment pruning.

### 3. MCP handler delegates filtering to server — FAIL (broken integration)

The change in `packages/mcp/src/handlers/query-handlers.ts` sets `filter.substringMatch = true` and removes client-side filtering:

```typescript
filter.substringMatch = true;
// ... removed: if (name && !(node.name ?? '').includes(name)) continue;
// ... removed: if (file && !(node.file ?? '').includes(file)) continue;
```

This appears correct in isolation. The problem is in the plumbing between `handleFindNodes` and the server.

**Path from MCP handler to server:**

1. `handleFindNodes` calls `db.queryNodes(filter)` where `db` is a `GraphBackend`
2. The concrete implementation is `RFDBServerBackend.queryNodes()` (`packages/core/src/storage/backends/RFDBServerBackend.ts`, lines 500-523)
3. `RFDBServerBackend.queryNodes` explicitly rebuilds the query, passing only `nodeType`, `name`, `file` — `substringMatch` is dropped:

```typescript
const serverQuery: NodeQuery = {};
if (query.nodeType) serverQuery.nodeType = query.nodeType;
if (query.type) serverQuery.nodeType = query.type;
if (query.name) serverQuery.name = query.name;
if (query.file) serverQuery.file = query.file;
// substringMatch is never copied
```

4. `this.client.queryNodes(serverQuery)` calls `_buildServerQuery` in `packages/rfdb/ts/base-client.ts` (lines 318-326), which has the same explicit allowlist:

```typescript
protected _buildServerQuery(query: AttrQuery): Record<string, unknown> {
    const serverQuery: Record<string, unknown> = {};
    if (query.nodeType) serverQuery.nodeType = query.nodeType;
    if (query.type) serverQuery.nodeType = query.type;
    if (query.name) serverQuery.name = query.name;
    if (query.file) serverQuery.file = query.file;
    if (query.exported !== undefined) serverQuery.exported = query.exported;
    return serverQuery;
    // substringMatch is never forwarded
}
```

**Result:** The server receives `{ name: "Foo", file: undefined }` without `substringMatch`. The server defaults `substring_match` to `false` (exact match). Exact match `"Foo" == "handleFooBar"` fails. The query returns zero results.

The previous behavior (client-side filtering) would have returned one result. The new code returns zero results. This is a regression.

### 4. Existing exact-match callers still work — PASS (for Rust layer, broken via MCP)

All Rust callers in `rfdb_server.rs` that explicitly set `substring_match: false` are unaffected. The `findDependentFiles` internal call at line 1604 correctly sets `substring_match: false`. NAPI bindings use `..Default::default()` which gives `false`.

The issue is only in the MCP path.

---

## Edge Case Analysis

- **Empty string guard** — implemented correctly (`!f.is_empty() && ...`). PASS
- **Exact match still works** — yes, for all non-MCP callers. PASS
- **Substring of path (`"foo.ts"` in `"foo.test.ts"`)** — would work at the Rust level if the query reached the server correctly. Moot given item 3.
- **Post-flush behavior** — `test_find_by_attr_substring_after_flush` tests L0 flush (write buffer to L0 segment). This is correct and sufficient since `find_node_ids_by_attr` doesn't scan L1 segments — but this is a pre-existing gap, not introduced by this PR.

---

## Test Coverage Gap

The test suite covers the Rust protocol layer exhaustively (`test_find_by_attr_name_substring`, `test_find_by_attr_file_substring`, `test_find_by_attr_exact_default`, `test_find_by_attr_empty_query_no_match_all`, `test_find_by_attr_substring_no_false_positives`, `test_find_by_attr_substring_after_flush`).

There is no integration test that exercises the full MCP → `RFDBServerBackend` → `base-client` → server path with `substringMatch`. Steve's review correctly noted the tests are thorough at the protocol level, but the integration path was not tested. The MCP unit tests (if any) use `MockBackend`, which would not catch this gap.

---

## Scope Creep

None observed. Changes are well-scoped.

---

## Required Fix

Two files need changes:

**`packages/core/src/storage/backends/RFDBServerBackend.ts`** — add substringMatch forwarding:

```typescript
const serverQuery: NodeQuery = {};
if (query.nodeType) serverQuery.nodeType = query.nodeType;
if (query.type) serverQuery.nodeType = query.type;
if (query.name) serverQuery.name = query.name;
if (query.file) serverQuery.file = query.file;
if ((query as Record<string, unknown>).substringMatch !== undefined) {
  (serverQuery as Record<string, unknown>).substringMatch =
    (query as Record<string, unknown>).substringMatch;
}
```

Or more cleanly: expose `substringMatch` in `NodeQuery` type and pass it through.

**`packages/rfdb/ts/base-client.ts`** — add to `_buildServerQuery`:

```typescript
if (query.substringMatch !== undefined) serverQuery.substringMatch = query.substringMatch;
```

And update `AttrQuery` in `packages/types/src/rfdb.ts` to explicitly declare the field:

```typescript
export interface AttrQuery {
  // ... existing fields ...
  substringMatch?: boolean;
}
```

An integration test covering the MCP → server path should also be added.

---

**REJECT**
