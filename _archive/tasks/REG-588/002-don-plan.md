# Don Melton Plan: REG-588 — Server-side substring matching for name/file

## Exploration Findings

### 1. `matches_attr_filters` in shard.rs (lines 922-962)

The function does exact equality comparison for both `file` and `name`:

```rust
if let Some(f) = file {
    if file_value != f {   // line 946 — exact match
        return false;
    }
}
if let Some(n) = name {
    if name_value != n {   // line 951 — exact match
        return false;
    }
}
```

The fix here is straightforward: replace `!=` with `!.contains()`.

### 2. Zone map pruning in `find_node_ids_by_attr` (lines 1231-1334)

Two layers of pruning happen before the per-record `matches_attr_filters` call:

**Descriptor-level (manifest.rs `may_contain`):**
```rust
if let Some(nt) = node_type {
    if !desc.may_contain(Some(nt), file, None) {
        continue;
    }
} else if !desc.may_contain(None, file, None) {
    continue;
}
```
`may_contain` checks `self.file_paths.contains(fp)` — a `HashSet<String>` exact membership test. If `file = "foo/bar"` and the segment has `"src/foo/bar.ts"`, it would incorrectly prune that segment.

**Segment-level (segment.rs `contains_file`):**
```rust
if let Some(f) = file {
    if !seg.contains_file(f) {
        continue;
    }
}
```
`contains_file` delegates to `ZoneMap::contains("file", f)` — another exact `HashSet` lookup. Same problem.

**Note:** The `name` field is NOT pruned at the zone-map level at all — only `node_type` and `file` are pruned via zone maps. So the zone map problem is limited to `file`.

### 3. ZoneMap internals

`ZoneMap` stores `HashMap<String, HashSet<String>>`. The `contains` method is exact: `s.contains(value)`. For substring queries, `get_values` returns the full `HashSet<String>`, which could be used to check whether any stored value `.contains()` the query string.

However, iterating all zone map values on every segment check defeats the purpose of zone maps (fast skip). This is a real performance consideration.

### 4. Protocol / wire format

`Request::FindByAttr { query: WireAttrQuery }` and `Request::QueryNodes { query: WireAttrQuery }` both use the same `WireAttrQuery` struct:

```rust
pub struct WireAttrQuery {
    pub node_type: Option<String>,
    pub name: Option<String>,
    pub file: Option<String>,
    pub exported: Option<bool>,
    pub extra: HashMap<String, serde_json::Value>,  // metadata filters
}
```

There is currently no field to distinguish "exact" vs "substring" matching semantics. Adding one is an option but requires a protocol change.

### 5. MCP handler workaround (query-handlers.ts lines 276-328)

```typescript
// Send only type to server (exact match); name/file are substring-matched client-side
const filter: Record<string, unknown> = {};
if (type) filter.type = type;

for await (const node of db.queryNodes(filter)) {
    if (name && !(node.name ?? '').includes(name)) continue;
    if (file && !(node.file ?? '').includes(file)) continue;
    // ...
}
```

The MCP handler intentionally drops `name` and `file` from the server query to avoid exact-match pruning results. After this change, it should pass `name`/`file` through and remove the client-side filtering loop.

### 6. Existing callers of `findByAttr` with `file`/`name`

Key callers that pass `file` or `name`:

| Caller | Field | Value type | Notes |
|--------|-------|------------|-------|
| `base-client.ts:findDependentFiles` | `file` | Exact path (`changedFiles` array) | Will still work — `"src/foo.ts".contains("src/foo.ts") == true` |
| `dataflow-handlers.ts:95` | `name` | Search string (may be substring) | Currently goes through `queryNodes` → server; does a `break` after first hit |
| `PathValidator.ts:77` | `name` | Exact function name, then filters by file manually | `.contains()` may return extra nodes; the manual `if (node.file === file)` post-filter keeps this correct |
| `RFDBServerBackend.ts:queryNodes` | both | Passes through from callers | No issue — server-side contains still works for exact inputs |

**Critical insight:** `.contains()` is a superset of `==`. Any caller passing an exact string will continue to get correct results because `"exact_value".contains("exact_value") == true` in Rust. The only behavioral difference is that the server may now return MORE nodes (nodes that contain the query as a substring) — callers that expected exact results must do their own post-filter if they need exactness. PathValidator already does this.

**Regarding `findDependentFiles`:** It passes exact file paths. Since `.contains("src/foo/bar.ts")` on the stored value `"src/foo/bar.ts"` is true, this continues working identically with no extra false positives (exact path won't be a substring of any other path unless there's a path prefix collision, which is fine).

---

## Implementation Plan

