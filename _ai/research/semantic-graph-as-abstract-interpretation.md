# The Semantic Graph as Cross-Artifact Abstract Interpretation

**Status:** design conversation, 2026-06-09 (Vadim + Claude). NOT built — this is the conceptual
map that fell out of designing the Datalog-v2 stdlib / DSL / plugin model. Sibling to
`datalog-unified-engine-design.md` (that one is the engine L0–L4; this one is the *theory* that
names what the engine is FOR).

## 0. One-line thesis

**Grafema's derived semantic graph is a declaratively-specified abstract interpretation (Cousot &
Cousot, 1977) run ACROSS artifacts (code + config + deployment), computed as a Datalog fixpoint.**
Plugins are abstract-interpretation specifications; value-domains are the abstract value lattices;
the v2 engine is the fixpoint solver; semiring tags carry precision/confidence. Already-named in
`theoretical-foundations.md` ("semantic projections are abstract interpretations") — the fresh move
here is **cross-artifact** AI joined by value-domains, and **coverage reframed as demand-diff**.

## 1. What is abstract interpretation here (and what is NOT)

- **Concrete semantics** = run the program on a concrete input (an *instance*: request `/api/users`
  → backend `/users`). Runtime.
- **Abstract semantics** = run the program over an *abstract domain* — sets/patterns of values (a
  *type*: the pattern of all possible URLs) → a sound over-approximation of all concrete runs.
  Analysis-time. The user's phrase: "исполнение кода типа, не экземпляра."

**Honest boundary (not everything is AI — avoid the hammer-nail trap):**
- **Extracted structure** (AST, CONTAINS, the parse tree) = concrete syntax = plain facts. NOT AI.
- **Derived semantics** (dataflow, routing, reachability, points-to, cross-service links) = abstract
  interpretation (reasoning over the set of possible behaviors). AI names THIS layer.

## 2. Value-domains — the abstract value lattices ("values with their own life")

A value-variable like `:endpoint` is not a Datalog variable; it is an instance of a VALUE-DOMAIN.

**Communicational cut (good for talking, 3 recognizable phenomena, each with prior art):**
1. **Canonicalizer** — normalize raw value to a comparable form (prefix-append, domain-rewrite).
   ← canonical-forms / equality-modulo-theory.
2. **Equivalence / aliasing** — comparability is itself computed (a≡b, b≡c ⟹ a≡c).
   ← points-to/alias analysis as Datalog (DOOP/bddbddb/Soufflé), union-find, e-graphs/equality
   saturation (egg, POPL'21).
3. **Value-invention / fan-out** — one value mints many / synthesizes a node.
   ← Datalog^± / existential rules / the chase / Skolem / labeled nulls.

**Engineering cut (deeper, from a thinking-algebra audit of the above):**
- The invariant: a value-domain = **a keying function `occurrence → set-of-canonical-keys`**;
  identity = equal keys. Maps directly onto the engine's `encode_value`/`fact_id` (the canonical key
  IS the fact identity).
- Canonicalizer and equivalence are **DUALS, not siblings** — two implementations of ONE *equality
  theory*: `canon(x)=canon(y) ⟺ x~y`. Pick by whether a normal form exists (canon-fn, cheap) or not
  (derived congruence via rules, general). Fan-out is the orthogonal axis: a *creation policy*.
