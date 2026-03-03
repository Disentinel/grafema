# Projection 6: Organizational

**Question:** *Who* is responsible, to whom do they answer, and how do they coordinate?
**Soundness:** Real organizational structure exists → graph reflects it.

## Lenses

### 6.1 Ownership (who owns what)

**team** — group of people with shared responsibility over a bounded scope
- × Semantic: "This team owns modules A, B, C." Code ownership boundary.
- × Operational: "This team operates services X, Y." Operational accountability.
- × Financial: "This team's infrastructure spend is $40k/month." Cost attribution to team.

**role** — formal organizational position a person holds (Staff Engineer, PM, SRE, QA Lead)
- × Authority: "Only Principal Engineers can approve architectural changes." Role-gated approvals.
- × Epistemic: "The SRE on this team owns the runbooks — role determines knowledge responsibility."
- Note: Distinct from `owner` (accountability) and `expert` (knowledge). A role is a formal org slot.

**owner** — individual ultimately accountable for a specific artifact or scope
- × Causal: "This owner was paged for the incident." Accountability in incident chain.
- × Epistemic: "This owner knows why this architectural decision was made." Knowledge source.
- Note: Intentionally different from `expert`. An owner may delegate knowledge but not accountability.

**org_unit** — node in the organizational hierarchy (department → group → tribe → squad → team)
- × Financial: "This department has a $2M annual budget." Headcount and budget at hierarchy level.
- × Intentional: "This tribe owns the entire checkout domain." Scope at org-hierarchy granularity.
- × Risk: "This squad has 2 engineers but owns 4 services — understaffed." Resource concentration.
- Note: `team` is the leaf node; `org_unit` models the hierarchy above it.

### 6.2 Staffing (who is on the team and how it changes)

**person** — individual contributor or stakeholder in the org
- × Expertise: "Alice has deep knowledge of the billing module." Person-to-knowledge link.
- × Risk: "Bob is the only person who has touched service X in 18 months." Bus factor.
- × Temporal: "Alice joined in Q1; Carlos left in Q3." Team composition over time.

**membership** — time-bounded relationship between a person and a team
- × Temporal: "The team that built the auth service no longer exists — membership changes erased the experts." Historical staffing at a point in time.
- × Risk: "3 of 5 engineers who built this service have left in the last year." Attrition risk on a codebase.
- Note: Not just current roster — historical membership enables "who wrote this and are they still here?"

**contractor** — external contributor with bounded engagement, different access and knowledge transfer constraints
- × Risk: "Core authentication logic was written by a contractor whose contract ended 6 months ago." Knowledge retention risk.
- × Security: "Contractor has write access to production repo." Access scope for non-employees.
- × Epistemic: "No internal engineer fully understands this module — contractor knowledge was not transferred."

**stakeholder** — person who has interest in or authority over a system without owning its code (PM, designer, legal, compliance, security officer)
- × Intentional: "PM Alice defined the acceptance criteria for this feature." Non-engineer requirement ownership.
- × Contractual: "Legal requires GDPR compliance for this data flow — stakeholder drives the constraint."
- × Risk: "No security officer has reviewed this new payment flow." Missing stakeholder sign-off.

### 6.3 Authority (who can approve changes)

**approver** — person or role authorized to approve a specific class of change
- × Temporal: "Approval for this change requires 3 reviewers — average wait: 3 days." Bottleneck in delivery.
- × Risk: "Only one person can approve changes to service X — single point of authority."
- × Causal: "Change was approved without security review — that approval gap is the root cause."

**approval_process** — structured workflow for authorizing a change (review gates, committees, legal sign-off, CAB)
- × Temporal: "This approval process adds 5 days to every production deploy." Lead time impact.
- × Risk: "The approval process for emergency changes is informal and undocumented." Crisis governance gap.
- × Intentional: "This CAB gate exists because of the 2023 outage incident." Process provenance.

**escalation_path** — defined chain of authority activated when normal approval cannot proceed
- × Causal: "Escalation from on-call to SRE manager took 45 minutes during the incident." Response latency in causal chain.
- × Risk: "Escalation path crosses 3 org boundaries — no single person can unblock it alone."
- Note: Distinct from `approval_process` (normal path). Escalation is the exception path when authority is unclear or unavailable.

