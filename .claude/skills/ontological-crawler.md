---
name: ontological-crawler
description: >
  Autonomous knowledge graph construction through formalized curiosity.
  Use when onboarding into an unfamiliar codebase, system, or domain;
  analyzing incidents and postmortems; building an ontology of a system
  from scratch; or detecting structural fragility. Trigger on phrases like
  "let's map this system", "what do we know about X", "analyze this postmortem",
  "find fragility", "onboard into this codebase", "build a knowledge graph",
  "what's connected to what". Also use when a user provides an incident report,
  postmortem, or architectural document and wants structured knowledge extracted.
---

# Ontological Crawler

A method for autonomous knowledge graph construction through formalized
curiosity. The system asks "why does this exist?" and "what breaks if we
remove it?", verifies answers against operational data, and grows a graph
that gets smarter with every stressor.

This is Graph Driven Development applied to the process of understanding.

## Core Principles

Every step must satisfy all four:

1. **Externalize** — knowledge moves from heads into the graph
2. **Relations, not things** — describe edges, not node attributes; state is the presence or absence of an edge
3. **Cheap to operate** — agent does the work, human is oracle for tacit knowledge only
4. **Name as you think** — ontology uses the team's language, not imposed taxonomy

When all four operate simultaneously: cascade resonance — complexity disappears.

## The Backlog

A simple queue of entities to process. Each entry:

```json
{
  "name": "payment-service",
  "source": "postmortem-2024-03-15",
  "status": "inbox",
  "depth": 0
}
```

Status: `inbox` → `in_progress` → `done` | `deferred`

Depth tracks BFS level. Higher depth = more peripheral. Human decides
when to stop — there is no algorithmic cutoff.

When to defer:
- Entity is peripheral (high depth, low fan-in from known entities)
- Verification sources exhausted without resolution but blast radius is low
- Entity belongs to a domain outside current investigation scope
- Backlog is growing faster than processing — defer low-impact items

Deferred is not deleted. Periodically review deferred items — context
from later processing may make them resolvable or reveal them as important.

Storage: JSON files in a directory. No database needed.

Operations: `push` (new entity), `pop` (take next), `defer` (skip for now).

## The Core Cycle

For each entity popped from the backlog:

### Step 1: Recall

Search the graph for what is already known.

- Semantic search: is this entity or something similar already present?
- If match found: consider merge or linking rather than creating new
- If related entities exist: load them as context for hypothesis generation

Read `references/recall.md` for detailed recall procedures.

### Step 2: Hypothesize

Apply perspectives to generate hypotheses about expected connections.

Two universal questions:
- **"Why does this exist?"** — reveals causes, purposes, dependencies.
  For intentional structures: yields design rationale, business purpose.
  For accidental structures (legacy, copy-paste, forgotten code):
  "why" returns "nobody knows" — and that itself is a signal.
  Unknown purpose + high fan-out = fragility. Unknown purpose + zero
  fan-out = candidate for removal.
- **"What breaks if we remove it?"** — reveals dependents, blast radius,
  criticality. Works regardless of whether the entity is intentional
  or accidental. Does not require knowing purpose — only consequences.
  This is the primary question for legacy/accidental structures where
  "why" produces no answer.

These branch into domain-relevant perspectives. For code systems:
- Structural: what does it depend on, what depends on it?
- Ownership: who created it, who maintains it, who knows about it?
- Operational: how is it deployed, monitored, configured?
- Temporal: how often does it change, when was it last touched?
- Failure: has it appeared in incidents, what went wrong?

Each perspective generates specific testable hypotheses:
"This is a service → it should have a healthcheck endpoint"
"This imports Redis → it depends on a Redis instance"
"This hasn't changed in 8 months but has fan-out 200 → suppressed volatility"

Read `references/perspectives.md` for perspective catalog and hypothesis templates.

### Step 3: Verify

Agent attempts to confirm or refute each hypothesis using operational sources.

Sources by priority:
1. Code (grep, AST, imports, configs)
2. Git history (authors, frequency, co-changes)
3. Infrastructure configs (Dockerfile, k8s, terraform, CI)
4. Documentation (README, ADRs, wikis)
5. Incident data (postmortems, Slack threads, alert history)
6. Metrics (Prometheus, Datadog — via connectors)
7. Human (escalation — only when sources 1-6 insufficient)

