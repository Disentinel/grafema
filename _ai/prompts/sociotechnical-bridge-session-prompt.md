# Session prompt — sociotechnical bridge for Grafema

**Use this in a fresh Claude Code session, possibly in a forked worker.** This
prompt is self-contained — it briefs Claude on the context, the open question,
the existing material, and the deliverables.

---

## Brief

You are designing a **sociotechnical bridge** for Grafema — a layer that
connects the existing code-graph entity model (six entities at L1–L4:
ENTRY_POINT / INTERFACE / CONTRACT / BEHAVIOR / FEATURE / COMPONENT) to
business-domain entities (PRODUCT, PRODUCT_LINE, OWNER, COST, REVENUE).

Grafema's working hypothesis: most of this can be *anchored* by the human with
minimal labels (one anchor per product), and the graph can expand the cluster
to discover the full set of code-side entities belonging to that product.
Pure-emergent (no anchors) discovery may be feasible from naming entropy +
ownership signals + dep-cluster pressure, but is probabilistic — confidence
score required.

External business metrics (revenue per call, runtime cost per call) are not
derivable from code alone; they must be imported from APM / billing / analytics
systems. Grafema's job in this layer is to be the **single index** that links
code-graph entities to business metrics.

## Required reading (in order)

1. `_ai/research/feature-taxonomy.md` — canonical six-entity model. Start here.
2. `_ai/research/shape-and-contract-inference.md` §2.5–§2.7 + Appendix A —
   contract classes, registry-extension schema.
3. `_ai/research/cognitive-debt-and-feature-detection.md` §3 (Product–Code
   Rosetta Stone) — existing thinking on bridging product/code vocabularies.
4. `_ai/research/sociotechnical-graph-model.md` — existing sociotechnical
   research thread (Org / Team / Person projection).
5. `_ai/research/sociotechnical-entity-catalog.md` — existing catalogue.
6. `_ai/research/flow-analysis-design.md` — METRIC nodes layer; per-FEATURE
   runtime metrics. This is the layer that future cost/usage metrics will hook
   into.
7. `_ai/plans/feature-taxonomy-rollout.md` — current task list, where the
   bridge fits.

## Open questions to address

### Q1. Anchored vs emergent product discovery

What's the minimum human input that makes product-cluster detection reliable?
The hypothesis is "one anchor per product" — a single labelled FEATURE per
product, graph expands via dep + co-Behavior clustering. Validate or refute on
the existing `cognitive-debt-and-feature-detection.md` §3 framework, propose
empirical experiment.

Pure-emergent (zero anchors) — under what naming entropy + ownership signal
density does it cross the 0.7 confidence threshold? Hypothesis: open-source
monorepo like supabase or gitlab-ce with `apps/*` directory structure should
test cleanly.

### Q2. PRODUCT and PRODUCT_LINE in the graph

Are these new entities, or just KB FACT nodes with `applies_to` pointing at
COMPONENT clusters? Decide the storage model:

- Option A: PRODUCT as graph node with `GROUPS_COMPONENT` edges
- Option B: KB FACT entries with `kind: product` and `applies_to: [<comp-id>]`
- Option C: hybrid — PRODUCT node carries identity, KB FACT carries history /
  decisions

### Q3. The `manifest.product.yaml` schema

Concrete schema for the per-project (or per-org) manifest that anchors
products, declares revenue/cost metrics sources, owners. See draft sketch in
chat. Open: how does this relate to `effects-db/`? Same registry mechanism or
separate?

### Q4. Cost computation

Per-FEATURE cost = Σ(effect surface × frequency × resource cost). Need:
- effect → resource mapping (FS_WRITE → bytes; NETWORK_OUT → requests/bytes;
  CPU → BEHAVIOR core size × usage frequency)
- runtime metric ingest (Datadog / Honeycomb / OpenTelemetry → METRIC nodes
  per FEATURE)
- aggregation per cost-of-record (per call / per day)

Frame the work for `flow-analysis-design.md` integration.

### Q5. Revenue attribution

Revenue per FEATURE = ? Sometimes obvious (Stripe charge → cli:command
'checkout' on http:route 'POST /charges'). Sometimes ambiguous (homepage view
attributable to which feature?). Multi-touch attribution is a domain in
itself. Propose minimum viable attribution model that's better than "no
attribution".

### Q6. What questions does the bridge enable

Mirror the `feature-taxonomy.md` §6 query taxonomy but for sociotechnical
queries. Examples to seed:

- "Which features earn more than they cost?" — ratio
- "Which red-zone features should be deprecated?" — ratio < threshold + low
  usage
- "Which components are shared infrastructure across products?" — COMPONENT in
  ≥2 PRODUCT clusters
- "If we kill product X, which features go orphan?" — backward-walk
- "Which team owns the highest-cost feature surface?" — owner × cost
- "PII flow per product" — backward-walk from sensitive fields → enumerate
  PRODUCTs touching

## Deliverables

1. **Research doc** `_ai/research/sociotechnical-bridge.md` — full design:
   entities, edges, registry extension, anchored-vs-emergent decision,
   manifest schema, cost/revenue model, query taxonomy, integration with
   flow-analysis-design.md.

2. **Linear issue** under team Reginaflow, project Grafema, label `Research`,
   `v0.5+`. Title: "Sociotechnical bridge — FEATURE → PRODUCT/COST/REVENUE".
   Body summarises the doc and links to it. Block on REG-1121 (COMPONENT
   clustering).

3. **`manifest.product.yaml` example** for Grafema itself (small fictitious
   example with 2-3 products) so the schema is concrete.

4. **(Optional) Empirical experiment design** for emergent product discovery
   on supabase or gitlab-ce monorepos. Don't run it — just design.

## Constraints

- Don't surface this as a public-facing positioning artifact yet. It's
  research / internal architecture only.
- Don't propose deep changes to `effects-db/` schema without first checking
  whether the bridge's needs overlap with the contract registry's needs (per
  `shape-and-contract-inference.md` §A.9).
- Be honest about what's anchored vs derived; don't pretend the human-label
  step is trivial.
- This thread blocks on REG-1121 (COMPONENT clustering) for actual graph-side
  implementation; the research can run ahead of that.

## Style

Match the existing `_ai/research/*.md` style: technical, structured, cite
papers where relevant (Conway's law, value-stream mapping, microservices
literature on bounded contexts), include open architectural questions
explicitly. Aim for ~400-600 lines.
