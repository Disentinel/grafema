# Projection 12: Risk

**Question:** What *could go wrong*?
**Soundness:** Real risk exists → graph models it.

---

> **Design note — probability and impact are attributes, not entities.**
> A `probability` node with no identity beyond "likelihood of some risk" has no cross-projection edges
> that don't already belong on the `risk` node itself. Modeling them as separate entities would produce
> a graph where every `risk → probability → risk` traversal is equivalent to just reading a field.
> Both are scalar attributes on `risk` (or `risk_register` entry). This is not a simplification — it is
> the correct model.

---

## Lenses

### 12.1 Threat (what can go wrong)

**risk** — identified potential negative event, with probability and impact as attributes
- × Financial: "If AWS raises prices 30%, our margin drops from 60% to 40%. P=0.3, Impact=$180k/year." Quantified financial exposure on one node.
- × Intentional: "If competitor ships feature X first, our initiative loses value. P=0.5, Impact=high." Strategic threat traceable to a specific initiative.
- × Temporal: "This risk expires after migration completes in Q2." Time-bounded risk with automatic resolution condition.
- × Security: "CVE-2024-1234 is unpatched. P=0.6 (actively exploited in the wild), Impact=data breach." Security-to-risk link.

**technical_debt** — accumulated shortcuts whose future cost (interest) compounds over time
Not just "a risk" — technical debt has a specific compounding structure: each deferral increases the future remediation cost. Distinct from `risk` because it is both a present state and a growing liability.
- × Semantic: "Module X has 400 TODOs and no tests — estimated 6 weeks to stabilize." Code-level debt quantification.
- × Financial: "Carrying this debt costs ~2 sprints/quarter in emergency fixes." Debt-as-running-cost.
- × Temporal: "This debt has grown 3x in 18 months without intervention." Compounding trajectory.
- × Intentional: "Planned feature Y cannot ship until debt in module X is resolved." Debt as blocker to strategy.

**regulatory_change** — risk that applicable law or regulation changes, creating new compliance burden
Distinct from `risk` (generic) and from `regulation` in Security projection (which models current requirements). This entity models the *delta* — a future legal change that does not yet apply but is foreseeable.
- × Contractual: "EU AI Act enters force in 2026 — our contracts make no provision for it." Future compliance gap.
- × Financial: "Retroactive GDPR enforcement on legacy data could cost up to 4% of global revenue." Regulatory impact quantification.
- × Intentional: "Feature X may become illegal under proposed FTC rule — paused pending clarity." Strategy-to-regulatory-uncertainty link.

### 12.2 Mitigation (how are we protected)

**contingency** — documented plan B: what to do if a specific risk materializes
- × Epistemic: "Contingency plan documented in runbook X — but only Alice knows where." Knowledge-to-risk link.
- × Temporal: "Contingency plan was last tested 8 months ago — readiness is decaying." Staleness of preparedness.
- × Organizational: "Contingency requires Team A and Team B to coordinate — but there is no established channel." Org gap in mitigation.

**redundancy** — duplicate capability that allows the system to absorb a failure without going down
Redundancy is an operational fact (lives in Operational projection) that becomes a *mitigation* when linked to a specific risk. The cross-projection value is that link.
- × Operational: "Database has 3 replicas across 2 regions — single-node failure does not trigger risk." Infrastructure fact as mitigation evidence.
- × Financial: "Redundancy costs $8k/month extra — this is the price of the risk mitigation." Cost of safety.
- × Risk (self): "Redundancy mitigates SPOF risk on DB but not on the single message queue — partial coverage." Mitigation gap.

**risk_control** — preventive or detective measure that reduces probability or detectability of a risk
Broader than contingency (reactive) or redundancy (structural). Covers: automated alerts, rate limits, circuit breakers, approval gates, code review requirements. Without this entity, there is no way to query "what controls exist for risk X?" separate from "what do we do if it happens?"
- × Semantic: "Circuit breaker on service X prevents cascade — reduces P(cascade failure) by design." Code-level control.
- × Behavioral: "Alert fires if error rate > 5% for 5 minutes — detection control." Monitoring-as-control.
- × Contractual: "SLA requires 99.9% uptime — internal control: auto-failover enforced by contract." Contract-driven control requirement.

