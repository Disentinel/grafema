# Projection 5: Intentional

**Question:** *Why* does this exist?
**Soundness:** Real purpose exists → graph links code to it.

## Lenses

### 5.1 Requirement (what must the system do, and under what constraints)

The most foundational form of intent. Split functional from non-functional — they constrain the system in orthogonal ways.

**functional_requirement** — named behavior the system must provide
- × Semantic: "Requirement R-42 is implemented by modules A, B." Requirement-to-code traceability.
- × Contractual: "R-42 has 3 acceptance tests; test T-17 verifies the edge case." Requirement-to-test link.
- × Temporal: "R-42 was added in Q2 2023, superseded R-18 which required the old flow." Requirement evolution.
- × Organizational: "R-42 was authored by product owner Alice, approved by CTO." Accountability chain.

**non_functional_requirement** — constraint on how the system must perform (latency, throughput, cost per call, availability)
- × Operational: "NFR: p99 latency < 200ms on /api/checkout — drives choice of in-process cache." Architecture rationale.
- × Contractual: "This NFR is expressed as SLO target T-7." NFR formalized into SLO.
- × Causal: "Incident INC-31 violated this NFR — latency hit 800ms." NFR breach as incident cause.
- × Financial: "Meeting this NFR requires $8k/month in compute." Cost of correctness.

**business_rule** — domain constraint that directly dictates system behavior (the hardest thing to find in code)
- × Semantic: "Rule BR-9: 'customer cannot place order if account is suspended' is enforced in `OrderService.validateCustomer()`." Rule-to-code link.
- × Contractual: "BR-9 is tested by acceptance test AT-44." Rule-to-test link.
- × Causal: "Bug INC-18: BR-9 was not applied to API orders — only to web orders. Inconsistency." Rule scope gap.
- × Organizational: "BR-9 is owned by the Legal/Compliance team — changes require their sign-off."

**acceptance_criteria** — verifiable conditions that define done for a requirement
- × Contractual: "Criterion AC-7 maps 1:1 to assertion in test T-22." Criterion-to-test traceability.
- × Intentional: "AC-7 traces to functional requirement R-42." Criterion-to-requirement traceability.
- × Organizational: "AC-7 was approved by product owner Alice — accountability for scope."

### 5.2 Feature (what user value is delivered, and why we built it)

Features without hypotheses are archaeology, not intent. A feature's "why" lives in the hypothesis that justified it and the evidence that validated (or killed) it.

**feature** — user-facing capability
- × Semantic: "Feature 'bulk export' is implemented by modules A, B, C." Feature-to-code traceability.
- × Behavioral: "Feature 'bulk export' is used by 30% of users weekly — core retention driver."
- × Financial: "Feature 'SSO' is the primary unlock for enterprise tier: $800k ARR."
- × Intentional: "Feature traces to hypothesis H-12." Why it was built.

**hypothesis** — the falsifiable belief that justified building something ("We believe X users will do Y because Z, which will produce outcome O")
- × Intentional: "H-12: 'Enterprise buyers block on SSO — adding it will unlock deals >$50k.'" The actual reasoning.
- × Behavioral: "H-12 result: 4 enterprise deals closed within 60 days of SSO launch — validated."
- × Temporal: "H-12 was stated on 2023-01-10, measured on 2023-03-15." Hypothesis lifecycle.
- × Epistemic: "H-12 was validated — recorded in ADR-88 as rationale for continued investment."

**experiment** — formalized test of a hypothesis (A/B test, canary, feature flag with measurement)
- × Semantic: "Experiment EXP-3 is implemented as feature flag `bulk_export_v2` in `flags.ts`." Why this flag exists.
- × Behavioral: "EXP-3: variant B increased checkout completion by 8% — hypothesis confirmed."
- × Temporal: "EXP-3 ran 2023-08-01 to 2023-08-28. Still-running experiments are incomplete signals."
- × Causal: "EXP-3 caused regression in mobile — variant B re-rendered full page on each step."

**user_story** — specific scenario within a feature from a user's perspective
- × Contractual: "Story US-15 has 3 acceptance criteria, 2 with passing tests, 1 with none." Coverage gap.
- × Behavioral: "US-15 happy path: 95% completion rate. Edge case (partial upload): 40%." Story health.

### 5.3 Domain Model (why the code is structured the way it is)

The vocabulary for expressing intent at architectural scale. Without this lens, "why does this module exist" is unanswerable from the graph. DDD concepts are not abstract formalism — they are the mapping between business reality and code structure.

**bounded_context** — autonomous domain with its own model and language
- × Semantic: "Bounded context 'Payments' maps to packages `payments/`, `billing/`." Why this code boundary exists.
- × Organizational: "Bounded context 'Payments' is owned by Team Fintech — team and code boundary aligned." Conway's law check.
- × Contractual: "Bounded context boundary is enforced by guarantee G-14: no cross-context direct DB access."
- × Causal: "Incident INC-44: 'Orders' context reached into 'Inventory' DB directly — boundary violation was the root cause."

**aggregate** — cluster of domain objects with a single consistency boundary and root
- × Semantic: "Aggregate 'Order' has root `Order.js`, members `OrderLine`, `Discount`, `ShippingAddress`." Structural grouping rationale.
- × Contractual: "Invariant: all writes to Order aggregate go through OrderRepository — enforced by guarantee G-9."
- × Causal: "Bug REG-204: OrderLine was updated directly, bypassing aggregate root, causing stale total." Why the invariant exists.

