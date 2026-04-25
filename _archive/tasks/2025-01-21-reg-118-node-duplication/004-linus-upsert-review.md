# Linus Torvalds: Architectural Review of UPSERT Proposal

**Date:** 2025-01-21
**Issue:** REG-118
**Question:** Is UPSERT at the RFDB level the right solution?

## TL;DR

**No. UPSERT at the storage level is wrong.**

It's not fundamentally wrong as a feature, but using it to solve this problem is architecturally backwards. We're papering over a design flaw with a storage hack.

---

## The Actual Problem

Let me be direct: the problem isn't "how do we prevent duplicates" - it's **"why are we creating duplicates in the first place?"**

Look at the current flow:

```
grafema analyze (run 1)
  -> JSASTAnalyzer parses foo.js
  -> GraphBuilder collects nodes: {id: "FUNCTION#bar#foo.js#10:0:0", ...}
  -> RFDBServerBackend.addNodes() -> INSERT
  -> Result: 1 FUNCTION node

grafema analyze (run 2) [same file, unchanged]
  -> JSASTAnalyzer parses foo.js AGAIN
  -> GraphBuilder collects nodes: {id: "FUNCTION#bar#foo.js#10:0:0", ...}
  -> RFDBServerBackend.addNodes() -> INSERT
  -> Result: 2 FUNCTION nodes (duplicate!)
```

The bug is obvious: **we're analyzing unchanged files and inserting results that already exist.**

UPSERT would "fix" this by silently overwriting. But that's treating the symptom, not the disease.

---

## What's Actually Broken

### 1. Idempotency Violation

Analysis should be idempotent: `analyze(file) + analyze(file) = analyze(file)`

The current system violates this. The fix isn't "make storage tolerate non-idempotent operations" - it's "make operations idempotent."

### 2. No "Clear Before Re-analyze" Strategy

When re-analyzing a file, we should:
1. Delete all nodes belonging to that file
2. Insert new nodes

OR:

1. Compute what should exist
2. Diff against what does exist
3. Apply delta (add new, update changed, delete removed)

Currently we do neither. We just blindly insert.

### 3. Semantic IDs Are There But Unused

Look at the code - we already have `semanticId` and `stableId`:

```typescript
// From JSASTAnalyzer.ts
functions.push({
  id: functionId,
  stableId: functionId,  // <-- This exists!
  ...
});

// Scopes have semanticId
scopes.push({
  semanticId: ifSemanticId,  // <-- This exists too!
  ...
});
```

We went through the effort of generating stable IDs, but then we don't use them to prevent duplicates. That's insane.

---

## Why UPSERT at Storage Level is Wrong

### 1. Wrong Layer of Abstraction

Storage should be dumb. It stores what you tell it to store. The decision about "should this be an insert or update" belongs in the business logic layer - that's GraphBuilder or the Orchestrator.

Putting intelligence in storage leads to:
- Hidden behavior (caller thinks it inserted, but it updated)
- Performance overhead (check existence on EVERY insert)
- Debugging nightmares (why did my node change? where did it come from?)

### 2. Semantic ID != Storage Key

Look at the current ID format:
```
FUNCTION#functionName#/path/to/file.js#10:0:0
```

This includes line:column:counter. When code changes, line numbers change. Same semantic function, different ID. UPSERT by this ID doesn't help.

To make UPSERT work, you'd need to UPSERT by `file + name + type`, not by the full ID. That's a semantic operation, not a storage operation.

### 3. Existing Data Problem

You asked about existing data. Yes, we already have duplicates in production graphs. UPSERT doesn't fix them. It just prevents new ones.

With UPSERT you'd need:
1. Migration to deduplicate existing data
2. Logic to decide which duplicate to keep (newest? oldest? most complete?)
3. Edge re-pointing (edges reference node IDs)

This is a mess.

---

## The Right Solution

### Option A: Clear-and-Rebuild (Simple, Correct)

Before analyzing a file:
```typescript
// In Orchestrator or JSASTAnalyzer
async analyzeFile(file: string) {
  // 1. Delete all nodes from this file
  await this.deleteNodesForFile(file);

  // 2. Delete edges referencing those nodes
  // (cascading delete or handled by storage)

  // 3. Now analyze fresh
  await this.parseAndInsert(file);
}
```

Pros:
- Dead simple
- Guaranteed correctness
- No duplicate possibility

Cons:
- Loses node history (if we care about versioning)
- Loses edges that need re-creation

### Option B: Delta Computation (Complex, Complete)

```typescript
async analyzeFile(file: string) {
  // 1. Get expected state
  const newNodes = this.parse(file);

  // 2. Get current state
  const oldNodes = await graph.getNodesByFile(file);

  // 3. Compute delta
  const toAdd = newNodes.filter(n => !oldNodes.has(n.semanticId));
  const toUpdate = newNodes.filter(n =>
    oldNodes.has(n.semanticId) && hasChanged(n, oldNodes.get(n.semanticId))
  );
  const toDelete = oldNodes.filter(n => !newNodes.has(n.semanticId));

  // 4. Apply
  await graph.deleteNodes(toDelete);
  await graph.addNodes(toAdd);
  await graph.updateNodes(toUpdate);
}
```

Pros:
- Preserves history
- Minimal changes to graph
- Efficient for large graphs

Cons:
- Complex
- Requires proper semantic IDs (not line-number-based)
- Edge handling still tricky

### Option C: Versioned Analysis (What We Might Actually Want)

```typescript
async analyzeFile(file: string) {
  const version = generateVersion(); // timestamp or hash

  // 1. Add new nodes with new version
  const newNodes = this.parse(file);
  newNodes.forEach(n => n.version = version);
  await graph.addNodes(newNodes);

  // 2. Mark old versions as superseded (lazy delete)
  await graph.markSuperseded(file, version);

  // 3. Queries default to "latest version only"
}
```

This is what the existing `VersionManager` hints at but doesn't fully implement.

---

## My Verdict

**Option A (Clear-and-Rebuild)** is the right fix for now.

Why:
1. It's simple and obviously correct
2. It matches user expectation (re-analyze = start fresh)
3. It doesn't require semantic ID refactoring
4. It can be implemented in an hour, not a week

The implementation should be:

```typescript
// In JSASTAnalyzer.analyzeModule() or Orchestrator
if (!forceAnalysis && !fileChanged) {
  // Skip - use cached
  return;
}

// File changed or force - clear old data first
await this.clearFileFromGraph(module.file, graph);

// Now analyze normally
// ...existing code...
```

---

## What We Should NOT Do

1. **UPSERT in RFDB** - Wrong abstraction level, hides problems
2. **UPSERT in GraphBuilder** - Same problem, just moved
3. **Hash-based deduplication** - Treating symptom, not cause
4. **"Just run clear first"** - That's manual, not automatic

---

## Implementation Notes

The `clearFileFromGraph` function needs to:
1. Find all nodes where `file == targetFile`
2. Find all edges where `src` or `dst` is one of those nodes
3. Delete edges first (foreign key style)
4. Delete nodes

RFDB already has:
- `deleteNode(id)` - works
- `find_by_attr({ file: ... })` - can find nodes by file

Missing:
- Efficient "delete all edges involving nodes X, Y, Z"
- Or cascading delete support

This is simple to add and is the RIGHT place to add functionality.

---

## Final Thoughts

Stop trying to make the database smart. Make the application logic correct.

The fundamental rule: **if you're inserting data that might already exist, you're doing something wrong upstream.**

Fix the upstream problem. Don't paper over it with storage magic.

---

**Verdict: REJECT UPSERT approach. Implement Clear-and-Rebuild.**
