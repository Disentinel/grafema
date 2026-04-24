# DAI-22 — Cohesion-signal gap (diagnosis)

**Date:** 2026-04-24
**Flagged by:** user ("Не может быть чтобы оно за 7 секунд посчитало")
**Status:** REAL DEFECT in plan §A.1 liftable-edge assumption. Placement is correct but cohesion is inert.

## What's observed

On grafema self-analysis RFDB (331,779 nodes / 845,961 edges post-layout):

| Liftable type | Total | Both-endpoints-placeable |
|---|---|---|
| CONTAINS | 334,235 | (structural — already in folder tree) |
| READS_FROM | 105,097 | ~4% (mostly REFERENCE→PARAMETER, REFERENCE→CONSTANT, PROPERTY_ACCESS→REFERENCE) |
| PASSES_ARGUMENT | 30,622 | ~0% (CALL→REFERENCE dominant) |
| CALLS | 7,159 | 0% (CALL→FUNCTION dominant, CALL is excluded) |
| RETURNS | 2,582 | ~0% (FUNCTION→LITERAL / FUNCTION→CALL dominant) |
| HAS_METHOD | 1,691 | 100% (IMPL_BLOCK→FUNCTION 796, CLASS→METHOD 683) ✅ |

Loader reports **1,502 liftable edges** after `skip if endpoint not placeable` filter. Breakdown: almost all HAS_METHOD structural edges + a few IMPORTS_FROM. **The semantic call graph is completely lost.**

## Why

Grafema models function calls through CALL-node intermediaries:

```
FUNCTION A  --[CONTAINS]-->  CALL "b()"  --[CALLS]-->  FUNCTION B
```

Edge type `CALLS` has `src = CALL` (excluded from PLACEABLE_TYPES) and `dst = FUNCTION` (placeable). Plan §A.1 listed CALLS as liftable but didn't account for the CALL intermediary — so the filter drops every CALLS edge at loader time.

Same shape for `READS_FROM` (REFERENCE/PROPERTY_ACCESS as src), `PASSES_ARGUMENT` (CALL as src), `RETURNS` (FUNCTION→CALL/LITERAL dst), `AWAITS` (FUNCTION→CALL dst), etc.

## Impact

- **Placement is still correct** — zero collisions, 26,240/26,240 unique positions, 91.63% placed.
- **Cohesion is inert** — iswap does 5,217 swaps on 1,502 (almost exclusively structural) edges and converges at 77.6% Σlink reduction almost instantly. There is no "pull" from semantic call relationships because the layout input doesn't contain them.
- **Visual consequence:** two functions that call each other heavily are NOT placed close together. The layout clusters purely by folder hierarchy + class membership.
- **Original bug (858-node collision pile-up) is fixed.** This is a different, subtler bug on top.

## Fix — Chunk-12 scope

**Edge-lifting pass in `layout/loader.rs`.** For edge types routed through CALL/REFERENCE/PROPERTY_ACCESS intermediaries, add a join that lifts them to their enclosing placeable symbols via `CONTAINS`.

Example Datalog for CALLS:

```
lifted_calls(P, D) :-
  edge(P, C, "CONTAINS"),         // placeable P contains the intermediary
  placeable(P),
  edge(C, D, "CALLS"),
  placeable(D),
  P != D.
```

Repeat for: `READS_FROM`, `WRITES_TO`, `PASSES_ARGUMENT`, `AWAITS`, `RETURNS` (the destination-as-CALL variants also need the mirror lift).

For `READS_FROM REFERENCE→VARIABLE/CONSTANT/PARAMETER` — both endpoints can be non-placeable, so two-hop isn't enough; need full walk to enclosing FUNCTION/METHOD on both sides. Pragmatic: start with source-lift only (most common pattern), measure cohesion signal, iterate.

Expected outcome post-lift: liftable edge count grows from 1,502 to ≥ 20k. iswap will have real work to do; Σlink reduction should surpass the current 77.6% with meaningful spatial cohesion.

**Estimated effort:** ~300 lines of loader changes + Datalog query edits + tests. Perf impact: each liftable edge type now does a join (O(edges_of_type)) — cheap, still seconds.

**Merge gate for Chunk-12:** after lift, liftable edge count ≥ 20k AND iswap sigma_link reduction strictly greater than the current 77.6% baseline.

## Honest assessment

Plan v2 passed 3-pass Dijkstra review but all three passes operated on an assumption about Grafema's edge model that none of us verified. Dijkstra's Table 2 even asked "are all liftable types correct?" — answered "YES" based on the existing tectonic `liftable` list, which had the same bug (tectonic was MODULE-only so it didn't matter). A competent skeptic (user) caught it by asking "7 seconds is suspicious."

Retrospective: the plan verification should have included a **sample query on live data** to confirm each liftable type contributes > 0 both-endpoints-placeable edges before declaring the list complete. That kind of "verify-on-live-data" check is now a thing to add to the Dijkstra pattern.
