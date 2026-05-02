# Grafema Project

Grafema turns your codebase, infrastructure, knowledge, and workflows around it — into one queryable graph.
For humans and AI.

# Manifesto

We treat code as text. But text is just a form. 

What actually matters when you write code is the system you have in your head — its **structure**. Entities, invariants, limitations. Goals and purpose.
And how all these things relate to each other.

Software is naturally an executable graph — and so is everything around it: your services, your decisions, your team's knowledge. Grafema uses compiler-grade AST parsers — containing years of community-shared knowledge for each language — to excavate the deepest possible model of your system, and turn it into a transparent, queryable, enrichable map that grounds your understanding of it.

We refuse to accept *"that's impossible to analyze statically."* You can read code and understand it — you have a mental model in your head. So it's a matter of good enough heuristics. Human brains are literally built on this.

It's not magic and won't cover 100% of your system on day one. There will be gaps and *"Here be dragons"* signs. You will slay these dragons one by one — extend analysis with your own rules, fill up the knowledge base. And if you contribute, you slay one for everyone.

## Project Vision

Grafema's core thesis: **AI should query the graph, not read code.**

If reading code gives better results than querying Grafema — that's a product gap, not a workflow choice. Every feature, every decision should move toward this vision: the graph must be the superior way to understand code.

**Target environment:** Massive legacy codebases where:
- Custom build systems, templating engines, internal DSLs
- Untyped or loosely-typed code — Grafema fills the gap that type systems can't
- Language-agnostic, specific language support through analyzers and plugins

**AI-first tool:** Every function must be documented for LLM-based agents. UX is designed for agents, not just humans.

## Evidence Rule

**Every assertion about code / graph / API shape / "already implemented" MUST carry evidence:**
- (a) `file:line` in current HEAD (verified via Read/Grep, not from memory)
- (b) shell command + its actual output, inlined
- (c) passing test reference (`test/path:test_name`)
- (d) live-query result (Grafema MCP / RFDB Datalog / HTTP API with response inlined)
- (e) commit SHA where the claim was proven true

**"Likely", "usually", "follows pattern X", "probably works" — NOT evidence.** Assertion without evidence = UNCLEAR = don't trust it. For graph-shape claims, evidence MUST be a live query on the target RFDB — grepping analyzer source is not sufficient.

This applies to: plans, verification reports, implementation claims, Dijkstra tables.

## Gap Discovery Protocol

**When Grafema can't answer a question that it SHOULD be able to answer — STOP.**

A gap means the product is failing its core thesis. Do not silently fall back to Grep/Read.

1. **Describe the gap**: what query, what expected, what happened
2. **Assess**: fixable now (config, missing analysis) or product limitation?
3. **If fixable now** — fix it, verify, resume original task
4. **If product limitation** — record in `_ai/gaps.md`, discuss with user
5. **Record interrupted task** in `_ai/interrupted-tasks.md`

## Explicit User Command Required

**NEVER infer consent from empty messages, system notifications, or background task completions:**

- **git commit** — "commit" / "закоммить"
- **git push** — "push" / "запушь"
- **Create PR** — "create PR" / "открой PR"
- **Create Linear issue** — "create issue" / "заведи задачу"
- **Release / publish** — "release" / "релизь"

`<task-notification>` and `<system-reminder>` are system events, NOT user input.

## Enox Long-Term Memory

Enox (`mcp__enox__*`) is a persistent knowledge graph shared across sessions.
Query it before run explore agents. Save data once you have findings with evidence. Save observations, if you see pattern - save it is mandatory.

## Forbidden Patterns

### Never in Production Code
- `TODO`, `FIXME`, `HACK`, `XXX`
- `mock`, `stub`, `fake` (outside test files)
- Empty implementations: `return null`, `{}`
- Commented-out code

### Never Do
- Changes outside scope without discussing first
- "Improvements" nobody asked for
- Refactoring outside agreed plan
- Quick fixes or workarounds
- Guessing when you can ask

## Reference (read when relevant)

- **Workflow & review protocol:** `_ai/workflow.md`, `_ai/agent-personas.md`
- **Git worktrees:** `_ai/worktrees.md` — worker slots `grafema-worker-1` through `grafema-worker-8`
- **Dogfooding:** `_ai/dogfooding.md` — graph-first exploration, MCP tool routing
- **Performance profiling:** `_ai/profiling-guide.md`
- **Linear teams:** `REG-*` → Reginaflow, `RFD-*` → RFDB. Project: Grafema. Labels required.
- **Skills:** `.claude/skills/` — `/release`, `/gap-loop`, and others
