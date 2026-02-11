# Steve Jobs Review: REG-409 Duplicate Edges

## Verdict: REJECT

This plan treats the symptom, not the disease. We're adding 80-120 bytes per edge to work around a design flaw that shouldn't exist in the first place.

## The Real Problem

The fundamental issue is that `add_edges()` is being called with the same data multiple times. We're fixing this at the storage layer by adding a HashSet cache, when we should be asking: **Why is the caller sending us duplicate edges?**

Look at the root cause from Don's analysis:

> **Scenario A: Re-analysis without `--clear`**
> 1. First `grafema analyze` creates edges, flush writes them to segment
> 2. Second `grafema analyze` (without `--clear`) re-creates the same edges as delta

This is backwards. The CLI should not be calling analyze twice on the same data without clearing. If `--clear` is required for correctness, then **it should be the default**, or analysis should be idempotent by design.

And yet the plan says:
> The CLI defaults to `forceAnalysis: false`

So we KNOW the CLI has the wrong default, and instead of fixing that 1-line config change, we're adding ~60-80 lines of deduplication machinery to the database layer.

## Specific Concerns

### 1. Vision Alignment: FAIL

"AI should query the graph, not read code."

This bug makes the graph lie about call counts. That's a product-killing issue. But the fix doesn't address why the graph is getting bad data in the first place. We're putting a filter on polluted water instead of stopping the pollution.

### 2. Root Cause: FAIL

The plan acknowledges the CLI's wrong default but doesn't fix it. From Joel's plan:

> Scenario A: Re-analysis without `--clear` (most likely for host vs Docker diff)

If Scenario A is "most likely," then the CLI is misconfigured. **Change the default.** One line:

```typescript
forceAnalysis: options.clear ?? true,  // Default to clear unless --no-clear
```

Then RFDB doesn't need a HashSet at all.

### 3. Complexity: PARTIAL PASS

The operations are O(1) per edge, which is good. But we're adding a permanent memory tax:

> **For Grafema's scale:**
> - ~12,000 edges (current): ~1.4 MB
> - ~100,000 edges (large): ~12 MB
> - ~1,000,000 edges (massive): ~120 MB

120 MB just for deduplication on a million-edge graph. That's not free.

### 4. Architecture: FAIL

The plan adds `edge_keys: HashSet<(u128, u128, String)>` as a permanent field. This is a cache that duplicates information already in the graph (segment + delta). Caches that must be kept in sync are complexity magnets.

From Joel's plan:

> Must ensure the HashSet is kept in sync across all code paths (add, delete, clear, open, flush rebuild).

10 separate code changes to maintain one HashSet. And if we miss one path, we get silent corruption (edge_keys says edge exists, but it doesn't, or vice versa).

### 5. Edge Cases: PARTIAL PASS

The plan covers add, delete, flush, clear, open, delete_version. But what about error paths?

- What if `flush()` fails halfway through writing the segment? Does `edge_keys` get rolled back?
- What if `open()` finds a corrupted segment? Does `edge_keys` reflect the pre-corruption state or the post-corruption state?

The plan doesn't mention rollback or error recovery.

### 6. Tests: PASS

7 tests, covering:
- Same-session dedup
- Flush dedup
- Reopen dedup
- Different edge types
- Delete-readd
- Clear reset
- `get_outgoing_edges` regression

This is thorough. If we were fixing the right problem, this would be excellent.

### 7. No Shortcuts: FAIL

The entire plan IS a shortcut. We're adding complexity to RFDB to avoid fixing a 1-line bug in the CLI.

### 8. Scope: FAIL (Over-engineered)

Joel says:
> ~60-80 lines of production code changes, ~120 lines of tests. All in one file.

For a problem that could be solved by changing a default from `false` to `true` in `analyze.ts`.

## The Right Fix

### Phase 1: Fix the CLI (1 line)

Change `packages/cli/src/commands/analyze.ts` line 354:

```typescript
// BEFORE:
forceAnalysis: options.clear || false,

// AFTER:
forceAnalysis: options.clear ?? true,
```

Make `--clear` the default. Add a `--no-clear` flag if users want incremental analysis (but why would they? The graph is append-only per version, not incremental).

### Phase 2: Make RFDB defensive (if still needed)

If after CLI fix we STILL see duplicates, THEN add deduplication to RFDB. But do it at the right layer:

**Option 1 (minimal):** Deduplicate in `flush()` only. No `edge_keys` field, just a HashMap during flush (like the plan already does). This prevents duplicates on disk without the memory cost.

**Option 2 (principled):** Make edges a proper set abstraction. Change `delta_edges: Vec<EdgeRecord>` to `delta_edges: HashMap<(u128, u128, String), EdgeRecord>`. This makes deduplication inherent to the data structure, not bolted on.

### Phase 3: Understand why Docker vs host differs

Don's analysis says:
> - **Docker**: Fresh container, fresh graph, single analysis run -> ~12718 edges (correct)
> - **Host**: Persistent graph from previous runs. If `grafema analyze` was run multiple times without `--clear`, edges accumulate -> ~19421 edges

This confirms the CLI is the problem. Docker works because it starts fresh. Host fails because the graph persists.

But here's the question nobody asked: **Why was `grafema analyze` run multiple times on host?**

- Was it a user mistake?
- Is there a script that runs analyze in a loop?
- Does `analyze` fail partway through and get retried?

If it's (1), fix the CLI default. If it's (2) or (3), we have a bigger problem than duplicates.

## Why This Matters

Grafema's thesis is "AI should query the graph, not read code." If the graph has 2x the edges it should, every query is polluted:

- "How many callers does this function have?" → Wrong answer
- "What's the call graph depth?" → Wrong answer
- "Find unused functions" → Wrong answer (false negatives)

This isn't a nice-to-have. This is existential.

And we're "fixing" it by adding a cache to the storage layer instead of stopping the pollution at the source.

## What I'd Ship

**Not this.** I'd ship a 1-line CLI change and a test that verifies running `grafema analyze` twice produces the same edge count as running it once.

If that STILL fails, then we investigate why RFDB is storing duplicates despite correct caller behavior. But we don't add a HashSet until we understand why the simple fix didn't work.

## Questions for the Team

1. Can you run `grafema analyze` twice on preact (without `--clear` between runs) and confirm edge count doubles?
2. If so, why is `forceAnalysis: false` the default?
3. Have you tested changing that default to `true`? Does it fix the issue?
4. If it does, why are we adding 80-120 bytes per edge to RFDB?

## Final Stance

**REJECT.** Fix the CLI first. If that's not sufficient, come back with data showing why RFDB needs the HashSet.

Don't build a sewage treatment plant when you can turn off the sewage pump.

---

**Date:** 2026-02-11
**Reviewer:** Steve Jobs
**Status:** REJECTED - Fix CLI default before adding RFDB complexity
