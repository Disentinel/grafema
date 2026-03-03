# Projection 10: Financial

**Question:** How much does it *cost*, how much does it *earn*, and where is money being wasted?
**Soundness:** Real cost exists → graph attributes it. Real revenue exists → graph traces it to code.

## Lenses

### 10.1 Infrastructure Cost (what the system pays to run)

**cloud_resource_cost** — spend on cloud compute, storage, networking, managed services
- × Operational: "Service X: 4 pods × $0.05/hour = $146/month." Cost per service, per environment.
- × Intentional: "Feature Y's infrastructure costs $3k/month." Cost per feature, enabling TCO analysis.
- × Organizational: "Team Z owns resources totaling $40k/month." Cost per team, budget accountability.

Note: `compute_cost` is a dimension of this entity (tag `resource_type=compute`), not a separate entity. Splitting it out creates false precision — all cloud resources show up in the same bill.

**licensing_cost** — spend on software licenses, SaaS subscriptions, seat licenses, API quotas
- × Risk: "We pay for 500 GitHub seats but only 320 developers are active." Waste detection.
- × Organizational: "Datadog costs $80k/year — who actually uses it?" License-to-team attribution.
- × Intentional: "This $12k/month vendor license enables feature X — is the feature worth it?" Build-vs-buy signal.

Distinct from cloud costs: licensing is contractual, often annual, harder to cancel, and invisible to infra dashboards. Needs its own entity.

**vendor_api_cost** — pay-per-use third-party API spend (Stripe fees, Twilio, SendGrid, OpenAI tokens, etc.)
- × Risk: "Stripe fees: $30k/month. A 20% price increase = +$6k/month impact." Vendor leverage quantification.
- × Behavioral: "Twilio cost spikes every Monday — correlates with weekly report emails." Anomaly attribution.
- × Semantic: "80% of OpenAI spend originates from function `generateSummary()`." Code-to-cost attribution.

Distinct from licensing: these costs scale with usage, not seats. Behavior-linked. Can be optimized by code changes.

### 10.2 Labor Cost (what humans cost to build and maintain the system)

The biggest cost in software development, entirely absent from the original file.

**developer_time_cost** — cost of developer hours attributed to features, modules, incidents
- Modeled as: person × rate × hours_logged, attributed via commit/PR/ticket linkage.
- × Organizational: "Team A spent 400 dev-hours on Feature X this quarter = $60k at blended rate."
- × Intentional: "Initiative Y has consumed $280k in dev time but is only 40% complete." Budget burn signal.
- × Temporal: "This module receives 8 hours of maintenance per sprint on average — forever." Carrying cost of complexity.

**incident_cost** — cost of incidents in dev time, lost revenue, and SLA penalties
- × Behavioral: "Last month's outage: 3 engineers × 6 hours + $20k SLA penalty + $8k estimated lost revenue."
- × Risk: "Service X has had 4 incidents this quarter — total incident cost: $85k." Risk-to-money translation.
- × Temporal: "Incident cost is increasing quarter-over-quarter." Trend signal requiring architectural action.

**technical_debt_cost** — the financial liability of accumulated technical debt, expressed as future dev time
- Technical debt accrues like debt: the "principal" is the refactoring cost, the "interest" is the extra time every feature takes because the code is hard to change.
- × Semantic: "Module `payments/legacy/` adds ~30% overhead to every feature that touches it." Interest rate of specific debt.
- × Intentional: "Rewriting the auth module costs $40k once. Carrying it costs ~$15k/year in slowdown." Debt vs. payoff decision.
- × Temporal: "Tech debt interest payments have grown 20% per quarter — compounding." Debt trajectory.

This is not a soft concept. It is a real financial liability that belongs in the financial projection, quantified via dev-time overhead metrics.

### 10.3 Budget (what is allocated and how it flows)

