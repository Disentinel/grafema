# Steve Jobs Vision Review — REG-588 (Round 2)

**Verdict: APPROVE**

---

## What Changed Since Round 1

Round 1 approved the vision and architecture but was written before Вадим's and Uncle Bob's REJECTs exposed two real problems. This review confirms both are now fixed.

---

## Fix 1: DRY — `wire_to_attr_query` helper extracted (Uncle Bob REJECT resolved)

The triple-duplicated `WireAttrQuery -> AttrQuery` conversion block is gone. A `wire_to_attr_query(query: WireAttrQuery) -> AttrQuery` function now exists at line 793 of `rfdb_server.rs`, with a proper doc comment, and is called from all three sites:

- `Request::FindByAttr` handler (line 1040)
- `Request::QueryNodes` handler (line 1206)
- `handle_query_nodes_streaming` (line 1975)

The helper correctly maps all fields including `substring_match`. The `#[serde(flatten)]` extra fields conversion is in one place. If `AttrQuery` gains another field tomorrow, exactly one site changes. This is the right structure.

---

## Fix 2: Full JS pipeline now forwards `substringMatch` (Вадим REJECT resolved)

Three layers were broken. All three are now correct:

**`packages/types/src/rfdb.ts`** — `AttrQuery` interface now declares `substringMatch?: boolean` with a doc comment. The type system knows about this field. No more casting through `Record<string, unknown>`.

**`packages/rfdb/ts/base-client.ts`** — `_buildServerQuery` at line 325 forwards the field:
```typescript
if (query.substringMatch) serverQuery.substringMatch = query.substringMatch;
```

**`packages/core/src/storage/backends/RFDBServerBackend.ts`** — `queryNodes` at line 510 forwards the field:
```typescript
if (query.substringMatch) serverQuery.substringMatch = query.substringMatch;
```

The MCP handler sets `filter.substringMatch = true`. That value now flows: MCP handler → RFDBServerBackend → base-client `_buildServerQuery` → wire JSON → RFDB server → `wire_to_attr_query` → `AttrQuery.substring_match = true` → `matches_attr_filters` → `.contains()`. The pipe is continuous.

---

## Vision Check

"AI should query the graph, not read code."

This feature is the exact embodiment of that principle at the query layer. An AI agent calling `find_nodes` with a partial function name like `"Controller"` or a partial path like `"src/auth"` now gets back the right nodes. The server does the work. The graph is the answer.

Before this change, the MCP layer was doing client-side substring filtering — a hack that only worked because the server returned all matching names as exact strings and the client re-filtered. That was fragile and invisible. Now the contract is explicit: the query carries intent, and the storage layer executes it.

The zone map bypass for file substring queries (`let prune_file = if substring_match { None } else { file }`) is the one concession to implementation reality. It is well-documented, correct, and acceptable. Name-type combined queries (the common case for AI) still benefit from node_type zone map pruning.

---

## One Remaining Observation (Not Blocking)

The `matches_attr_filters` function now has 11 parameters. This was noted by Uncle Bob and is pre-existing technical debt, not introduced by this PR. It is not a reason to reject. It should be filed as a follow-up if it is not already tracked.

---

**APPROVE**
