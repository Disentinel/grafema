# Steve Jobs Vision Review — REG-588

**Verdict: APPROVE**

---

## 1. Vision Alignment: Does this move us forward?

Yes. This is a clean, direct move in the right direction.

The project vision is "AI should query the graph, not read code." Before this change, `handleFindNodes` in the MCP layer was doing client-side substring filtering in TypeScript — meaning the server returned more than it needed to, the client iterated and filtered, and any agent using `find_nodes` with a partial name was relying on accident-of-implementation rather than a deliberate, stable contract.

Moving substring matching into the RFDB server is exactly right. The filter now runs at the data layer, close to the data. The MCP handler becomes thinner. The boundary is cleaner. This is the direction every feature should move.

---

## 2. Is `substring_match: bool` the right abstraction?

For now, yes. The field has a clear name, defaults to `false` (preserving backward compatibility for all existing queries), and the semantics are unambiguous. Callers opt in explicitly.

The concern about future extensibility (regex, case-insensitive) is real but not a reason to block this. A bool is the simplest thing that works today. When the need for regex or case-insensitivity arrives, the evolution path is straightforward: replace the bool with an enum (`MatchMode { Exact, Substring, Regex, ILike }`). The existing `false` callers map to `Exact`, the `true` callers map to `Substring`. The wire format changes minimally.

One observation: the `AttrQuery` builder in `storage/mod.rs` does not have a `substring_match` builder method. All internal Rust callers must set the field directly on the struct. This is a minor rough edge — not a blocker, but worth noting as a follow-up.

---

## 3. Zone Map Pruning Disabled for File Substring Queries

The implementation is correct and the tradeoff is acceptable.

The logic at line 1255 of `shard.rs` is explicit:

```rust
let prune_file = if substring_match { None } else { file };
```

Zone maps store exact file paths. They cannot answer "does this segment contain any file path that contains the substring X?" without iterating. Disabling file-based zone map pruning for substring queries is the only correct behavior.

The performance consequence is O(all_segments) scans when querying by file substring. For the target environment — large legacy codebases — this could be significant. However:

- `node_type` zone map pruning is still active (lines 1290-1312). If the caller also specifies a `node_type`, most segments will still be pruned before row-level scanning begins.
- The MCP `handleFindNodes` always passes `substringMatch: true` but allows callers to also supply `type`. In practice, most AI-driven queries will include a type filter, limiting the scan surface.
- The current codebase does not have a file-path index that could support substring lookups efficiently. Disabling exact pruning is the honest, correct response to that architectural reality — not a workaround.

This is acceptable. The gap (no substring-capable file index) is noted and can be addressed later if profiling shows it matters.

---

## 4. Complexity: O(m*n) per node

The per-node `.contains()` call is O(m*n) where m is the query length and n is the stored string length. For typical function names and file paths, both are short strings (under 200 characters). The concern is negligible in practice.

The real cost driver is the number of nodes scanned, governed by which zone maps fire. See section 3 above.

---

## 5. Architecture Layer

This belongs in RFDB core, not in a plugin. Filtering by name/file is a fundamental storage primitive — the same reason `node_type` filtering is in the storage layer. This is the right place.

---

## 6. Test Coverage

The tests are thorough and well-structured:

- `test_find_by_attr_name_substring` — basic name match
- `test_find_by_attr_file_substring` — basic file match
- `test_find_by_attr_exact_default` — confirms default behavior is unchanged (no regression)
- `test_find_by_attr_empty_query_no_match_all` — empty string = skip filter (correct semantics)
- `test_find_by_attr_substring_no_false_positives` — precision test, two nodes, only one matches
- `test_find_by_attr_substring_after_flush` — verifies the zone map bypass works correctly for data in flushed segments (not just write buffer)

The post-flush test is the most important one. It is present and correct. This gives me confidence the implementation is not accidentally working only against the write buffer.

---

## 7. Would Shipping This Embarrass Us?

No. The implementation is clean, the tests are honest, and the tradeoffs are documented and acceptable.

---

## Minor Observations (Not Blocking)

1. The `AttrQuery` builder lacks a `substring_match()` method. All internal Rust code must set it by struct literal. Not a bug, just inconsistency with the builder pattern used for other fields.
2. The MCP handler unconditionally sets `filter.substringMatch = true` (line 287 of `query-handlers.ts`). This is the intended behavior for the AI-facing tool. It is correct. But it means there is no way for an MCP caller to request exact-match behavior from `find_nodes`. This is a deliberate product decision — the AI tool always uses substring mode — but it should be consciously owned, not accidentally locked in.

---

**APPROVE**
