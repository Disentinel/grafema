## User Request: REG-462

**Title:** Review & split Orchestrator.ts (1,248 lines)

**Goal:** Uncle Bob review of Orchestrator.ts (1,248 lines, 2.5x over limit). Split if clear boundaries exist.

**Scope:**
- File-level review: identify responsibilities
- Method-level review: identify candidates for extraction
- Decision: split or defer (if risk > benefit)

**Acceptance Criteria:**
- File < 500 lines, OR documented reason to defer
- All tests pass