Verification must produce evidence, not just a yes/no.
"Confirmed: payment-service depends on Redis. Evidence: `import redis`
in src/payment/cache.py, line 14. Last modified 2024-01-20."

Read `references/verification.md` for source-specific verification procedures.

### Step 4: Classify

Each hypothesis after verification receives one of four classifications:

- **Confirmed** — evidence found. Create edge with provenance in graph.
- **Gap** — expected but not found. Known unknown. Either the system lacks
  it (fragility signal) or we looked in the wrong place (defer and revisit).
- **Unexpected** — found something, but not what was predicted. Highest
  value signal. Investigate immediately. Could be an anomaly, a hidden
  dependency, an architectural surprise.
- **Serendipitous** — found something unrelated but potentially valuable.
  New entity pushed to backlog for later processing.

Read `references/classification.md` for classification decision tree.

### Step 5: Update Graph

Based on classification:

- Confirmed → add edge with: source entity, target entity, relation type,
  perspective that generated it, evidence/provenance, timestamp.
  Remember: state is an edge, not an attribute.
  "hypothesis X confirmed by evidence Y" = `(hypothesis)-[confirmed_by]->(evidence)`
- Gap → record as open hypothesis. If class signature predicts this edge
  should exist, flag as anomaly.
- Unexpected → flag for investigation. Add to high-priority backlog.
- Serendipitous → push new entities to backlog.

New entities discovered during verification → push to backlog.

### Step 6: Meta-checks

Before proceeding to next entity:

**Saturation check.** Are hypotheses becoming predictable? If the last N
entities all confirmed exactly what was expected — consider shifting
abstraction level. Go deeper (function-level instead of service-level)
or broader (domain-level instead of service-level).

**Analogy check.** Does the subgraph around this entity resemble a known
pattern? If service-A has the same dependency structure as service-B
but service-B has an additional edge — transfer that edge as a hypothesis
for service-A.

**Triangulation check.** Did multiple independent perspectives predict
the same edge? If yes — high confidence. If only one perspective
predicted it — lower confidence, consider seeking second verification
source. When possible, use different models for generation vs verification
to ensure true independence.

Read `references/meta-checks.md` for detailed procedures.

## Meta-Processes

These operate across multiple cycle iterations, not within a single step.

### Class Signature Crystallization

After processing N+ entities of the same apparent type, extract the
pattern of edges they share.

"8 out of 10 services have: depends_on DB, has healthcheck, owned_by team,
monitored_by alert, deployed_via CI."

This becomes the class signature. New entities of this class are checked
against the signature. Missing edges = anomalies = investigation candidates.

Minimum viable sample: ~10 entities of same class for meaningful signature.
Below this, use reference signatures from domain knowledge.

Heterogeneity is itself a signal: "why do similar tasks use different
patterns?" — either intentional (ADR in graph) or accidental (fragility).

### Convention Detection

When a class signature edge appears with frequency >80%:
candidate convention. Confirm with human: "Is this intentional?"

- Yes → convention. Formalize as rule.
- No, historical accident → legacy signal, different kind of value.
  "We didn't know we were all doing this" is itself a finding.

Distinguish convention from copy-paste: convention is confirmed
independently by multiple authors/teams. Single-author pattern = habit,
not convention.

### Rule Crystallization

Confirmed convention → Datalog rule in RFDB.
`violation(X) :- service(X), not has_healthcheck(X).`

Rules have a lifecycle:
- Active: enforced, blocks or warns on violation
- Suspended: temporarily disabled (migration in progress)
- Invalidated: superseded by new convention or ADR
- Invalidation is an edge: `(rule)-[invalidated_by]->(ADR)` with reason

### Cognitive Debt Measurement

When human cannot answer a question that code answers:
cognitive debt detected. Measurable as:

- Binary: knew / didn't know
- Depth: "didn't know X exists" vs "knew X exists, didn't know X does Y"
- Impact: debt on high-fan-out module vs leaf function
- Temporal: "knew 6 months ago, forgot" vs "never knew"

Not all forgetting is debt. Forgetting import paths = normal abstraction.
Forgetting that a service depends on Redis = real debt.

### Cascade Staleness

When a node is updated (new commit, config change):
- All outgoing edges receive stale flag
- Stale edges don't get deleted — they transition from confirmed to
  hypothesis (require re-verification)
- Staleness propagates: if A→B is stale and B→C was derived from
  knowledge about B, then B→C is also potentially stale
- Re-verification priority: by blast radius of the stale node

### Graph Self-Cleanup

