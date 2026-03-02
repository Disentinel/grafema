# CodeGraph.ru — Competitor Analysis

**Date:** 2026-03-02
**Threat level:** LOW (2/10)
**Website:** https://codegraph.ru
**GitHub:** https://github.com/mkhlsavin/codegraph.ru (only static site, engine is closed-source)
**Contact:** hello@codegraph.ru, Telegram @codegraph_ru
**Category:** AI copilot for code analysis (CPG-based, on-premise enterprise)

## Why This Matters

Russian enterprise-focused code analysis product built on Code Property Graph. Same core technology direction as Grafema (graph-based code understanding for AI), but targeting a completely different market: Russian corporate sector with compliance requirements (152-FZ, GOST).

## What It Is

AI-powered code analysis platform combining CPG with LLM capabilities. Positioned as an on-premise alternative to GitHub Copilot / Sourcegraph Cody for Russian enterprises that cannot send code to the cloud.

Key selling points:
- Code never leaves customer infrastructure
- Russian compliance ready (152-FZ, GOST R 57580)
- Supports Russian LLMs (GigaChat, YandexGPT)
- Security-first: DLP, SIEM, RBAC, audit logging

## How It Works

1. **GoCPG** — Joern CPG engine rewritten in Go from scratch (started late December 2025, ~2 months dev)
2. **Tree-sitter parsers** — all 11 language parsers use Tree-sitter (not custom)
3. **CPG construction** — AST + CFG + PDG + DDG in 33 analytical passes
4. **Storage** — DuckDB (graph), ChromaDB (vector embeddings)
5. **Query pipeline** — ~100 specialized handlers classify NL query → select analysis algorithm → graph query → LLM synthesizes answer
6. **"Hypothesis system"** — claimed main know-how: automated security hypothesis generation and verification against graph

## Architecture

- **Engine:** GoCPG — full rewrite of Joern in Go (not a fork/wrapper)
- **Parser:** Tree-sitter (multi-language)
- **Database:** DuckDB (graph storage) + ChromaDB (vectors)
- **Query language:** SQL/PGQ (not Datalog, not Cypher)
- **AI:** Hybrid RAG (graph + vector, claimed +33.6% F1 vs vector-only)
- **Protocol:** MCP Server (16 tools), Claude Code integration claimed
- **Deployment:** Docker, Kubernetes, on-premise only
- **Built with:** Claude Opus ("Plan & Act" methodology for Joern reverse-engineering and algorithm porting)

## GoCPG vs Joern (from their own Telegram posts)

Key revelations from @codegraph_ru channel:
- **Deliberately sacrificed Joern's deep semantic analysis** via built-in compilers — chose speed over depth
- Current graph completeness: **6-38% gap with Joern** on key node types (C, Python, Go)
- Claimed 200x speedup on some critical stages vs naive implementation
- Taint analysis on diffs: "in testing", not public yet
- **Plan to open-source GoCPG** (announced, no timeline)
- Development methodology: parse same code with Joern & GoCPG → Claude compares graphs → port missing algorithms
- Self-describe as "not Joern replacement but specialized industrial engine"

## Supported Languages

11 languages claimed: C/C++, Java, Python, JavaScript/TypeScript, Go, C#, Kotlin, PHP, 1C:Enterprise

## Claimed Metrics (Unverifiable)

| Metric | Claim |
|--------|-------|
| Accuracy | 95.6% (160-question benchmark) |
| CVE detection | 100% (on 3 targets — tiny sample) |
| False positive reduction | -60% via data flow verification |
| CWE types | 58 |
| CAPEC patterns | 27 |
| Function search speedup | 600x |
| Indexing | 1M LOC ~30 min |
| Query latency | 2-3 ms |
| Tested scale | 5M+ LOC |

**Note:** All metrics are self-reported with no public benchmark. "100% CVE detection" on 3 targets is statistically meaningless.

## Enterprise Features

