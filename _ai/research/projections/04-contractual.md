# Projection 4: Contractual

**Question:** What is *guaranteed*?
**Soundness:** Real guarantee exists → graph contains it.

## Lenses

### 4.1 Service Level (what is promised and to whom)

**slo** — internal promise: a team commits to its organization that a service will meet a measurable target (e.g., "p99 < 200ms, 99.9% availability")
- × Operational: "This SLO applies to service X running in production." Which runtime entity is covered.
- × Organizational: "This SLO is owned by Team Y — they are accountable when it's breached."
- × Financial: "Breaching this SLO triggers internal chargeback or budget penalty."
- × Risk: "Error budget is 80% consumed this month — one more incident exhausts it."

**sla** — external promise: a legally binding agreement with a customer or vendor (distinct from SLO — has legal and financial consequences)
- × Financial: "Failing this SLA triggers a penalty clause: $10k/month credit." SLA breach = real money.
- × Organizational: "This SLA covers enterprise customer Acme Corp — Sales negotiated it."
- × Risk: "We have no SLO matching this SLA's targets — we're flying blind."

**sli** — the measurement used to evaluate whether an SLO/SLA is being met (p99 latency, error rate, availability %)
- × Operational: "SLI reads from /api/checkout endpoint metrics." What runtime signals are measured.
- × Behavioral: "SLI: 99.5% of user sessions complete without error." User-facing signal.
- × Causal: "SLI degraded 30 minutes before the incident was declared — leading indicator."

**vendor_sla** — promise made by an external dependency to us (distinct from our SLA to customers)
- × Operational: "This external dependency promises 99.9% uptime." Their promise, our dependency.
- × Risk: "Our SLO is 99.95% but our vendor SLA is 99.9% — we cannot meet our SLO if they fail."
- × Financial: "Vendor SLA credits are capped at $500/month — far less than our actual downtime cost."

### 4.2 API Contract (what interface shape is promised)

**schema** — machine-readable definition of an API's structure: what inputs are accepted, what outputs are produced (OpenAPI spec, GraphQL schema, protobuf definition, JSON Schema, Avro schema)
- × Semantic: "This schema maps to types declared in module X." Code-to-contract traceability.
- × Operational: "This schema is served at /openapi.json — runtime artifact, not just documentation."
- × Organizational: "This schema is the contract between Team A (producer) and Teams B, C, D (consumers)."

**schema_version** — immutable snapshot of a schema at a point in time; enables reasoning about compatibility
- × Temporal: "Schema v2.3 was published on 2024-03-15 — consumers locked to this version."
- × Causal: "Schema v2.4 removed field `user.role` — broke 3 consumers silently."
- × Risk: "No schema versioning — any change is a potentially breaking unknown."

**deprecation** — a promise that something will be removed, with a timeline and migration path (API field, endpoint, package, behavior)
- × Temporal: "Deprecated in v2.1, removal planned for v3.0 — deadline 6 months away."
- × Organizational: "12 teams consume this deprecated endpoint — all must migrate before removal."
- × Intentional: "This deprecation is the forcing function for migrating off the legacy auth system."

**compatibility_promise** — explicit statement of what changes are safe (semver contract, backwards compatibility guarantee, "no breaking changes in minor versions")
- × Temporal: "This package follows semver — a major version bump signals breaking changes."
- × Risk: "No compatibility promise on this internal API — consumers have no protection."
- × Organizational: "Breaking this promise requires a deprecation cycle and coordination with all consumers."

### 4.3 Invariant (what structural rules must always hold)

**guarantee** — a rule that must hold over the graph: structural, behavioral, or ownership (e.g., `grafema check` rules, Datalog invariants)
- × Semantic: "Every exported function must have JSDoc." Structural rule on code.
- × Security: "Every API endpoint must have auth middleware." Security invariant.
- × Organizational: "Every service must have an owner in CODEOWNERS." Ownership invariant.
- × Operational: "Every datastore must have a backup SLO defined." Operational hygiene rule.