The graph applies its own method to itself. Periodically, for each edge:

1. "Why does this edge exist?" — check provenance. If source is gone,
   evidence invalidated, or nobody can explain its value → candidate.
2. "What breaks if we remove it?" — check if any rule, signature,
   fragility detection, or downstream edge depends on this knowledge.
   If nothing depends on it → safe to remove.

Edges that fail both questions are garbage collected.
Edges that fail (1) but pass (2) are re-verified — the knowledge
matters but the justification is lost.
Edges that pass (1) but fail (2) are demoted — valid knowledge
that currently serves no purpose. May become useful later; archive
rather than delete.

This is compaction by value, not by age or depth.

### Perspective Evolution

Track verification rate per perspective. After every N entities processed
(suggest: review after every 10), compute:

`confirmation_rate = confirmed_hypotheses / total_hypotheses` per perspective.

Actions:
- Rate > 70%: perspective is productive, keep at current weight
- Rate 30-70%: perspective is noisy but occasionally valuable.
  Review the confirmed cases — is there a sub-pattern? Refine the
  perspective to target only the productive sub-pattern.
- Rate < 30%: perspective is generating mostly noise. Deprioritize —
  apply only when other perspectives are exhausted, or retire.

New perspectives emerge from:
- Human asks a question the system hadn't considered ("why is this
  in a separate repo?") → new perspective: "repository boundary"
