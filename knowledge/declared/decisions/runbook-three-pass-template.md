---
id: kb:decision:runbook-three-pass-template
type: DECISION
status: active
projections:
  - epistemic
relates_to:
  - _ai/runbooks/README.md
created: 2026-03-06
---

Every knowledge extraction runbook follows a mandatory 3-pass structure:

1. **Pass 1: Entity Extraction** — identify and create KB nodes (DECISION, FACT, SESSION, etc.) with semantic IDs
2. **Pass 2: Relationship Extraction** — create edges between entities in edges.yaml
3. **Pass 3: Cross-Reference Validation** — validate IDs, check collisions, resolve code refs, detect duplicates

This structure ensures completeness (pass 1 forces enumeration), consistency (pass 2 standardizes relationships), and correctness (pass 3 catches errors). The 3-pass approach was validated by the POC extraction of the 2026-03-06 session where a single-pass approach missed 6 tickets and used unstable file-path IDs.

Rejected alternatives:
- Single-pass extraction: incomplete (POC proved this — missed tickets, used wrong ID format)
- 2-pass (extract + validate): misses relationship extraction as a distinct concern
