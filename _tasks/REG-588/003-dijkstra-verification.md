# Dijkstra Verification: REG-588 — Server-side substring matching for name/file

**Verifier:** Edsger Dijkstra (Plan Verifier)
**Plan Source:** `002-don-plan.md`
**Verdict:** REJECT — critical gaps found

---

## Methodology

For every filter/condition/classification in the plan, I enumerate all cases and verify correctness by inspection of the actual source code. I do not THINK it handles all cases — I PROVE it, by enumeration.

Files inspected:
- `packages/rfdb-server/src/storage_v2/shard.rs` (lines 922-1334)
- `packages/rfdb-server/src/storage_v2/multi_shard.rs` (lines 572-604)
- `packages/rfdb-server/src/storage_v2/zone_map.rs`
- `packages/rfdb-server/src/storage_v2/manifest.rs` (lines 242-264)
- `packages/rfdb-server/src/storage_v2/segment.rs` (lines 295-302)
- `packages/rfdb-server/src/graph/engine_v2.rs` (lines 328-352)
- `packages/rfdb-server/src/graph/engine.rs` (lines 967-1160)
- `packages/rfdb-server/src/graph/index_set.rs` (lines 162-167)
- `packages/rfdb-server/src/bin/rfdb_server.rs` (lines 610-624, 1021-1034, 1194-1222, 1592-1601, 1994-2004)
- `packages/rfdb/ts/base-client.ts` (lines 688-714)
- `packages/mcp/src/handlers/query-handlers.ts` (lines 276-328)
- `packages/mcp/src/handlers/dataflow-handlers.ts` (line 95)
- `packages/core/src/validation/PathValidator.ts` (lines 74-82)
- `packages/core/src/plugins/analysis/ServiceLayerAnalyzer.ts` (line 383)
- `packages/core/src/plugins/analysis/ExpressResponseAnalyzer.ts` (lines 435, 443, 455)
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (line 644)
- `packages/core/src/plugins/enrichment/AliasTracker.ts` (lines 368-412)

---

## 1. Matching Semantics Completeness

The plan changes `shard.rs` `matches_attr_filters` to use `str::contains()` for `file` and `name` fields when `substring_match=true`.

Rust `str::contains()` returns `true` if the argument is a substring of the receiver. Empty string is a substring of every string.

| Stored value | Query value | Expected | `contains()` result | Correct? |
|---|---|---|---|---|
| `"src/foo/bar.ts"` | `"foo/bar"` | match | `true` | YES |
| `"src/foo/bar.ts"` | `"src/foo/bar.ts"` | match (exact) | `true` | YES |
| `"handleFooBar"` | `"Foo"` | match | `true` | YES |
| `"handleFooBar"` | `"handleFooBar"` | match (exact) | `true` | YES |
| `"handleFooBar"` | `"Bar"` | match | `true` | YES |
| `"handleFooBar"` | `"baz"` | no match | `false` | YES |
| `""` (empty stored) | `"foo"` | no match | `false` | YES |
| `"foo"` | `""` (empty query) | ALL nodes match | `true` | **CRITICAL GAP (see below)** |
| `"src/foo.test.ts"` | `"src/foo.ts"` | no match (false positive) | `true` | **FALSE POSITIVE** |

### CRITICAL GAP 1: Empty query string returns all nodes

`"anything".contains("")` is `true` in Rust. This is well-known Rust behavior.

The plan acknowledges this: "CRITICAL: The empty query case — what happens if MCP passes `name: ""` or `file: ""`? `"anything".contains("")` is `true` in Rust! This could return ALL nodes. Is this handled?"

**Plan's answer:** Not addressed in the implementation steps. The plan enumerates no guard against empty strings in either `shard.rs` or the MCP handler.