**domain_event** — something that happened in the domain that other parts care about
- × Semantic: "Event `OrderPlaced` is published by `OrderService`, consumed by `InventoryService`, `EmailService`." Why this coupling exists.
- × Causal: "Event `PaymentFailed` triggers compensation in `OrderService` — this is why the rollback logic exists."
- × Behavioral: "Event `UserChurned` is consumed by 6 services — high-fan-out events are fragility markers."

**ubiquitous_language_term** — a word that means the same thing in both business speech and code
- × Semantic: "Term 'Subscription' in code: class `Subscription`, table `subscriptions`, used in 38 files." Consistency check.
- × Epistemic: "Term 'Account' is ambiguous: means user account in Auth context, billing account in Finance context — different concepts, same name." Naming collision risk.
- × Causal: "Bug INC-7: confusion between 'Order' (placed) vs 'Order' (fulfilled) caused incorrect email trigger."

### 5.4 Product (how value is organized and invested)

**product** — coherent user-facing offering with its own P&L
- × Financial: "Product 'Enterprise' generates $2M ARR, costs $500k to operate." P&L per product.
- × Organizational: "Product 'Enterprise' is owned by Product Team Falcon." Product accountability.
- × Operational: "Product 'Enterprise' depends on 12 services — blast radius of an outage."
- × Intentional: "Product 'Enterprise' traces to initiative I-3: 'move upmarket by end of 2024'."

**capability** — stable functional building block that outlives individual features; maps to a bounded context; can be enabled/disabled as a unit
- × Semantic: "Capability 'payment processing' maps to bounded context 'Payments' and package `payments/`."
- × Risk: "Capability 'payment processing' depends on single external vendor Stripe — vendor concentration."
- × Intentional: "Capability 'real-time collaboration' was added to meet requirement NFR-8 (< 500ms sync latency)."

**mvp_scope** — explicit record of what was intentionally deferred at launch ("good enough for now")
- × Intentional: "MVP scope of 'bulk export': CSV only, no filtering, no scheduling — deferred to v1.1."
- × Temporal: "MVP deferred items from 2023-Q1 are still unimplemented as of 2024-Q3." Debt accumulation.
- × Causal: "MVP decision 'use synchronous export' is the root cause of the 30s timeout bug in INC-56."

### 5.5 Strategy (where we are going and what we chose not to do)

Cancelled initiatives explain absence. OKR failures are hypothesis results. These matter as much as what succeeded.

**initiative** — strategic direction with budget, owner, and lifecycle state (active / completed / cancelled)
- × Financial: "Initiative I-3 'move upmarket' has $500k budget for H2." Budget-to-direction link.
- × Risk: "If I-3 fails, competitor X takes enterprise segment — strategic risk."
- × Temporal: "I-3 started Q1 2024, target completion Q3 2024, currently 60% complete."
- × Intentional: "Initiative I-7 was cancelled in Q2 2023 — explains why module `partner-api/` is abandoned but not deleted."

**OKR** — measurable objective with its result (did it work?)
- × Behavioral: "KR: 20% increase in DAU. Actual: +12%. Miss — hypothesis about virality was wrong."
- × Financial: "KR: reduce infra cost by 15%. Actual: +3% (cost grew). Root cause: new NFR overrode savings."
- × Intentional: "OKR O-4 Q3: result was 'Not achieved' — this decision was reversed, explains why feature X was rolled back."

**tech_investment** — intentional decision to invest in technical capability (rewrite, migration, new infrastructure)
- × Semantic: "Tech investment TI-2: 'migrate billing to event-sourcing' — explains why `billing/` has two parallel implementations."
- × Financial: "TI-2 cost: 3 engineer-months, projected savings: $40k/year infra, 50% faster audit queries."
- × Risk: "TI-2 is in-flight — old and new paths both live, dual-write risk until migration completes."
- × Temporal: "TI-2 started 2024-01-15, target completion 2024-06-01, currently 70% migrated."

**deprecation_intent** — explicit plan to remove or replace something
- × Semantic: "API endpoint `POST /v1/orders` is deprecated — replacement is `POST /v2/orders`." Which code is on death row.
- × Temporal: "Deprecation scheduled for 2024-12-01. As of today, 8 known callers still using v1 endpoint."
- × Contractual: "Deprecation notice was published in API changelog 2024-03-01 — external callers have 9 months."
- × Organizational: "Deprecation owner: Team Platform — accountable for migration support and final removal."

**technical_debt** — intentional deferral of quality, with explicit owner, tradeoff rationale, and repayment plan
- × Semantic: "Debt D-7: `UserService` is a god class — should be split into `AuthService` + `ProfileService`."
- × Intentional: "D-7 was deferred 2023-Q2 to hit product deadline for launch — explicit tradeoff, approved by CTO."
- × Temporal: "D-7 repayment planned for 2024-Q1. Unresolved for 3 quarters — compound interest accumulating."
- × Causal: "D-7 contributed to bug REG-204 — the god class had inconsistent state update paths."
- × Risk: "D-7: every new feature touching UserService requires understanding its full 3000-line scope — velocity tax."

## Entity Count: 22
