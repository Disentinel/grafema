# Steve Jobs High-level Review: RFD-10 T3.3 Client Snapshot API

> Date: 2026-02-14
> Reviewer: Steve Jobs
> Status: **REJECT**

---

## Executive Summary

The implementation is **technically correct** but ships with a **fatal architectural limitation** that defeats the feature's purpose. This is exactly the kind of "MVP limitation" we must reject.

**The problem:** The client can send snapshot commands, but the server can't handle them. The feature is **0% usable** until the server is updated. We're shipping dead code.

**The right solution:** Either ship the full vertical slice (client + server), or don't ship at all.

---

## What's Right

### 1. Code Quality — Excellent

- Clean, consistent implementation matching existing patterns
- Type safety is solid — TS types map correctly to Rust wire format
- 22/22 tests pass, including 15 new snapshot tests
- Wire format helper (`_resolveSnapshotRef`) is well-designed
- Tests document intent clearly with WHY comments

### 2. Type Mapping — Correct

```typescript
// TS type                     Rust type
SnapshotStats.totalNodes   →  ManifestStats.total_nodes
SnapshotDiff.fromVersion   →  SnapshotDiff.from_version
SegmentInfo.nodeTypes[]    →  SegmentDescriptor.node_types (HashSet)
```

Serde will serialize this correctly when the server is ready. No issues here.

### 3. Testing — Strong

15 new tests cover:
- `resolveSnapshotRef()` union discrimination
- Type contract validation
- Wire format payload structure
- Edge cases (version 0, empty tags)

These are **unit tests for dead code**, but they're good tests.

---

## What's Wrong

### CRITICAL ISSUE: Feature is 0% Usable

**The server doesn't support snapshot commands.**

From Don's plan:
> "The Rust server does NOT use storage_v2 yet... The server binary has no `DiffSnapshots`, `TagSnapshot`, `FindSnapshot`, or `ListSnapshots` variants."

This means:
```typescript
await client.diffSnapshots(1, 5);
// ERROR: Unknown command 'diffSnapshots'
```

**Every single snapshot method will fail with "unknown command" until the server is updated.**

This isn't a "limitation" — this is **non-functional code masquerading as a feature.**

### The "Option B" Defense Doesn't Hold

Don's plan justifies this:
> "Option B: Client-only (as specified in T3.3)... Server-side handlers deferred (they're trivial delegation)."

**This is wrong for three reasons:**

1. **T3.3 scope is arbitrary.** Just because the task was scoped as "client-only" doesn't mean that's the right boundary. The task should have been: "Add snapshot API (client + server)."

2. **"Trivial delegation" is a red flag.** If the server handlers are so trivial (5 lines each), why not include them? The only reason to defer is if there's an architectural blocker. There isn't — the Rust storage_v2 code is ready.

3. **Tests can't verify correctness.** The tests check that we send the right JSON. They can't verify that the server interprets it correctly, because the server doesn't support it yet.

### This Violates Root Cause Policy

From CLAUDE.md:
> "When behavior or architecture doesn't match project vision:
> 1. STOP immediately
> 2. Do not patch or workaround
> 3. Identify the architectural mismatch
> 4. Discuss with user before proceeding
> 5. Fix from the roots, not symptoms"

**Shipping client methods with no server support IS a workaround.** The root cause is: "We need snapshot API." The correct fix is: "Add snapshot API end-to-end."

Shipping client-only is cutting corners. If it takes longer to do the full vertical slice — it takes longer. No shortcuts.

---

## Architectural Gap Analysis

### Why is the server not using storage_v2?

The real question: **Why does storage_v2 exist in the codebase if the server doesn't use it?**

This suggests one of two things:
1. **storage_v2 is unfinished** — in which case we shouldn't be adding client methods for it
2. **storage_v2 is ready but not integrated** — in which case the blocker is server integration, not client code

Either way, **adding client methods now is premature.**

### The Right Order

1. **Server uses storage_v2** (or we decide it's not ready)
2. **Server implements snapshot command handlers** (5 lines each per Don)
3. **Client implements snapshot methods** (this task)
4. **Integration tests** verify end-to-end

We're doing step 3 before steps 1 and 2. That's backwards.

---

## What Should Have Happened

### Mini-MLA Would Have Caught This

If Don had questioned "why is this task scoped as client-only?", the answer would have been: "Because that's how the RFD broke it down." But **task breakdown is not architecture.**

The correct response:
> "The task scope is wrong. Snapshot API should be a vertical slice: types + client + server + integration test. Splitting it into client-only makes the feature unusable."

### The User Should Have Been Asked

From CLAUDE.md:
> "When in doubt about whether a task warrants a team, prefer spawning a team."

This task is **NOT well-understood.** It touches RFDB v2 protocol, storage_v2 integration, and client-server contracts. It should have gone through full MLA.

At minimum, Steve + Vadim review should have been invoked **before implementation**, not after.

---

## Scope Creep Check

430 LOC delivered vs 150 LOC estimated. Why?

Breakdown:
- 248 LOC tests (15 tests, but verbose WHY comments — this is good)
- 67 LOC client methods (4 methods + helper — reasonable)
- 96 LOC types (7 types + docs — detailed but necessary)
- 10 LOC re-exports

**Verdict:** Not scope creep. The task was underestimated. 430 LOC for 4 methods + 7 types + 15 tests is reasonable.

---

## Zero Tolerance for "MVP Limitations" Check

From CLAUDE.md:
> "If a 'limitation' makes the feature work for <50% of real-world cases → REJECT"

**This feature works for 0% of real-world cases** until the server is updated.

**REJECT.**

---

## Questions for User

1. **Why was this task scoped as client-only?** Is there a reason the server handlers couldn't be included?

2. **When will storage_v2 be integrated into the server binary?** If that's months away, we shouldn't be adding client methods now.

3. **What's the plan for server integration?** Is there a follow-up task? If so, why not do it atomically?

4. **Should we revert this and redo as full vertical slice?** Or keep this PR but block merging until server support lands?

---

## Recommended Action

**Option A: Revert and Redo (Preferred)**

1. Revert this implementation
2. Expand task scope to include server handlers
3. Re-implement as full vertical slice:
   - Server: Add 4 Request variants, wire to storage_v2 methods (~50 LOC Rust)
   - Client: Current implementation (430 LOC TS)
   - Integration test: Verify end-to-end (~30 LOC)
4. Ship atomically

**Option B: Block Merge Until Server Ready**

1. Keep this implementation in branch
2. Create blocker task: "Integrate storage_v2 into server binary"
3. Do NOT merge until server supports these commands
4. When server ready, add integration tests BEFORE merging

**Option C: Ship It (NOT Recommended)**

1. Merge this PR
2. Document limitation in release notes
3. Create follow-up issue for server support

**I recommend Option A.** The task was scoped wrong. Fix it from the roots.

---

## Verdict

**REJECT**

Not because the code is bad — the code is excellent. But because **we're shipping a feature that doesn't work.**

Grafema's vision: "AI should query the graph, not read code."

This PR: "AI can send snapshot commands, but the server will ignore them."

**That's not the right way to build product.**

---

## Next Steps

1. **Escalate to user immediately** — ask the 4 questions above
2. **Do NOT proceed** until we agree on the right scope
3. If user confirms client-only is intentional (e.g., server integration blocked by other work) → ask for explicit justification
4. If user agrees scope was wrong → revert and expand to full vertical slice

**Default stance: REJECT. Zero tolerance for shipping dead code.**
