---
id: kb:fact:no-vector-search-in-kb
type: FACT
confidence: high
projections:
  - epistemic
created: 2026-03-06
---

The Knowledge Base has no vector/semantic search capability. `query_knowledge(text=...)` performs case-insensitive substring matching only. Duplicate detection in the validation framework relies on keyword overlap via this text search, not semantic similarity. Full vector search would require embeddings (either in RFDB or an external index) — this is a known limitation, not a current priority.
