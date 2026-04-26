# Linus Torvalds' High-Level Plan Review for REG-177

## TL;DR: Stop. This is built on a false premise.

The plan is technically sound, well-structured, and follows good engineering practices. **But it's solving the wrong problem.**

## The Fatal Flaw

Both Don's and Joel's plans assume that Grafema doesn't extract variables inside try/catch blocks. Look at the user request (line 36):

```
Missing (expected but not created): 3
  - VARIABLE: response (line 43) - inside try block, not extracted
  - VARIABLE: data (line 44) - inside try block, not extracted
```

**This assumption is wrong.** I checked the code:

1. `VariableVisitor` only extracts module-level variables (line 220-222):
   ```typescript
   VariableDeclaration: (path: NodePath) => {
     // Only module-level variables
     const functionParent = path.getFunctionParent();
     if (!functionParent) {
   ```

2. **BUT** `analyzeFunctionBody()` in JSASTAnalyzer DOES handle function-scoped variables:
   ```typescript
   funcPath.traverse({
     VariableDeclaration: (varPath: NodePath<t.VariableDeclaration>) => {
       this.handleVariableDeclaration(
         varPath,
         getCurrentScopeId(),
         module,
         variableDeclarations,
         classInstantiations,
   ```

3. Try/catch blocks ARE tracked with proper scope handling.

So **variables inside try blocks SHOULD be extracted**. If `response` variable wasn't found, it's either:

A) The variable WAS extracted but the user couldn't find it (query UX problem)
B) There's a specific edge case bug preventing extraction (need actual reproduction)
C) The user's example is hypothetical, not a real case

## What This Means

We're building a feature based on a hypothetical problem that may not exist. Before we write ANY code:

1. **Reproduce the actual issue**: Analyze the real `Invitations.tsx` file. Is `response` actually missing from the graph?
2. **If missing**: Why? Is it a bug in extraction? A scope resolution issue? A semantic ID problem?
3. **If present**: The real problem is query UX, not extraction coverage.

## The Right Questions

Don asked: "Is runtime AST-to-graph comparison the right approach?"

**Wrong question.** The right question is: **"Is there actually a coverage gap, or is this a query/discoverability problem?"**

If variables ARE being extracted but users can't find them, then `grafema explain` won't help. What we need is better query commands, better MCP integration, or graph schema improvements.

## What's Good About the Plan

Despite the flawed premise, the technical execution is solid:

- Clean architecture (FileExplainer class, separate from CLI)
- Good pattern matching (follows CoverageAnalyzer, doctor command)
- Sensible scope reduction for MVP
- Well-defined test plan
- Proper phase separation

If we DO need this feature, Joel's implementation plan is excellent.

## What's Bad

1. **No validation of the core assumption**: Neither Don nor Joel questioned whether the try/catch limitation actually exists.

2. **The "Known Limitations" registry is a hack**: Hardcoding limitations that may not be real limitations is technical debt from day one.

3. **Runtime AST comparison is expensive**: Re-parsing files on every `explain` call. This is acceptable for debugging, but if the real problem is query UX, we're optimizing the wrong thing.

4. **Scope creep risk**: Once we have `explain`, users will want:
   - `explain` for specific symbols, not just files
   - Integration with `query` command
   - MCP endpoints for AI agents
   - Coverage tracking over time

   None of this is planned, but it's inevitable.

## Alignment with Grafema Vision

**Does this make "query the graph" more viable than "read the code"?**

Don says yes. I say **maybe**, but only if the premise is correct.

If variables ARE extracted and users just can't find them, then adding `explain` is a band-aid. We're admitting the graph query system is inadequate and adding a diagnostic layer instead of fixing the root cause.

The vision says: **"AI should query the graph, not read code."** But `explain` works by re-reading code and comparing it to the graph. That's exactly backwards.

## My Verdict

**STOP. Do not implement this plan yet.**

## What to Do Instead

1. **Reproduce the original issue**:
   - Get the actual `Invitations.tsx` file
   - Run `grafema analyze`
   - Query for `response` variable using existing commands
   - Document what happens

2. **If variable is missing**:
   - Create minimal reproduction case
   - File bug report with root cause analysis
   - Fix the extraction bug FIRST
   - Then consider diagnostic tools

3. **If variable exists but hard to find**:
   - The problem is query UX, not coverage
   - Improve `query` command instead
   - Add better MCP integration for AI agents
   - Consider adding fuzzy search, scope-aware queries, etc.

4. **Only then**: If we genuinely have extraction gaps we can't fix, THEN implement `explain`.

## Final Thoughts

This is exactly the kind of thing where doing the wrong thing perfectly is worse than doing nothing. We're about to invest days of engineering time on a feature that might be solving a problem that doesn't exist.

Don, Joel: You did good technical work. But we missed the most important step: **verify the problem exists before designing the solution**.

---

## Recommendation

Before proceeding, we need to validate the problem. Create a test case:

1. Write a simple file with variables inside try/catch
2. Run `grafema analyze`
3. Query for those variables
4. Document the results

If they're missing → extraction bug (fix that first)
If they're present → query UX problem (different solution needed)
