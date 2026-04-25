# Steve Jobs - Product Design Review: REG-118 UPSERT Solution

## The Core Question

Before we talk about UPSERT, we need to answer a more fundamental question:

**What is the user's mental model of `grafema analyze`?**

When I run `grafema analyze` on my project, what am I asking for?

1. "Show me what my code looks like RIGHT NOW" - a snapshot
2. "Update the graph to reflect current state" - synchronization
3. "Add this analysis to my historical record" - accumulation

The answer determines everything.

---

## What the User EXPECTS

Let's be honest about what every single user will expect:

**Running `grafema analyze` twice should produce the SAME RESULT.**

This is not a preference. This is basic software behavior. If I run `ls` twice, I get the same output. If I run `git status` twice, I get the same status. If I save a document twice, I don't get two documents.

The current behavior (6 nodes become 12) is not a "bug". It's a **broken mental model**. It's like if saving a Word document created a second copy every time.

No user will ever say: "I expected 12 import nodes because I ran analyze twice."

---

## The Deeper Problem

But here's where it gets interesting. The proposed UPSERT solution assumes:

> "Same semantic ID = same thing"

Is this always true? Let's think about edge cases:

### Case 1: The Naive Happy Path
```
File: utils.js
- import { foo } from 'bar'

First analysis:  IMPORT node with id "utils.js:import:bar:foo"
Second analysis: Same semantic ID, UPSERT updates it
Result: 1 node. Good.
```

### Case 2: The Rename
```
Before: import { foo } from 'bar'
After:  import { baz } from 'bar'

Semantic ID before: "utils.js:import:bar:foo"
Semantic ID after:  "utils.js:import:bar:baz"

Result: OLD NODE ORPHANED. Now we have BOTH nodes.
```

The rename case reveals the real problem: **UPSERT handles updates but not deletions.**

### Case 3: The Semantic ID Collision
What if two different things get the same semantic ID by accident?

```
// File A, Line 10
import { helper } from './utils'

// File B, Line 10
import { helper } from './utils'
```

If semantic IDs are not file-scoped properly, these could collide. UPSERT would silently merge them.

This is not hypothetical. It's the kind of bug that makes you question every query result.

---

## Alternative Approaches

### Option A: Clear-Before-Analyze (Simple but Violent)
```
grafema analyze:
1. Clear all nodes for this file
2. Insert new nodes
```

**Pros:**
- Simple
- No orphans
- No collisions
- Idempotent

**Cons:**
- Loses ALL history
- Cannot diff between analyses
- Cannot track "this function was renamed from X to Y"

### Option B: UPSERT + Garbage Collection
```
grafema analyze:
1. Mark all existing nodes for this file as "unverified"
2. For each new node: UPSERT (marks as "verified")
3. Delete all nodes still marked "unverified"
```

**Pros:**
- Handles updates AND deletions
- No orphans
- Still idempotent

**Cons:**
- More complex
- Still no history

### Option C: Full Versioning
```
grafema analyze:
1. Create new version "v2"
2. All new nodes get version="v2"
3. Keep old nodes with version="v1"
4. Query defaults to latest version
```

**Pros:**
- Full history
- Can diff between versions
- Can rollback

**Cons:**
- Storage grows over time
- Complexity in queries
- "Latest" version must be explicit

---

## The "Would I Show This On Stage?" Test

Let me imagine demoing each approach:

### Demo: UPSERT Only
"Watch as I run analyze twice... see? Same number of nodes!"
*Renames a function*
"Now watch as I analyze again... wait, why are there MORE nodes now?"
*Audience confused*

**Verdict: Would NOT show on stage.**

### Demo: Clear-Before-Analyze
"Watch as I run analyze twice... same result!"
*Renames a function*
"Analyze again... updated! No orphans."
"But I can't see what changed between analyses."

**Verdict: Acceptable, but not impressive.**

### Demo: UPSERT + GC (Option B)
"Watch as I run analyze twice... same result!"
*Renames a function*
"Analyze again... see how the old node was removed and new one created?"
*Query shows only current state*

**Verdict: Would show on stage.**

### Demo: Full Versioning
"Watch as I analyze... version 1 created."
"Now I rename this function and analyze again... version 2."
"Query: show me what changed between versions."
*Shows diff: function renamed from X to Y*

**Verdict: Would PROUDLY show on stage. This is the premium experience.**

---

## My Recommendation

### For REG-118 (Immediate Fix)
**Implement Option B: UPSERT + Garbage Collection**

Why:
1. Solves the immediate problem (no duplicates)
2. Handles both updates AND deletions
3. Doesn't require massive architectural changes
4. Is the correct behavior for a "synchronization" mental model

### For The Future (REG-XXX)
**Design for Full Versioning**

Why:
1. Aligns with Grafema's vision ("understand code evolution")
2. Enables killer features: "What changed since last commit?"
3. Differentiates from TypeScript/other tools
4. History is what makes Grafema valuable for legacy codebases

---

## Critical Questions Before Implementation

1. **Is semantic ID currently file-scoped?**
   If semantic ID is `function:foo` instead of `path/file.js:function:foo`, we have collision risk.

2. **What about edges?**
   If we delete a node, what happens to edges pointing to/from it?
   GC must cascade to edges.

3. **How do we mark "unverified"?**
   - Add a `_verified` boolean? (metadata pollution)
   - Use a separate in-memory Set during analysis? (cleaner)
   - Timestamp-based? (compare `updatedAt` with analysis timestamp)

4. **What about cross-file edges?**
   If file A imports from file B, and we only re-analyze file A, what happens?
   GC must be scoped to the file being analyzed.

---

## Summary

| Approach | Idempotent | Handles Renames | Has History | Stage-Ready |
|----------|------------|-----------------|-------------|-------------|
| Current (Insert) | No | No | Yes (broken) | No |
| UPSERT Only | Yes | No | No | No |
| Clear + Insert | Yes | Yes | No | Meh |
| UPSERT + GC | Yes | Yes | No | Yes |
| Full Versioning | Yes | Yes | Yes | Hell Yes |

**Immediate action: UPSERT + GC**
**Strategic direction: Full Versioning**

---

## One More Thing

The real question isn't "how do we prevent duplicates?"

The real question is: **"What story does the graph tell about code evolution?"**

Duplicates are a symptom. The disease is treating analysis as "insert" instead of "synchronize" or "version."

Fix the mental model, and the implementation becomes obvious.

-- Steve