**violation** — a concrete instance where a guarantee is broken
- × Causal: "This violation was the root cause of the incident." Invariant gap → incident.
- × Temporal: "This violation was introduced in commit X, undetected for 14 days." When and how long.
- × Risk: "12 active violations of the auth invariant — each is a potential security exposure."

**db_constraint** — a rule enforced at the database level: NOT NULL, UNIQUE, FOREIGN KEY, CHECK constraint, trigger (structurally different from application-level guarantees — enforced regardless of code)
- × Semantic: "This FK constraint enforces the relationship modeled in type `Order → User`." DB-to-code alignment.
- × Causal: "Removing this FK to improve write throughput caused orphaned records — silent data corruption."
- × Risk: "No FK between orders and users — application logic is the only enforcement layer."

**schema_constraint** — runtime validation rule applied at a system boundary: Zod schema, JSON Schema validator, input sanitizer, request body parser with strict mode
- × Semantic: "This Zod schema validates inputs to function `createUser` — runtime contract."
- × Security: "This constraint prevents injection attacks by rejecting unexpected field shapes."
- × Causal: "No schema constraint at the API boundary — invalid payload reached the database."

### 4.4 Verification (what is proven to hold)

**test** — automated check of behavior (unit, integration, e2e, contract test)
- × Semantic: "This test covers function X — what code is verified."
- × Causal: "This test would have caught the incident if it existed." Safety net gap revealed after the fact.
- × Temporal: "This test was added reactively after incident Y — not proactive."
- × Contractual: "This is a contract test — it verifies that Team A's client matches Team B's schema."

**coverage** — fraction of code paths, branches, or behaviors verified by tests
- × Risk: "Module X has 12% coverage — highest-risk area if it changes."
- × Organizational: "Team Y averages 85% coverage, Team Z averages 30% — uneven safety net."
- × Causal: "The incident path had 0% branch coverage — blind spot in verification."

**contract_test** — test that verifies a consumer-producer interface agreement (Pact, consumer-driven contract testing); distinct from unit tests because it crosses team/service boundaries
- × Organizational: "This contract test is co-owned by Team A (consumer) and Team B (producer)."
- × Temporal: "Contract test was broken for 3 days before being caught in CI."
- × Causal: "No contract test for this integration — schema mismatch reached production."

### 4.5 Policy (process and access contracts)

**gate** — an automated enforcement point that blocks a process until conditions are met (CI check required to merge, required reviewers, branch protection rules, deployment approval)
- × Organizational: "This gate requires sign-off from the security team before deployment." Who must approve.
- × Temporal: "This gate adds an average of 4 hours to deployment cycle time." Process cost.
- × Risk: "Emergency bypass of this gate exists — when was it last used?"

**review_policy** — rules governing human review of changes (min approvers, who must review, stale review invalidation, CODEOWNERS-based routing)
- × Organizational: "CODEOWNERS routes changes to `src/payments/` to Team Finance." Ownership → review responsibility.
- × Temporal: "Review policy was bypassed 12 times in the last quarter." Policy adherence trend.
- × Risk: "No review required for changes under 10 lines — small changes are unreviewed."

**compliance_requirement** — an external mandate the system must satisfy (GDPR, PCI-DSS, SOC2, HIPAA, ISO 27001); functions as a contract imposed by a regulator or auditor
- × Operational: "GDPR requires EU user data stays in EU regions." Data residency rule.
- × Security: "PCI-DSS requires network segmentation between payment and general services."
- × Organizational: "SOC2 requires changes go through staging before production." Process mandate.
- × Financial: "GDPR violation: up to 4% of annual global revenue. This is a financial contract."

**inter_team_agreement** — explicit documented contract between two internal teams: interface ownership, change notification requirements, SLO commitments for internal services
- × Organizational: "Team A owns this API; Team B can consume it but must notify before breaking changes."
- × Temporal: "This agreement was last reviewed 18 months ago — may be stale."
- × Causal: "Team A changed the API without notifying Team B — agreement was violated, incident followed."

## Entity Count: 19
