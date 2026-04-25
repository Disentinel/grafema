---
id: kb:session:2026-03-15-competitive-analysis-licensing-strategy
type: SESSION
projections:
  - epistemic
created: 2026-03-15
---

## Session: Competitive analysis, licensing, and monetization strategy

**Date:** 2026-03-15
**Branch:** enox

### What was done
1. **Disk cleanup** — freed ~27 GB across worktrees (Rust target dirs, npm cache, inactive projects)
2. **Competitive research** — deep analysis of CodeAlive (codealive.ai) and Nia (trynia.ai/Nozomio, YC $6.2M). Created competitor files in `_ai/competitors/`
3. **Market positioning** — established Grafema's unique position: only tool combining local + deep semantic graph + untyped code + MCP + free/open-source
4. **Licensing decision** — proposed switch from Apache 2.0 to FSL 1.1 with dual licensing (commercial embedding at 1-2% revenue share)
5. **Registry strategy** — three-tier licensing (FSL core, Apache Enox protocol, mixed registry data). Pre-built manifests solve bootstrap problem. Economic advantage: CPU compute vs LLM inference.
6. **Investment analysis** — discussed seed/Series A valuations, YC mechanics, bootstrapped vs VC trade-offs. Conclusion: investment not needed for product, only for GTM speed.

### Key outcomes
- CodeAlive and Nia are marketing-heavy but technically shallow (LSP/text indexing + inference)
- Grafema's compute-not-inference model is a structural economic advantage
- FSL + commercial embedding = turn competitors into customers
- 15K-file BrightData demo is the critical next milestone
- Prompt prepared for license change execution

### Artifacts created
- `_ai/competitors/codealive.md`
- `_ai/competitors/nia-nozomio.md`
- 3 DECISION nodes, 4 FACT nodes in KB
