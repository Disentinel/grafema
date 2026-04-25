---
id: kb:decision:license-fsl-dual-licensing
type: DECISION
status: proposed
effective_from: 2026-03-15
scope: global
projections:
  - epistemic
  - contractual
created: 2026-03-15
---

## Switch from Apache 2.0 to FSL 1.1 with dual licensing

**Decision:** Replace Apache 2.0 license with FSL 1.1 (Functional Source License) + commercial embedding license.

**FSL terms:**
- Code fully open, usable for anything except building a competing product
- After 2 years each release converts to Apache 2.0
- Not OSI-approved ("source available", not "open source")

**Commercial license:**
- Competitors can embed Grafema as analysis engine for 1-2% revenue share
- Turns competitors into customers instead of blocking them
- Contact: licensing@grafema.dev

**Rejected alternatives:**
- **Keep Apache 2.0** — rejected because competitors (CodeAlive, Nia) could embed Grafema as their core engine and resell without paying. No protection.
- **AGPLv3** — rejected because enterprise companies (Google, etc.) ban AGPL internally. Would hurt adoption more than FSL.
- **SSPL** — rejected as too aggressive, designed for MongoDB's specific problem (cloud DBaaS). Overkill for Grafema.
- **BSL** — considered but FSL is newer, cleaner, and Sentry already proved market acceptance.
- **Pure block (FSL without commercial option)** — rejected in favor of dual licensing. Revenue share from embedding is better than blocking.

**Timing:** Must change before external contributors appear (no CLA needed if sole author).
