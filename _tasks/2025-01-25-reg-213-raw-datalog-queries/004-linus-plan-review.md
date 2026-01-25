# Linus Torvalds Review: REG-213 Raw Datalog Queries

## Verdict: APPROVED with minor concern

The plan is fundamentally RIGHT and aligns with project vision. However, there's one architectural question that needs clarification.

## Analysis

### What You're Doing Right

1. **User intuition first**: Users naturally expect `type(N, T)` to query node types. Adding it as an alias is the RIGHT thing to do. This is about DX, not hacks.

2. **Additive, not destructive**: The change is purely additive:
   - `node` still works exactly as before
   - `type` is just an alias pointing to same logic
   - No breaking changes, no refactoring masquerading as bug fix

3. **Documentation**: Updating CLI help with predicate list and examples directly addresses the root problem — users shouldn't guess the syntax.

4. **Scope is appropriate**: You're NOT trying to:
   - Change Datalog semantics
   - Add error handling for unknown predicates (correctly deferred)
   - Overhaul the query engine
   - You're solving the immediate UX problem without gold-plating.

5. **Aligned with vision**: "AI should query the graph, not read code." Users shouldn't need to read code or docs to discover that `node` exists — the CLI should tell them.

### One Concern: Naming Consistency

**The question**: In the DATALOG.md documentation (line 54), the predicate is described as:
```
node(Id, Type).                    % noda s tipom
```

This clearly uses "node" as the primary name. Now we're adding "type" as an alias.

**Is this the right name for the alias?**

- `type(X, T)` - intuitive for "what type is X" or "find things of type T"
- **But** it's also a Datalog keyword in some systems (Prolog, etc.)
- The second argument is called Type, so asking for "type" makes sense

**Verdict**: Yes, `type` is the right alias. It's intuitive, users expect it, and it doesn't conflict with anything in Grafema's Datalog subset.

### On Deferred Error Handling

The plan correctly defers "unknown predicate" errors to a separate issue because:
1. Datalog allows user-defined predicates via rules
2. Silently returning empty results is semantically correct (no facts match)
3. Better to fix UX (documentation) than change semantics

**This is the right call.** Don't try to be clever with error messages now.

## Test Coverage Expectations

The plan mentions adding tests. Ensure they verify:
- `type(X, "FUNCTION")` returns same results as `node(X, "FUNCTION")`
- All four argument patterns work identically
- No edge cases where they diverge (they shouldn't)

## Sign-Off Checklist

- [x] Is this the RIGHT thing? YES — user intuition + DX improvement
- [x] Does it align with vision? YES — better graph query experience
- [x] Cutting corners? NO — straightforward alias
- [x] At right level of abstraction? YES — predicates are the right place
- [x] Scope appropriate? YES — just UX fixes + documentation
- [x] Will tests actually test the claim? TBD — Kent and Rob need to verify

## Final Verdict

**APPROVED.** This is good, pragmatic work. You're solving a real problem without overthinking it. The implementation is straightforward, the scope is bounded, and it directly improves the user experience.

Move to implementation. Let's see if the tests catch anything interesting.