- So: **value-domain = equality-theory [canon | congruence] × creation-policy [bounded fan-out]**,
  with **soundness obligations** the communicational cut silently dropped: canonicalizer must be
  deterministic + idempotent + total; congruence must terminate; fan-out must be bounded (= the
  abstract domain has finite lattice height / widening — the formal reason fan-out doesn't explode).
- **Modality:** may-equal vs must-equal = precision of the abstraction. may-equal = a **ConfTag-tagged**
  equivalence — this is where value-domains connect to the semiring layer.

## 3. Plugins as AI specifications; the polyglot molecule

A **plugin** is the unit shipped per language / framework / domain. Atoms, each chosen by the
**physics of its data** (not ideology):

| Atom | Is | Physics | When |
|---|---|---|---|
| **Facts (YAML)** | static data (effects-db arg-roles, library API shape) | written once, no recompute | fixed per-library knowledge |
| **Extractor (JS/imperative)** | parse + messy compute | recompute from scratch; no incremental | parsing, fuzzy string-ops, dirty canonicalizers, glue |
| **Rules (Datalog)** | derived relations | **cheap incremental maintain + invalidation (Gate D2)** | re-derived constantly + large (dataflow, resolution, reach) |

**Decision rule:** put in Datalog ONLY what earns its (high) authoring cost via incremental
re-derivation. Hard-to-write, cheap-to-maintain. JS is easy-to-write, recompute. YAML is static data.

**Declarative-source vs imperative-source (key distinction):**
- **Imperative source** (JS, Rust): extractor must be imperative (parse + dirty semantic inference);
  rules sit on top. The CodeQL split. JS atom is large.
- **Declarative source** (nginx, k8s yaml, terraform, SQL DDL, .env): the source is ALREADY
  rules/facts. No semantic gap — it is a translation declarative→declarative. The JS atom shrinks
  toward zero. Molecule ≈ {thin parser → facts} + {fixed semantics rule-pack interpreting the facts}
  + {projection to archetypes}.
- **Interpreter > compiler for incrementality:** config → **facts** + a **fixed** semantics rule-pack
  (meta-interpretation) beats config → per-config rules. Changing part = data (facts), so D2 maintains
  by fact-delta; rule-level regeneration is coarser invalidation.

The DSL (TLDR archetype notation) is the readability surface for the HARD atom only — **Datalog**.
YAML/JS are already readable. Rationale: Datalog is genuinely hard (the project owner did not grok it
in 6 months — a product-defining signal). **DSL = product surface; Datalog = hidden IR.** Needs:
value-vars (`:endpoint`), node-materialization-with-payload, arg-role addressing, mandatory verb on
flow operators, explicit `*` for transitivity, raw-Datalog escape hatch for the ~20% (aggregation/∀).

## 4. Worked example — frontend → nginx → backend

The join key (URL path) is rewritten by nginx, so client-path ≠ backend-path. nginx config IS the
transformation between the two key-namespaces.

- nginx directives project onto **archetypes** (nothing is "noise"):
  - **routing** (location/proxy_pass/rewrite) → edges (`rewrites`, depends/flow).
  - **endpoint contract** (gzip, ssl, client_max_body_size, auth_basic, limit_req) → **node
    attributes** (real query targets: "TLS-only?", "no rate-limit?"). NOT noise.
  - **side effects** (try_files, return, error_page, log) → write/exception edges.
- nginx is a **declarative source** ⇒ molecule is mostly Datalog: thin config→facts parser +
  fixed nginx-semantics rule-pack (longest-prefix-match, prefix-strip, try_files order) + projection.
- The path is a value-domain whose **equality theory is a config-DERIVED congruence** (the rewrite),
  not a static normal form — the live example of §2's "congruence" branch.
- Fidelity rule: don't model ALL of nginx (`if`, Lua, `map` = imperative pockets → builtins or a
  loud "here be dragons", never silently dropped). Capture every directive that carries meaning, to
  the precision the queries need.

## 5. Deployment binding (env / DNS / compose / k8s) — resolution vs AI spectrum

Deployment facts MUST be in the graph (manifesto: code + infra + knowledge, one graph). They are the
missing transfer-function that closes the frontend→proxy gap (frontend's `base_url` is otherwise a
free variable). Deployment binding is a SPECTRUM, not uniformly AI:

- **Resolution region (exact, NOT AI):** `API_URL=…` (env), `host→ip` (DNS), `Service→pods` (k8s
  selector). Unique binding ⇒ recursive join over binding facts. **Same mechanism as the code import
  resolver** (`deployment binding : topology :: import resolution : code` — follow the binding chain).
- **Variability region (genuine AI):** load-balanced upstream (may reach any of N — fan-out),
  env-conditional config, canary/traffic-split. Over-approximate the set of possible bindings.

**Unification:** resolution and abstract interpretation are two regions of ONE precision spectrum on
the SAME engine (Datalog fixpoint). Abstract domain = singleton ⇒ "resolution"; lattice ⇒ "AI". The
engine doesn't care; the difference is the domain's precision. (Pedantically, resolution = a
degenerate AI over the may-bind/points-to domain that happens to be exact.)

Deployment is just another declarative source → facts (`env_binding`, `dns`, `serves`,
`k8s_service`) + resolution/AI rules.

