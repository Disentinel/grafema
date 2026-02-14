# Steve Jobs Final Review: REG-414 Agent Skills Support

**Date:** 2026-02-14
**Reviewer:** Steve Jobs (High-level Review)
**Task:** REG-414 — Agent Skills Support for Grafema

---

## Verdict: **APPROVE WITH RESERVATIONS**

The implementation is fundamentally sound and addresses all five concerns from the initial review. However, there are philosophical and practical issues that need discussion before I can give full confidence.

---

## What Got Built (Summary)

### 1. Core Skill: SKILL.md (295 lines)
- Standard Agent Skills frontmatter (name, description, license, version, compatibility)
- Core principle: "Query the graph, not read code" (front and center)
- Essential Tools section (Tier 1): 5 most-used tools with inline examples
- Decision Tree: "What do you need?" workflow for tool selection
- 5 Common Workflows: Impact analysis, security audit, onboarding, dependency analysis, dead code detection
- Anti-patterns section based on real agent behaviors
- Tier 2/3 tools organized by specificity

**Assessment:** EXCELLENT. The structure matches how agents discover and consume information. Examples are terse but clear. Decision tree is actionable.

### 2. Reference Docs (328 lines total)
- `references/node-edge-types.md` (123 lines): Complete graph schema, attribute reference, quick patterns
- `references/query-patterns.md` (205 lines): Datalog cookbook with basic, edge traversal, negation, invariant, join patterns

**Assessment:** GOOD. Progressive disclosure works. Agents can start with SKILL.md and deep-dive when needed.

### 3. CLI Command: `grafema setup-skill`
- Installs skill to project's `.claude/skills/` (default)
- `--platform` flag supports gemini/cursor (cross-platform)
- `--output-dir` for custom paths
- Version checking: skips if same version, warns if different version exists
- `--force` to overwrite
- Exported `installSkill()` function for programmatic use

**Assessment:** SOLID. Command does exactly one thing well. Version handling is pragmatic.

### 4. Auto-Install During Init
- `grafema init` auto-installs skill to `.claude/skills/`
- Non-blocking: init doesn't fail if skill install fails
- Prints confirmation message

**Assessment:** PERFECT. Opt-out (delete file) is better UX than opt-in (discover command).

### 5. Tests (7 tests, all passing)
- Help output verification
- Default installation to `.claude/skills/`
- Idempotent behavior (same version = skip)
- Force overwrite
- Platform support (gemini)
- Custom output dir
- Auto-install during init

**Assessment:** SUFFICIENT for current scope. Tests verify mechanics, not educational effectiveness.

---

## All Five Review Concerns Addressed

### ✅ 1. Cross-Platform
- **Concern:** Skill install location differs per platform
- **Resolution:** `--platform` flag, separate dirs per platform
- **Status:** RESOLVED

### ✅ 2. Auto-Install
- **Concern:** Opt-in = low adoption
- **Resolution:** Auto-install during `grafema init`
- **Status:** RESOLVED

### ✅ 3. Versioning
- **Concern:** Stale skills after Grafema updates
- **Resolution:** Version in metadata, idempotent install, `--force` to update
- **Status:** RESOLVED (sufficient for v0.2)

### ✅ 4. Validation Plan
- **Concern:** No proof agents will use it correctly
- **Resolution:** Real-world testing deferred post-release (valid for MVP)
- **Status:** DEFERRED (acceptable risk)

### ✅ 5. Inline Examples
- **Concern:** Not enough examples in SKILL.md
- **Resolution:** ~15 inline examples across Essential Tools, Decision Tree, Workflows
- **Status:** RESOLVED

---

## The Big Question: Will This Actually Change Agent Behavior?

**The honest answer: I DON'T KNOW.**

Here's the problem: Agent Skills is a **push** model. We're teaching agents "here's how to use Grafema" BEFORE they need it. But agents are reactive — they use tools when solving specific problems.

### What Could Go Wrong

1. **Agent doesn't read the skill before choosing tools**
   If the agent's tool selection happens at the LLM layer (not skill-aware), this is just nice documentation nobody reads.

2. **Agent reads skill but ignores it**
   Skills compete with system prompts, context, and prior training. If the model was pre-trained to "read code to understand it," our skill fights muscle memory.

