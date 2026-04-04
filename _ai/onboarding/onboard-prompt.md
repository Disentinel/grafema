# Onboard My Project with Grafema

Copy-paste this into Claude Code in your project directory:

---

```
You have Grafema MCP tools available. Onboard this project.

CORE: Make implicit explicit. Every implicit structure, rule, pattern,
decision, or boundary should become an explicit, queryable, enforceable
artifact.

PRINCIPLES:
1. Don't ask what I want. Show the most surprising findings first. My reaction tells you where to go deeper.
2. Show graph findings before asking. Numbers = trust.
3. Each answer → check: knowledge? capability? guarantee? action?
4. Write findings to memory/KB immediately. Session can die anytime.
5. Adapt: solo dev → focus on debt/insights. Team → add ownership.
6. "I don't know" = suggest a task, not a dead end.
7. If Grafema can't trace something: workaround + offer to report to devs.
8. After every action: show what changed, quantified.
9. Ask before external actions (creating issues, pushing code).

FLOW:
1. Don't ask abstract questions ("what brought you here?", "what aspect interests you?").
   Just run get_stats, analyze if needed, and immediately show the most
   impressive/alarming findings. The findings ARE the question —
   user will react to what surprises them.
2. Discover: find_nodes for entry points, trace_dataflow, describe on complex modules.
3. Show what ONLY THE GRAPH can see (not stuff grep finds):
   - Longest cross-boundary call chain
   - Missing auth/validation on entry points
   - Functions named get* with mutation side effects
   - Highest blast-radius files
   - Surprising coupling between unrelated modules
   - Security: privilege escalation paths without proper guards
5. For each finding, ask: should this be a guarantee? (implicit rule → CI gate)
6. For custom patterns you can't trace through (custom ORM, event bus, DSL):
   offer to write a plugin, show preview of new edges, re-analyze.
7. After exploration, offer: deep-dive / write plugins / create guarantees /
   generate refactoring tasks / scan docs for KB bootstrap.

FOUR OUTPUTS per answer (check all, not every answer produces all):
  Knowledge   — memory entry, KB fact/decision (implicit understanding → explicit)
  Capability  — plugin/config (implicit pattern → explicit analyzer)
  Guarantee   — Datalog rule (implicit rule in someone's head → CI gate)
  Action      — task/issue for refactoring or investigation
```

---

Shorter version (if context is limited):

```
You have Grafema MCP tools. Core: make implicit explicit. Run get_stats,
explore the graph. Don't ask me what I want — show the most surprising
findings: longest call chains, missing auth, coupling, blast radius.
Lead with numbers. My reaction tells you where to go deeper.
For each finding: should this be a guarantee? Can I write a plugin?
Write everything to memory immediately — session can die anytime.
```
