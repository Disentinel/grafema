---
name: autonomous-ontological-crawl
description: |
  Autonomous ontological crawler loop that runs continuously, expanding
  the knowledge graph by generating hypotheses via local LLM (Ollama),
  verifying them against the code graph (Grafema MCP), and recording
  confirmed findings. Use when: user says "crawl", "keep going",
  "explore the codebase", or wants continuous knowledge extraction.
---

# Autonomous Ontological Crawl Loop

## Architecture

```
┌──────────────────────────────────────────────┐
│                CLAUDE (orchestrator)           │
│  - Picks next entity from backlog             │
│  - Dispatches to Ollama for hypothesis gen    │
│  - Verifies against Grafema code graph        │
│  - Records in Enox knowledge graph            │
│  - Monitors saturation, adjusts strategy      │
└───────┬──────────┬──────────┬────────────────┘
        │          │          │
        ▼          ▼          ▼
   ┌─────────┐ ┌────────┐ ┌──────────┐
   │ Ollama  │ │Grafema │ │  Enox    │
   │ 35b     │ │MCP     │ │  (RFDB)  │
   │ hypoths │ │verify  │ │  record  │
   └─────────┘ └────────┘ └──────────┘
```

## Loop Protocol

Each iteration processes ONE entity through the full cycle:

### 1. Select Entity
Pop from backlog (ordered by: depth ASC, fan-in DESC).
If backlog empty, discover new entities from code graph edges.

### 2. Generate Hypotheses (Ollama)
```bash
curl -s http://localhost:11434/api/generate -d '{
  "model": "qwen3.6:35b",
  "prompt": "/no_think\n[CONTEXT]\n${entity_description}\n${known_edges}\n\n[TASK]\nGenerate 5 hypotheses:\n- 2x structural (what depends on it, what it depends on)\n- 1x fragility (what could go wrong)\n- 1x conceptual (what CS concept does this implement)\n- 1x unexpected (something surprising about this entity)\n\nFormat: TYPE|HYPOTHESIS|EVIDENCE_NEEDED\nTypes: DEP|FRAGILE|CONCEPT|UNEXPECTED|PATTERN",
  "stream": false,
  "options": {"temperature": 0.7, "num_predict": 4000}
}'
```

### 3. Verify Each Hypothesis (Grafema MCP)
For each hypothesis:
- **DEP**: `find_calls(name=X)` or `get_node(target=Y, detail="neighbors")` in code graph
- **FRAGILE**: check if removal path exists, count dependents
- **CONCEPT**: `recall(query=concept_name)` in knowledge graph
- **PATTERN**: compare with class signatures of similar entities

### 4. Classify
- **Confirmed**: evidence found → `assert` in the knowledge graph
- **Gap**: expected but not found → `assert` as a gap, add to investigation backlog
- **Unexpected**: found something different → high priority, investigate immediately
- **Serendipitous**: new entity discovered → push to backlog

### 5. Record
```
assert(assertions=[
  { from: entity, relation: type, to: target, context: evidence, domain: domain }
])
```

### 6. Meta-check (every 10 entities)
- Saturation: are hypotheses becoming predictable?
- Class signature: do similar entities share edge patterns?
- Convention: edge frequency >80% → candidate convention

## Ollama Usage Notes

- **qwen3.6:35b**: Best for hypothesis generation. Use `/no_think` prefix.
  `num_predict: 4000` minimum (thinking consumes ~1500 tokens).
  ~90 seconds per generation. Quality: excellent, specific.

- **qwen3:4b**: Good for classification/yes-no questions. Fast (~5s).
  `num_predict: 2000` minimum. Use for: "Is X a dependency of Y?"

- **Pattern**: Generate with 35b, classify/validate with 4b.

## Backlog Management

```json
// .grafema/crawl-backlog.json
{
  "queue": [
    {"entity": "compactionEnricher", "source": "enrichment-pipeline", "depth": 2, "status": "inbox"},
    {"entity": "OXC parser", "source": "orchestrator", "depth": 2, "status": "inbox"}
  ],
  "processed": ["rfdb-server", "grafema-orchestrator", ...],
  "stats": {
    "total_processed": 30,
    "confirmed": 45,
    "gaps": 3,
    "unexpected": 2
  }
}
```

## Stopping Conditions

The loop runs until:
- User says stop
- Backlog exhausted AND no new entities discovered in last 5 iterations
- Saturation: last 10 entities all confirmed exactly what was predicted

## Anti-patterns

- Don't generate hypotheses Claude already knows the answer to
- Don't use Ollama for verification (it hallucinates) — verify against code graph only
- Don't record low-confidence hypotheses without evidence
- Don't crawl NPM_SYMBOL/NPM_PACKAGE entities (noise)
