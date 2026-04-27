# Feature Taxonomy

**Status:** Internal architecture reference. Consolidates the entity model that
two upstream research docs cover from different angles:

- `cognitive-debt-and-feature-detection.md` — cognitive theory, detection
  pipeline phases, registry-of-knowledge (DECISION/FACT) integration.
- `shape-and-contract-inference.md` — formal CONTRACT model, three-class
  taxonomy (Speced / Emergent / Synthesized + Reflective), per-paradigm survey,
  shape-construction soundness.

This document gives the **canonical six-entity model** used by enrichers and
queries, the L0–L5 abstraction-level mapping, edge cardinalities, detection
mechanisms (functor: code → graph), and the registry-extension schema.

---

## 1. The six entities

### 1.1 ENTRY_POINT

A concrete access modality at one declarative or framework-level call site.
Detected directly from code via L0 enrichers. The most concrete entity in
the taxonomy.

Examples (categories shipped or planned): `cli:command`, `mcp:tool`,
`vscode:command`, `package:export`, `http:route`, `cron:schedule`,
`event:subscriber`.

Identity: `(modality, name, file, file-line)`.

### 1.2 INTERFACE

The pure structural surface of an ENTRY_POINT — the in-shape (parameters,
fields), out-shape (returns, response body), and error-shape (declared
exceptions). No semantics — just forms and names.

INTERFACE is a **subset** of CONTRACT. It corresponds to the SHAPE node in
`shape-and-contract-inference.md` §2 when the SHAPE is attached to an
ENTRY_POINT boundary.

### 1.3 CONTRACT

`CONTRACT = INTERFACE ⊕ behavioral guarantees` (Meyer's
Design-by-Contract: pre-conditions, post-conditions, invariants, effect
declarations, error semantics).

Owned by ENTRY_POINT, not by FEATURE. One logical product unit exposed via
two modalities (CLI + MCP) has **two distinct CONTRACTs** sharing one
underlying BEHAVIOR.

Class taxonomy (per `shape-and-contract-inference.md` §2.5):

- **Speced** — single declarative authority; consumers conform.
- **Emergent** — N producers / M consumers asymmetry; contract = inferred
  Σ(writers) ∩ Σ(readers); mismatch = bug.
- **Synthesized** — produced by a transformation: build-time codegen,
  resolution-time scope (type classes / traits / multimethods), or
  cross-cutting advice (AOP / middleware).
- **Reflective** (degenerate) — computed per-call; not enumerable; emit
  OPAQUE_BOUNDARY ISSUE.

Cross-cutting modifiers (orthogonal to class): Versioned / Compositional /
Time-dependent / Conditional / Open-world hook.

### 1.4 BEHAVIOR

The implementation region: the bounded transitive call closure rooted at
the ENTRY_POINT's handler. Represents *what the code actually does*,
abstracted from the access modality.

Identity: `sha256(sort(transitive_call_targets))`. Storage: `hash` +
`effects[]` + summary (`coreNodeCount`, `depth`). **No COMPRISES edges** —
membership recoverable on demand via backward CALLS-walk
(see skill `materialize-only-what-queries-need`).

Each ENTRY_POINT has exactly one BEHAVIOR. Different ENTRY_POINTs share
BEHAVIOR via `SHARES_BEHAVIOR_WITH` edges (hash-equality).

### 1.5 FEATURE

The product unit. Conceptually: equivalence class of ENTRY_POINTs under the
`SHARES_BEHAVIOR_WITH` relation — "the same logical capability, exposed via
one or more access modalities".

Status: **derived projection**, not necessarily a separate node. Materialize
as a graph node when attributes are needed (lifecycle, owner, capability
tag, business labels). Otherwise leave as a query-time grouping over
ENTRY_POINTs.

Open design choice: when to materialize. Default — keep as derivation;
materialize only when ≥1 attribute requires persistence beyond the
ENTRY_POINT cluster.