### 6.4 Expertise (who knows what)

**expert** — person with concentrated knowledge in a specific domain or codebase area
- × Risk: "Bus factor = 1: only Alice understands the billing module." Knowledge concentration.
- × Epistemic: "Alice's knowledge is undocumented — if she leaves, knowledge leaves with her."
- × Causal: "Incident was unresolved for 4 hours because Alice was unreachable." Expertise dependency in incidents.

**knowledge_domain** — organizational scope of expertise (not what the knowledge is — that's Epistemic; but who holds it and which team is responsible for it)
- × Organizational: "Knowledge domain 'payment processing' spans 3 teams — no clear owner." Cross-team expertise gap.
- × Intentional: "No team has claimed expertise in the area needed for feature X." Capability gap that blocks roadmap.
- × Risk: "This knowledge domain is covered by contractors only." Retention risk on critical expertise.

**on_call** — time-bounded responsibility assignment for incident response (distinct from code ownership)
- × Causal: "On-call engineer was not the owner of the failing service — 20-minute handoff delay." Mismatch between on-call and ownership.
- × Operational: "This service's on-call rotation has 2 engineers — alert volume is 40/week each." Operational load on org.
- × Risk: "On-call for this service rotates through 6 engineers, only 1 of whom has ever deployed it." On-call readiness gap.

### 6.5 Coordination (how teams interact)

**collaboration_mode** — type of interaction pattern between teams (from Team Topologies: collaboration, X-as-a-Service, facilitating)
- × Temporal: "Teams A and B switched from collaboration to X-as-a-Service 6 months ago." Interaction evolution.
- × Risk: "Team A has deep runtime dependency on Team B but no formal interaction mode agreed." Implicit coupling without coordination contract.

**communication_channel** — persistent channel through which organizational communication happens (Slack channel, mailing list, recurring meeting, standup)
- × Organizational: "This Slack channel is where service X change requests are posted — it IS the team API in practice." Channel as de facto interface.
- × Epistemic: "The architectural decision was made in a Slack thread that is now lost." Decision knowledge in ephemeral channel.
- × Risk: "All cross-team coordination happens in a single channel with 800 members — signal-to-noise collapse." Coordination bottleneck.

**team_api** — formal interface a team presents to others: what they offer, how to request it, SLOs on response
- × Contractual: "Team B promises <24h response to API change requests from other teams." Inter-team SLO.
- × Semantic: "This team API maps to REST endpoints X, Y, Z and internal library L." API-to-code traceability.
- × Temporal: "Team B's API contract was last updated 8 months ago — may not reflect current reality."

### 6.6 Conway's Law (where org structure and architecture align or conflict)

**conway_coupling** — an architectural dependency that exists because of org structure, not technical necessity
- × Semantic: "Services A and B share a database because they were once one team." Org history encoded in architecture.
- × Risk: "Three teams share this module — changes require coordination across all three." Cross-team coupling risk.
- × Intentional: "This API boundary exists because of the reorg in 2022, not because it's the right domain split."

**domain_team_mismatch** — a DDD bounded context that does not map cleanly to a single team's ownership
- × Semantic: "The 'order' domain is split across 4 teams — the API is fragmented accordingly." Conway's law violation made queryable.
- × Risk: "No single team can make an end-to-end change to this user journey without cross-team coordination." Delivery bottleneck.
- × Intentional: "Feature X requires changes in 6 repos owned by 3 teams — it will not ship on time." Roadmap impact of misalignment.

**org_debt** — structural organizational problem: wrong team boundaries, understaffed critical areas, ownership gaps, abandoned services with no team
- × Risk: "Service X has no team owner since the reorg — incidents go unresponded." Ownerless critical service.
- × Temporal: "This team boundary was drawn 4 years ago and has never been revisited despite 3 product pivots."
- × Financial: "Fixing this org boundary mismatch requires a 6-month migration — that cost has been deferred 2 years."

## Entity Count: 22
