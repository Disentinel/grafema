# Projection 11: Behavioral

**Question:** How is it *actually used*?
**Soundness:** Real usage pattern exists → graph captures it.

## Lenses

### 11.1 Session (atomic unit of user activity)

Without sessions, "usage" and "journey" are meaningless aggregates. Sessions are the foundation everything else here is computed from.

**session** — bounded episode of user activity with start, end, duration, and event sequence
- × Operational: "Sessions from EU users average 3x longer than US — maps to CDN latency differential." Behavioral-to-infra link.
- × Risk: "Session duration dropping 20% week-over-week — leading indicator of churn before retention numbers move."
- × Financial: "Sessions that include feature X have 4x revenue per session — justifies infra cost."

**session_error** — user-visible error state encountered during a session (distinct from operational errors; this is what the user experienced)
- × Semantic: "72% of session_errors at checkout map to `validatePayment()` throwing a recoverable exception that was swallowed." Error-to-code link.
- × Causal: "session_error rate tripled after deploy Y — which deploy? which code path?" Deploy-to-user-impact.
- × Risk: "Sessions with any error have 60% lower conversion. 8% of all sessions hit errors." Revenue risk quantification.

**entry_point** — where a session begins (direct, search, referral, specific deep-link)
- × Intentional: "60% of sessions start at a deep-link to feature X, but onboarding assumes users start at home." Intent vs reality gap.
- × Journey: "Entry point determines which funnel the session belongs to — can't interpret drop-off without it."
- × Financial: "Paid acquisition entry points convert at 2% vs 12% for organic — unit economics of acquisition."

### 11.2 User Segments (different populations, different behavior)

The single biggest omission in the original: all behavioral entities are meaningless without knowing *which users*. A power user abandoning a funnel step means something completely different than a first-time user doing it.

**user_segment** — stable classification of users by behavior profile (e.g., power user, casual, churned, B2B API consumer, internal developer)
- × Intentional: "Feature X was built for power users but 90% of its sessions come from casual users who use it differently." Product-reality gap.
- × Financial: "Power users (8% of base) generate 60% of revenue — retention risk is concentrated." Economic concentration.
- × Organizational: "B2B API consumers are served by the Enterprise team, but their bugs get routed to Core — wrong ownership."

**cohort** — group of users who started using the system in the same time period; essential for distinguishing "product got better" from "old users churned and new ones look different"
- × Temporal: "Cohort from Q3 2024 has 40% day-30 retention; Q4 cohort has 22% — something broke in onboarding, not the product." Cohort-to-change link.
- × Intentional: "Each cohort's behavior diverges by week 2 — validates that onboarding determines long-term patterns."
- × Risk: "If Q4 cohort retention doesn't recover to Q3 levels by month 3, projected ARR impact is $800k."

**api_consumer** — external system (B2B) that calls your API programmatically; has no "session" or "journey" in the human sense
- × Contractual: "api_consumer X calls endpoint `/export` 40k times/day — their SLA depends on it, but it's not in our SLO."
- × Operational: "api_consumer Y's request pattern causes thundering herd every hour at :00 — visible in infra projection."
- × Financial: "Top 5 api_consumers represent 70% of API volume — their churn risk is existential."

### 11.3 Usage (what is used and how often)

**feature_adoption** — what fraction of a target segment uses a feature, over what time window
- × Intentional: "Feature X was designed for power users; 5% of power users adopted it vs 40% of casual users — wrong segment found it useful." Intent vs reality gap.
- × Financial: "Feature X costs $3k/month to run and serves 500 users across 2 segments = $6/user/month; but power user segment pays 3x the ARPU." Unit economics by segment.
- × Risk: "Core feature Y has declining adoption in power user segment — 30% drop in 3 months. That segment drives revenue." Churn signal with economic weight.

**DAU/MAU** — daily/monthly active users, always segmented; raw aggregate is nearly useless
- × Financial: "Cost per active user by segment: $0.12/month for casual, $1.40/month for power users (who pay 10x more)." Per-segment unit economics.
- × Contractual: "SLO guarantees are owed to B2B api_consumers whose 'active' pattern is continuous, not daily."

