# Grafema Marketing Plan — Competitive Response

**Date:** 2026-02-16
**Context:** CodeGraphContext (CGC) growing fast (735 stars), same thesis as Grafema. Need to capture the "code graph for AI" audience before CGC locks in mindshare.
**Linear issues:** REG-465 through REG-470

## Core Positioning

**"Deep vs Shallow"** — one contrast that drives all messaging:

> **Call graph (CGC):** "processQuery calls executeSQL"
> **Grafema:** "req.body.userId → processQuery(userId) → buildFilter(userId) → executeSQL('SELECT * WHERE id=' + userId)" — full taint path through 4 files

This is NOT hate-marketing. It's explaining what's NEW through contrast with what's UNDERSTOOD.

## Channel Strategy (Prioritized)

### Tier 1: MCP Directories (REG-465) — DO FIRST

Zero-effort, permanent traffic. CGC is already listed — Grafema must be next to it.

| Directory | How | Impact |
|-----------|-----|--------|
| mcpservers.org | mcpservers.org/submit | Main MCP directory |
| punkpeye/awesome-mcp-servers | GitHub PR | ~40k stars |
| wong2/awesome-mcp-servers | Via mcpservers.org/submit | ~30k stars |
| appcypher/awesome-mcp-servers | GitHub PR | ~10k stars |
| pulsemcp.com | Submit form | MCP directory |
| modelcontextprotocol/servers | GitHub PR (Anthropic official) | Most authoritative |

**Prerequisites:** Polished README with GIF demo, reliable npm install, MCP server works out of the box.

### Tier 2: Side-by-Side Demo (REG-466) — BLOCKS EVERYTHING ELSE

The demo is the foundation for all marketing. Without it, other channels won't convert.

**Deliverables:**
1. GIF/video (30-60 sec) — split screen query comparison
2. Screenshot set — for Reddit/Twitter
3. Sample codebase — realistic, open source, reproducible
4. Narrative — 3-4 sentences explaining WHY depth matters

**Format:** Same question asked to both tools: "How does user input reach the database?"

**Rules:** Must be honest — don't cherry-pick failures, show partial vs full answers.

### Tier 3: Reddit (REG-467) — WARMEST AUDIENCE

Target subreddits ordered by priority:

| Subreddit | ~Members | Angle |
|-----------|----------|-------|
| r/ClaudeAI | 200k | "MCP server that gives Claude deep code understanding beyond call graphs" |
| r/cursor | 100k | "Your AI sees data flow, not just function names" |
| r/programming | 6M+ | "Show: semantic code graph that traces data flow through untyped codebases" |
| r/javascript | 2M+ | "Understanding legacy JS without types — data flow tracing" |
| r/LocalLLaMA | 500k | "MCP server that gives any LLM deep code context" |
| r/ChatGPTCoding | 200k | Angle TBD |

**Post format:** NOT "check out my tool". Demo with wow-effect. Show problem → existing tool answer → Grafema answer. Let contrast sell itself.

**Timing:** Tuesday-Thursday, space posts 3-5 days apart. Start with r/ClaudeAI.

**CGC on Reddit:** As of Feb 2026, no Reddit posts found about CGC. This is an opportunity — be first in the niche.

### Tier 4: Hacker News (REG-468) — ONE SHOT

**Title options:**
- "Show HN: I built a semantic code graph that traces data flow through untyped codebases"
- "Show HN: Call graphs show A calls B. Grafema shows what data flows between them"

**Mechanics:**
- Tuesday-Thursday, 9-11am ET
- README must be flawless with GIF
- `npm install` must work first try
- First comment = founder motivation + technical approach
- Be available 6-8 hours for comments
- Have 2-3 people ready for early engagement

**Pre-launch checklist:**
- [ ] Polished README with GIF
- [ ] One-command install works
- [ ] Demo codebase ready
- [ ] FAQ prepared ("why not TypeScript?", "how different from CGC?", "does it scale?")
- [ ] Blog post / landing page ready

### Tier 5: Article Outreach (REG-469)

Pitch to authors of existing "Best MCP servers" articles where CGC is featured:

| Article | Site |
|---------|------|
| 10 Best MCP Servers for coding in 2026 | Jotform |
| The Best MCP Servers for Developers | Builder.io |
| Top 10 MCPs for AI Workflows | Decodo |
| Top 20 MCP Tools | BrowserAct |
| Top 10 MCP Servers 2026 | dasroot.net |

**Template:** "Hi [name], your article covers CodeGraphContext for code analysis. I built Grafema — goes deeper with data flow, scope resolution, value tracing. Would you include it in your next update? Happy to provide comparison/demo."

### Tier 6: Content Marketing (REG-470)

**Blog post:** "Call graphs lie: why your AI needs data flow"

Outline:
1. Problem: AI reads code like grep
2. Partial solution: call graphs (CGC etc.)
3. What's missing: data flow, value tracing, scope resolution
4. Grafema's approach: semantic graph
5. Demo: same codebase, different depth
6. Honest: when call graphs are enough
7. When you need depth: legacy, security, untyped

**Publish:** dev.to (SEO) + own blog. Cross-post Medium optional.

**Tone:** Educational, not pitch. Technical but accessible.

## Execution Order

```
Week 1: REG-465 (MCP directories) + REG-466 (demo prep)
         ↓ demo ready
Week 2: REG-467 (Reddit: r/ClaudeAI, r/cursor)
Week 3: REG-470 (blog post) + REG-467 (Reddit: r/programming, r/javascript)
Week 4: REG-468 (Show HN) — when all materials polished
Ongoing: REG-469 (article outreach)
```

## Dependencies

```
REG-465 (directories)  ──→ standalone, do immediately
REG-466 (demo)         ──→ BLOCKS: REG-467, REG-468, REG-469, REG-470
REG-467 (Reddit)       ──→ needs REG-466
REG-468 (Show HN)      ──→ needs REG-466 + REG-470 ideally
REG-469 (outreach)     ──→ needs REG-466
REG-470 (blog post)    ──→ needs REG-466
```

## Success Metrics

| Metric | Target (3 months) |
|--------|-------------------|
| GitHub stars | 500+ |
| npm weekly installs | 200+ |
| MCP server activations | 100+ |
| Reddit post upvotes | 100+ on best post |
| HN points | 50+ |
| Listed in MCP directories | All 6 |
| "Best MCP servers" articles | 2+ include Grafema |

## Key Principles

1. **Depth is the moat.** Don't compete on language count. Win by being 10x deeper on JS/TS.
2. **Demo sells, words don't.** Every channel needs visual proof, not claims.
3. **Be honest.** Acknowledge when call graphs are enough. Credibility > hype.
4. **Reduce friction.** `pip install` (CGC) vs Rust binary build (Grafema) is a real barrier. Fix before launch.
5. **Timing matters.** CGC hasn't hit Reddit or HN yet. First-mover advantage is available NOW.
