# Pipeline profiling as a queryable subgraph

`grafema analyze` emits a **profile subgraph** so the pipeline's critical path
and bottlenecks are a GRAPH QUERY, not a log-grep. The derive packs in
particular — previously visible only as a `Rule pack materialized pack=X ms=N
edges=M` log line (the blind spot) — are now graph facts.

## Schema (everything namespaced `profile:` so it never pollutes code queries)

| Node type       | One per                                   | Attrs (metadata)                                          |
|-----------------|-------------------------------------------|-----------------------------------------------------------|
| `profile:run`   | `grafema analyze`                         | `ts`, `total_ms`                                          |
| `profile:phase` | phase (`resolve`, `derive`, …)            | `phase`                                                   |
| `profile:stage` | resolver-cmd / derive-pack / enricher     | `phase`, `kind`, `wall_ms`, `edges_produced`, `nodes_produced`, `order` |
| `METRIC`        | one measure                               | `value`, `unit` — REUSES the existing METRIC node type    |

Edges:
- `profile:phase --PART_OF--> profile:run`
- `profile:stage --PART_OF--> profile:phase`
- `profile:stage --PRECEDES--> profile:stage` (execution order within a phase — the *route*)
- `METRIC --OBSERVES--> profile:stage` (and per-phase `wall_ms` METRIC OBSERVES the phase) — same shape as today's per-file `parse_ms`

Stages are extracted from the profiler's in-memory event stream
(`rule_pack_complete`, `resolve_cmd_complete`, `js_resolve_complete`,
`ruby_resolve_complete`). All ids live under the synthetic file
`__grafema_profile/<run_ts>` so they tombstone on the next analyze and never
collide with code nodes.

`kind` ∈ `resolver` | `derive_pack` | `enricher`.

## On by default

Emission is on by default (cheap — a few hundred nodes). Disable with
`GRAFEMA_PROFILE_SUBGRAPH=0`.

## Reading it

### The helper (route + jams + dead stages from the graph)

```bash
node scripts/profile-graph.mjs --project .            # human-readable
node scripts/profile-graph.mjs --json                 # machine-readable
node scripts/profile-graph.mjs --dead-threshold-ms 5000
```

It walks the `PRECEDES` chains, sums `wall_ms`, and prints the critical path
(longest chain by summed wall_ms), the top jams, and the dead stages.

### Raw Datalog (`grafema query --raw`)

All stages ranked by wall time (the jams):

```
stage(S, Name, Ms, E) :- node(S, "profile:stage"), attr(S, "name", Name),
                         attr(S, "wall_ms", Ms), attr(S, "edges_produced", E).
```

**Dead stages** — high wall time AND zero edges produced (the REG-1128
type-inference / shape-verifier class):

```
dead(S, Name, Ms) :- node(S, "profile:stage"),
                     attr(S, "edges_produced", "0"),
                     attr(S, "wall_ms", Ms),
                     gt(Ms, "1000"),
                     attr(S, "name", Name).
```

The PRECEDES route (stage order within phases):

```
route(A, B) :- edge(A, B, "PRECEDES").
```

Per-phase totals:

```
phase_wall(P, Ms) :- node(P, "profile:phase"), node(M, "METRIC"),
                     edge(M, P, "OBSERVES"), attr(M, "value", Ms).
```

> Note: the *critical path = longest PRECEDES chain by summed wall_ms* needs a
> weighted longest-path walk, which pure Datalog does not express; the
> `profile-graph.mjs` helper computes it from the `profile:stage` + `PRECEDES`
> facts. The dead-stage query above is fully expressible in Datalog and is the
> standing-fact CI-gate candidate.
