# RFD-18: T5.4 Guarantee Integration

## Source
Linear issue RFD-18: https://linear.app/reginaflow/issue/RFD-18/t54-guarantee-integration

## Request
Implement Guarantee Integration (Track 2, Orchestrator Phase D).

Guarantees move to post-enrichment hook with selective checking.

~200 LOC, ~12 tests

### Subtasks
1. Move guarantee checking to post-enrichment hook
2. Selective: check only rules matching changedNodeTypes/changedEdgeTypes
3. Coverage monitoring via content_hash canary (I4)
4. Remove guarantees from VALIDATION phase

### Validation
- Guarantees never fire between analysis and enrichment
- Selective: change FUNCTION → only FUNCTION-related rules checked
- Coverage canary: content changed + analysis unchanged → warning
- All existing guarantee tests pass

### Dependencies
- ← RFD-16 (T5.2: Orchestrator Batch Protocol) — MERGED
- → RFD-19 (T5.5: Enrichment Pipeline Validation) — blocked by this