**budget** — planned spending limit for a team, initiative, or time period
- × Intentional: "Initiative X has $500k budget for H1." Strategy-to-money link.
- × Temporal: "60% of Q1 budget consumed by end of February." Burn rate visibility.
- × Risk: "Budget overrun by 30% — needs approval or scope cut." Early warning.

**allocation** — how budget is distributed across teams, initiatives, cost categories
- × Organizational: "Team A gets 40%, Team B gets 35%, Team C gets 25%." Resource distribution.
- × Intentional: "80% to feature development, 20% to tech debt reduction." Strategic balance signal.

### 10.4 Unit Economics (cost and revenue per unit of value)

The current model has total costs but no per-unit costs. That makes optimization impossible — you can't tell if growth is profitable.

**cost_per_unit** — cost per user, per transaction, per API call, per request (domain-specific unit)
- × Behavioral: "Cost per active user: $0.003/month. At current growth rate this crosses $0.01 at 500k users." Scalability inflection point.
- × Operational: "Cost per checkout transaction: $0.12 infra + $0.08 Stripe fee = $0.20 total." Full unit cost.
- × Intentional: "Feature X costs $2.50 per user activation. LTV is $40. Unit economics are positive." Investment decision.

**margin_per_feature** — revenue minus total cost for a specific feature or product area
- × Intentional: "Checkout: $200k/month revenue, $45k/month total cost (infra + dev + support) = 77.5% gross margin."
- × Risk: "Feature X has negative margin — each new user makes it worse. Stop growing it until fixed."
- × Organizational: "Team B's feature portfolio has average 40% margin vs Team A's 70%." Efficiency comparison.

### 10.5 ROI (return on investment)

**revenue_attribution** — which code, feature, or team generates revenue
- × Intentional: "Feature X generates $200k ARR." Feature value quantification.
- × Semantic: "Module `checkout/` is responsible for 60% of revenue — it is a critical asset." Code-to-revenue mapping.
- × Risk: "80% of revenue flows through one module. A bug there is a P0 revenue event." Concentration risk.

**opportunity_cost** — value of what was not built because resources were spent elsewhere
- × Intentional: "Team spent Q1 on Feature X ($80k). Competitor shipped Feature Y in Q1, capturing $500k ARR. Opportunity cost: ~$500k."
- × Temporal: "3-month delay in launching Feature Z cost an estimated $120k in missed revenue." Time-to-market value.

Opportunity cost is often the largest financial figure in software and is never tracked. It requires linking roadmap decisions to market outcomes.

### 10.6 Cost Trends and Anomalies (is cost behavior healthy)

**cost_trend** — directional change in costs over time, per resource, per team, per feature
- × Temporal: "Cloud spend up 40% month-over-month while user count grew 10% — cost is growing faster than usage." Efficiency degradation signal.
- × Operational: "Database costs increasing linearly — no caching layer is working." Root cause attribution.
- × Intentional: "Budget trajectory suggests overspend by $200k by end of quarter if unchecked."

**cost_anomaly** — sudden unexpected deviation in cost from the established baseline
- × Behavioral: "Cloud bill spiked $15k on Tuesday — correlates with deployment of service X." Anomaly-to-cause attribution.
- × Operational: "Lambda invocation count 10x normal — runaway loop or DDoS?" Operational incident signal with financial tag.
- × Risk: "Anomaly frequency increasing — cost predictability degrading." Meta-trend on anomalies.

**cost_optimization_opportunity** — identified waste: idle resources, over-provisioned capacity, unused licenses, redundant vendors
- This is FinOps in graph form: the graph knows what's deployed, what's used, what's paid for.
- × Operational: "3 EC2 instances running at <5% CPU for 60+ days. Estimated waste: $1,200/month."
- × Organizational: "Team C has 12 unused Datadog seats ($3,600/year)." Actionable waste.
- × Semantic: "Function `generateReport()` calls external API on every request — caching would reduce cost 80%." Code change → cost reduction.

## Entity Count: 16