### 1.6 COMPONENT

A cluster of FEATUREs sharing dependency graph, behavioral overlap, or
co-effect surface. Business-domain unit (paradigm-level, L4).

Detection: community detection on the dependency graph or on the
SHARES_BEHAVIOR_WITH × CALLS bipartite graph. Threshold tunable
(Jaccard ≥ 0.85 as starting point per `cognitive-debt-and-feature-detection.md`
§4.3 Phase 5).

Capability is a **human-labelled** property on COMPONENT (interview output);
the cluster is auto-derived but the business name is not.

---

## 2. Abstraction-level placement (L0–L5)

```
L5 cognitive    │ Cognitive load = f(BEHAVIOR core size,
                │                    effect count,
                │                    modality count,
                │                    contract complexity,
                │                    NamingIncongruence)
                │
L4 paradigm     │ COMPONENT  ──delivers──►  Capability  (human-labelled)
                │     ▲
                │     │ clustering on co-Behavior / co-deps / co-effects
                │     │
L3 projection   │ FEATURE  (equivalence class on SHARES_BEHAVIOR_WITH)
                │     ▲
                │     │ HANDLES / IMPLEMENTED_BY / SHARES_BEHAVIOR_WITH
                │     │
L2 op-semantics │ ENTRY_POINT ──HAS_CONTRACT──►  CONTRACT  ⊃  INTERFACE
                │     │
                │     └──IMPLEMENTED_BY──►  BEHAVIOR
                │                            │
                │                            ├─PRODUCES_EFFECT─► EffectType
                │                            └─THROWS─────────► ErrorClass
                │
L1 AST          │ FUNCTION / METHOD / PARAMETER / CALL / LITERAL /
                │ EXPORT_BINDING / RETURNS-edge / THROWS-edge
                │
L0 source       │ raw text + library declarative strings
```

Each level upward is an abstract interpretation (Cousot & Cousot 1977) of
the level below. The functors L0→L1→L2 are detection enrichers. L2→L3 and
L3→L4 are derivations (clustering, equivalence-class projection).

---

## 3. Edges and cardinality

| Source | Edge | Target | Cardinality |
|---|---|---|---|
| ENTRY_POINT | `HANDLES` | FUNCTION/METHOD | 1 |
| ENTRY_POINT | `HAS_CONTRACT` | CONTRACT | 1 |
| ENTRY_POINT | `IMPLEMENTED_BY` | BEHAVIOR | 1 |
| ENTRY_POINT | `EXPOSES` | FEATURE | N→1 *(if FEATURE materialized)* |
| CONTRACT | `PROJECTS_TO` | INTERFACE | 1 *(or fields inlined)* |
| CONTRACT | `DECLARES_EFFECT` | EffectType | N |
| CONTRACT | `DECLARES_ERROR` | ErrorClass | N |
| CONTRACT | `HAS_CLASS` | {Speced,Emergent,Synthesized,Reflective} | 1 |
| CONTRACT | `HAS_MODIFIER` | Modifier | N |
| BEHAVIOR | `SHARES_BEHAVIOR_WITH` | BEHAVIOR | N (hash-equality) |
| BEHAVIOR | `PRODUCES_EFFECT` | EffectType | N |
| BEHAVIOR | `THROWS` | ErrorClass | N |
| FEATURE | `GROUPED_INTO` | COMPONENT | N→1 |
| FEATURE | `HAS_LIFECYCLE` | {active, deprecated, experimental, …} | 1 |
| COMPONENT | `DELIVERS` | Capability | N |

CONTRACT-side edges (`DECLARES_EFFECT`, `DECLARES_ERROR`) are **declared**
guarantees from the spec; BEHAVIOR-side edges (`PRODUCES_EFFECT`, `THROWS`)
are **observed** facts from the implementation. Mismatch between declared
and observed is a contract violation — directly enforceable as a Datalog
guarantee.

---

