# Uncle Bob Review — REG-588 (Server-side substring matching)

**Reviewer:** Robert Martin (Uncle Bob)
**Focus:** Structure, naming, duplication, readability

---

## Summary

The change adds a `substring_match: bool` flag that threads from the wire protocol through the storage engine, allowing `name` and `file` filters to use `.contains()` instead of exact equality. The TypeScript MCP handler (`handleFindNodes`) unconditionally sets `substringMatch: true` so callers can pass partial names or paths.

The scope is well-bounded. No new abstractions were invented — the boolean was added where it was needed. That is the right instinct.

---

## File-by-file Analysis

### `packages/rfdb-server/src/storage/mod.rs` — AttrQuery field addition

Clean. The new field has a proper doc comment that states both the semantics and the default. The `#[serde(default)]` is correct so existing serialised queries without the field continue to work.

No issues.

### `packages/rfdb-server/src/storage_v2/shard.rs` — `matches_attr_filters`

**Parameter count: 11.** This function already had 10 parameters; the new boolean brings it to 11.

```rust
fn matches_attr_filters(
    node_type_value: &str,
    file_value: &str,
    name_value: &str,
    metadata_value: &str,
    node_type: Option<&str>,
    node_type_prefix: Option<&str>,
    file: Option<&str>,
    name: Option<&str>,
    exported: Option<bool>,
    metadata_filters: &[(String, String)],
    substring_match: bool,   // <-- new
) -> bool
```

This is the most significant structural issue in the diff. Eleven parameters is well past the "consider a Parameter Object" threshold. The first four are the node's own field values; the next six (now seven) are the query predicates. These two groups are conceptually separate and should not be collapsed into a flat parameter list. A `NodeAttrValues<'_>` struct and a query-side reference would make both call sites more readable and the function signature maintainable.

This issue pre-existed the change, but the new boolean makes it one parameter worse. Per project policy, touching a function is an opportunity to notice problems — it should be noted even if not fixed in this PR.

**Not a blocker for this PR** since the pre-existing design was accepted, but it is technical debt that should be tracked.

The substring matching logic itself is clean:

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

The `!f.is_empty()` guard for the empty-string-as-no-filter semantics is intentional and tested. Its intent is not immediately obvious from reading the code alone — a brief comment would help (`// empty string with substring_match = skip filter`). Minor issue.

### `packages/rfdb-server/src/storage_v2/shard.rs` — `find_node_ids_by_attr`

The zone-map bypass logic is clear and well-commented:

```rust
// When substring matching, file-based zone map pruning must be skipped
// because zone maps store exact file paths and can't evaluate substrings.
let prune_file = if substring_match { None } else { file };
```

This is the most non-obvious correctness subtlety in the whole change and it has the right comment. No issues.

### `packages/rfdb-server/src/bin/rfdb_server.rs` — WireAttrQuery + handlers

**`WireAttrQuery` struct:** Clean. The `#[serde(default)]` on `substring_match` gives safe wire compatibility. The doc comment on the struct explains the `extra` flatten pattern. No issues.

**Duplicate conversion block — critical duplication.**

The `WireAttrQuery -> metadata_filters -> AttrQuery` conversion is written out identically in **three** places:

1. `Request::FindByAttr` handler (lines ~1011-1032)
2. `Request::QueryNodes` handler (lines ~1198-1218)
3. `handle_query_nodes_streaming` (lines ~1988-2008)

All three blocks are character-for-character identical. This is a textbook Rule of Three violation. A helper function should exist:

```rust
fn wire_to_attr_query(query: WireAttrQuery) -> AttrQuery {
    let metadata_filters = query.extra.into_iter()
        .filter_map(|(k, v)| match v {
            serde_json::Value::String(s) => Some((k, s)),
            serde_json::Value::Bool(b) => Some((k, b.to_string())),
            serde_json::Value::Number(n) => Some((k, n.to_string())),
            _ => None,
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

This duplication is a **reject-level** finding. If the `AttrQuery` struct gains another field, all three sites must be updated in sync — a coordination failure waiting to happen. The streaming handler is the most dangerous because it lives in a separate function scope and is the easiest to forget.

Note: The comment in the `FindByAttr` handler says `// Convert extra wire fields to metadata filters` while the `QueryNodes` handler drops that comment. The streaming handler has `// Build AttrQuery from wire format (same as non-streaming path)`. If the intent was to note that the conversion is shared logic, the correct conclusion was to extract it rather than comment it.

**Tests:** Six new tests, clearly named, well-structured. Each test exercises a distinct scenario:
- `test_find_by_attr_name_substring` — basic name partial match
- `test_find_by_attr_file_substring` — basic file partial match
- `test_find_by_attr_exact_default` — default is exact, backwards compat
- `test_find_by_attr_empty_query_no_match_all` — empty string = skip filter
- `test_find_by_attr_substring_no_false_positives` — negative case
- `test_find_by_attr_substring_after_flush` — segment path (zone map bypass)

The flush-after test is particularly good — it specifically targets the zone map bypass correctness path, which is the riskiest part of the implementation. The comments inside tests explaining what is being verified are helpful.

No forbidden patterns in tests. Assertions have meaningful messages.

One minor issue: some test names use the word "no" ambiguously. `test_find_by_attr_exact_default` tests both non-match and match in the same test body — it could be split into `test_find_by_attr_exact_no_partial_match` and `test_find_by_attr_exact_full_match` for tighter focus, but this is a style preference, not a hard violation.

### `packages/mcp/src/handlers/query-handlers.ts` — MCP handler

The change removes dead parameter threading and unconditionally sets `substringMatch: true`. The handler is now cleaner than before.

```typescript
filter.substringMatch = true;
```

This is a one-liner, clearly placed, no ceremony. Good.

The function is 51 lines, just over the 50-line threshold but only because of pagination boilerplate. Not a real concern.

No issues.

### `packages/rfdb-server/src/storage_v2/multi_shard.rs` + `graph/engine_v2.rs`

The threading of `substring_match` through these layers is mechanical and correct — just adding the boolean to existing parameter lists and forwarding it. No logic changes. Clean.

---

## Forbidden Patterns Check

- No `TODO`, `FIXME`, `HACK`, `XXX` in changed code.
- No `mock`/`stub`/`fake` outside test files.
- No commented-out code.
- No empty implementations.

---

## Verdict: REJECT

**One hard violation that requires a fix before approval:**

**Duplicate `WireAttrQuery -> AttrQuery` conversion** in three locations (`FindByAttr` handler, `QueryNodes` handler, `handle_query_nodes_streaming`). Extract a `wire_to_attr_query(WireAttrQuery) -> AttrQuery` helper. This is not stylistic — triplication of a 12-line conversion block is a maintenance hazard and violates DRY explicitly.

**One tracked observation (not blocking, but log it):**

`matches_attr_filters` has 11 parameters. This is pre-existing debt, but it should be filed as a follow-up. A `NodeAttrValues<'_>` struct would halve the parameter count at future call sites.

Fix the duplication, re-run tests, re-submit for review.
