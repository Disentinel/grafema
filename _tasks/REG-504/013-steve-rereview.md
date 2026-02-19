# Steve Jobs Re-Review — REG-504 (utils.rs fixes)

**APPROVED**

Both changes are verified and correct.

**Fix 1 — Derived predicates provide free Var args (line 239-245):**
The `_` wildcard arm now calls `free_vars(args, bound)` instead of returning an empty set.
The comment is accurate: derived predicates bind variables via their rule head projection.
This is the minimal, correct fix — no overreach, no new complexity.

**Fix 2 — Combined `incoming` and `path` arms (line 213):**
`"incoming" | "path" =>` is clean. Both predicates share identical placement semantics
(first arg must be bound, remaining args are provided). The consolidation is honest DRY,
not cosmetic. No behavioral change.

**No new concerns.** The logic is tight, the code reads well, and the fix solves
the root cause rather than patching around it. This is what good engineering looks like.
