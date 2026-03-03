# Projection 8: Epistemic

**Question:** What is *known*, where is it recorded, and how healthy is that knowledge?
**Soundness:** Real knowledge artifact exists → graph indexes it.

## Lenses

### 8.1 Formal Documentation (written artifacts with explicit audience)

**readme** — entry-point document for a repository or module
- × Organizational: "No team has claimed ownership of this README — it hasn't been updated in 2 years." Ownership gap.
- × Temporal: "README was last modified before the architectural rewrite — describes a system that no longer exists." Staleness.
- × Semantic: "README references modules A, B, C — graph can verify whether those modules still exist."

**ADR** — architecture decision record: why a decision was made, what alternatives were rejected
- × Causal: "ADR-42 explains why we chose Redis over Postgres." Decision provenance.
- × Risk: "ADR-42's key assumption ('traffic < 10k RPS') no longer holds — decision needs revisiting." Assumption invalidation.
- × Temporal: "ADR was written in 2019 — 3 architectural changes have happened since." Decision staleness.

**API_spec** — formal interface description (OpenAPI, GraphQL schema, Protobuf)
- × Contractual: "API spec is the contract — integration tests validate against it." Spec-as-contract.
- × Intentional: "API spec defines what surface area feature X exposes." Feature interface.
- × Organizational: "API spec is the team boundary — Conway's law made explicit."

**post_mortem** — structured knowledge artifact derived from an incident: what happened, why, what we learned
- × Causal: "Post-mortem links the incident to root cause: missing circuit breaker." Learned causality.
- × Risk: "Post-mortem identified 3 action items — 2 are still open 6 months later." Unmitigated learned risk.
- × Temporal: "This is the third post-mortem about the same component — learning is not being applied." Recurrence signal.

**runbook** — operational procedure document for a specific task or incident type
- × Operational: "Runbook describes how to manually fail over the database." Procedure-to-infra link.
- × Risk: "Runbook was last tested 14 months ago — may not reflect current infrastructure." Readiness decay.
- × Behavioral: "During the last incident, the runbook was opened but the resolution path diverged — runbook was not followed." Effectiveness signal.

**onboarding_guide** — documentation targeted at new team members
- × Organizational: "Onboarding guide covers team A's services but not team B's, which new hires also touch." Coverage gap.
- × Temporal: "Onboarding guide references a setup process that was replaced 8 months ago." New-hire experience risk.
- × Risk: "No onboarding guide exists for the billing module — every new hire rediscovers the same gotchas." Repeated onboarding cost.

### 8.2 Inline Knowledge (knowledge co-located with code)

**code_comment** — human-readable explanation embedded in source: intent, rationale, warnings
- × Semantic: "Comment explains why this function does X — the graph can link explanation to the exact code node it describes."
- × Temporal: "Comment references a 'temporary workaround for bug #1234' — that bug was closed 3 years ago." Stale comment.
- × Risk: "Comment says 'do not call this on the main thread' — no automated enforcement exists." Undocumented invariant as comment.

**docstring** — structured documentation comment attached to a function, class, or module (JSDoc, Python docstrings, etc.)
- × Semantic: "Docstring describes parameter types and return value — graph can verify consistency with actual usage."
- × Contractual: "Docstring specifies preconditions — violations are undetected contract breaches."
- × Behavioral: "Function is called 500 times/month but has no docstring — undocumented high-traffic API."

**changelog_entry** — recorded description of what changed and why in a release
- × Temporal: "Changelog entry marks when breaking change was introduced." Change provenance.
- × Contractual: "Breaking change was not documented in changelog — consumers had no warning." Contract communication failure.
- × Organizational: "Changelog is maintained by team X — consumers from team Y are not notified of changes."

### 8.3 Conversational Knowledge (knowledge embedded in communication artifacts)

**pr_review_comment** — code-review feedback attached to a specific diff location
- × Semantic: "Review comment on line 47 explains why this approach is wrong — co-located with the code it describes."
- × Temporal: "Review comment identifies a known issue that was accepted as tech debt — 18 months ago. Still there."
- × Organizational: "Reviewer who left this critical comment has since left the company — knowledge is now unreachable."

**commit_message** — rationale and context recorded at the point of change
- × Causal: "Commit message explains why this behavior change was intentional, not a bug." Change intent.
- × Temporal: "Commit message references an incident ticket that no longer exists in the tracker." Lost context.
- × Semantic: "Commit modifies 12 functions but message says only 'fix bug' — rationale is lost."

**discussion_thread** — asynchronous conversation about a decision, design, or problem (GitHub issues, internal forums, Slack archives)
- × Causal: "The design decision was made in a GitHub issue thread — rationale is not captured anywhere else."
- × Organizational: "Discussion happened in a Slack channel that was deleted — knowledge is permanently lost."
- × Risk: "Key architectural constraint was communicated only in a discussion thread — not findable by search."

### 8.4 Tacit Knowledge (knowledge that exists only in people's heads)

**undocumented_convention** — implicit rule that everyone follows but nobody wrote down, discoverable by observing the code
- × Risk: "Convention 'all timestamps must be UTC' is not documented — new hires use local time until they hit a bug." Onboarding risk.
- × Contractual: "This convention is an unwritten invariant — should be codified as a guarantee."
- × Semantic: "Graph can detect violations of the convention even though it was never formally stated."

**tacit_knowledge** — understanding that exists only in someone's head: WHY the system is the way it is, historical context, mental models
- × Risk: "Only Bob knows why the billing module has a 30-second sleep in the critical path. Bus factor = 1." Knowledge concentration.
- × Organizational: "Bob left the company — this knowledge is now permanently lost." Knowledge extinction.
- × Causal: "The incident was caused by a decision made for reasons only the original author understood." Lost rationale.

**mental_model_divergence** — gap between how a person believes the system works and how it actually works
- × Semantic: "Developer believes function X is idempotent — graph shows it has a side effect." Belief vs reality.
- × Risk: "Ops team mental model of failover behavior differs from actual behavior — dangerous during incidents."
- × Causal: "Incident was caused by an engineer acting on an incorrect mental model of the deployment process."

### 8.5 Knowledge Health (meta-level: is the knowledge good?)

**knowledge_gap** — something that SHOULD be documented or known but is not
- × Risk: "Module X has no documentation, no docstrings, no code comments, and its only expert left the company." Compounded gap.
- × Organizational: "Knowledge gap in 'payment processing' means no team can safely modify that module."
- × Intentional: "Feature Y cannot be extended because nobody understands its current constraints." Strategic blocker.

**knowledge_staleness** — degree to which a knowledge artifact no longer reflects reality
- × Temporal: "Document was last updated 18 months ago, the code it describes has changed 200 times since." Drift measure.
- × Risk: "Runbook staleness: last validated during an incident 2 years ago — untested against current infra."
- × Causal: "Engineer followed stale runbook — caused secondary incident." Staleness as incident cause.

**knowledge_reach** — who actually has access to this knowledge artifact
- × Organizational: "Post-mortem is in a Confluence space that only senior engineers can read — junior engineers repeat the same mistakes."
- × Risk: "Critical security runbook is not accessible to the on-call engineer during an incident." Access gap at crisis time.
- × Intentional: "Onboarding guide is theoretically available but not linked from anywhere new engineers land." Unreachable knowledge.

## Entity Count: 19
