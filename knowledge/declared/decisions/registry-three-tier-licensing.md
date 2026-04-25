---
id: kb:decision:registry-three-tier-licensing
type: DECISION
status: proposed
effective_from: 2026-03-15
scope: global
projections:
  - epistemic
  - contractual
created: 2026-03-15
---

## Registry and Enox protocol licensing strategy

**Decision:** Three-tier licensing for the Grafema ecosystem:

1. **Grafema core (analyzer)** — FSL 1.1. Protected from competitive embedding.
2. **Enox protocol** — Apache 2.0. Open standard, maximize adoption (like HTTP).
3. **Registry data:**
   - Grafema-generated manifests (fleet scanning) — FSL. Our compute, our IP.
   - Community-contributed manifests (authors publish via Enox) — MIT. Open.

**Monetization of registry:**
- Free: public manifests, basic API
- Paid: private registry for enterprise, SLA, priority rebuild on new package versions, custom analyses

**Analogy:** Docker Hub model. Docker engine = open source. Docker Hub = service. Community images = open. Official images = curated by Docker Inc.
