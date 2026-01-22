# Linus Torvalds - Plan Review: REG-125

## Verdict: APPROVED WITH MINOR NOTES

The plan is RIGHT. It's simple, focused, and addresses the real problem. Let's not overthink this.

---

## Did They Do The RIGHT Thing?

**Yes.**

Steve Jobs was right - hiding semantic IDs behind `--json` is stupid. The whole point of Grafema is that graph identity matters more than file:line locations. If we're not showing semantic IDs by default, we're undermining our own product.

Don correctly identified this as a "philosophical failure" - and he's right. The plan addresses this head-on.

---

## Did They Cut Corners?

**No.**

The plan is appropriately scoped:
- Create one utility module (`formatNode.ts`)
- Update four commands (query, trace, impact, check)
- Write proper tests

That's exactly what needs to happen. Not too much, not too little.

---

## Does It Align With Project Vision?

**Perfectly.**

"AI should query the graph, not read code."

If CLI output shows `file:line` as primary and hides semantic IDs, we're training users to think in files. This fix makes semantic IDs the primary identifier - exactly as it should be.

---

## Did They Add Hacks?

**No.**

The solution is clean:
1. Centralized formatting logic (DRY - good)
2. Consistent output format across commands
3. No flags, no configuration, no complexity

This is how it should have been built from day one.

---

## Is It At The Right Level of Abstraction?

**Yes.**

Joel's plan creates `formatNodeDisplay()` and `formatNodeInline()` - two functions that cover the two use cases (primary display vs. list items). Simple and sufficient.

The `DisplayableNode` interface is minimal - just what's needed. Not over-engineered.

---

## Did They Forget Something?

**One minor thing:** The plan doesn't mention what happens when a node has no semantic ID (edge case: external modules, malformed data, etc.). The utility should gracefully handle `node.id` being undefined or empty.

Not a blocker. Kent can catch this in tests.

---

## Technical Notes

1. **Line numbers in plan vs. actual code**: Joel's plan references specific line numbers that don't match the actual files. For example, he says `displayNode()` is at line 397, but it's at line 397. Actually wait - it IS at 397. Okay, the line numbers are accurate. Good.

2. **The `NodeInfo` interface already has `id`**: Both plans assume we need to add semantic ID support, but looking at the code, `NodeInfo` already has `id: string` in all commands. The semantic ID is already there - it's just not being displayed. This makes the implementation even simpler.

3. **The plan correctly uses ASCII arrows** (`<-`, `->`) instead of Unicode. Smart choice for copy-paste friendliness and terminal compatibility.

4. **JSON output unchanged**: Correct. Don't touch what works.

---

## What Could Go Wrong

**Nothing serious.**

The only risk is scripts parsing current output format. But:
- This is a dev tool, not a production API
- Anyone parsing CLI output should use `--json`
- If they're parsing human-readable output, they get what they deserve

Document in release notes and move on.

---

## Final Notes

1. **Estimated 1.5-2 hours**: Realistic. Might be less since the data is already there.

2. **Test strategy is sound**: Unit tests for utility, then verify CLI output. Simple and sufficient.

3. **The output format examples are clear**: No ambiguity about what the end result should look like.

---

## Decision

**APPROVED.**

Proceed to implementation. Kent writes tests first, Rob implements.

The plan is right. The scope is right. The abstraction is right. Ship it.

---

*"Talk is cheap. Show me the code."*

Now go write it.
