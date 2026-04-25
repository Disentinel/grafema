# REG-335: RFDB Multi-Database Server Mode - High-Level Review

**Reviewer:** Linus Torvalds (High-Level)
**Date:** 2026-02-04
**Documents Reviewed:**
- `001-don-analysis.md`
- `002-joel-tech-spec.md`

---

## Verdict: APPROVED with minor concerns

This is a solid, well-thought-out design. You did the right thing.

---

## What You Got Right

### 1. Concurrency Model - The Critical Fix

The original Linear issue proposed two options:
- Option A: Single Writer per database (session-level locking)
- Option B: Write Locking (request-level)

You correctly identified that **Option A would break parallel analysis**. This was the key architectural insight:

> "ANALYSIS phase runs N parallel workers writing to same graph. Session-level locking would serialize analysis -> defeat purpose."

This is exactly right. The whole point of moving to client-server was to enable parallel workers writing to the same graph. Session-level write locks would have been a regression that defeats the purpose of this entire change.

**The fix:** Rely on existing `RwLock<GraphEngine>` for request-level concurrency. Simple, correct, no new complexity.

### 2. Named Databases Over Numbered Slots

Rejecting the Redis numbered database model was the right call. Redis's creator himself called it "one of the worst design decisions." Named databases are:
- Self-documenting
- Debuggable (list shows names, not numbers)
- Unlimited (not capped at 16)

### 3. Backwards Compatibility

Protocol v1 auto-detection is clean. Existing clients continue to work without changes. This is how you do a protocol extension.

### 4. Ephemeral Databases

In-memory-only ephemeral databases that never touch disk is the right model for tests. No cleanup needed, no disk I/O, instant creation/destruction.

### 5. Scope Reduction

Original estimate (with custom write locking): ~15-20 days
Final estimate (using existing RwLock): 9-12 days

You didn't add complexity you didn't need. Good.

---

## Concerns (Minor)

### 1. AccessMode is Misleading

```rust
enum AccessMode {
    ReadOnly,
    ReadWrite,
}
```

You describe this as "advisory only" - it doesn't actually enforce anything because multiple writers are allowed. But then you have:

```rust
if !session.can_write() {
    return Response::ErrorWithCode {
        error: "Operation not allowed in read-only mode",
        code: "READ_ONLY_MODE",
    };
}
```

So it DOES enforce something - it blocks that specific client from writing. But it doesn't stop OTHER clients from writing to the same database.

This is confusing. Either:
1. Remove AccessMode entirely (KISS - if you don't need it, don't add it)
2. Document clearly that it's per-session, not per-database

I lean toward option 1. You don't have a concrete use case for read-only sessions yet. Add it when you need it.

**Recommendation:** Remove AccessMode for v1. It's unnecessary complexity. All sessions are read-write. Add read-only mode later when you have a real use case (e.g., visualization tools that shouldn't accidentally mutate).

### 2. Ephemeral Database Cleanup on Disconnect

The spec says:
> "Ephemeral databases are destroyed when no connections remain."

But the code comment says:
> "// If ephemeral and no other users, drop it
> // Note: This happens automatically when Arc ref count drops"

This is incorrect. The Arc ref count dropping doesn't delete the database from the manager's HashMap. You need explicit cleanup logic.

In `handle_close_database`:
```rust
fn handle_close_database(session: &mut ClientSession) {
    if let Some(db) = &session.current_db {
        db.remove_connection();
        // If ephemeral and no other users, drop it
        // Note: This happens automatically when Arc ref count drops  <-- WRONG
    }
    session.clear_database();
}
```

The database entry remains in `DatabaseManager.databases` HashMap. The Arc won't drop because HashMap still holds a reference.

**Fix:** After `remove_connection()`, check if ephemeral + connection_count == 0, then call manager.drop_database().

This requires passing `&DatabaseManager` to `handle_close_database`, which is a bit annoying but necessary.

### 3. createTestDatabases Implementation

```typescript
export async function createTestDatabases(
  count: number,
  options: TestHelperOptions = {}
): Promise<TestDatabase[]> {
  for (let i = 0; i < count; i++) {
    const db = await createTestDatabase({...}); // Sequential!
    databases.push(db);
  }
  return databases;
}
```

This creates databases sequentially. For 100 databases, that's 100 round-trips. Should be:

```typescript
return Promise.all(
  Array.from({ length: count }, (_, i) =>
    createTestDatabase({
      ...options,
      namePrefix: options.namePrefix ? `${options.namePrefix}-${i}` : `test-${i}`,
    })
  )
);
```

Minor, but you're optimizing for test speed - might as well do it right.

---

## Questions Answered Correctly

Don asked good open questions. Joel's answers are solid:

1. **Ephemeral storage:** In-memory only. Correct.
2. **Name validation:** `[a-zA-Z0-9_-]`, 1-128 chars. Reasonable.
3. **Connection pooling:** Design for it, don't implement. Correct.
4. **Metrics:** Basic only (nodeCount, edgeCount). Correct - YAGNI.
5. **Hot reload:** No. Correct - complexity for no benefit.

---

## Alignment with Project Vision

**"AI should query the graph, not read code"**

This change doesn't directly serve the vision, but it unblocks development velocity. Fast tests -> faster iteration -> faster progress toward vision.

**"TDD - Tests First, Always"**

30+ minute test suite is a TDD blocker. This directly addresses it. Target: <1 minute with parallel workers.

**"Massive legacy codebases"**

Multi-database enables:
- Per-branch analysis databases
- Development/staging/production graphs
- Historical snapshots for comparison

This extends Grafema's utility for the target use case.

---

## Complexity Checklist

- **Does the solution iterate over ALL nodes of a broad type?** No.
- **Could iteration be narrowed?** N/A.
- **What's the Big-O complexity?** All operations O(1) except ListDatabases O(n databases). Acceptable.
- **Are there nested iterations?** No.
- **Thread contention?** Per-database RwLock, not global. Correct.

---

## Conclusion

The design is sound. The critical architectural decision (request-level locking via existing RwLock, not session-level locking) is correct and shows good judgment.

Minor issues to address before implementation:
1. Either remove AccessMode or document its per-session semantics clearly
2. Fix ephemeral database cleanup (HashMap removal when connection_count hits 0)
3. Parallelize createTestDatabases

None of these are blockers. Proceed to implementation.

---

**Approved for implementation.**

*"Good code is its own best documentation."*
