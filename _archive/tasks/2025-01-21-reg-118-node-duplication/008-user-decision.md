# User Decision: REG-118 Approach

**Date:** 2025-01-22

## Decision

1. **Versioning postponed** — until Pro/Enterprise phase (ImpactAnalysis by diff)
2. **Current scope:** Single point in time, no version tracking
3. **Solution:** Clear-and-Rebuild

## Rationale

Based on analysis from:
- Steve Jobs (003): UPSERT alone doesn't handle deletions
- Linus Torvalds (004): Clear-and-Rebuild is simple and obviously correct
- Altshuller TRIZ (005): Identified contradiction, both UPSERT and Clear viable
- Don Melton (006): Layered versioning is premature, fix REG-118 first
- Robert Tarjan (007): Clear-and-Rebuild for single-version, bitemporal for future

## Acceptance Criteria (updated)

- [ ] Running `grafema analyze` twice produces identical graph state
- [ ] Before analyzing file F: delete all nodes with `file = F`
- [ ] Cascading delete: remove edges involving deleted nodes
- [ ] Tests verify no duplication on re-analysis
- [ ] NO versioning, NO UPSERT — simple clear + insert

## Out of Scope

- Version tracking (main vs __local)
- IncrementalAnalysisPlugin changes
- Diff between versions
- UPSERT logic in RFDB
