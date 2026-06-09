# Plugin → datalog2 rule-pack migration — synthesis (workflow wf_5c1d0663-039, 2026-06-10)

Full specs + adversarial verdicts: `plugin-datalog2-migration-specs.json` (3 specs × analyze+verify
agents; each verifier re-read the plugin source). Reference migration: `method-call-resolver` →
`packages/rfdb-server/src/datalog2/stdlib/method_calls.dl` (done this session).

## Verdict per plugin

| Plugin | Expressible | Verifier | Core join in Datalog? | Hard blockers |
|---|---|---|---|---|
| `shape-verifier` | partially | sound, 6 refinements | YES — violation join is pure Datalog (`SHAPE_VIOLATION` edges CALL→type, exclusive mode OK: dedicated type) | ISSUE **node** creation; message/id string construction; metadata payload |
| `semantic-bridge-detector` | partially | sound, 9 parity caveats | partially — sender/receiver matching joins yes, but heavy string heuristics | ~7 string/metadata builtins; service-name heuristics don't belong in-engine; several plugin strategies are literal-tracing-dependent |
| `axum-route-detector` | partially | **NOT sound as drafted** | YES for HANDLED_BY/ROUTES_TO joins | `http:route` **node** creation; **ROUTES_TO is SHARED vocabulary → exclusive mode would tombstone others' edges (must be additive)**; edge-metadata reads |

## The capability gaps (ranked by unblock value)

1. **Node materialization** — `@materialize_node(node_type=..., id from key columns / skolemized)`.
   Unblocks shape-verifier FULLY (ISSUE nodes) and axum-route-detector FULLY (http:route nodes).
   The single biggest engine feature for plugin migration.
2. **Small string builtins** (each mirrors `method_suffix` implementation pattern):
   `concat/3`, `ends_with/2`, `str_lower/2`, `basename/2`, `strip_quotes/2`.
3. **`edge_attr/5`** — read edge metadata (PASSES_ARGUMENT index, etc.). Needed by 2 of 3.
4. **Metadata projection in `@materialize`** — project named body bindings into the written
   edge's metadata (alongside the provenance stamp).

## Execution order (recommendation)

1. **FIRST the 4th q-error layer** (gaps.md): build-once base-leg joins in `join_extensional`
   (mirror `join_attr_generator_built_once`). Without it ANY full-graph rule-pack >900s — all
   migrations are gated on this.
2. `shape-verifier` rule-pack (violation join, SHAPE_VIOLATION edges, exclusive) + a thin
   consumer that derives ISSUE nodes from the edges (or wait for @materialize_node). Apply the
   verifier's 6 refinements (receiver-path precedence, first-EXTENDS-only parity note, fixture nit).
3. `axum-route-detector` with **additive** ROUTES_TO + HANDLED_BY; http:route nodes via consumer
   until node materialization lands.
4. `semantic-bridge-detector` LAST (least Datalog-natural; re-scope after the string builtins land).

## Cross-cutting stratifier note (from the shape-verifier spec)

`\+ edge(C, _, "CALLS")` is legal in a pack that does NOT materialize CALLS itself (per-program
storage-level deps) — but that pack must then RUN AFTER method_calls.dl. Merging both packs into
one program would re-trip E-STRAT-001. Rule-pack ORDERING is a real contract surface for the
plugin-loader design (decision #3).