## 4. Detection mechanisms (functor: code → graph)

All enrichers are deterministic post-processors over the AST/CALLS/READS_FROM
projections. Single declarative input is `effects-db/`.

| Entity | Mechanism | Registry input |
|---|---|---|
| ENTRY_POINT (Speced libraries) | `libraryCallbackEnricher` matches CALL→library-rule via `args[N].role: ENTRY_POINT_CALLBACK` | `effects-db/packages/*.yaml` |
| ENTRY_POINT (custom dispatchers) | per-framework enricher (e.g. `mcpToolDefinitionEnricher` for switch-by-name dispatch) | hard-coded in enricher; can move to YAML |
| ENTRY_POINT (package-level) | `packageApiEnricher` — barrel `index.ts` + EXPORT_BINDING | `package.json#exports` and/or barrel-parsing |
| CONTRACT — Speced | per-category extractor (commander declaration string, MCP `inputSchema`, `package.json#contributes`, route decorators, function signature) | `effects-db/packages/*.yaml` plus proposed `contract_class: speced` field |
| CONTRACT — Emergent | shape inference on channel: Σ(writer WRITES_TO) ∩ Σ(reader READS_FROM); identify channel via library rule | `effects-db` channel-identity rules |
| CONTRACT — Synthesized | (codegen) ingest post-expansion artifact; (resolution) implement compiler-style instance resolution; (advice) model intercept chain | per-language rule pack |
| CONTRACT — Reflective | flag site, emit `OPAQUE_BOUNDARY` ISSUE | per-language list of reflective constructs |
| INTERFACE | projection: pull only structural fields out of CONTRACT | derived |
| BEHAVIOR | `behaviorEnricher` — CALLS-only forward closure, hash, effect rollup via `EffectsLookup` | `effects-db/` for effect propagation |
| FEATURE | dedup pass: equivalence class on BEHAVIOR.hash | derived |
| COMPONENT | clustering algorithm on dep-graph + SHARES_BEHAVIOR_WITH | tunable thresholds; capability label from interview |

---

## 5. Registry interaction

The single point of declarative extension is `effects-db/`. Two existing
classes of YAML files cover most ground:

- `effects-db/runtimes/<rt>.yaml` — Node.js builtins, Python stdlib, JVM
  builtins, …
- `effects-db/packages/<pkg>.yaml` — per-package: `args[].role`,
  `returns.type`, `channel`, `effects`.

### 5.1 Proposed extension (per `shape-and-contract-inference.md` §A.9)

```yaml
# additions to effects-db/packages/<pkg>.yaml
contract_class: speced | emergent | synthesized-codegen
              | synthesized-resolution | synthesized-advice | reflective
modifiers: [versioned, compositional, time-dependent, conditional, open-world]

# new top-level concept: channel-identity rules for emergent contracts
channels:
  - kind: redis_pubsub
    identity: "redis.publish(args[0])"   # path-into-call to extract channel ID
  - kind: event_emitter
    identity: "emitter.emit(args[0])"
```

Adding a new framework / new language entry-point becomes a YAML edit, no
code. This is the contract registry's load-bearing claim: a new extractor
should not require a new enricher.

### 5.2 Knowledge Base (KB) registry

Orthogonal registry: `_ai/knowledge/` holds DECISION / FACT / SESSION /
COMMIT / TICKET nodes added via `add_knowledge`. KB connects to graph nodes
through `applies_to: [<semantic-id>]`. For the taxonomy:

- A FEATURE's `lifecycle: deprecated` decision lives as KB DECISION linked
  via `applies_to: <feature-id>`.
