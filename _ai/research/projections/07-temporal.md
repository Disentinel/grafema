# Projection 7: Temporal

**Question:** *When* and in what order?
**Soundness:** Real event occurred or real age exists → graph records it.

## Lenses

### 7.1 History (what changed and when)

**commit** — atomic change to code, recorded in VCS
- × Semantic: "This commit modified functions A, B, C." Change-to-code mapping.
- × Organizational: "This commit was authored by person X." Attribution.
- × Causal: "This commit introduced the bug." Root cause tracing.

**pull_request** — proposed change unit with review gate
- × Organizational: "This PR was reviewed by 3 people." Review coverage.
- × Contractual: "This PR passed all CI checks." Verification at change time.
- × Epistemic: "PR description explains the rationale." In-context documentation.
- × Causal: "This PR reverted the broken change — rollback chain."

**diff** — set of specific code changes within a commit (file-level, hunk-level)
- × Semantic: "This diff changes the signature of function X." Precise impact surface.
- × Risk: "This diff touches 47 files — blast radius is abnormally high."
- × Causal: "The incident started with this exact hunk — line 42 of payments.js."

### 7.2 Deployment (when code goes live)

> Commits record what changed in the repo. Deployments record when code reached a runtime environment. These are distinct events — a commit can sit undeployed for weeks, or be deployed to staging but not production.

**deployment** — event of pushing a specific version of code to a specific environment
- × Operational: "This deployment pushed service-v2.3.1 to production at 14:32 UTC." Code-to-runtime event.
- × Causal: "The incident started 4 minutes after this deployment." Deployment-to-incident link.
- × Organizational: "This deployment was approved by Alice and triggered by Bob." Accountability chain.
- × Risk: "This deployment skipped staging — no pre-production validation."

**rollback** — event of reverting a running environment to a previous version
- × Causal: "Rollback to v2.2.8 resolved the incident." Remediation event.
- × Organizational: "Who triggered the rollback? Who approved it at 3 AM?" Incident accountability.
- × Risk: "This service has never been rolled back — rollback procedure is untested."
- × Contractual: "Rollback completed in 8 minutes — within the 15-minute MTTR SLO."

**release** — named, versioned artifact published for consumption (npm package, GitHub release, Docker image tag)
- × Contractual: "Release 3.0.0 broke the API contract — MAJOR version increment required."
- × Organizational: "Release ownership: who cut it, who approved it."
- × Semantic: "Release 2.1.0 introduced function `parseQuery` — when did this capability appear?"

**deploy_freeze** — explicit temporal window during which deployments are blocked
- × Intentional: "Code freeze before Q4 holiday season — no deployments Nov 25 – Jan 2." Time-boxed intent constraint.
- × Contractual: "Deployment blocked until security audit completes." External gate.
- × Organizational: "Who declared the freeze? Who can override it?"

### 7.3 Versioning (what version is active)

> Not the same as History. History tracks what changed. Versioning tracks what's currently active and what contract it carries. A system can have API v1 and v2 running simultaneously — that's not a historical fact, it's a current state with temporal extent.

**api_version** — versioned interface contract (REST v1/v2, GraphQL schema version, gRPC proto revision)
- × Contractual: "API v1 is sunset — callers must migrate by June 1." Deadline-to-version link.
- × Semantic: "API v2 changes the response shape of `/users` — all callers affected." Impact of version change.
- × Organizational: "Team A owns v1, Team B owns v2 — migration coordination required."

**schema_version** — versioned data schema in a datastore (migration number, schema hash, Avro schema version)
- × Operational: "Schema at version 47 — what table structure does production have right now?"
- × Causal: "Migration 45 dropped column `legacy_id` — the bug: old service still reads it."
- × Risk: "Schema version in staging is 44, production is 47 — incompatible if rolled back."

**package_version** — pinned version of a dependency in use
- × Security: "Package `lodash@4.17.15` has known CVE — when was it introduced, is it still in use?"
- × Risk: "Two services depend on incompatible versions of the same library." Version conflict.
- × Causal: "Upgrading `axios` from 0.27 to 1.0 changed error handling — root cause of regression."

### 7.4 Migration (irreversible ordered transformations)

> Migrations are not just schema changes. They are a distinct category: temporal events with ordering constraints, often irreversible, with cross-projection impact on data, contracts, and operations.

**migration** — ordered, tracked transformation applied to a datastore or system state (DB migration, data backfill, API contract migration, configuration migration)
- × Operational: "Migration 47 must run before service v2.3 starts — deploy ordering constraint."
- × Causal: "Migration ran on 3 of 5 shards before failing — system is in partial state." Partial migration risk.
- × Contractual: "Migration adds NOT NULL constraint — backwards-incompatible with old service versions."
- × Risk: "This migration is irreversible — no rollback path exists."

**migration_state** — current progress of a migration across systems or shards (pending, running, partial, complete, failed)
- × Operational: "Shard 3 migration is stuck — cross-shard data inconsistency in progress."
- × Risk: "Migration has been 'running' for 6 hours — is it hung? What's the blast radius?"

### 7.5 Flag Lifecycle (how configuration state changed over time)

> Operational projection captures current flag state. Temporal projection captures when it changed, creating the audit trail needed for incident root-cause tracing and compliance.