- **DLP:** 25+ patterns (API keys, passwords, PII, card numbers), 3 modes (block, mask, alert)
- **SIEM:** Syslog RFC 5424, CEF (ArcSight), LEEF (QRadar), SARIF 2.1.0 export
- **RBAC:** 4 roles, 21 permissions
- **Vault:** HashiCorp Vault (Token, AppRole, Kubernetes auth)
- **Compliance:** 152-FZ, GOST R 57580, escrow source code in contracts

## Integrations

**Ready:** GitHub PR review, GitLab MR review, Docker, K8s, Prometheus, Grafana, MCP Server (16 tools), Claude Code, GigaChat, Yandex AI Studio

**Planned (Q2-Q3 2026):** OAuth2/OIDC + LDAP/AD, Jira, Confluence, Jenkins, SonarQube, Slack, Telegram, GitVerse, SourceCraft

## Business Status

- **Source code:** Closed (not available anywhere)
- **Product access:** Demo by request only — no free tier, no Docker image, no npm package
- **Funding:** Pre-Series A, targeting 15-25M RUB in H2 2026
- **Stage:** Pre-product or early enterprise sales
- **Team:** CPO (18y IT), CTO (15y cybersecurity) — small team

## Digital Presence (as of 2026-03-02)

**SEO: effectively zero.**
- `site:codegraph.ru` returns 0 results in Google — site is not indexed
- No search queries lead to codegraph.ru — drowned out by 8+ other "CodeGraph" projects
- Brand name "CodeGraph" is completely diluted globally

**Public channels:**

| Channel | Status |
|---------|--------|
| Telegram (@codegraph_ru) | Exists, **14 subscribers**, 3+ technical blog posts |
| Habr | No articles, no mentions |
| vc.ru | No articles, no mentions |
| YouTube | No videos |
| Twitter/X | Not found |
| LinkedIn | Not found |
| ProductHunt | Not listed |
| MCP directories | Not listed |
| npm / PyPI / crates.io | No packages |
| Conferences | No talks found |
| Third-party mentions | **Zero** — nobody has written about them |

**Website structure:** 6 HTML pages + 72 docs pages (heavy documentation for zero users).
`/.claude/` in robots.txt — likely using Claude to generate content.
Actively maintained (last update: 2026-02-28).

**Assessment:** "Website ready, product absent" stage. Extensive documentation with no audience.

**Telegram content (3 posts analyzed):**
1. "What is CodeGraph?" — positioning as AI copilot for large codebases, SAST + code quality + onboarding
2. "From static analysis to dialogue" — CPG + NL queries, MCP/API integration, "hypothesis system"
3. "Why we rewrote Joern in Go" — reveals GoCPG is a Joern rewrite built with Claude Opus, Tree-sitter parsers, 6-38% graph gap with Joern

Posts are well-written, technically substantive, but read like Claude-generated long-form content. No engagement metrics visible.

## Strengths (vs Grafema)

1. **Multi-language** — 11 languages vs Grafema's JS-only (depth unknown)
2. **Enterprise compliance** — 152-FZ, GOST, DLP, SIEM — complete enterprise checklist
3. **Native Go parser** — likely faster than JS/Babel for raw parsing
4. **Hybrid RAG** — graph + vector search combined (if the +33.6% F1 claim is real, validates approach)
5. **Inter-procedural data flow** — claims cross-function/cross-file data flow analysis
6. **SQL/PGQ queries** — lower learning curve than Datalog for enterprise users
7. **Security focus** — vulnerability detection as primary use case resonates with enterprise buyers

## Weaknesses (vs Grafema)

1. **Closed source, no product to try** — vaporware risk. Zero public validation.
2. **Russian market only** — 152-FZ/GOST focus, GigaChat integration, Russian LLMs. Not a global player.
3. **Unverifiable claims** — "100% CVE detection", "95.6% accuracy" with no public benchmark
4. **No community** — no stars, no forks, no public users, no ecosystem
5. **DuckDB for graph queries** — SQL/PGQ is less expressive than Datalog for complex graph patterns
6. **Pre-revenue stage** — seeking Series A of 15-25M RUB (~$150-250K), very small for a dev tools company
7. **No incremental analysis mentioned** — 30 min for 1M LOC with no clear git-diff-based updates
8. **Enterprise sales cycle** — long sales cycles, proof-of-concepts, compliance audits. Slow growth.

