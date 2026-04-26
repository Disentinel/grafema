---
name: materialize-only-what-queries-need
description: |
  Decide what to PERSIST in your data structures (graph nodes, DB tables,
  cache layouts) based on the QUERIES you must answer, not the DEFINITIONS
  that justify the data. Definitions tell you logical identity; storage
  strategy is independent. Materializing every definitional component
  leads to O(N×M) blow-ups that masquerade as memory leaks. Use when:
  (1) designing a new graph-node type, edge type, DB table, or cache layout;
  (2) about to name a `subgraph` / `comprises` / `members` / `contains`
  collection on a parent entity;
  (3) memory growth proportional to (entities × per-entity-elements);
  (4) "memory leak" debugging that survives multiple targeted patches —
  the leak may be storage shape, not retention;
  (5) pre-implementation sketch includes "for each X, store all reached nodes";
  (6) research/spec doc says "X = ⟨A, B, C⟩" and you're tempted to make
  it three storage edges per X.
author: Claude Code
version: 1.0.0
date: 2026-04-26
---

# Materialize only what queries need

## Why this skill

Definitions are about logical identity. Storage is about physical access cost.
These are independent. When the spec says

> Behavior = ⟨ExecutionSubgraph, Effects, ExitPoints⟩

it tells you what *characterizes* a Behavior — not how to represent it on disk.
Reading the tuple as "store these three pieces" is a category mistake. The
result is a representation that contains data no query asks for, at the cost
of OOM-grade memory pressure on real-scale inputs.

This is the meta-pattern behind a class of "performance bugs" that resist
patching: each patch makes the implementation slightly faster, but the
fundamental shape of the persisted data is wrong by orders of magnitude.

## In-action triggers (catch the wrong default before writing code)

| Trigger | Reflect | Quick check |
|---|---|---|
| Naming a collection `subgraph` / `members` / `contains` / `comprises` on a parent entity | List queries that need *membership* | If none — drop the collection, store an aggregate |
| Spec says `X = ⟨A, B, C⟩` and you're modeling A, B, C as fields/edges of X | Distinguish definition from storage | Definition can stay; storage ≠ definition |
| Estimated row/edge count = entities × average-children = millions | Cost-model the queries you'd serve | Most queries are answerable from a 64-byte hash |
| "Materialize once, query fast" intuition | Only true if `storage_cost ≪ Σ query_cost`. Usually false for forward closures over large graphs | Estimate aggregate query frequency × on-demand cost vs storage cost |
| 2nd patch at "memory issue" hasn't fixed it | Climb from process to premise: am I storing the right thing at all? | Apply this skill; the leak is shape, not retention |

## On-action diagnostic: am I about to over-materialize?

For every persistent collection / edge type / table you're about to create,
walk this list. Skip → don't materialize.

1. **Name a concrete query** — user-facing or internal — that needs THIS data
   in THIS shape. If you can't, stop.
2. **Aggregate?** Could a hash, count, max/p90, or Set<dimension> answer instead?
3. **On-demand viable?** Can the query be computed from existing edges in
   ≤ 1 s on the realistic-scale graph? If yes, don't precompute.
4. **Direction inverted?** Many "X contains Y" queries are answered better
   by "Y is reachable from X-entry" — runtime backward walk, not stored
   forward edges.
5. **Frequency?** A query that runs once per CI gate doesn't justify
   precompute. A query in a hot path that scales with graph size might.

If ALL queries answer "aggregate suffices" or "on-demand is fine" — drop
the materialized collection.

## Diagnostic when memory issues resist patching

Symptoms that point at over-materialization (vs. real leak):

- Memory grows roughly linearly with the number of *parent* entities being
  iterated, not with global state size.
- Targeted patches (chunked flush, explicit GC, freeing intermediate vars)
  reduce the slope but don't eliminate it.
- "Synthetic small fixture passes; real-scale OOMs" — synthetic tests don't
  show the explosion because per-parent payload is small.
- Time-to-OOM is roughly proportional to heap_cap. Doubling the cap doubles
  the time before OOM, instead of completing.

When 2-3 of these are true, the issue is storage shape, not allocation discipline.

## Refactor recipe

When you've over-materialized:

1. **Re-derive query list** for the artifact under suspicion.
2. **For each query, pick minimum storage:**
   - Aggregate (hash, count, p90) → field on parent entity
   - On-demand traversal → no storage; document the query function instead
   - Repeated forward joins on stored data → maybe materialize, with explicit
     cost model in the spec
3. **Drop the unneeded edges/rows.** Existing analyzers/enrichers stop emitting them.
4. **Add a Datalog rule or query function** for queries previously served by
   the materialized form.
5. **Update the spec / research doc**: change `X = ⟨A, B, C⟩` to clarify
   "A, B, C characterize X; storage = {hash, summary, ...}".

## Anti-patterns

- **"The research doc says it's a tuple, so I store all three components"** —
  category error. Spec gives the concept; storage is independent.
- **"Materialize once, query fast"** without a cost model — usually false
  for forward-closure-over-large-graph cases.
- **Synthetic-only verification** — "200 small entities pass, ship it."
  Always verify on realistic-scale fixture early. The shape bug only shows
  up when per-parent payload is large.
- **Patching the leak instead of the shape** — chunked flush, explicit GC,
  `WeakRef`, etc. each look reasonable in isolation but accumulate without
  fixing the issue. After 2 failed patches, climb to premise.
- **"It's fine for typical case"** as exit excuse — if the failing case is
  a moderate codebase, real worst case is bigger, not smaller. Don't
  rationalize away the failure.

## Concrete failure (Grafema, 2026-04-26)

Spec (research doc):

```
Behavior  = ⟨ ExecutionSubgraph, Effects, ExitPoints ⟩
ExecutionSubgraph = reachable(EntryPoint, CALLS ∪ READS_FROM) ∩ ...
```

Initial plan emitted `BEHAVIOR -COMPRISES-> code_node` edges per touched node.
For 149 features × ~thousands of touched nodes per feature (real codebase),
that's millions of edges materialized in RFDB.

Real user queries:
- Auto-doc → CONTRACT (params/returns) + effect summary. **Not** subgraph.
- Dedup → `hash(sorted(transitive_call_targets))`. **Not** subgraph.
- Cognitive metrics → counts + depth p90. **Not** membership.
- "What features does this code serve?" → backward callers traversal at
  query time. **Not** forward subgraph.

Three patch rounds at "memory leak" (chunked flush → trim retained → shared
index cache) each cut growth rate but never eliminated it. Round 4 (premise
reflection triggered by user pushback) revealed: no query needs the
materialized edges. Drop them — peak memory falls ~1000×.

## Connection to companion skills

- **reflection-in-and-on-action**: catches the trigger ("2nd patch attempt").
  This skill provides the resolution at premise level.
- **profile-before-rewrite**: don't optimize the wrong thing. This skill is
  upstream — pick the right shape, then profile. If you've already profiled
  and the issue is "we're storing X bytes per entity", this skill says
  "consider not storing X at all".
- **validate-assumptions-before-implementing**: same family. Validate the
  *premise* (do we even need this data?) before validating the *implementation*
  (does the leak fix work?).

## When NOT to apply

- Spec's tuple components are all small and bounded (e.g., a few fields).
- The query that needs full materialization runs frequently and is in a hot path.
- You've already verified at realistic scale that materialization is safe and
  the spec query mix justifies it.

Skill is about catching the *default* mistake of materializing because the
spec describes the concept that way. Some materializations are correct; the
discipline is to derive them from queries, not from definitions.
