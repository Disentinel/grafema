# REG-326 Plan REJECTED

**Date:** 2026-02-03
**Decision:** Plan rejected, task blocked by REG-327

## What Happened

During planning for REG-326 (Backend value tracing), Linus Torvalds (then high-level reviewer) discovered a **fundamental architectural gap**:

> **Function-local variables are NOT in the graph.**
>
> JSASTAnalyzer only creates VARIABLE nodes for module-level declarations. Variables inside functions don't exist in the graph.

This means the most common Express handler pattern CANNOT be traced:

```javascript
app.get('/users', async (req, res) => {
  const users = await db.all('SELECT * FROM users');  // NOT in graph!
  res.json(users);  // Cannot trace back to db.all()
});
```

**This pattern represents 90%+ of real-world code.**

## The Wrong Decision

Linus's response was: "Accept the limitation for MVP."

This violates the Root Cause Policy from CLAUDE.md:

> **CRITICAL: When behavior or architecture doesn't match project vision:**
> 1. STOP immediately
> 2. Do not patch or workaround
> 3. Fix from the roots, not symptoms
> 4. **If it takes longer — it takes longer. No shortcuts.**

And the project vision:

> "AI should query the graph, not read code. If reading code gives better results than querying Grafema — **that's a product gap, not a workflow choice.**"

Shipping REG-326 without function-local variables would create a feature that works for <10% of real code. This defeats the entire purpose.

## The Correct Decision

1. **Plan rejected**
2. **REG-327 created:** "JSASTAnalyzer: create nodes for function-local variables"
3. **REG-326 blocked by REG-327**

REG-326 will be unblocked when REG-327 is complete.

## Process Changes

Linus Torvalds removed from high-level reviewer role. New review process:

**Steve Jobs + Vadim Reshetnikov (parallel review)**
- Both must approve
- Default stance: REJECT
- Zero tolerance for "MVP limitations" that defeat feature purpose
- When in doubt — escalate to user

## Artifacts Created (not to be committed)

The following files were created during planning but should NOT be committed:

- `002-don-plan.md` through `009-kent-tests.md` — planning artifacts for rejected plan
- `test/unit/plugins/analysis/ExpressResponseAnalyzer-dataflow.test.ts` — tests for rejected feature
- `test/unit/cli/trace-from-route.test.ts` — tests for rejected feature

## Lessons Learned

1. **"Accept limitation for MVP" is dangerous** when the limitation defeats the feature's purpose
2. **Architectural gaps must be fixed first**, not papered over
3. **Reviewers must REJECT** plans that would ship broken features, even if it means more work

---

*This decision made by Vadim Reshetnikov (product owner)*
