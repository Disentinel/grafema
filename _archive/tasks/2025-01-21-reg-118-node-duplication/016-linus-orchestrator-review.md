# Linus Review: Orchestrator-Level Clear Plan

## Verdict: APPROVED WITH MINOR CONCERNS

---

## What's Good

### 1. We Actually Learned from the Mistake

Previous approach was stupid. You tried to clear at GraphBuilder level (ANALYSIS phase) but MODULE nodes are created in INDEXING phase. That's like trying to clean the kitchen after the food is already burnt.

The new "Clear on First Touch" pattern is the RIGHT level of abstraction. First one to touch a file clears it. Doesn't matter which phase. That's correct.

### 2. The Pattern is Sound

The `touchedFiles: Set<string>` passed through context is clean, not hacky. It's:
- Simple state (just a Set)
- Passed explicitly (no magic globals)
- Works across phases (same Set continues from INDEXING to ANALYSIS)

The sync check + add before async clear is correct for preventing race conditions in Promise.all batches. JavaScript is single-threaded for sync operations - by the time you hit `await`, other calls already see the file is touched.

### 3. Single Responsibility

`FileNodeManager.ts` with two functions:
- `clearFileNodesIfNeeded` - file-level clearing
- `clearServiceNodeIfExists` - service-level clearing

Clean separation. No god objects.

### 4. Edge Cases Covered

- EXTERNAL_MODULE (no file property) - won't match queryNodes, stays as singleton
- SERVICE nodes (file=directory) - handled explicitly in Orchestrator
- Concurrent batch processing - addressed with sync check before async clear
- Backend without deleteNode - graceful degradation

---

## What's Wrong / Concerns

### 1. Console Logging in Library Code

```typescript
console.log(`[FileNodeManager] Cleared ${nodesToDelete.length} nodes for ${fileName}`);
console.warn(`[FileNodeManager] Failed to delete ${id}:`, (err as Error).message);
```

This is fine for now, but eventually should use a proper logger that can be silenced. Not blocking.

### 2. JSModuleIndexer Change is Invasive

Joel's spec says to add this inside the DFS loop:

```typescript
const touchedFiles = (context as { touchedFiles?: Set<string> }).touchedFiles;
if (touchedFiles) {
  await clearFileNodesIfNeeded(graph, currentFile, touchedFiles);
}
```

Two problems:

**Problem A:** You're casting `context as { touchedFiles?: Set<string> }` because JSModuleIndexer's context type doesn't have touchedFiles. This is a type system smell.

**Fix:** Either:
1. JSModuleIndexer should declare it expects `touchedFiles` in its context type
2. Or use the PluginContext interface which now has it

**Problem B:** You're calling `clearFileNodesIfNeeded` inside the DFS loop for EVERY file. That's correct, but you're checking `if (touchedFiles)` on every iteration. Minor, but the check should be outside the loop.

**Fix:** Move the check outside:
```typescript
const touchedFiles = (context as PluginContext).touchedFiles;
// ... in the loop:
if (touchedFiles) {
  await clearFileNodesIfNeeded(graph, currentFile, touchedFiles);
}
```

Actually, that's the same. Never mind. The check is O(1), it's fine.

### 3. What About Multiple Services Sharing a File?

Service A imports `shared/utils.js`
Service B imports `shared/utils.js`

Both are in the same batch. Both will try to clear `shared/utils.js`.

The code handles this via `touchedFiles.has(file)` check. First one clears, second sees it's touched. Good.

But wait - what if they're in DIFFERENT batches?

```
Batch 1: [Service A]  - clears shared/utils.js, creates nodes
Batch 2: [Service B]  - sees shared/utils.js is touched, skips clearing
```

But `touchedFiles` is created once per `run()` call and passed to ALL batches. So this works correctly. Good.

### 4. RustAnalyzer Not in Joel's Spec

Don mentioned RustAnalyzer needs the same pattern. Joel's spec doesn't include it.

**Fix:** Either:
1. Add RustAnalyzer to the spec
2. Or document it as a follow-up task

This isn't blocking for REG-118 (which is about JS/TS), but it's a gap.

### 5. deleteNode Error Handling

```typescript
try {
  await graph.deleteNode(id);
} catch (err) {
  console.warn(`[FileNodeManager] Failed to delete ${id}:`, (err as Error).message);
}
```

What if the backend throws because the node was already deleted by a concurrent operation? The warning is fine, but we should probably check the error type.

Actually, the comment says "node might already be deleted by concurrent operation" - that's the right understanding. The warning is appropriate. Not blocking.

---

## Required Changes

None blocking. The plan is solid.

**Recommendations (non-blocking):**

1. **RustAnalyzer:** Add a comment or follow-up task for RustAnalyzer to use the same pattern. Don't mix it into this PR - keep scope focused.

2. **Type safety in JSModuleIndexer:** Use `(context as PluginContext).touchedFiles` rather than a custom cast, since PluginContext now has the field.

---

## Final Assessment

This is the right fix at the right level. The previous approach was wrong, and you identified why (phase boundary problem). The new approach (clear on first touch, track across phases) is architecturally sound.

6 files is not over-engineered for this:
- 1 new utility file
- 1 type change
- 4 integration points (Orchestrator, JSModuleIndexer, JSASTAnalyzer, GraphBuilder removal)

That's the minimum surface area for a cross-cutting concern.

**Ship it.**

---

Linus Torvalds
High-level Reviewer
