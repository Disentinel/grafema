# Sociotechnical Graph Model

**Status:** Research / Foundational
**Date:** 2026-03-03
**Origin:** Descent from cognitive model (L5) back to projections (L3) — expanding Grafema's concrete domain from "source code" to "the entire sociotechnical system around code"

## Problem

Grafema currently models code. But code doesn't exist in isolation — it exists inside a sociotechnical system: people write it, infrastructure runs it, incidents break it, tasks plan it, products justify it, documents explain it.

Every existing tool covers one slice: Datadog sees runtime, Linear sees tasks, GitHub sees code history, PagerDuty sees incidents. Nobody connects them into a single queryable graph. The developer who needs to answer "why did this break, who owns it, what feature is affected, and where is the runbook?" must manually traverse 5 tools.

## Core Thesis

**The concrete domain is the sociotechnical system, not source code.**

In Abstract Interpretation terms:
- **Concrete domain** = all possible states of the system (code + infrastructure + people + processes + business)
- **Projections** = abstract interpretations, each capturing one orthogonal concern
- **Graph** = unified representation enabling cross-projection queries

Code analysis (current Grafema) is one projection. A powerful one, but still one of twelve.

## Prior Art

| System | What it models | Projection coverage | Formal properties |
|--------|---------------|--------------------|--------------------|
| [Backstage (Spotify)](https://backstage.io/docs/features/software-catalog/system-model/) | Component, API, System, Domain, Resource, User, Group | Flat ontology across Semantic + Organizational + Operational | None |
| [Cortex](https://www.cortex.io/products/catalog) | Services, APIs, resources, teams, custom entities | Flat catalog, 60+ integrations | None |
| [Leavitt Diamond](https://www.mindtools.com/ac3k6vj/leavitts-diamond/) (1958) | Task, People, Structure, Technology | L5/L4 — too abstract for projections | Qualitative only |
| [Sommerville STS](https://archive.cs.st-andrews.ac.uk/STSE-Handbook/Papers/SociotechnicalsystemsFromdesignmethodstosystemsengineering-BaxterSommerville.pdf) | Technical + Social subsystems | Two subsystems, not projections | Joint optimization principle |
| **This model** | 12 orthogonal projections, ~40 sub-projections | Full sociotechnical coverage | Soundness + completeness per projection |

**Gap:** Nobody frames the sociotechnical system as orthogonal projections with formal properties (soundness, completeness). Backstage has entities but no projections. STS theory has subsystems but no formalism. Knowledge graphs have ontologies but no guarantees.

## Twelve Orthogonal Projections

Each projection answers a question no other projection can answer.

| # | Projection | Question | Key entities | Soundness property |
|---|------------|----------|-------------|-------------------|
| 1 | **Semantic** | What does the code *mean*? | function, variable, type | Real code dependency exists → graph shows it |
| 2 | **Operational** | How does code *execute*? | service, endpoint, deployment | Real runtime interaction exists → graph shows it |
| 3 | **Causal** | What *caused* what? | incident, change, root cause | Real causal chain exists → graph has a path |
| 4 | **Contractual** | What is *guaranteed*? | SLO, invariant, test | Real guarantee exists → graph contains it |
| 5 | **Intentional** | *Why* does this exist? | feature, product, initiative | Real purpose exists → graph links code to it |
| 6 | **Organizational** | *Who* is responsible? | team, owner, domain | Real ownership exists → graph reflects it |
| 7 | **Temporal** | *When* and in what order? | event, release, state transition | Real event occurred → graph records it |
| 8 | **Epistemic** | What is *known* and where? | ADR, runbook, doc | Real knowledge artifact exists → graph indexes it |
| 9 | **Security** | Who/what *can access* what? | role, permission, vulnerability | Real access path exists → graph shows it |
| 10 | **Financial** | How much does it *cost*? | infra cost, budget, ROI | Real cost exists → graph attributes it |
| 11 | **Behavioral** | How is it *actually used*? | adoption, journey, feedback | Real usage pattern exists → graph captures it |
| 12 | **Risk** | What *could go wrong*? | threat, exposure, mitigation | Real risk exists → graph models it |

### Orthogonality arguments

Two projections are orthogonal if neither can derive the other's answers:

- **Semantic ⊥ Operational**: dead code has semantics but no runtime. One service executes code from many modules.
- **Causal ⊥ Temporal**: "A before B" (temporal) ≠ "A caused B" (causal). Correlation ≠ causation.
- **Contractual ⊥ Semantic**: "p99 < 200ms" is not derivable from code. "Returns non-null" is an expectation, not a fact.
- **Intentional ⊥ Semantic**: why a function exists is not in the code. Feature "user onboarding" spans 40 files, none know about the feature.
- **Epistemic ⊥ all others**: knowledge about the system is a separate layer. An ADR explains a decision; a runbook explains a procedure — neither is derivable from code, infrastructure, or org structure.
- **Organizational ⊥ Semantic**: who owns code is a social fact, not a code fact. CODEOWNERS is a proxy, not the truth.
- **Temporal ⊥ Semantic**: code structure is atemporal. History is not in the AST.
- **Operational ⊥ Contractual**: how code runs vs what it promises to do — runtime can violate contracts.
- **Security ⊥ Organizational**: who *owns* code ≠ who *can access* production. Security ⊥ Contractual: what is *guaranteed* ≠ what is *vulnerable*.
- **Financial ⊥ Operational**: how a service *works* ≠ how much it *costs*. Financial ⊥ Intentional: why a feature *exists* ≠ what its *ROI* is.
- **Behavioral ⊥ Intentional**: what we *intended* users to do ≠ what they *actually* do. The gap is where product insights live.
- **Risk ⊥ Causal**: what *already caused* something ≠ what *could* go wrong. Risk ⊥ Security: technical *vulnerability* ≠ business *exposure* (bus factor, vendor lock-in).

## Sub-Projections

Each projection decomposes into ~3–4 sub-projections. Each sub-projection has its own abstract domain.

### 1. Semantic (what code means)

| Sub-projection | Question | Key entities |
|---|---|---|
| **DFG** | Where do values flow? | value, assignment, return |
| **CFG** | In what order does code execute? | branch, loop, exception |
| **Scope** | Where are names visible? | binding, declaration, closure |
| **Call** | Who calls whom? | call site, callee, argument |
| **Module** | What depends on what? | import, export, re-export |
| **Structure** | What is composed of what? | class, method, property |
| **Type** | What transforms into what? | type annotation, inference, cast |

### 2. Operational (how code executes)

| Sub-projection | Question | Key entities |
|---|---|---|
| **Topology** | What connects to what at runtime? | service, database, queue |
| **Traffic** | How do requests flow? | request, trace, span |
| **Resource** | What is consumed? | CPU, memory, pod, node |
| **Config State** | What behavior changes without code changes? | feature flag, env var, A/B experiment |

### 3. Causal (what caused what)

| Sub-projection | Question | Key entities |
|---|---|---|
| **Incident** | What broke and why? | incident, root cause, contributing factor |
| **Impact** | What did this change affect? | change, affected service, blast radius |
| **Regression** | What used to work and stopped? | before-state, after-state, delta |
| **Decision** | What choices led to current state? | decision, alternative, trade-off |

### 4. Contractual (what is guaranteed)

| Sub-projection | Question | Key entities |
|---|---|---|
| **SLO** | What is promised externally? | SLI, error budget, target |
| **Verification** | What is proven correct? | test, assertion, coverage |
| **Invariant** | What structural rules must hold? | guarantee, rule, violation |

### 5. Intentional (why does this exist)

| Sub-projection | Question | Key entities |
|---|---|---|
| **Feature** | What user value is delivered? | feature, user story, acceptance criteria |
| **Product** | How is value organized? | product, product line, capability |
| **Strategy** | Where are we going? | initiative, OKR, milestone |

### 6. Organizational (who is responsible)

| Sub-projection | Question | Key entities |
|---|---|---|
| **Ownership** | Who owns what? | team, owner, CODEOWNERS |
| **Authority** | Who can approve changes? | approver, reviewer, escalation |
| **Expertise** | Who knows what? | expert, knowledge area, bus factor |
| **Interaction** | How do teams interact? | collaboration mode, API contract between teams |

### 7. Temporal (when and in what order)

| Sub-projection | Question | Key entities |
|---|---|---|
| **History** | What changed? | commit, PR, diff |
| **Lifecycle** | What state is it in? | state, transition, deprecation |
| **Cadence** | What is the rhythm? | sprint, release cycle, on-call rotation |

### 8. Epistemic (what is known)

| Sub-projection | Question | Key entities |
|---|---|---|
| **Documentation** | What is formally recorded? | doc, ADR, API spec |
| **Tribal** | What do only people know? | undocumented convention, oral tradition |
| **Discoverability** | How easy is it to find? | search index, navigation path |

### 9. Security (who/what can access what)

| Sub-projection | Question | Key entities |
|---|---|---|
| **Access** | Who can do what? | role, permission, policy |
| **Vulnerability** | What can be attacked? | attack surface, CVE, exposure |
| **Compliance** | What external requirements apply? | regulation, audit, certification |

### 10. Financial (how much does it cost)

| Sub-projection | Question | Key entities |
|---|---|---|
| **Cost** | What is the running cost? | infra cost, compute, storage |
| **Budget** | What is allocated? | budget, allocation, limit |
| **ROI** | What is the return? | revenue attribution, cost per feature |

### 11. Behavioral (how it is actually used)

| Sub-projection | Question | Key entities |
|---|---|---|
| **Usage** | What is used and how often? | feature adoption, DAU, retention |
| **Journey** | What paths do users take? | funnel, flow, drop-off |
| **Feedback** | What do users say? | ticket, review, NPS |

### 12. Risk (what could go wrong)

| Sub-projection | Question | Key entities |
|---|---|---|
| **Threat** | What can go wrong? | risk, probability, impact |
| **Mitigation** | How are we protected? | contingency, insurance, redundancy |
| **Exposure** | How vulnerable are we? | single point of failure, concentration |

## Entity Placement

Entities from the sociotechnical system mapped to projections:

```
source code              → Semantic
infrastructure           → Operational
metrics, alerts          → Contractual × Operational
incidents                → Causal
problems, tasks          → Intentional × Temporal
projects                 → Intentional
products, features       → Intentional
initiatives              → Intentional
guarantees, invariants   → Contractual
code ownership           → Organizational
tests                    → Contractual × Semantic
documents                → Epistemic
access policies          → Security
cloud spend              → Financial × Operational
user analytics           → Behavioral
vendor dependencies      → Risk × Operational
```

Entities at intersections (tests, alerts, vendor deps) are inter-projection bridges — they have edges into multiple projections. This is a feature, not an anomaly.

## Projection Discovery Protocol

**When a new entity type appears that doesn't fit cleanly into existing projections:**

1. **Formulate the question** the entity answers. What concern does it address?
2. **Test derivability** — can ANY existing projection answer this question? If yes → it's an entity within that projection, or at an intersection.
3. **Test orthogonality** — if no existing projection answers it, test pairwise against all 12: can the new concern's answer be derived from any existing projection? If no → candidate for a new projection.
4. **Formulate soundness** — what does "no false negatives" mean for this concern? If you can state it clearly → the projection is real.
5. **Identify sub-projections** — does the new projection decompose into ≥2 orthogonal sub-concerns?
6. **Update this document** with the new projection, orthogonality arguments, and sub-projections.

**The list of 12 projections is not closed.** It is the current best model of the sociotechnical system. New projections may emerge as the model encounters new entity types.

## Inter-Projection Edges: Where the Value Lives

Within a single projection — commodity. "Function calls function" (Semantic), "team owns service" (Organizational). Any specialized tool does this.

The unique value of a unified graph: **cross-projection queries**.

Example — a single query traversing six projections:

```
This INCIDENT (Causal)
  was caused by this FUNCTION (Semantic)
    owned by this TEAM (Organizational)
      it violated this SLO (Contractual)
        for this FEATURE (Intentional)
          documented in this ADR (Epistemic)
```

No existing tool can answer this. Each lives in its own projection (Datadog in Operational, Linear in Intentional, GitHub in Semantic + Temporal).

### Inter-projection edge types (examples)

| From → To | Edge | Example |
|-----------|------|---------|
| Semantic → Operational | DEPLOYED_AS | function → service |
| Causal → Semantic | CAUSED_BY_CHANGE_IN | incident → function |
| Contractual → Semantic | VERIFIED_BY | test → function |
| Intentional → Semantic | IMPLEMENTED_BY | feature → module |
| Organizational → Semantic | OWNS | team → module |
| Epistemic → Semantic | DOCUMENTS | ADR → module |
| Causal → Contractual | VIOLATED | incident → SLO |
| Temporal → Semantic | CHANGED | commit → function |
| Security → Operational | HAS_ACCESS_TO | role → service |
| Financial → Operational | COSTS | service → dollar amount |
| Behavioral → Intentional | VALIDATES | usage data → feature hypothesis |
| Risk → Organizational | EXPOSED_BY | single-point-of-failure → team |

## Role Coverage Check

Every role in the organization should have its primary concerns covered:

| Role | Primary projections |
|------|------------------|
| Developer | Semantic, Temporal, Contractual |
| SRE/DevOps | Operational, Causal, Contractual |
| Product Manager | Intentional, Behavioral, Financial |
| Security Engineer | Security, Semantic, Operational |
| Engineering Manager | Organizational, Financial, Temporal |
| CTO/VP Eng | Financial, Intentional (Strategy), Behavioral |
| Compliance Officer | Security (Compliance), Contractual |
| CEO | Risk, Financial, Intentional (Strategy), Behavioral |

## Formal Properties

### Soundness per projection

Each projection has its own soundness guarantee: if a real relationship exists in the concrete domain, the graph captures it. False positives are acceptable (over-approximation), false negatives are not.

### Completeness per projection

For each projection — what entity types and edge types exist, and what percentage is covered. The semantic rules matrix (see `declarative-semantic-rules.md`) is the completeness model for the Semantic projection. Each other projection needs its own completeness model.

### Composability

Projections compose through shared nodes. A `service` node exists in both Operational and Organizational projections. A `test` node exists in both Contractual and Semantic. This is how cross-projection queries work: the graph is one, the projections are views.

## Relation to Existing Theory

| Concept | In code-only Grafema | In sociotechnical Grafema |
|---------|---------------------|--------------------------|
| Concrete domain | Program states | Sociotechnical system states |
| Abstract domain | One per code projection | One per system projection |
| Galois connection | AST → Graph edges | System event → Graph edges |
| Soundness | No missed code deps | No missed system relationships |
| Completeness | AST node matrix | Entity type matrix per projection |

## What This Changes

1. **Graph schema** — node types and edge types expand from code-only to system-wide
2. **Data sources** — not just parsers, but integrations (Linear, GitHub, Datadog, PagerDuty, Confluence...)
3. **Completeness model** — one matrix per projection, not just the semantic rules matrix
4. **Value proposition** — from "understand code" to "understand the system around code"
5. **Competitive moat** — no tool unifies all twelve projections into a single queryable graph

## Open Questions

- How to maintain soundness when data comes from external systems with different guarantees?
- What is the minimal viable set of inter-projection edges for the first cross-projection query to be useful?
- Priority order: which projection after Semantic adds the most value?
- How does the Temporal projection interact with versioning of the graph itself?
- Is the list of 12 projections complete? (See Projection Discovery Protocol above)

## Related

- [Theoretical Foundations](./theoretical-foundations.md) — the five abstraction levels, cognitive dimensions
- [Declarative Semantic Rules](./declarative-semantic-rules.md) — completeness model for the Semantic projection