## Head-to-Head Comparison

| Dimension | Grafema | CodeGraph.ru |
|-----------|---------|--------------|
| **Core thesis** | AI queries graph, not code | AI copilot for enterprise code analysis |
| **Source** | Open source | Closed source |
| **Parser** | Babel (JS) | GoCPG (Go, native) |
| **Database** | RFDB (Rust, custom) | DuckDB + ChromaDB |
| **Query language** | Datalog + MCP tools | SQL/PGQ + LLM natural language |
| **AI approach** | MCP tools for AI agents | Hybrid RAG pipeline |
| **Data flow** | Yes (deep) | Claimed (unverified) |
| **Languages** | JS/TS | 11 claimed |
| **MCP server** | Yes (25+ tools) | Yes (16 tools claimed) |
| **Security analysis** | Not primary focus | Primary selling point |
| **DLP/SIEM/RBAC** | No | Yes |
| **Setup** | npm install + Rust binary | Demo by request |
| **Traction** | Growing OSS community | Zero public users |
| **Target market** | Global, dev-tools | Russia, enterprise |
| **Target codebases** | Massive legacy, untyped | Enterprise (any language) |
| **Pricing** | Free/open source | Enterprise licensing |

## Threat Assessment: LOW (2/10)

### Why It's Not a Threat Now

1. **No product in the wild.** Closed source, demo only. Cannot be tried, tested, or compared. Until there's a product to use, it's a pitch deck.
2. **Different market entirely.** Russian enterprise compliance is their core value prop. Grafema targets global developers and AI agents.
3. **No community or ecosystem.** Zero stars, zero forks, zero public users. No network effects.
4. **Tiny funding.** 15-25M RUB Series A target is ~$150-250K — barely enough for 2-3 developers for a year.

### Why Worth Monitoring

1. **Validates the market.** Another team independently arriving at "CPG + AI" confirms the category is real.
2. **Hybrid RAG approach.** If their graph+vector search truly improves F1 by 33%, this architectural insight is valuable for Grafema's roadmap.
3. **Enterprise feature checklist.** Their DLP/SIEM/RBAC/compliance features are a useful reference if Grafema ever targets enterprise.
4. **MCP + Claude Code claim.** They list Claude Code integration — worth checking if real (likely just documentation, not actual integration).
5. **Could get acquired.** Russian enterprise tools with compliance features could be attractive acquisition target for Yandex/Sber/VK, which could accelerate their development.

## What We Can Learn

1. **SQL/PGQ as alternative query interface** — consider exposing a SQL-like query layer alongside Datalog for lower barrier to entry
2. **Hybrid RAG (graph + vector)** — combining graph queries with vector similarity search is a promising direction
3. **Enterprise compliance as product feature** — DLP, SIEM, RBAC, audit trails are table stakes for enterprise
4. **Security analysis as use case** — data flow analysis → vulnerability detection is a natural extension of Grafema's capabilities
5. **Go-based native parser** — performance comparison point; Grafema's Babel parser may be slower but provides richer AST access

## Monitoring Cadence

**Quarterly check** — not high priority. Check for:
- [ ] Product launch / public release
- [ ] GitHub activity (new repos, open-source components)
- [ ] Funding announcements
- [ ] Customer testimonials or case studies
- [ ] MCP server actual availability
- [ ] Conference talks or technical blog posts

## Sources

- https://codegraph.ru
- https://codegraph.ru/cpg.html
- https://codegraph.ru/security.html
- https://codegraph.ru/docs/ru/
- https://github.com/mkhlsavin/codegraph.ru
