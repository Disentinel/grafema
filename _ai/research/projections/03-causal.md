# Projection 3: Causal

**Question:** What *caused* what?
**Soundness:** Real causal chain exists → graph has a path.

## Lenses

### 3.1 Incident (what broke and why)

**incident** — a production failure event with observable impact
- × Semantic: "This incident was triggered by a bug in function X." Code-to-incident link.
- × Organizational: "This incident was handled by Team Y, but the code is owned by Team Z." Ownership gap — coordination failure.
- × Financial: "This incident cost $50k in lost revenue." Business impact of a technical failure.

**timeline_event** — a discrete timestamped action or observation during an incident
- This is where causation actually lives. "At T+0 deploy went out; at T+3min errors spiked; at T+7min alerts fired; at T+12min rollback started." Without timeline_event you can't model causal sequence — you only have a blob.
- × Temporal: "Alert fired 7 minutes after deploy — too slow for automated recovery." Detection latency.
- × Operational: "At T+12min, on-call was still paged but didn't respond — escalation gap."

**postmortem** — the recorded causal analysis artifact produced after an incident
- Distinct from the incident itself. The incident is what happened; the postmortem is the structured human interpretation of why. Postmortems produce action items, link to decisions, and are the primary source of organizational causal knowledge. Without this entity, blameless culture and learning loops are unmodeled.
- × Epistemic: "Postmortem identified an undocumented assumption about input ordering." Knowledge gap surfaced.
- × Organizational: "Postmortem action items were assigned to Team Z but never closed." Accountability failure.

**near_miss** — an event that nearly caused an incident but didn't, due to luck or a safety net catching it
- Near-misses reveal the same latent conditions as real incidents. Modeling them is the foundation of proactive safety. A system that never had an incident but has 20 near-misses is not safe — it's lucky. Without near_miss, the causal model is only reactive.
- × Risk: "Near-miss: query planner chose a full table scan; caught by load test, not production." Latent risk exposed.
- × Epistemic: "Near-miss was not documented — organizational learning opportunity lost."

**proximate_cause** — the immediate technical trigger of an incident
- The thing that directly caused the failure. Distinct from root_cause (the underlying condition) and contributing_factor (conditions that enabled it). Blameless post-mortems explicitly separate these three layers. Without this separation, "root cause" becomes a political label rather than a precise causal claim.
- × Semantic: "Proximate cause: NullPointerException in PaymentProcessor.charge() line 142."
- × Temporal: "Proximate cause appeared 4 releases ago — latent, not introduced in the triggering deploy."

**root_cause** — the latent systemic condition that made the proximate cause possible
- Not "who wrote the bad code" — that's blame, not cause. Root cause is the systemic gap: missing test, absent monitoring, undocumented constraint, design flaw. In blameless culture, root cause always points to a process or system, never a person.
- × Contractual: "Root cause: no test for the empty-collection edge case." Safety net gap.
- × Epistemic: "Root cause: undocumented assumption that userId is always a UUID. Started breaking when auth migrated to email-based IDs."

**contributing_factor** — a pre-existing condition that amplified impact or enabled the failure
- Different from root_cause: contributing factors don't independently cause failure but make it worse or more likely. Examples: no circuit breaker, degraded capacity, alert fatigue from too many false positives. Multiple contributing factors can combine with one proximate cause to produce a disaster.
- × Risk: "Contributing factor: no circuit breaker on the payments API — failure cascaded to checkout."
- × Operational: "Contributing factor: cache had been warming for only 2 minutes post-deploy — hit rate was 12%, not 95%."

### 3.2 Propagation (how causation spreads through the system)

This lens models the mechanical layer of causal spread. Without it, Incident and Impact are disconnected — you know something broke and something was affected, but not how the failure traveled from one to the other.

**dependency_chain** — an ordered sequence of dependencies through which failure propagates
- "Service A calls B calls C. C failed → B failed → A degraded." This is a path in the dependency graph with causal direction. Distinct from a static dependency (which is modeled in Operational projection) — a dependency_chain is the activated causal path during a specific failure.
- × Operational: "Chain: frontend → API gateway → auth service → user-db. Failure in user-db propagated up in 340ms."
- × Risk: "This chain has no circuit breaker at the API gateway — single point of cascading failure."

**cascade** — a propagation event where one failure triggers one or more downstream failures
- A cascade is a step in a dependency_chain: "because X failed, Y failed." Modeling cascades as distinct entities lets you query: "Which services have been the source of cascades?" and "What is the expected blast radius if S3 goes down?"
- × Organizational: "This cascade crossed team boundaries — Team A's failure caused Team B's incident."
- × Financial: "This cascade took down 4 services — 40× the revenue impact of the original failure."

