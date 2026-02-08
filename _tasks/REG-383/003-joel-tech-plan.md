# Joel Tech Plan — REG-383

## Goal
Add explicit guidance in the plugin development guide about analysis plugin execution frequency (per module/indexing unit) and idempotency patterns to prevent duplicate nodes/edges.

## Scope
Docs only. No API or runtime changes.

## Steps
1. Open `docs/plugin-development.md` and find the “Plugin Order” section (around the registration/configuration area).
2. Add a new subsection: **Execution Model & Idempotency**.
3. Document execution semantics:
   - ANALYSIS plugins can be executed per module/indexing unit (not necessarily once per project).
   - Consequence: global logic can run multiple times.
4. Add recommended patterns:
   - Deterministic IDs for nodes/edges (based on file/module + semantic identity).
   - Run-once guard for truly global logic inside the plugin instance.
   - Prefer file-scoped processing; avoid accumulating global state across modules unless keyed.
   - When aggregating, check for existing nodes/edges before creating duplicates.
5. Verify that wording doesn’t promise specific call counts; keep it clear and cautious.

## Complexity (Big-O)
Documentation edits only. Operational complexity is O(1).

## Tests
None (docs-only).

## Deliverable
Updated `docs/plugin-development.md` with the new section and examples/patterns.