**insurance** — financial transfer of risk to a third party (cyber insurance, E&O, D&O)
Distinct from contingency (process) and redundancy (structural). Insurance transfers residual financial impact; it does not reduce probability. Enables the query "which risks have financial coverage and at what cap?" — impossible without this entity.
- × Financial: "Cyber insurance policy: $5M coverage, $50k deductible. Covers: data breach, ransomware." Financial exposure cap.
- × Risk (self): "Insurance covers breach but not reputational damage — risk partially unhedged." Coverage gap analysis.
- × Contractual: "Customer contract requires proof of E&O insurance — certificate on file." Insurance-as-contractual-requirement.

### 12.3 Exposure (how vulnerable are we right now)

**single_point_of_failure** — component whose failure alone is sufficient to break a critical path
- × Semantic: "Module X has no alternative — if it fails, feature Y is fully down." Code-level SPOF.
- × Organizational: "Only Alice understands the billing module — human SPOF (bus factor = 1)." People-level SPOF; cross-link to `expert` in Organizational projection.
- × Operational: "All traffic routes through one load balancer in us-east-1." Infrastructure SPOF.

**concentration** — over-reliance on a single entity: vendor, client, person, geography, technology
- × Financial: "80% of ARR from one client — if they churn, existential." Revenue concentration.
- × Operational: "All services run on AWS us-east-1 — regional outage = total outage." Geographic and vendor concentration.
- × Organizational: "One team owns 60% of critical services — team dissolution is a systemic risk."
- × Intentional: "All growth bets on one acquisition channel." Strategic concentration.

**blast_radius** — set of components, services, or outcomes that fail if a given component fails
Distinct from SPOF: SPOF identifies *the* single node that causes failure; blast_radius models *what* that failure takes down. Enables "if service X fails, what else breaks?" — a fundamental risk query that neither Operational nor Semantic projection answers in risk terms.
- × Semantic: "Service X is imported by 14 modules — blast radius spans 60% of the codebase." Code dependency blast radius.
- × Operational: "Failure of the auth service takes down 100% of user-facing endpoints." Operational blast radius.
- × Financial: "Auth service failure = $0 revenue until resolved. Blast radius: $12k/hour." Financial blast radius.

**scaling_threshold** — concrete breakpoint beyond which the current architecture fails or cost cliffs
"What breaks at 10x traffic?" is a risk question, not just an operational one. Scaling thresholds are future risk exposures baked into present architecture. Without this entity, you can model current SPOFs but not capacity-based risks.
- × Operational: "PostgreSQL write throughput saturates at ~5k TPS — current load is 3.2k TPS." Headroom quantification.
- × Financial: "At 10x traffic, compute cost goes nonlinear — estimated $400k/month vs current $40k." Cost cliff.
- × Intentional: "Feature X requires DB rewrite before we can serve enterprise tier." Scaling risk as strategic blocker.

### 12.4 Governance (how risk is managed as a practice)

**risk_register** — formal artifact: curated list of identified risks with owners, mitigations, status, and review dates
Without this entity, the projection can surface risk patterns but cannot model "known and tracked" vs "unidentified." The risk register is the governance artifact that closes the loop. Enables: "which risks are unmitigated?", "which identified risks have no owner?", "which risks were identified but then dropped without resolution?"
- × Organizational: "Risk REG-7 (key person) is owned by CTO — last reviewed 4 months ago." Accountability chain.
- × Temporal: "Risk register has 23 open items — 8 are overdue for review." Governance health metric.
- × Intentional: "Three risks in the register block the enterprise tier launch." Risk-to-strategy linkage.

**risk_appetite** — formally declared threshold: how much risk the organization is willing to accept
Without this entity, every risk is evaluated in a vacuum. Risk appetite is the baseline against which all other risk entities are measured. Enables: "is this risk within tolerance?", "which risks exceed declared appetite?", "has appetite changed since last year?" — none of these are answerable without a formal appetite entity.
- × Financial: "Declared appetite: maximum $500k uninsured annual loss exposure." Financial risk tolerance.
- × Intentional: "Board has zero appetite for regulatory risk in the EU — constrains feature roadmap." Appetite as strategy constraint.
- × Risk (self): "Current concentration risk (80% ARR from one client) exceeds declared appetite threshold." Risk-vs-appetite gap query.

## Entity Count: 13
