---
id: kb:fact:grafema-compute-advantage-no-inference
type: FACT
confidence: high
subtype: domain
scope: global
projections:
  - epistemic
  - operational
created: 2026-03-15
---

## Grafema's economic moat: deterministic analysis, no inference

Grafema's analysis is pure CPU compute — parser + graph construction, no LLM inference.

**Implications:**
- Cost per package analysis ≈ $0 (laptop CPU time)
- Embarrassingly parallel by file — scales linearly with cores
- ~1000 packages/day on a single laptop (4 threads, ~5 min/package)
- K8s fleet on spot instances: top-5000 npm in one day
- Results are deterministic and reproducible
- Works offline, no API keys needed

**vs competitors:**
- Nia/CodeAlive: every user query = LLM inference = $$$
- Their costs scale linearly with users
- Grafema registry: build once → serve static manifests via CDN → marginal cost ≈ $0
- Rebuild on new analyzer version = batch k8s job on spot instances, not ongoing cost