## 6. Coverage, reframed — the payoff

**Old coverage:** "% of files parsed." Bottom-up, blunt; says a file is dark, not what meaning is lost.

**New coverage:** completeness of the abstract-interpretation CHAINS for the questions you care about.
A target fact (e.g. `link(client, backend)`) is the end of a derivation chain; a gap is an **unbound
premise at a specific hop**.

**Mechanism (demand-diff, top-down):**
- Use the **top-down evaluator** (spec §1 keeps it "for goal-directed point queries") to expand the
  DEMAND for a target backward (magic-sets / goal-directed) → exactly which sub-facts are needed.
- **Coverage = demand-set ∖ EDB.** The difference IS the gaps.
- Each gap = a **why-NOT** (the dual of our `why()`/witness): which body literal failed. And it comes
  fully characterized, because the failed sub-goal NAMES itself:
  - **type** (predicate + arity): e.g. `env_binding(frontendA, "API_URL", ?)` — exact shape;
  - **location**: which node/artifact it attaches to;
  - **source**: where to get it (.env / nginx.conf / backend analysis / a framework plugin);
  - **form**: the head of the failed sub-goal IS the EDB schema of the fact to record ("в каком виде").
- In AI terms a gap is a **⊤ (unknown)** at a specific hop — a dragon with an address.

**This is the manifesto's "Here be dragons" turned into a ranked worklist** of named, typed, localized,
sourced missing facts — ranked by how many queried chains each closes. Coverage shifts from
parse-driven % (bottom-up) to **query-driven chain coverage** (top-down). 100% parsed with a broken
frontend→backend chain = 0% useful coverage for "who calls whom through the proxy."

**Honest hard part:** general why-not provenance (over recursion/negation) is harder than why — the
"what could make it true" space can be infinite. Tractable version: demand-set via the top-down
engine, intersect with EDB, report the FIRST missing premise per chain. Finite, localized, actionable.

## 7. Naming the domain

What we kept circling ("sem-spec / молекула / операции записи семантики") = the **semantic
specification layer**: how meaning is *specified and written into* the graph (vs the engine that
stores and the queries that read). It is a small **algebra of inscription operations**
`match → derive → canonicalize → materialize → tag/witness → claim` over an **ontology** (archetypes +
value-domains). Sub-layers: ontology (archetypes + value-domains) · derivation (the
`declarative-semantic-rules` matrix — already named) · write/provenance algebra (semiring tags +
actions) · packaging (the plugin molecule) · surface (the DSL). Only "derivation" was previously named.

## 8. What's textbook vs what's ours

- Textbook (don't reinvent): abstract interpretation soundness/precision/termination (Cousot);
  Datalog points-to (DOOP); equality saturation (egg); existential rules/chase (Datalog^±);
  provenance semirings (Green–Karvounarakis–Tannen); magic-sets/demand transformation.
- Ours ("своё сан-рэмо", not chasing CodeQL's QL-library): **cross-artifact** AI (code+config+deploy
  as one chain joined by value-domains); **incremental** maintenance of the AI fixpoint (Gate D2);
  a **live shared** graph (not a per-query DB); the **readable DSL** surface CodeQL never had; and
  **coverage-as-demand-diff** (self-reporting typed gap worklist).

## 9. Recommended first experiment

Not "an analyzer as Datalog" (dataflow) first. Instead: **run ONE cross-artifact chain
`link(client, backend)` (frontend HTTP_REQUEST → nginx rewrite → backend EXPOSES) on a FIXTURE with a
deliberate hole, and collect the typed missing-facts list.** This proves the whole apparatus at once
(value-domain join + declarative-source plugin + demand-diff coverage) and is immediately
product-valuable. Runner-up: import-resolution as Datalog — because the SAME resolver mechanism serves
both code imports and deployment binding, it proves cross-artifact reuse with one rule-pack.

## 10. Open forks (need a human decision)

1. Coverage worklist UX: surface why-not gaps as the primary "coverage" output (replacing %)?
2. Value-domain spec form: a constrained transform-spec (canonicalize/equiv/fan-out) — its syntax.
3. Declarative-source plugin first target: nginx (full molecule, real value-domain) vs a config we
   already half-model.
4. DSL readability vs precision: accept "structured-English-with-required-annotations" (mandatory
   verb + explicit `*`), or push fuller natural language?
