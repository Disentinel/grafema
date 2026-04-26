# REG-489: Plan Revision (Dijkstra Gaps)

Don's original plan (003-don-plan.md) is correct and complete except for two gaps
identified by Dijkstra's rejection. This document covers only the additional changes
required. Everything else in the original plan stands.

---

## Gap 1: PhaseRunner Must Pass `protectedTypes` for ANALYSIS Phase

### Problem

`PhaseRunner.runPluginWithBatch` (PhaseRunner.ts line 98) wraps every plugin that
does NOT have `managesBatch: true`. All ANALYSIS plugins except JSASTAnalyzer fall
into this path. Their `commitBatch` call:

```typescript
// PhaseRunner.ts line 98 — current
const delta = await graph.commitBatch(tags, deferIndex);
```

...has no `protectedTypes`, so any one of ExpressAnalyzer, FetchAnalyzer,
ServiceLayerAnalyzer, SocketAnalyzer, etc. will re-trigger MODULE deletion after
JSASTAnalyzer has already preserved them. JSASTAnalyzer runs first (all others
depend on it), so the fix unravels on the very next plugin.

### Additional Change Required

`PhaseRunner.runPluginWithBatch` must pass `protectedTypes: ['MODULE']` when the
current phase is ANALYSIS:

```typescript
// PhaseRunner.ts line 98 — after revision
const protectedTypes = phaseName === 'ANALYSIS' ? ['MODULE'] : undefined;
const delta = await graph.commitBatch(tags, deferIndex, protectedTypes);
```

The guard on `phaseName` ensures:
- INDEXING commits: no protectedTypes (correct — INDEXING IS the authoritative write)
- ENRICHMENT commits: no protectedTypes (enrichers use `file_context`, different path)
- VALIDATION commits: no protectedTypes (ISSUE nodes, no file-overlap concern)
- ANALYSIS commits via PhaseRunner: `['MODULE']` (matches JSASTAnalyzer's own calls)

This is a one-line change at the `commitBatch` call site inside
`runPluginWithBatch`. No new parameters, no interface changes to `PhaseRunner` or
`PhaseRunnerDeps`.

---

## Gap 2: Second `commitBatch` Signature in `rfdb.ts`

### Problem

Don's plan identified and updated one interface location:

- `packages/types/src/plugins.ts` line 326 — `GraphBackend.commitBatch`

There is a second, separate `commitBatch` signature that was missed:

- `packages/types/src/rfdb.ts` line 505 — part of the `IRFDBClient` interface

Current:
```typescript
commitBatch(tags?: string[]): Promise<CommitDelta>;
```

This signature is already missing the `deferIndex` parameter that the implementation
has. Adding `protectedTypes` here is required or the TypeScript compiler will reject
the updated `client.ts` implementation as not satisfying this interface.

### Additional Change Required

Update `packages/types/src/rfdb.ts` line 505 to match the full signature:

```typescript
commitBatch(tags?: string[], deferIndex?: boolean, protectedTypes?: string[]): Promise<CommitDelta>;
```

This brings `IRFDBClient.commitBatch` in sync with both `GraphBackend.commitBatch`
(plugins.ts) and the `RFDBClient.commitBatch` implementation (client.ts).

---

## Revised Implementation Order

Insert these two changes into Don's Step 2–4 sequence:

1. Rust server change (Step 1) — unchanged
2. Build rfdb-server — unchanged
3. TypeScript client change (Step 2) — unchanged
4. **Update `packages/types/src/rfdb.ts` line 505** (Gap 2 — was missed in Step 4)
5. Update `packages/types/src/plugins.ts` line 326 (Step 4, as planned)
6. JSASTAnalyzer change (Step 3) — unchanged
7. **Update `PhaseRunner.runPluginWithBatch` line 98** (Gap 1 — one-line addition)
8. Tests (Step 5) — unchanged

---

## No Other Changes

The original plan's "What We Are NOT Doing" section is correct except for the
now-incorrect statement:

> Not adding protectedTypes to PhaseRunner's generic `runPluginWithBatch` —
> unnecessary, JSASTAnalyzer manages its own batch

This line should be removed. PhaseRunner DOES need the one-line change above.
All other exclusions in the original plan remain valid.
