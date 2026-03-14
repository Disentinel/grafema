# Enox $50 Experiment — Schema

## Edge format (one per JSONL line)

```json
{
  "_type": "edge",
  "from": "arxiv:XXXX.XXXXX",
  "rel": "extends",
  "to": "arxiv:YYYY.YYYYY",
  "confidence": 0.25,
  "condition": "sparse graphs only",
  "source": "arxiv:XXXX.XXXXX",
  "extracted": "2026-03-14",
  "status": "extracted",
  "note": "Brief human-readable explanation"
}
```

## Node format (one per JSONL line)

```json
{
  "_type": "node",
  "id": "arxiv:XXXX.XXXXX",
  "node_type": "paper",
  "title": "Paper Title",
  "authors": ["Author1", "Author2"],
  "year": 2024,
  "arxiv_id": "XXXX.XXXXX",
  "doi": "10.XXXX/...",
  "domain": "cs.LG",
  "citations_approx": 1500,
  "abstract_short": "One-line summary"
}
```

Concept nodes:
```json
{
  "_type": "node",
  "id": "enox:concept/graph_neural_network",
  "node_type": "concept",
  "label": "Graph Neural Network",
  "domain": "cs.LG",
  "aliases": ["GNN"]
}
```

## Relation archetypes

| Relation | Domain | What it captures |
|----------|--------|-----------------|
| implements | CS | Paper implements algorithm from another |
| extends | CS | Paper extends/improves upon method |
| outperforms | CS | Method beats another (with conditions) |
| fails_on | CS | Method fails under conditions |
| requires | CS | Method requires technique/assumption |
| introduces | CS | Paper introduces a new concept/method |
| supports | Science | Provides evidence for a claim |
| refutes | Science | Contradicts findings |
| is_based_on | CS | Theoretical foundation |
| applies_to | CS | Method applicable to domain/problem |
| isomorphic_to | Meta | Structural similarity across domains |
| supersedes | CS | Newer method replaces older |
| surveys | CS | Paper reviews a field |
| enables | CS | One technique enables another |
| formalizes | CS/Math | Paper formalizes an informal concept |

## Confidence levels (all LLM-extracted = 0.1-0.3)

- 0.1 = weak inference from general knowledge
- 0.2 = moderate confidence, based on well-known relationships
- 0.3 = high confidence for LLM extraction (e.g., explicit in abstract)