**flag_change** — event of enabling, disabling, or modifying a feature flag for a cohort
- × Causal: "Flag `new-checkout` was enabled at 14:31, errors started at 14:33." The event IS the root cause.
- × Organizational: "Who toggled the flag? Was it part of a planned experiment or ad hoc?"
- × Operational: "Flag is now enabled for 100% of users — the experiment has concluded."

**flag_schedule** — planned future change to a flag state (enable at time T, disable after N days)
- × Intentional: "Flag `dark-mode` enables automatically at feature launch date." Time-locked intent.
- × Risk: "Scheduled flag change has no owner assigned — who validates it before it fires?"

### 7.6 Cadence (the rhythm of work and delivery)

**release_cycle** — recurring pattern of how often releases happen (continuous delivery, weekly, sprint-based)
- × Risk: "Releases are weekly — if this week's release breaks, max production exposure is 7 days."
- × Contractual: "Release cadence satisfies 'security patches within 48h' SLO."
- × Organizational: "Release cadence is owned by Team X — they control the gates."

**sprint** — time-boxed planning and execution cycle
- × Intentional: "This sprint's scope commits to delivering feature X by Friday." Time-boxed intent.
- × Financial: "Sprint capacity: 8 developer-weeks = ~$40k cost." Resource allocation.

### 7.7 DORA Metrics (velocity and stability measurements)

> DORA metrics (Deployment Frequency, Lead Time for Changes, MTTR, Change Failure Rate) are the standard industry measurements of engineering throughput and stability. They exist only as temporal aggregations — they require historical data across commits, deployments, and incidents. Without the Temporal projection, they cannot be computed.

**deployment_frequency** — how often a team deploys to production (per day/week/month, per service)
- × Organizational: "Team A deploys 5x/day, Team B deploys 1x/month — radically different risk profiles." Maturity gap.
- × Risk: "Low deployment frequency means larger changesets per deploy — higher blast radius per release."
- × Intentional: "Roadmap goal: increase deploy frequency from weekly to daily by Q3."

**lead_time** — time from commit to running in production
- × Causal: "Feature X took 22 days from merge to production — why? CI bottleneck? Review queue?"
- × Organizational: "Team A: 2 hour lead time. Team B: 3 week lead time." Delivery capability difference.
- × Risk: "Long lead time means security patches are slow to reach production."

**mttr** — Mean Time To Recovery: how long incidents take to resolve from detection to resolution
- × Causal: "This service has MTTR of 4 hours — post-mortems show rollback procedure is manual."
- × Contractual: "MTTR exceeds availability SLO — remediation required."
- × Organizational: "MTTR is high because incident response involves 3 teams with no clear owner."

**change_failure_rate** — fraction of deployments that cause a production incident or require rollback
- × Risk: "Service X has 40% change failure rate — every other deploy causes an incident." Quality signal.
- × Causal: "Change failure rate spiked in March — correlates with team ownership change."
- × Contractual: "Change failure rate above 15% triggers mandatory post-mortem process."

### 7.8 Age and Staleness (how old is it, when was it last touched)

> Age and staleness are not historical queries — they are properties of entities at query time. They enable cross-projection questions that are impossible without them: "show me the critical path through the oldest untouched code" or "which compliance-relevant modules haven't been reviewed in 2 years?"

**last_modified** — timestamp of most recent change to an entity (file, function, module, config)
- × Risk: "This critical security module hasn't been touched in 4 years — is it abandoned or stable?"
- × Epistemic: "Last person who modified this file left the company 18 months ago." Knowledge risk.
- × Semantic: "Function `parseToken` last modified in 2019 — predates the security requirements added in 2021."

**age** — elapsed time since an entity was created
- × Risk: "This service is 8 years old — built before current security standards, never audited."
- × Organizational: "The oldest modules belong to teams that have been reorganized twice since — orphaned code."
- × Contractual: "Compliance audit requires review of any module older than 3 years that handles PII."

**staleness** — derived measure: last_modified relative to expected change frequency for this entity type
- × Risk: "This config was last updated 14 months ago but service behavior has changed — likely stale." Divergence signal.
- × Epistemic: "Documentation last updated 2 years ago — high probability of being wrong."
- × Causal: "Stale runbook caused 45 extra minutes during incident — responder followed outdated procedure."

### 7.9 Lifecycle State (what phase is an entity in)

**lifecycle_state** — current phase of an entity (experimental, active, deprecated, sunset, removed)
- × Risk: "This module is deprecated but 15 services still depend on it." Migration debt.
- × Intentional: "This feature is sunset — no further investment." Resource allocation signal.
- × Semantic: "This function is deprecated — all callers must migrate before June 1."

**lifecycle_transition** — recorded event of moving from one lifecycle state to another, with timestamp and actor
- × Organizational: "Alice declared this module deprecated on March 15." Decision audit trail.
- × Temporal: "Module was deprecated Jan 15, migration deadline is June 1 — 107 days remain."
- × Causal: "Service called deprecated endpoint after its sunset date — who missed the migration?"

> Note: `lifecycle_state` models the current phase. `lifecycle_transition` models the event of changing phases. They are distinct — the transition records who decided, when, and why, enabling accountability queries the state alone cannot answer.

## Entity Count: 25