**retention** — do users from a given cohort return, measured by cohort not aggregate
- × Intentional: "Power user cohort from Q3: 85% day-30 retention. Casual cohort: 23%. Product works differently for each." Segment-differentiated validation.
- × Risk: "Power user retention dropping 2%/month — not visible in aggregate DAU because casual acquisition masks it." Hidden strategic risk.

### 11.4 Journey (what paths do users take)

**funnel** — ordered sequence of steps toward a defined goal, with conversion rate at each step, segmented by user type
- × Semantic: "Funnel step 3 (payment) maps to endpoint `/api/checkout` — a code change there broke step 3 conversion." Journey-to-code link.
- × Causal: "Drop-off at step 3 correlates with the deploy that changed checkout flow; power users unaffected, casual users dropped 18%."
- × Financial: "10% drop-off at payment step in casual segment = $200k/year lost revenue — not visible without segmentation."

**drop_off** — specific step where users abandon a journey, with segment and cohort breakdown
- × Semantic: "Drop-off at this step maps to a function that takes 3s to respond on mobile but 200ms on desktop." Platform-differentiated performance-to-conversion link.
- × Causal: "Drop-off increased 15% after deploy Y — only in mobile segment, not desktop." Segment-specific deploy impact.
- × Risk: "New user cohort drops off at step 2 (account creation) at 40% — this is a structural onboarding problem, not a one-time event."

**device_context** — device type, OS, and browser for a session; determines which journey is even possible
- × Semantic: "Feature X is unavailable on mobile — but 30% of sessions attempting it are mobile." Dead-end flow in the graph.
- × Operational: "Mobile sessions generate 3x API requests per funnel step due to retry logic on flaky connections." Infra impact from behavioral context.
- × Intentional: "Product was designed desktop-first; 55% of actual sessions are mobile — platform priority inversion."

**locale_context** — language and region for a session; different locales have systematically different behavioral patterns
- × Semantic: "RTL locales (Arabic, Hebrew) have 3x drop-off at step 4 — maps to a layout bug in the payment form that's only visible in RTL." Locale-to-code link.
- × Financial: "DE/FR markets convert at 8% vs US 24% — 3x gap that's invisible in aggregate metrics."
- × Intentional: "Product roadmap has no localization investment, but 40% of sessions are non-English."

### 11.5 Feedback (what do users say)

**support_ticket** — user-reported problem, classified by type (bug, confusion, feature request) and linked to segment
- × Semantic: "80% of tickets about 'slow search' from power user segment map to `search/index.js` — but power users run queries 10x larger." Feedback-to-code link with segment context.
- × Causal: "Ticket volume spiked 3x after deploy X — specifically from api_consumer segment, not human users." Segment-differentiated deploy impact.
- × Organizational: "Tickets about module X go to Team Y — but 60% originate from B2B api_consumers who are owned by Team Z."

**feature_request** — structured signal about capability gap, distinct from a bug report; tells you what the product doesn't do that users need
- × Intentional: "Top feature request from power user segment is 'bulk export' — not on roadmap, but represents $400k ARR in upsell."
- × Organizational: "Feature requests from api_consumers go to support, never reach Product — structural feedback loop failure."

**churn_reason** — why users leave; structured data from exit surveys, sales calls, or inferred from behavioral pattern before last session
- × Intentional: "Top churn reason: 'missing feature X' — which is on the roadmap for Q3. Delay has a measurable cost."
- × Financial: "Churn reason 'switched to competitor Y' represents $1.2M ARR lost in 6 months — competitor analysis needed."
- × Risk: "30% of churned power users cite 'performance' — maps to p99 latency spike that ops dismissed as within SLO."

**NPS_response** — individual survey response (not the aggregate score); the raw signal that enables segment-level and cohort-level analysis
- × Intentional: "Aggregate NPS +30 masks: power users +65, casual users -5. Product works for one segment, not the other."
- × Temporal: "NPS for Q3 cohort dropped from +40 to +10 by month 3 — same trajectory as churn leading indicator."

## Entity Count: 20