- Unexpected finding suggests a dimension not covered ("found shared
  state between services") → new perspective: "shared state coupling"
- Cross-domain analogy ("this is like the cold seep pattern") →
  new perspective transferred from another domain

Perspectives are first-class entities in the graph. They have edges
to the hypotheses they generated, enabling this meta-analysis.

## Fragility Detection

Fragility is not a single metric but a convergence of signals:

- **Concentration**: node with high fan-in, single point of failure
- **Suppressed volatility**: high fan-out + low change frequency
- **Bus factor**: single owner/author
- **Cognitive debt**: maintainers don't understand the module
- **Convention outlier**: violates emergent conventions without ADR
- **Missing redundancy**: no fallback, no graceful degradation
- **Hidden coupling**: connection exists but only visible through
  non-obvious paths (transitive deps, shared state, temporal correlation)

Each signal is an edge or absence of edge in the graph.
Fragility index = weighted combination, customizable per organization.

## Escalation Protocol

Escalate to human when:
1. Verification sources 1-6 exhausted, hypothesis unresolved
2. Classification is "unexpected" with high blast radius
3. Convention confirmation needed (is this intentional?)
4. Cognitive debt detected (human didn't know what code knows)
5. Analogy suggests connection but no evidence found

Do NOT escalate:
- Routine confirmations the agent can verify from code
- Low-depth, low-fan-out entities (defer instead)
- Questions answerable by reading documentation

Human is oracle and immune regulator, not bottleneck.
If escalation queue grows faster than human processes it:
raise confidence threshold, defer more, focus on high-impact items.

## Execution Tiers

Not all crawl work costs the same. Match the tool to the task.

### Tier 1: Local LLM (Ollama) — continuous, free
- Hypothesis generation (creative, tolerates noise)
- Entity description enrichment
- Running overnight / unattended
- Model: qwen3.6:35b for generation, qwen3:4b for classification
- Speed: ~5 min/entity, 12 entities/hour
- Requires: `/no_think` prefix, `num_predict: 4000+`
- Limitation: verification accuracy ~35% (too speculative on DEP/FRAGILE)

### Tier 2: Haiku API — fast, cheap ($0.02/entity)
- Verification with native tool_use (grep, read, file_overview)
- Batch API for mass crawl (50% discount, parallel processing)
- Speed: ~30s/entity, 120 entities/hour
- Best for: CONCEPT and PATTERN hypotheses (high confirmation rate)

### Tier 3: Claude (this session) — precise, expensive
- Manual crawl with full context
- Architectural decisions, cross-entity analysis
- Subagent delegation for parallel exploration
- Best for: first pass, meta-analysis, actionable perspective

### Recommended split:
- **Generation**: Ollama 35b (free, continuous) OR Haiku (fast, cheap)
- **Verification**: Haiku API with tools (accurate, fast)
- **Recording + meta-analysis**: Claude orchestrates, writes to graph
- **Overnight enrichment**: Ollama-only loop with JSONL output

## Persistence Protocol

**JSONL first, graph second.** All findings write to append-only JSONL
before RFDB. If database crashes, JSONL survives for replay.

File: `.grafema/crawl-findings.jsonl`
Format: one JSON per line:
```json
{"entity":"X","type":"DEP","hypothesis":"...","verdict":"confirmed","evidence":"file:line","confidence":0.9,"timestamp":"ISO"}
```

Batch sizes: ≤50 nodes/edges per RFDB write. Larger batches can
timeout and crash the server.

Backup sources (recovery priority):
1. `.grafema/crawl-findings.jsonl` — write-ahead log
2. `/tmp/crawl-*.jsonl` — session crawl outputs
3. Subagent output files — contain full MCP call history
4. This conversation context — manual replay

## Actionable Perspective

Every finding belongs to one of three actionable states:

- **domain=architecture** — confirmed knowledge, no action needed
- **domain=anomalies** — OPEN item requiring action or mitigation
- **domain=questions** — UNRESOLVED hypothesis needing investigation

Query for TODO list: `enox_query(domain="anomalies")` returns all open items.
An anomaly with an incoming `enables` edge = partially mitigated.
An anomaly with no mitigation edges = fully open, highest priority.

### Convention → Rule → Guarantee lifecycle:
1. Convention detected (frequency >80%) → recorded as FACT
2. Convention → proposed Datalog rule → recorded as UNENFORCED entity
3. Rule implemented in `.grafema/guarantees.yaml` → ENFORCED
4. `grafema check` validates → CI gate

### Git as connector (not storage):
Commit SHAs as dangling edge targets, resolved from git on-the-fly.
Aggregates (bus factor, churn) cached as FACT with staleness timestamp.
Don't store COMMIT nodes in RFDB — git is the canonical source.

## Lessons Learned

This section grows through use. Each entry is a failure mode discovered
during real application of the method. Add new ones as they emerge.

- **Data loss from rm -rf**: 2026-05-23 incident. Deleted knowledge.rfdb
  to "fix" a load error. Lost 120+ entities. Root cause: RFDB non-default
  databases need explicit `openDatabase`, not auto-load. ALWAYS backup
  before destructive action. See skill `backup-before-mass-updates`.
- **Batch size kills server**: 5000+ edges in one batch timed out and
  crashed RFDB. Cap at 50 per batch.
- **LLM speculation on fragility**: Ollama generates plausible but wrong
  DEP/FRAGILE hypotheses (~30% confirmation rate). Better for CONCEPT/PATTERN
  (~60%+ rate). Use code tools for factual verification, LLM for
  conceptual classification.
- **Subagent outputs as backup**: Subagent JSONL transcripts contain full
  MCP tool call history with arguments. Recoverable data source.
- **Graph for graph's sake**: every edge must serve detection or understanding.
  If you can't explain why an edge matters, don't add it. The graph
  self-cleanup mechanism (see Graph Self-Cleanup) enforces this
  retroactively — edges that can't justify their existence get removed
  by the same two questions that created them.
- **Premature crystallization**: don't create rules from too few examples.
  Track sample size per class; signature reliability increases with N.
  Minimum viable sample is context-dependent — discover it empirically
  for each domain, don't assume a fixed threshold.
- **Ignoring unexpected**: unexpected findings are highest value.
  Never classify as "confirmed" to avoid investigation.
- **Ossified rules**: rules without lifecycle become obstacles.
  Every rule must have an invalidation path.
- **Oracle abuse**: if escalation rate feels unsustainable, the symptom
  points to one of two causes — verification is too shallow (agent
  isn't trying hard enough before asking) or hypotheses are too
  speculative (perspectives need recalibration). Track escalation rate
  and adjust; the right ratio is discovered per project, not prescribed.

## Applying This Skill To Itself

This skill is subject to its own method. Ask:
- Why does each section exist?
- What breaks if we remove it?
- Are there gaps in the class signature of "methodology sections"?
- Which perspectives are missing?
- Where is this skill fragile?

If you find gaps, extend the skill. It should grow through use.

## Reference Files

Read these as needed, not upfront:

- `references/perspectives.md` — catalog of perspectives with hypothesis templates
- `references/verification.md` — source-specific verification procedures
- `references/classification.md` — classification decision tree with examples
- `references/meta-checks.md` — saturation, analogy, and triangulation procedures
- `references/fragility-patterns.md` — detailed taxonomy of fragility types
- `references/postmortem-protocol.md` — specific workflow for postmortem analysis
