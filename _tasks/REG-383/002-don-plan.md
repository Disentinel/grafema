# Don Plan — REG-383

## Summary
The issue is documentation-only: the plugin development guide does not explain that ANALYSIS plugins can run per indexing unit (module/service slice), which makes it easy to create duplicate nodes/edges when plugins assume a single global pass. We should add an explicit execution model section and provide concrete idempotency patterns aligned with Grafema’s graph-first philosophy.

## Prior Art (WebSearch)
- Babel plugin system runs per file; there is no global “all files done” hook. This is a strong analogy for per-file/per-module execution in AST-driven tooling. See Stack Overflow discussion. citeturn1search0
- ESLint rule implementations can run per file and may be re-run on the same file after autofix, which reinforces the need for idempotent rule logic. citeturn1search4

## Proposed Doc Changes
Update `docs/plugin-development.md` to include a short “Execution Model & Idempotency” section near “Plugin Order” or “Plugin Structure”:
- State that ANALYSIS plugins may execute per module/indexing unit, not necessarily once per project.
- Explain consequences: duplicates if plugin assumes global run.
- Provide recommended patterns:
  - Use deterministic IDs for nodes/edges (stable keys based on file + semantic identity).
  - Guard global logic with a run-once flag inside the plugin instance when appropriate.
  - Prefer file-scoped processing (operate on the current module) rather than global scans.
  - If global aggregation is required, store/merge by stable keys and check for existing nodes/edges before creating.

## Files
- `docs/plugin-development.md`

## Risks
Low risk. Documentation change only. Primary risk is inaccurate description of execution model; we should align wording with known behavior from REG-383 context and avoid overpromising exact call counts.

## Decision
Proceed with a docs update only; no product or API changes.
