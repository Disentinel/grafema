---
id: kb:decision:registry-pre-built-manifests-strategy
type: DECISION
status: proposed
effective_from: 2026-03-15
scope: global
projections:
  - epistemic
  - operational
created: 2026-03-15
---

## Registry solves bootstrap problem via pre-built manifests

**Decision:** Build a registry of pre-built package manifests (like DefinitelyTyped for graphs) to solve the Enox bootstrap problem.

**Strategy:**
1. Grafema fleet scanners analyze top npm/pypi/maven packages
2. Publish manifests to registry — authors don't need to do anything
3. If authors want to refine/extend — Enox protocol allows it
4. Community can contribute manifests for niche packages

**Economics advantage over Nia/CodeAlive:**
- No LLM inference needed — deterministic analysis, CPU-only
- One laptop: ~1000 packages/day. K8s fleet on spot instances: top-5000 npm in a day
- Build once, serve forever (static manifests, CDN delivery)
- Rebuild on new analyzer version = batch job, not ongoing cost
- Competitors scale inference costs linearly with users. We scale CDN.

**Rejected alternative:**
- Wait for organic Enox adoption (authors publish their own) — rejected because bootstrap problem. Nobody publishes if nobody reads.