- A COMPONENT's `capability: "billing"` is similarly a FACT.
- Guarantees in `.grafema/guarantees.yaml` reference taxonomy nodes
  (e.g. "every CONTRACT must `DECLARES_EFFECT` matching its BEHAVIOR's
  `PRODUCES_EFFECT`").

The taxonomy is the **referent target** of KB; KB enriches the taxonomy
with intent / decision / lifecycle / ownership.

---

## 6. Query taxonomy — what the model lets us answer

Grouped by abstraction level. Query primitives are the shipped
`find_nodes` / `find_calls` / `trace_dataflow` / `query_graph` MCP tools
plus the derived enrichers above.

### L1–L2 (concrete, already implemented)
- "Where is X defined?" → `find_nodes`
- "Who calls X?" → `find_calls`
- "Where does Y flow?" → `trace_dataflow`

### L2 (ENTRY_POINT / CONTRACT / BEHAVIOR)
- "What's the contract of this endpoint?" → `HAS_CONTRACT` → metadata
- "What effects does this endpoint produce?" → BEHAVIOR `PRODUCES_EFFECT`
- "Did the contract drift?" — diff Σ(producer-shape) vs Σ(consumer-reads) on
  Emergent CONTRACT → ISSUE

### L3 (FEATURE)
- "What features are in this code?" → enumerate ENTRY_POINTs +
  cluster on BEHAVIOR.hash
- "Which features share behavior?" → `SHARES_BEHAVIOR_WITH` edges —
  cross-modality dedup signal
- "What features depend on this code?" → backward CALLS-walk to ENTRY_POINTs
  (impact analysis)
- "Which features bypass declared effects?" — DECLARES_EFFECT vs
  PRODUCES_EFFECT diff

### L4 (COMPONENT)
- "Which components are coupled?" — cross-component edge density
- "Which component owns this capability?" — `DELIVERS` edge
- "Where does shared infrastructure live?" — modules with callers across ≥3
  COMPONENTs

### L5 (cognitive — Phase 9 in upstream doc, not yet implemented)
- "How heavy is this feature to comprehend?" — composite metric on BEHAVIOR
  size × effect count × NamingIncongruence
- "What would simplify the most?" — ranked refactoring suggestions

---

## 7. Open architectural questions

| # | Question | Default answer | Where to revisit |
|---|---|---|---|
| Q1 | Materialize FEATURE as a graph node, or keep as derived projection? | Derived; materialize when ≥1 attribute needs persistence | when introducing FEATURE.lifecycle, FEATURE.owner |
| Q2 | One CONTRACT node per ENTRY_POINT, or split INTERFACE / behavioral fields? | One CONTRACT carrying both | when behavioral guarantees grow rich (pre/post-conditions) |
| Q3 | When to switch from exact-hash dedup to Jaccard similarity? | Stick with exact-hash for v1; Jaccard ≥ 0.85 for v0.5 | when SHARES_BEHAVIOR_WITH count seems to under-report on a real codebase |
| Q4 | COMPONENT clustering algorithm | Louvain / community detection on dep-graph | when graph scale demands streaming clustering |
| Q5 | Synthesized contracts — read post-expansion or model the transformation? | Read post-expansion when artifact is on disk; model when not | per-language case-by-case |

---

## 8. Cross-references

- `_ai/research/cognitive-debt-and-feature-detection.md` — detection pipeline
  phases, FEATURE_FLAG (L2), cognitive-load metrics (L5), KB integration,
  C1–C6 cognitive dimensions.
- `_ai/research/shape-and-contract-inference.md` — formal CONTRACT model,
  three-class taxonomy + degenerate Reflective, cross-paradigm survey
  (Appendix A), per-FEATURE-category interface sources.
- `_ai/research/sociotechnical-graph-model.md` and
  `sociotechnical-entity-catalog.md` — Org / Team / Person projection on top
  of COMPONENT layer.
- `_ai/research/flow-analysis-design.md` — METRIC nodes layer (per-feature
  runtime metrics, future bridge to FEATURE.cost / FEATURE.usage).
- `effects-db/` — declarative extension surface.

This document is **internal architecture reference**, not a user-facing
positioning artifact. Public-facing framing of what this enables is tracked
separately.
