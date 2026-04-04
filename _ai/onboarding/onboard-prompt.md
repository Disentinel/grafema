# Onboard My Project with Grafema

One prompt. Paste into Claude Code. It installs Grafema, configures MCP, analyzes your code, and shows you what only a graph can see.

---

## Full prompt

```
Install and set up Grafema code graph for this project, then explore it with me.

SETUP (skip steps that are already done):
1. Install: npm install --save-dev grafema
2. Run initial analysis: npx grafema analyze
   This creates .grafema/ directory, auto-detects project structure, and builds the graph.
   Wait for it to complete.
3. Create .mcp.json in project root (if not exists):
   { "mcpServers": { "grafema": { "command": "npx", "args": ["grafema-mcp", "--project", "."] } } }
4. Tell me to restart Claude Code so MCP tools load.
   Wait for me to confirm before continuing.
5. Once MCP tools are available, run get_stats to verify the graph is loaded.

EXPLORE (once graph is loaded):
Core: make implicit explicit.

Don't ask me what I want. Show the most surprising findings first.
My reaction tells you where to go deeper.

Show what ONLY THE GRAPH can see (not stuff grep or linters find):
- Longest cross-boundary call chain (how many hops, which files)
- Missing auth/validation on entry points (privilege escalation paths)
- Functions named get*/find*/fetch* that have mutation side effects
- Highest blast-radius files (most transitive callers)
- Surprising coupling between seemingly unrelated modules
- Dead code: exported functions with zero callers

Lead every finding with specific numbers.

For each finding check:
- Should this become a guarantee rule? (implicit rule → CI gate)
- Is there a custom pattern I can't trace through? → offer to write a plugin
- Is this a known problem? → offer to create a refactoring task

PRINCIPLES:
- Show before ask. Numbers = trust.
- Each answer → knowledge (memory)? capability (plugin)? guarantee (rule)? action (task)?
- Write findings to memory immediately. Session can die anytime.
- "I don't know" from user = suggest a task, not a dead end.
- If Grafema can't trace something: workaround + offer to report to devs.
- After any plugin/re-analysis: show what changed, quantified.
- Ask before external actions (creating issues, pushing code).
```

---

## Short version

```
Install grafema (npm install --save-dev grafema), run npx grafema analyze,
create .mcp.json with {"mcpServers":{"grafema":{"command":"npx","args":["grafema-mcp","--project","."]}}}
then tell me to restart CC. After restart: run get_stats, then show the most
surprising graph-only findings — longest call chains, missing auth, blast radius,
surprising coupling. Lead with numbers. Write to memory immediately.
```

---

## URL version

User just says:

```
Read https://raw.githubusercontent.com/Disentinel/grafema/main/_ai/onboarding/onboard-prompt.md and follow the full prompt instructions.
```
