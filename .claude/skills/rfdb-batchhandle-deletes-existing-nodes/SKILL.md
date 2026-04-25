---
name: rfdb-batchhandle-deletes-existing-nodes
description: |
  Fix nodes silently disappearing from RFDB when an enricher or post-resolution
  pass writes new nodes via BatchHandle. Use when: (1) writing a TypeScript
  enricher that should ADD nodes/edges to existing files, (2) after calling
  `client.createBatch()` + `batch.addNode({file: 'X', ...})` + `batch.commit()`
  the original nodes in file X have vanished, (3) tests that load a graph
  fixture, run an enricher, then query original nodes get empty results,
  (4) a verification step shows expected nodes pre-enrichment but 0 post-enrichment.
  Root cause: `BatchHandle.commit()` invokes RFDB's `commit_batch` which
  AUTO-POPULATES `changed_files` from each added node's `file` field, then
  the server DELETES all existing nodes whose `file` matches before inserting
  new ones — file-level upsert semantics. This is correct for the JS/Haskell
  analyzers (which fully re-emit a file's contents) but catastrophic for
  enrichers that only ADD to existing files.
author: Claude Code
version: 1.0.0
date: 2026-04-25
---

# RFDB BatchHandle deletes existing nodes in changed files

## Problem

`BatchHandle.commit()` is not append-only. It performs file-level upsert:
the set of `changed_files` is automatically populated from the `file` field
of every node added in the batch, and the server deletes ALL existing nodes
in those files before inserting the new batch.

This is correct semantics for the per-file analyzer pipeline (Haskell JS
analyzer re-emits a whole file's nodes when re-analyzing), but it's a trap
for enrichers that ADD nodes to existing files (the typical pattern for
post-resolution enrichment such as `libraryCallbackEnricher.ts`).

## Context / Trigger Conditions

- Writing a TypeScript enricher that runs post-resolution (after main analysis).
- Enricher creates new domain nodes (e.g., `cli:command`, `mcp:tool`, `http:route`)
  with `file: <some existing source file>` so they're discoverable via
  `find_nodes(file: X)`.
- Uses `client.createBatch()` → `batch.addNode(...)` → `batch.addEdge(...)` → `batch.commit()`.
- After `commit()`: original CALL/FUNCTION/MODULE nodes in those files have disappeared.
- Tests show pre-enrichment query returns N nodes; post-enrichment returns just the new domain nodes.

## Solution

Use direct `client.addNodes(...)` and `client.addEdges(...)` calls instead of
`BatchHandle`. These bypass the `changed_files` auto-population and don't
trigger file-level deletion.

```typescript
// ❌ WRONG — wipes existing nodes in the file
const batch = await client.createBatch();
batch.addNode({ id, type: 'cli:command', name, file: existingFile, ... });
batch.addEdge({ src: callId, dst: id, type: 'EXPOSES' });
batch.addEdge({ src: id, dst: handlerId, type: 'HANDLES' });
await batch.commit();   // ← DELETES original nodes in `existingFile`!

// ✅ RIGHT — append-only writes
await client.addNodes([
  { id, type: 'cli:command', name, file: existingFile, /* ... */ }
]);
await client.addEdges([
  { src: callId, dst: id, type: 'EXPOSES' },
  { src: id, dst: handlerId, type: 'HANDLES' }
]);
```

Trade-off: `BatchHandle` is more efficient (single round-trip) and atomic.
The direct calls are safer for additive writes but split into multiple round-trips.
For enrichers, correctness wins.

## Verification

Write a regression test that:

1. Creates a fixture graph with existing FUNCTION nodes in file `X`.
2. Runs the enricher (which adds new domain nodes also tagged `file: X`).
3. Asserts the original FUNCTION nodes still exist after enrichment.

Without the fix, this test fails with original count → 0 post-commit.

## Example

From `packages/util/src/enrichers/libraryCallbackEnricher.ts` — the enricher
appends `cli:command`/`mcp:tool` nodes to source files that already contain
CALL nodes for the framework registration. Using BatchHandle.commit() during
initial implementation wiped out the original CALL nodes that the enricher
itself had just queried (they were referenced by `EXPOSES`/`HANDLES` edges,
which then dangled).

## Notes

- This is distinct from `rfdb-stale-node-cleanup` (where cleanup is INCOMPLETE
  due to L1/index desync); here cleanup is COMPLETE and that's the problem.
- The Haskell analyzer pipeline is unaffected because each per-file analyzer
  emits the WHOLE file's nodes — file-level upsert is desirable there.
- The convention `addNodes`/`addEdges` direct API exists for exactly this
  enricher use case. Search for it in the RFDBClient interface.
- If you must use BatchHandle for atomicity, an alternative is to give
  enricher-emitted nodes a SYNTHETIC file path (e.g., `__features/<name>`)
  that doesn't collide with any source file. Mirrors how METRIC nodes use
  `__grafema_perf/{phase}`.

## References

- Discovery context: `_ai/research/cognitive-debt-and-feature-detection.md` Phase 4 enrichment pipeline
- Implementation: `packages/util/src/enrichers/libraryCallbackEnricher.ts`
- Server side: `commit_batch` handler in `packages/rfdb-server/src/`