**isolation_boundary** — a design element that stops or limits cascade propagation
- Circuit breakers, bulkheads, timeouts, fallbacks, queue decoupling. These are the causal blockers. Modeling them as entities lets you query: "Where does our system have no isolation boundaries?" — a direct risk gap query.
- × Risk: "Boundary exists: circuit breaker between API gateway and auth service. Trip threshold: 5 errors in 10s."
- × Intentional: "This boundary was added after the 2023-08 incident as a mitigation."

### 3.3 Impact (what did a change affect)

**change** — a discrete modification to the system: code deploy, config change, migration, dependency update
- The causal agent for most non-hardware incidents. A change is not just a git commit — it includes config changes, schema migrations, and dependency version bumps. Without covering all change types, the causal model has blind spots.
- × Semantic: "This change modified functions A, B, C — all callers of PaymentProcessor.charge()."
- × Temporal: "Change deployed at 14:32 UTC — incident started at 14:35 UTC. 3-minute lag."
- × Organizational: "Change authored by Person X, reviewed by Person Y, approved by Person Z. All three need incident context."

**affected_entity** — a system entity (service, function, datastore, user segment) harmed by a change
- `blast_radius` as modeled in the original file is not an entity — it's a derived aggregate (count of affected entities). What you actually store are the individual affected_entity relationships. The blast radius is then a query: `COUNT(affected_entity WHERE change = X)`. Replacing the vague blob with concrete relationships enables real cross-projection queries.
- × Operational: "affected_entity: payments-service, because it depends on the changed auth library."
- × Intentional: "affected_entity: checkout feature — this change broke the Happy Path for 12% of users."

**rollback** — a reversal of a change, restoring a prior system state
- Not all changes are rollback-safe (irreversible migrations, schema drops, published events). Modeling rollback as an entity with a `reversible` property is essential for risk queries.
- × Temporal: "Time from deploy to rollback: 47 minutes. MTTR benchmark exceeded."
- × Risk: "This change has no rollback path — the Postgres column was dropped. Recovery requires restore from backup."

### 3.4 Regression (what worked and then stopped, and why)

**regression** — a measurable degradation in a previously-met property: performance, reliability, correctness, or behavior
- Renamed and promoted from the original `before_state` + `delta` pair, which were not distinct enough to be separate entities. A regression is the causal event itself. It has a type (performance, correctness, behavioral), a magnitude, and links to a triggering change.
- × Contractual: "Regression: p99 latency crossed SLO threshold of 300ms. Before: 180ms. After: 450ms."
- × Behavioral: "Regression: conversion rate dropped 0.4pp. Detected by A/B framework, not monitoring."
- × Financial: "Performance regression of 270ms/request × 10M daily requests = material infrastructure cost increase."

**regression_test** — a test added specifically to detect a class of regression that previously caused an incident or near-miss
- The causal artifact that closes the loop. An incident without a regression test means the same proximate cause can recur. Modeling regression_test as a named entity links the incident → root_cause → regression_test chain, making the safety net queryable.
- × Contractual: "regression_test added for empty-collection edge case — covers the proximate cause of 2024-03 incident."
- × Semantic: "regression_test exercises PaymentProcessor.charge() with userId=null — previously uncovered."

**flapping** — an intermittent regression: the system alternates between working and broken states
- A qualitatively different causal pattern from clean before/after regressions. Flapping reveals race conditions, environment-dependent behavior, and timing-sensitive failures. It requires a different diagnosis strategy: correlation with load, time-of-day, infrastructure events. Without flapping as a distinct entity, intermittent failures are either invisible or misclassified as "fixed" after a transient resolution.
- × Operational: "Flapping: auth-service returns 503 approximately 2% of the time under >1000 req/s. Correlated with GC pauses."
- × Risk: "Flapping is harder to diagnose and fix than clean regressions — elevated risk of dismissal as 'environment issue'."