3. **Agent uses tools but uses them wrong**
   Example: Agent reads "use find_calls for callers" but still runs `find_calls` then reads all those files anyway. We taught tool selection, not workflow discipline.

4. **Skill is TOO good at teaching high-level tools**
   Agent learns to use `find_nodes`, `find_calls`, `get_function_details` for EVERYTHING and never discovers Datalog power for complex patterns.

### What Could Go Right

1. **Decision Tree drives behavior**
   If agents actually follow "START: What do you need?" → tool selection, we've won. This is the strongest part of the skill.

2. **Anti-patterns prevent common mistakes**
   "Don't read files to find call sites" — if agents internalize this, massive win.

3. **Common Workflows scaffold learning**
   Copy-paste workflows are easier than thinking. If agent hits "Impact Analysis" workflow and it WORKS, they'll reuse it.

---

## What I'm Worried About

### 1. No Feedback Loop

We're shipping this blind. No telemetry for:
- How often agents open SKILL.md
- Which tools they choose after reading it
- Whether they follow Decision Tree vs just grepping tool list
- Whether anti-patterns actually prevent mistakes

**Implication:** We won't know if this works until users complain or praise.

### 2. Progressive Disclosure Might Be Too Gentle

SKILL.md says "see references/ for details" but doesn't FORCE agents to look. What if agent needs Datalog for complex query but stops at Tier 1 tools?

**Counterpoint:** This is by design. Tier 1 should handle 80% of cases. If agent hits a Tier 1 limitation, they'll search for alternatives.

### 3. No Enforcement Mechanism

Nothing stops an agent from:
- Ignoring the skill entirely
- Reading files before trying graph queries
- Using Datalog for simple lookups

**Counterpoint:** That's true of ALL documentation. We can lead horses to water...

---

## What's Missing (But Acceptable for v0.2)

### 1. No "Try This First" Forcing Function
If I could add ONE thing, it would be: **MANDATORY starter example.**

Top of SKILL.md should have:
```
BEFORE ANYTHING ELSE: Try this query to verify MCP is working:
  find_nodes({ type: "MODULE" })

If this fails, Grafema MCP server is not configured. Stop here.
```

This forces agents to verify setup BEFORE spending tokens on wrong approaches.

**Status:** MISSING but easy to add later.

### 2. No Comparison to Alternatives
SKILL.md doesn't say:
- "Grafema vs TypeScript LSP: when to use which"
- "Grafema vs grep: here's what grep can't do"
- "Grafema vs AST querying: Grafema is FASTER for cross-file patterns"

**Counterpoint:** This might confuse more than help. Better to stay focused on Grafema's strengths.

### 3. No Performance Hints
Agents don't know:
- `find_calls` is O(1) lookup (indexed)
- `query_graph` without constraints is O(n) disaster
- `get_context` with no filters = full graph traversal

**Implication:** Agents might avoid fast tools (thinking they're slow) or spam slow tools (thinking they're fast).

**Status:** Query patterns doc has "Performance Tips" but not prominent enough.

---

## Complexity & Architecture Review

### Does It Use Existing Abstractions? ✅

**GOOD:**
- Skill stored in `packages/cli/skills/` (alongside dist/)
- CLI command uses standard Commander pattern
- `installSkill()` exported function = reusable
- Auto-install in `init.ts` uses exported function (DRY)

**NO RED FLAGS:**
- No new "skill management system"
- No plugin architecture for skills
- No dynamic skill loading
- Just: copy files from package to project

This is **exactly right** for v0.2. If we need skill updates, version bumps, auto-sync — those are v0.3 features.

### Iteration Complexity: O(1) ✅

Installation is O(1):
- Find source dir (package root)
- Copy to target dir (user project)
- No traversal, no scanning, no parsing

**GOOD.**

---

## The Real Test: Would I Show This On Stage?

**The demo:**

1. User runs `grafema init` → skill auto-installed
2. Agent opens Claude Code, sees Grafema skill in `.claude/skills/`
3. User asks: "Where is `processPayment` called?"
4. Agent reads skill → Decision Tree → "Find who calls function X" → `find_calls`
5. Agent runs: `find_calls({ name: "processPayment" })` → instant results
6. Agent DOESN'T read 20 files, DOESN'T grep, DOESN'T guess