### Step 1: Change `matches_attr_filters` in `shard.rs`

Change exact-match to substring-match for `file` and `name` fields only. `node_type` stays exact (correct — type matching is always exact or prefix via `starts_with`).

```rust
// Before:
if let Some(f) = file {
    if file_value != f {
        return false;
    }
}
if let Some(n) = name {
    if name_value != n {
        return false;
    }
}

// After:
if let Some(f) = file {
    if !file_value.contains(f) {
        return false;
    }
}
if let Some(n) = name {
    if !name_value.contains(n) {
        return false;
    }
}
```

Rust's `str::contains` is an O(n*m) substring search. For typical node names and file paths (short strings, < 200 chars), this is negligible.

### Step 2: Fix zone map pruning for file (descriptor-level)

In `find_node_ids_by_attr`, the two `file`-based zone map prune points must be disabled or adapted when `file` is present (since we now do substring matching).

**Option A — Skip file pruning entirely when file filter is present (simplest, recommended):**

```rust
// Descriptor-level: remove file from may_contain call
if let Some(nt) = node_type {
    if !desc.may_contain(Some(nt), None, None) {  // pass None for file
        continue;
    }
} else {
    // No node_type filter either — nothing to prune on
}

// Segment-level: remove file prune entirely
// (was: if let Some(f) = file { if !seg.contains_file(f) { continue; } })
```

**Option B — Iterate zone map values for substring check (slower but preserves pruning benefit):**

```rust
if let Some(f) = file {
    if let Some(values) = seg.zone_map.get_values("file") {
        if !values.iter().any(|v| v.contains(f)) {
            continue;
        }
    }
    // If zone map has no "file" field at all (field overflowed cap), don't skip
}
```

**Recommendation: Option A for file at the segment level.** The descriptor-level `may_contain` also checks `node_type` — we can keep the `node_type` part and just pass `None` for `file`. The segment-level `contains_file` block should be removed entirely when file is a substring query.

For `node_type_prefix`, there's already correct handling with `starts_with`. For `name`, there is no zone map pruning at all — no change needed.

**Net effect of Option A:** When a `file` filter is present, segments won't be pruned by file (they will be pruned by `node_type` if that's also set). This is safe — correctness is maintained, performance regresses slightly compared to exact-match file queries (but those never existed in the client anyway, since the MCP bypassed them).

### Step 3: No protocol changes needed

The decision to always use `.contains()` for `name`/`file` is the cleanest approach. The `WireAttrQuery` struct does NOT need a new `matchMode` field. Rationale:

- The original callers that pass exact values (`findDependentFiles`, `PathValidator`) are unaffected by substring semantics (exact string is always a substring of itself).
- No caller currently relies on server-side exact matching that would break if the server returns "too many" results — they already receive IDs and call `getNode` per result.
- Adding a `match_mode` field would require coordinating changes across: `WireAttrQuery`, `AttrQuery`, `find_node_ids_by_attr` signature, `matches_attr_filters` signature, both `Request::FindByAttr` and `Request::QueryNodes` handlers, and both `engine_v2.rs` and `multi_shard.rs` call sites. The complexity is not justified.

If future requirements need exact-match semantics server-side (e.g., for performance-critical paths), a `name_exact: bool` / `file_exact: bool` field can be added then.

### Step 4: Clean up MCP handler

In `packages/mcp/src/handlers/query-handlers.ts`, `handleFindNodes`:

1. Add `name` and `file` to the server filter object (they were intentionally excluded before)
2. Remove the client-side `includes()` loop
3. Keep `totalMatched` counting — move it after the server filter (nodes returned by server now already match)

```typescript
// After:
const filter: Record<string, unknown> = {};
if (type) filter.type = type;
if (name) filter.name = name;   // NEW: server does substring matching
if (file) filter.file = file;   // NEW: server does substring matching

const nodes: GraphNode[] = [];
let skipped = 0;
let totalMatched = 0;

for await (const node of db.queryNodes(filter)) {
    // No client-side name/file filtering needed anymore
    totalMatched++;
    if (skipped < offset) { skipped++; continue; }
    if (nodes.length < limit) { nodes.push(node); }
}
```

### Step 5: Tests to write

**Rust tests (in `shard.rs` test section or `engine_v2.rs`):**
1. `test_find_by_attr_name_substring` — node with name `"handleFooBar"` is found by query `name: "Foo"`
2. `test_find_by_attr_file_substring` — node with file `"src/foo/bar.ts"` is found by query `file: "foo/bar"`
3. `test_find_by_attr_exact_still_works` — exact name/file queries still return the same result (no regression)
4. `test_find_by_attr_substring_in_segment` — same as above but for flushed segment (not just write buffer), to verify zone map bypass works
5. `test_find_by_attr_no_false_positives` — `name: "Foo"` does NOT return a node with name `"Bar"`