**Actual risk:** The MCP `handleFindNodes` receives `args` from JSON input. If a client calls `find_nodes` with `name: ""` or `file: ""`, the filter would pass through to the server (after the plan's changes), and the server would return every node in the graph that has any name or file. This is a DoS-class bug for large graphs.

The current client-side code already has this same flaw (`"".includes(x)` is `false` in JS for non-empty x, but `x.includes("")` is `true`) — but the current code guards this implicitly because `name && ...includes(name)` would short-circuit on empty string due to `""` being falsy in JS. After the plan's changes (Step 4), the empty check moves to the server where Rust has no such falsy guard.

**Required fix:** Add a guard in `shard.rs` `matches_attr_filters` or in the server handler: skip substring matching when the query string is empty (treat as "no filter"). Alternatively, add a guard in the MCP `handleFindNodes` before passing to server.

### FALSE POSITIVE GAP: Path prefix collision

`"src/foo.test.ts".contains("src/foo.ts")` is `true` because `"src/foo.ts"` is a literal substring of `"src/foo.test.ts"`.

The plan documents this for `findDependentFiles` (Risk section: "Very low" likelihood). However, the characterization "Very low" is incorrect — this pattern is ROUTINE in JavaScript/TypeScript projects:
- `src/foo.ts` and `src/foo.test.ts` coexist in virtually every JS project
- `src/foo.ts` and `src/foobar.ts` would also collide
- `src/bar/component.ts` and `src/bar/component.stories.ts`

This is not an edge case. It is the standard naming convention for test files in JS/TS codebases.

---

## 2. Zone Map Pruning Correctness

### 2a. Descriptor-level (`manifest.rs may_contain`)

The plan correctly identifies that `desc.may_contain(Some(nt), file, None)` performs an exact `HashSet::contains()` for the file field. The fix (passing `None` for file) is correct: it removes file-based pruning at the descriptor level, preserving only `node_type` pruning.

**Verification:** `may_contain` returns `false` (skip segment) only if `!self.file_paths.contains(fp)`. With `None` passed, this branch is skipped entirely. No false negatives possible. Correct.

### 2b. Segment-level (`segment.rs contains_file`)

The plan correctly identifies that `seg.contains_file(f)` is an exact `ZoneMap::contains("file", f)` lookup. The fix (removing this check entirely when `substring_match=true`) is correct.

**Verification:** `ZoneMap::contains` does `s.contains(value)` where `s` is a `HashSet<String>`. There is no substring check. Removing this block prevents false negatives. Correct.

### 2c. `node_type` pruning — unchanged

The plan correctly notes that `node_type` filtering is always exact. With `substring_match=true`, the `node_type` zone map check still applies, which is correct (type filtering is never substring-based).

**Verification:** Both `desc.may_contain(Some(nt), None, None)` (type-only) and `seg.contains_node_type(nt)` check exact type membership. These are left in place. No false negatives for type. Correct.

### CRITICAL GAP 2: The `else` branch at descriptor-level when `node_type` is `None`

Current code in `find_node_ids_by_attr`:

```rust
if let Some(nt) = node_type {
    if !desc.may_contain(Some(nt), file, None) {
        continue;
    }
} else if !desc.may_contain(None, file, None) {
    continue;
}
```

The plan says to pass `None` for file in the first branch. But the `else` branch — where there is no `node_type` filter — currently uses the `file` parameter to prune. After the plan's fix, this `else` branch becomes:

```rust
} else {
    // No node_type filter either — nothing to prune on
}
```

The comment in the plan says "No node_type filter either — nothing to prune on" and omits the else block. This is **correct** — with no `node_type` and a substring `file`, the whole descriptor-level check can be dropped. But the plan's code example shows just the first `if` block and says `// No node_type filter either — nothing to prune on` — it is ambiguous whether the implementer should remove the `else` branch or leave it. If left as-is (the existing `else if !desc.may_contain(None, file, None)`) and the `file` is still passed in, it would cause false negatives. This needs explicit clarification.

**Required fix:** The plan must explicitly state that the `else` branch must also be changed (pass `None` for file, or drop it entirely).

### 2d. Write buffer — no zone map, correct

The write buffer scan in `find_node_ids_by_attr` (lines 1244-1267) calls `matches_attr_filters` directly on each node — no zone map involved. The plan correctly requires no changes here.

---

## 3. Backward Compatibility Completeness

The plan's "Final recommendation" is to add `substringMatch: bool` (default `false`) to `WireAttrQuery` and thread it through. This means existing callers get exact-match behavior unchanged. The completeness table:

| Caller | Uses `file` or `name`? | Gets `substring_match`? | Expected behavior after change | Safe? |
|---|---|---|---|---|
| `findDependentFiles` (base-client.ts:691) | YES — exact `file` path | No (default `false`) | Exact match | YES |
| `CommitBatch` handler (rfdb_server.rs:1592) | YES — exact `file` path for deletion | No (default `false`) | Exact match | YES |
| MCP `handleFindNodes` (query-handlers.ts) | YES — passes `name`/`file` | Yes (`true`) | Substring match | YES |
| `PathValidator` (PathValidator.ts:77) | YES — exact `functionName`, exact `file` post-filtered | No (default `false`) | Exact match, `node.file === file` post-filter still works | YES |
| `dataflow-handlers.ts:95` | YES — `name: source` | No (default `false`) | Exact match | OK but see note |
| `ServiceLayerAnalyzer.ts:383` | YES — exact `name` | No (default `false`) | Exact match (uses `queryNodes`) | YES |
| `ExpressResponseAnalyzer.ts:435, 443, 455` | YES — exact `name`, exact `file` | No (default `false`) | Exact match (uses `queryNodes`) | YES |
| `GraphBuilder.ts:644` | YES — exact `name`, exact `file` | No (default `false`) | Exact match (uses `queryNodes`) | YES |
| `AliasTracker.ts:371, 409` | YES — exact `name`, exact `file` | No (default `false`) | Exact match (uses `findByAttr`) | YES |
| `impact.ts:541` | YES — metadata filter `method` | No | Metadata filter, no name/file substring | YES |

**Note on `dataflow-handlers.ts:95`:** This caller uses `name: source` where `source` is user input (the trace source). With default `false`, it gets exact match — meaning tracing by a partial name would fail silently. This is a pre-existing limitation, not introduced by this change.

**CRITICAL GAP 3: `queryNodes` goes through the streaming path as well**

The streaming handler `handle_query_nodes_streaming` (rfdb_server.rs:1966-2004) also constructs an `AttrQuery` from `WireAttrQuery`. The plan mentions updating `WireAttrQuery`, `AttrQuery`, and the two handler paths (`FindByAttr`, `QueryNodes`). It does NOT mention the streaming handler as a separate code site.

Inspection shows the streaming handler constructs `AttrQuery` at line 1994 in the same way as the non-streaming `QueryNodes` handler (line 1206). If `substring_match` is added to `WireAttrQuery` and `AttrQuery`, this path must also be updated to pass it through to `find_by_attr`. The plan does not list this path explicitly. Risk: streaming queries silently fall back to exact match even when `substringMatch: true` was requested.

**Required fix:** The streaming path `handle_query_nodes_streaming` must be listed in "Files to Change" and must thread `substring_match` through to `AttrQuery`.

---

## 4. The v1 Engine is NOT Addressed (CRITICAL GAP 4)

The plan's "Files to Change" table lists `packages/rfdb-server/src/graph/engine.rs` with the note "Update v1 engine (if `find_by_attr` trait impl needs updating)."

This is too vague. After inspecting `engine.rs`:

1. The v1 `find_by_attr` (line 967) uses exact `==` comparison for both `file` (line 996-998) and `name` (line 1000).
2. The v1 engine uses a **secondary index** for candidate selection: when `query.file.is_some()`, it calls `self.index_set.find_by_file(query.file.as_ref().unwrap())` (line 1079-1081). `find_by_file` in `index_set.rs` (line 165) is an exact `HashMap` lookup — `self.file_index.get(file)`.
3. With `substring_match=true` AND the v1 engine path: the secondary index would return ZERO candidates for a substring query (since the index key is the full exact path), and then the `check_remaining` closure would also do exact match — resulting in ZERO results, not more results.

**This is a false-negative bug if `substring_match=true` is threaded into the v1 engine without also fixing the index lookup and the comparison logic.**

The plan needs to either:
- Fully specify the v1 engine fix (including index bypass), OR
- Explicitly state that v1 engine is only used for the legacy FFI path and is not reachable from the MCP/server protocol handler (and prove this)

Inspection shows the v2 engine path (`engine_v2.rs`) is the one used by the RFDB server protocol (via `GraphEngineV2::find_by_attr`). The v1 engine (`engine.rs`) is used by the FFI path (`ffi/engine_worker.rs`, `ffi/napi_bindings.rs`). If the FFI path is not reachable from JS MCP, the v1 issue is less urgent — but this must be explicitly stated in the plan, not left as "if needed."

The plan's Open Question 4 ("The v1 engine (`engine.rs`) also implements `find_by_attr` — does it need the same change?") was never answered. Dijkstra's rule: open questions are not plan items. They are blockers.

---

## 5. Preconditions / Serde Default

### 5a. WireAttrQuery serde default

The current `WireAttrQuery` (rfdb_server.rs:614-624) uses `#[serde(rename_all = "camelCase")]`. There is no `#[serde(default)]` on the struct.

When `substringMatch` is added to `WireAttrQuery`, it must be annotated with `#[serde(default)]` or the field must be `Option<bool>`. Otherwise, any existing JS client that sends a `FindByAttr` or `QueryNodes` request WITHOUT the new field will receive a deserialization error from serde (strict missing field handling for `Deserialize`-derived structs).

The plan does not state how the field will be typed or what serde annotation will be used.

**Required specification:** The plan must specify `#[serde(default)]` on `substring_match: bool` in `WireAttrQuery`, OR use `Option<bool>` with a fallback in the handler. Either works, but it must be explicit.

### 5b. AttrQuery struct — no serde issue

`AttrQuery` (storage/mod.rs:88) already derives `#[derive(Debug, Clone, Default, Serialize, Deserialize)]`. Adding `substring_match: bool` with a `#[serde(default)]` annotation would be safe. But `AttrQuery` is also constructed directly (not deserialized) in all server handlers — so `Default` is sufficient for existing constructors to be valid (the field would default to `false`).

However, if `AttrQuery` gains `substring_match: bool` without `Default`, all the explicit struct construction sites (there are many: rfdb_server.rs:1021, 1206, 1592, 1994) would fail to compile. The plan must account for this and either use `..Default::default()` spread or add the field explicitly at each site.

---

## 6. Edge Cases Enumeration

### 6a. Empty query strings (already covered in Section 1)

| Case | Rust `contains()` behavior | Risk |
|---|---|---|
| `name: ""` with `substring_match=true` | `"anything".contains("") == true` | ALL nodes with any name returned |
| `file: ""` with `substring_match=true` | `"anything".contains("") == true` | ALL nodes with any file returned |
| Both `name: ""` and `file: ""` | Both `true` | ALL nodes returned |

The fix must guard against empty strings. One approach: in `matches_attr_filters`, treat an empty query string as "no filter" (same as `None`).

### 6b. Query longer than stored value

`"abc".contains("abcdef") == false`. No false positives. Correct behavior.

### 6c. Special characters / Unicode / regex metacharacters

Rust `str::contains` is a plain byte/char substring search, not regex. It handles Unicode correctly (operates on `&str` which is valid UTF-8). Regex metacharacters (`.`, `*`, `[`, etc.) are matched literally. No risk.

### 6d. Multiple nodes matching the same substring query — dedup

The dedup logic in `find_node_ids_by_attr` uses `seen_ids: HashSet<u128>`. This is independent of the filter values. Multiple nodes matching a substring are all included (no dedup on result, only on ID to prevent returning the same node twice from buffer+segment). This is correct behavior.

### 6e. Zone map overflow (high-cardinality fields)

`ZoneMap::write_to` skips fields with more than `MAX_ZONE_MAP_VALUES_PER_FIELD` distinct values. After deserialization (reading from disk), such fields are absent from the zone map. In this case `ZoneMap::contains` returns `false` for absent fields.

Implication for the existing segment-level pruning: `seg.contains_file(f)` would return `false` if the file field exceeded the zone map cap — this would incorrectly skip the segment even for exact-match queries. This is a **pre-existing bug** not introduced by this change. After the plan's change, the segment-level file prune is removed entirely for substring queries — which actually FIXES this pre-existing false-negative case as a side effect. No new risk introduced.

---

## 7. Summary of Gaps Found

| # | Type | Severity | Description |
|---|---|---|---|
| 1 | BUG | CRITICAL | Empty string query with `substring_match=true` returns all nodes. Guard required in `matches_attr_filters` or the MCP handler. |
| 2 | BUG | HIGH | `findDependentFiles` false positives: `"src/foo.test.ts".contains("src/foo.ts") == true`. Plan labels this "Very low" but it is routine in JS/TS projects. A guard or post-filter is REQUIRED. |
| 3 | INCOMPLETE SPEC | MEDIUM | The descriptor-level `else` branch (no `node_type`, with `file`) is not explicitly addressed. If left unchanged with `file` still passed, it causes false negatives. |
| 4 | MISSING SCOPE | HIGH | Streaming handler `handle_query_nodes_streaming` (rfdb_server.rs:1966) constructs `AttrQuery` from `WireAttrQuery` independently. Must be listed and updated. |
| 5 | OPEN QUESTION | HIGH | v1 engine `find_by_attr` has exact-match logic AND a secondary file index (exact `HashMap` lookup). Plan says "if needed" — insufficient. Must either fix v1 or prove it is unreachable from MCP. |
| 6 | PRECONDITION | MEDIUM | `WireAttrQuery` needs `#[serde(default)]` on `substring_match`. Plan does not specify serde annotation. Without it, existing clients will fail with deserialization errors. |
| 7 | PRECONDITION | LOW | All explicit `AttrQuery { ... }` struct constructions must add `substring_match: false` (or use `..Default::default()`). Plan does not enumerate these sites. |

---

## 8. What Is Correct in the Plan

The following aspects of the plan are verified correct:

1. The core `matches_attr_filters` change (`!=` to `!contains()` with a guard parameter) is logically sound for non-empty strings.
2. Option A (skip file zone-map pruning) is correct and sufficient — the `node_type` zone map check still provides meaningful pruning when type is known.
3. The `substringMatch: bool` (default `false`) approach correctly preserves exact-match behavior for all existing callers.
4. Don's identification of the `findDependentFiles` risk is accurate (the plan acknowledges it in the Risk table); however the characterization of likelihood as "Very low" is wrong — the likelihood is CERTAIN for typical JS/TS projects.
5. The MCP handler cleanup (Step 4) is logically correct given the server does the filtering.
6. The test list (Step 5) is appropriate, covering the key paths.
7. `name` has no zone-map pruning at any level — confirmed. No zone map changes needed for `name`.
8. The `node_type_prefix` (wildcard `*`) handling is unchanged and correct.

---

## Verdict: REJECT

**Reason:** Four issues that would produce incorrect behavior in production:

1. **Empty string → all nodes**: A client sending `name: ""` or `file: ""` with `substring_match=true` would receive the entire graph. This is a correctness and performance bug.

2. **`findDependentFiles` false positives**: The CI/reanalysis pipeline uses `findDependentFiles` with exact file paths. After this change (with `substring_match=false` default, this path is safe), BUT if anyone calls `queryNodes` with `file` substring matching, it would produce false file matches in `ExpressResponseAnalyzer`, `GraphBuilder`, and `PathValidator` for any query where the file is a substring of another file. These callers do NOT guard against extra results the way `PathValidator` does — `ExpressResponseAnalyzer` breaks the loop on the first matching node (`break`), which could be a wrong node if substring matching returns extras.

3. **Streaming path omitted**: The streaming handler is an independent code path that must also thread `substring_match`. The plan lists `rfdb_server.rs` as a file to change but does not identify this path explicitly.

4. **v1 engine unresolved**: Open Question 4 remains open. The v1 engine has TWO levels of exact-match (secondary index + per-record check). If `substring_match=true` is threaded into the v1 path without also bypassing the secondary index, the result would be zero nodes — a silent false-negative.

**The plan is architecturally sound and the approach is correct. These are implementation gaps, not design flaws. The plan can be approved after addressing gaps 1, 3, 4, and 6 (critical/high severity).**