**Would that demo work?**

**If the agent cooperates: YES.**
**If the agent ignores the skill: NO.**

And that's the problem. This feature's success depends on agent compliance, which we can't control.

---

## Philosophical Concerns

### Is Agent Skills the Right Abstraction?

Agent Skills assumes:
- Agents read documentation before acting (optimistic)
- Skills can override model training (unproven)
- Static markdown > dynamic prompting (debatable)

**Alternative approach:** Grafema MCP server could RETURN skill hints in tool responses.

Example:
```json
{
  "error": "find_calls returned 0 results",
  "hint": "Try find_nodes first to verify the function exists",
  "see_also": "SKILL.md#decision-tree"
}
```

This is **reactive teaching** vs **proactive teaching**. Skills are proactive. In-band hints are reactive.

**Verdict:** We're doing proactive (skills). Reactive (hints in responses) is v0.3 territory.

---

## What Would Make Me Confident?

### 1. Real-World Dogfooding (Post-Release)

After merge:
- Use Grafema WITH this skill for 5 real tasks
- Track: Did agent follow Decision Tree? Did anti-patterns prevent mistakes?
- Document failures → iterate

**This is validation, not implementation.** Do it AFTER merge.

### 2. Telemetry (Future)

Add to MCP server:
- `get_skill_version()` tool → agents can check if skill is current
- Log tool usage patterns → see if skill changes behavior
- Compare: sessions WITH skill vs WITHOUT skill

**Status:** Out of scope for REG-414, but should be REG-XXX for v0.3.

### 3. A/B Test (Ambitious)

Run same query with two agents:
- Agent A: No skill, just MCP tools
- Agent B: Has skill installed

Measure:
- Time to solution
- Number of tool calls
- Number of file reads (anti-pattern)

**Status:** Research-level effort. Not blocking v0.2 release.

---

## Final Thoughts

This is **good work**. The implementation is clean, the documentation is thoughtful, the testing is adequate. It ships what the spec promised.

But here's what keeps me up at night: **We're betting on agent behavior we can't control.**

If agents DON'T read skills before acting → this is just pretty documentation.
If agents DO read skills but IGNORE them → we've wasted effort.
If agents read skills and FOLLOW them → we've built something transformative.

**We won't know which until real users try it.**

---

## Verdict Justification

### Why APPROVE?

1. **All review concerns addressed** — cross-platform, auto-install, versioning, examples
2. **Clean implementation** — no architectural debt, uses existing patterns
3. **Tests pass** — mechanics verified
4. **Aligns with vision** — "Query the graph, not read code" is FRONT AND CENTER
5. **Low risk** — worst case, agents ignore it and nothing breaks

### Why RESERVATIONS?

1. **No proof it works** — we're shipping blind, no validation plan beyond "try it and see"
2. **No feedback loop** — can't measure adoption or effectiveness
3. **Assumes agent compliance** — success depends on agent reading + following skill

### What Would Block Approval?

- If SKILL.md had NO examples (but it has ~15)
- If auto-install was missing (but it's there)
- If version handling was broken (but it works)
- If tests failed (but 7/7 pass)

None of these are true. The implementation is SOLID.

---

## Recommendation

**MERGE TO MAIN.**

Then:
1. Dogfood for 1 week (use Grafema WITH skill for real work)
2. Document agent behavior (did they use Decision Tree? follow anti-patterns?)
3. Create Linear issue for telemetry (v0.3)
4. Create Linear issue for in-band hints (v0.3)

If dogfooding reveals fundamental issues → patch in v0.2.1.
If agents ignore skill entirely → revisit Agent Skills abstraction in v0.3.

---

## One Last Thing

The Decision Tree is the star of this implementation. If agents actually follow:

```
"Find who calls function X"
  -> find_calls({ name: "X" })
  -> For full details: get_function_details({ name: "X" })
```

...then this feature is a HOME RUN.

If they don't follow it, we've learned something valuable: **agents need reactive guidance, not proactive documentation.**

Either way, we learn. That's worth shipping.

---

**Status:** APPROVED
**Escalation:** Ready for Вадим's review
