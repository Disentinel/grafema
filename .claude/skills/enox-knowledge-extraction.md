---
name: enox-knowledge-extraction
description: |
  Graph-informed relation extraction pipeline for building Enox knowledge graphs from academic papers.
  Use when: (1) extracting relations from paper abstracts/texts, (2) building knowledge graphs from corpora,
  (3) need to decide extraction strategy based on IE research. Follows ChatIE + EDC + Chinchilla patterns.
trigger: enox extract, knowledge extraction, relation extraction from papers, build knowledge graph from arxiv
---

# Enox Knowledge Extraction Pipeline

## Architecture (Graph-Informed Decisions)

Based on querying the IE research graph, optimal extraction uses 3 phases:

### Phase 1: Extract (Haiku agents, parallel)
- **Pattern**: ChatIE multi-turn (+16.65% vs single-prompt)
- **Model**: Haiku (cheap, parallel) — Chinchilla: more data × weak model > less data × strong model
- **Input**: Full abstracts from arxiv API
- **Output**: Raw triples {entities: [], relations: []}
- **Script**: `enox/extract-relations.js --all`

### Phase 2: Canonicalize (Opus, batch)
- **Pattern**: EDC Define+Canonicalize
- **Tasks**: Entity dedup, schema validation, ID resolution to existing graph
- **Script**: `enox/canonicalize.js`

### Phase 3: Merge
- **Script**: `enox/merge.js` → `enox/cross-links.js`

## Anti-patterns (from graph)
- Single mega-prompt (ChatIE: multi-turn is 16% better)
- Unconstrained generation (GenIE: constrained > unconstrained)
- Trusting LLM NER blindly (Bio IE paper: fine-tuned PLM beats GPT-3 by 15-16% F1 on NER)
- Using only abstracts (DocRED: document-level captures cross-sentence relations)

## Relation Schema

```
implements, extends, outperforms, fails_on, requires,
introduces, supports, refutes, is_based_on, applies_to,
supersedes, surveys, enables, uses, formalizes,
isomorphic_to, sameAs, overlaps_with
```

## Running the Full Pipeline

```bash
cd /Users/vadimr/grafema/enox

# 1. Fetch abstracts from arxiv
node enrich-abstracts.js --all

# 2. Generate extraction prompts
node extract-relations.js --all --size 25

# 3. Launch Haiku agents on each batch (via Claude Code subagents)
# Each reads phase1-prompts-batchN.jsonl, writes phase1-raw-batchN.jsonl

# 4. Canonicalize raw extractions
node canonicalize.js

# 5. Merge into unified graph
node merge.js
node cross-links.js
```

## Key Insight: Graph as Attention Guide

The knowledge graph doesn't give the LLM NEW information — it **structures decision-making**
by activating the right knowledge at the right time. Like an index to a book you've already read.

Evidence from this experiment:
- Without graph: single prompt, Opus for everything, no validation
- With graph: multi-turn, Haiku+Opus split, schema validation, specific anti-patterns to avoid
- The graph turned "I vaguely know IE techniques" into "here are ranked techniques for my exact situation"

## Files

- `enox/schema.md` — Edge/node format spec
- `enox/extract-relations.js` — Phase 1 prompt generation
- `enox/canonicalize.js` — Phase 2 canonicalization
- `enox/merge.js` — Merge + dedup + stats
- `enox/cross-links.js` — Cross-cluster edge generation
- `enox/enrich-abstracts.js` — Fetch abstracts from arxiv API
- `enox/merged/graph.jsonl` — Unified graph
- `enox/merged/abstracts.jsonl` — Full abstracts
- `enox/merged/stats.json` — Graph statistics