**delta** — the minimal diff between before and after states that explains the regression
- Kept but scoped precisely. The delta is the explanation artifact: not just "what changed" (that's `change`) but "what specific aspect of the change caused this specific regression." A deploy can change 500 lines — the delta might be one configuration default that changed behavior.
- × Semantic: "Delta: default timeout changed from 30s to 5s in config.default.js line 47."
- × Epistemic: "Delta revealed that the original 30s timeout was cargo-culted from a prototype — no documented rationale."

### 3.5 Decision (what choices led to current state)

**decision** — a recorded choice between alternatives made at a specific point in time
- The causal origin of intentional architecture. Decisions are the reason the system is the way it is. Without them, all architectural choices look arbitrary.
- × Epistemic: "Decision recorded in ADR-42: chose Redis over Postgres for session storage." Decision-to-knowledge link.
- × Intentional: "Decision made to support feature X (real-time presence). Would not have been made for a batch system."
- × Temporal: "Decision made 2 years ago under different scale assumptions. Context has since changed."

**assumption** — a belief held at decision time that was not verified, and may have since proven false
- The causal engine of technical debt and architectural mismatch. Decisions are only as good as their assumptions. "We assumed read:write ratio would be 100:1 — it's actually 1:10." This assumption failure causally explains current performance problems. Without assumption as a first-class entity, post-hoc causal analysis is guesswork.
- × Epistemic: "Assumption: userId is always a UUID. Proven false when auth migrated to email-based IDs in 2024."
- × Risk: "This assumption was never validated — it was inherited from the original prototype."
- × Temporal: "Assumption was valid at decision time but became false 18 months later due to a platform change."

**constraint** — a real-world limitation (budget, team size, tech maturity, deadline) that eliminated certain alternatives
- The reason alternatives weren't chosen. Without constraint, you can't distinguish "we chose this because it was best" from "we chose this because we had no other option." Constraints also expire — a constraint from 3 years ago may no longer apply, meaning a previously-rejected alternative is now viable.
- × Financial: "Constraint: $0 budget for managed services → self-hosted Kafka instead of cloud pub/sub."
- × Organizational: "Constraint: no Rust expertise in the team → rewrote performance-critical module in Go, not Rust."
- × Temporal: "This constraint no longer applies — company now has a cloud budget. ADR should be revisited."

**alternative** — an option that was considered but not chosen
- Real: ADRs explicitly capture these. Enables queries like "What options exist for replacing this component?" (alternatives to the current decision that were already evaluated). Also enables counterfactual analysis: "Would Alternative B have caused this incident?"
- × Risk: "Alternative B (Postgres-backed sessions) would have added 12ms latency but eliminated the Redis single-point-of-failure that caused the 2024-08 incident."
- × Financial: "Alternative B was $30k/year cheaper. Chose A for reliability — that trade-off has held."

**trade_off** — what was explicitly sacrificed in making a decision
- Justified as a distinct entity (not just embedded in decision) because trade-offs can be queried across decisions: "Show all places we traded consistency for availability" → cross-cutting architectural pattern. Also trade-offs can be independently violated over time: "We said we'd sacrifice consistency — but now a new feature requires strong consistency. The trade-off has been broken without a new decision."
- × Contractual: "Trade-off: AP over CP (consistency sacrificed for availability). Embedded in SLO: eventual consistency within 500ms."
- × Risk: "This trade-off is no longer acceptable post-GDPR — data consistency is now a compliance requirement."

### 3.6 Counterfactual (what would have happened differently)

This lens is distinct from Decision/Alternative because those capture historical choices. Counterfactuals are forward-looking inference: "given what we know now, what would have happened under different conditions?" They enable scenario modeling, risk assessment, and learning.

**counterfactual_scenario** — a hypothesized alternative system state or decision path, used to evaluate causal claims
- "If we had had a circuit breaker at the API gateway, this cascade would have been contained." This is not a historical alternative (we didn't choose it) — it's a causal inference about a world that didn't exist. Without counterfactuals, post-mortem action items are arbitrary ("add monitoring") rather than causally justified ("add monitoring because, counterfactually, 2-minute detection would have reduced blast radius by 80%").
- × Risk: "Counterfactual: with request timeout at 2s instead of 30s, the cascade would have self-healed within 90 seconds."
- × Intentional: "Counterfactual: if feature flag had been used, 99% of users would have been unaffected by the rollout bug."
- × Financial: "Counterfactual: with automated rollback triggered at >1% error rate, incident revenue loss would have been $5k not $50k."

**causal_claim** — an explicit assertion that entity A caused entity B, with supporting evidence or reasoning
- The link that makes the causal graph queryable. Without reifying causal claims, you have a graph of events but no causal edges. A causal_claim has: source entity, target entity, claim type (necessary cause, sufficient cause, contributing factor), confidence, and evidence. Enables: "Show me all causal claims involving service X" and "Which causal claims have no supporting evidence — i.e., are speculation?"
- × Epistemic: "Causal claim: 'deploy caused latency spike' — evidence: correlation with timeline_event, confirmed by profiling."
- × Organizational: "Causal claim disputed between Team A and Team B — different teams attribute the incident to different root causes."

## Entity Count: 24