**JS/TS tests (in `test/unit/`):**
1. Test that `handleFindNodes` with `name` substring returns matching nodes (mock backend returning nodes with various names)
2. Test that `handleFindNodes` with `file` substring returns matching nodes
3. Regression: `handleFindNodes` with only `type` still works

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Zone map bypass causes performance regression | Low | Medium | For large graphs with many types+files, the `node_type` prune still helps significantly. File-only queries will scan more segments. Acceptable given current usage. |
| Existing callers break due to substring semantics | Low | High | Analyzed all callers — none rely on server-returning ONLY exact matches in a correctness-critical way. PathValidator has its own post-filter. |
| `findDependentFiles` returns extra files | Very low | Medium | Would require a file path being a substring of another (e.g., `src/foo.ts` matching inside `src/foo.test.ts`). Possible! Caller should add exact-match post-filter. |
| Rust benchmark regressions | Low | Low | Substring search on short strings is negligible vs disk I/O |

**Notable subtlety for `findDependentFiles`:** If `changedFiles` contains `"src/foo.ts"`, a node with `file: "src/foo.test.ts"` would now match because `"src/foo.test.ts".contains("src/foo.ts")` is true. This is a false positive. However, this is an existing robustness problem in the architecture (not introduced by this change — the client was always capable of doing this match). The `findDependentFiles` function doesn't use `queryNodes` through MCP — it calls `this.findByAttr({ file })` directly on the RFDB client. **This is a real breakage risk.** The implementer must add an exact-match post-filter in `findDependentFiles`, OR we must make the substring behavior opt-in (see "No protocol changes" discussion above — reconsider).

**Revised recommendation on protocol changes:** Given the `findDependentFiles` risk, the safest approach is to add a `nameSubstring: boolean` / `fileSubstring: boolean` flag to `WireAttrQuery`. Shard stays backward compatible (default=false means exact match). MCP passes `fileSubstring: true`. `findDependentFiles` and other exact callers pass nothing (defaults to false). This requires more code but eliminates the false-positive risk.

Alternatively, add a single `substringMatch: boolean` flag that applies to both `name` and `file`.

**Final recommendation:** Add `substringMatch: boolean` (default `false`) to `WireAttrQuery` and thread it through. This is 4-5 more files touched but eliminates all backward-compat risk. The MCP handler passes `substringMatch: true`. All other callers omit it and get existing exact-match behavior unchanged.

---

## Files to Change

| File | Change |
|------|--------|
| `packages/rfdb-server/src/storage_v2/shard.rs` | `matches_attr_filters`: add `substring_match: bool` param, use `.contains()` when true; `find_node_ids_by_attr`: add `substring_match` param, skip file zone-map prune when true |
| `packages/rfdb-server/src/storage_v2/multi_shard.rs` | Thread `substring_match` through `find_node_ids_by_attr` |
| `packages/rfdb-server/src/graph/engine_v2.rs` | Thread `substring_match` from `AttrQuery` through to storage |
| `packages/rfdb-server/src/graph/mod.rs` | Update `AttrQuery` struct if `substring_match` is added there |
| `packages/rfdb-server/src/bin/rfdb_server.rs` | Add `substring_match` to `WireAttrQuery`; pass it through in `FindByAttr` and `QueryNodes` handlers |
| `packages/mcp/src/handlers/query-handlers.ts` | Pass `name`, `file`, `substringMatch: true` to server; remove client-side `.includes()` loop |
| `packages/rfdb-server/src/graph/engine.rs` | Update v1 engine (if `find_by_attr` trait impl needs updating) |

**AttrQuery struct location:** grep showed it's used in `engine.rs`, `engine_v2.rs`, `ffi/engine_worker.rs`, `ffi/napi_bindings.rs` — need to locate the struct definition and add `substring_match: bool`.

---

## Open Questions for Implementer (Dijkstra)

1. Where is `AttrQuery` defined? (Not found in exploration — need to check `types.rs` or similar in rfdb-server)
2. Should `substring_match` apply to both `name` and `file` together, or separately (`name_substring`, `file_substring`)? Separate flags are more flexible but verbose.
3. Is there a `node_type_prefix` already in `AttrQuery`? (Yes — wildcard `*` suffix in engine_v2.rs handles this.) No change needed there.
4. The v1 engine (`engine.rs`) also implements `find_by_attr` — does it need the same change? (It appears to be a legacy path. If tests require v1/v2 equivalence, yes.)
