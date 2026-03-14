# Enox MCP — Roadmap to Publication

## Vision

Decision-support knowledge graph for CS research, delivered as remote MCP server.
"Semantic Scholar tells you what's popular. Enox tells you what to USE."

## Current State (v0.1 — Proof of Concept)

- 332 nodes, 222 edges from 50 papers (KGE/GNN domain)
- 8 decision-support relation archetypes validated
- Pipeline: extract-v3.js (Sonnet + few-shot) → load-to-rfdb.js → RFDB
- Stability: stddev 1.2, range 3-8 rels/paper, 0% noise

## Phase 1: Scale the Graph (Target: 2-3K papers)

### 1.1 Paper Selection
- [ ] Curate 2-3K most-cited papers across core CS domains:
  - ML/DL fundamentals (optimizers, architectures, regularization)
  - NLP (transformers, tokenization, embeddings, fine-tuning)
  - Systems (databases, distributed systems, consensus protocols)
  - Software Engineering (testing, type systems, static analysis, program comprehension)
  - Graph algorithms (GNN, graph databases, network analysis)
  - Security (cryptographic primitives, attack vectors)
- [ ] Source: Semantic Scholar API for top-cited + arxiv category browsing
- [ ] Fetch abstracts via enrich-abstracts.js

### 1.2 Extraction at Scale
- [ ] Run extract-v3.js on all papers (batches of 10, Sonnet subagents)
- [ ] Estimated: ~200 batches, ~5-6 hours of Sonnet compute
- [ ] Post-extraction validation: check for banned relation types, missing conditions
- [ ] Entity deduplication across batches (canonicalize.js v2)

### 1.3 Quality Audit
- [ ] Sample 50 random edges, manually verify accuracy
- [ ] Target: >90% precision on sampled edges
- [ ] Identify systematic extraction errors, adjust prompts if needed

## Phase 2: MCP Server

### 2.1 Core Server
- [ ] TypeScript MCP server (stdio for local, HTTP+SSE for remote)
- [ ] In-memory graph (few MB at 3K papers)
- [ ] Tools:
  - `query_failures(entity)` → all fails_on with conditions
  - `compare(A, B)` → outperforms edges between A and B
  - `find_equivalent(entity)` → equivalent_to edges
  - `check_obsolete(entity)` → superseded_by chain
  - `decide(task, constraints)` → ranked methods matching constraints
  - `explore(entity)` → all edges around a node, DSL notation
  - `search(query)` → fuzzy entity search

### 2.2 Auth & Rate Limiting
- [ ] API key generation (simple UUID → tier mapping)
- [ ] Rate limiter middleware (in-memory, per-key)
- [ ] Tiers:
  - `free`: 5 queries/day, graph subset (top-500 papers)
  - `pro` ($5/mo): 100 queries/day, full graph
  - `team` ($20/mo): unlimited, webhooks for domain updates

### 2.3 Deployment
- [ ] Cloudflare Workers or Fly.io (low latency, cheap)
- [ ] CI/CD: GitHub Actions → deploy on push to `enox-mcp` branch
- [ ] Health check endpoint
- [ ] Usage analytics (anonymous: query counts, popular entities, error rates)

## Phase 3: Publication

### 3.1 MCP Hub
- [ ] Package as npm (for local stdio mode)
- [ ] Publish to MCP Hub with README:
  - What it does (decision support, not citation search)
  - Example queries with real output
  - Comparison table vs Semantic Scholar MCP
  - Pricing tiers
- [ ] Demo video (30s: ask question → get structured answer)

### 3.2 Landing Page
- [ ] enox.dev or similar
- [ ] Interactive graph explorer (optional, nice-to-have)
- [ ] API key signup (Stripe for payments)

### 3.3 Launch
- [ ] Post on HN, Twitter, Reddit r/MachineLearning
- [ ] Share on Claude Code Discord / Anthropic community
- [ ] Reach out to AI coding tool builders

## Phase 4: Verification & Trust

### 4.1 Confidence & Provenance (Already Implemented)
Every edge has:
- `confidence`: 0.1-0.3 (extraction confidence)
- `source_paper`: arxiv ID linking to the paper
- `condition`: when this relation holds
- `note`: brief explanation

### 4.2 User Feedback Mechanism
- [ ] `report_issue(edge_id, reason)` MCP tool — users flag inaccurate edges
- [ ] Reported edges get `status: "disputed"` + reason stored
- [ ] Weekly review queue: disputed edges → manual verification
- [ ] Verified edges get `confidence` bumped to 0.4-0.6 range
- [ ] Refuted edges get `status: "retracted"` (not deleted — provenance preserved)

### 4.3 Verification Pipeline
```
Extracted (0.1-0.3) → Disputed (user report) → Reviewed (human) → Verified (0.4-0.6)
                                                                → Retracted (kept but hidden)
```

- [ ] Dashboard for reviewer: see disputed edges, source paper, user reason
- [ ] Bulk verification: when one edge is verified, check similar edges from same paper
- [ ] Community verification: if 3+ users confirm an edge, auto-promote to verified

### 4.4 Freshness
- [ ] Weekly arxiv scan for new papers in tracked domains
- [ ] Auto-extract from new papers, add as `status: "extracted"` (low confidence)
- [ ] Notify pro/team users when new edges appear in their domains

### 4.5 Trust Signals in API Response
```json
{
  "from": "DistMult",
  "rel": "fails_on",
  "to": "antisymmetric relations",
  "confidence": 0.5,
  "status": "verified",
  "confirmations": 3,
  "source": "arxiv:1606.06357",
  "disputes": 0
}
```

## Phase 5: Federation (Future)

If Enox MCP gains traction, the federated protocol becomes viable:
- Anyone can publish their own Enox-format knowledge graph
- MCP server aggregates multiple sources
- Cross-graph edges (equivalent_to) link domains
- Trust model: source reputation based on verification rate

This is the original Enox vision — "Semantic Web done right" — but we earn it
by proving the format works in a centralized setting first.

## Decision Log

| Date | Decision | Why |
|------|----------|-----|
| 2026-03-14 | 8 relation archetypes, not 14+ | Generic types (applies_to, uses) are noise. Decision-support only. |
| 2026-03-14 | Sonnet for extraction, not Haiku | Haiku 50x variance without fine-tuning. Sonnet stable at 1.2 stddev. |
| 2026-03-14 | RFDB as storage, not SQLite | Dogfooding + Datalog queries for free. Already built. |
| 2026-03-14 | Remote MCP, not local-only | Monetizable. Graph data is centralized asset, not code. |
| 2026-03-14 | Manual verification first | Build trust signal before automating. Community verification at scale. |
