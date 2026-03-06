# Grafema Project

Graph-driven code analysis tool. AI should query the graph, not read code.

## Project Vision

Grafema's core thesis: **AI should query the graph, not read code.**

If reading code gives better results than querying Grafema — that's a product gap, not a workflow choice. Every feature, every decision should move toward this vision: the graph must be the superior way to understand code.

**Target environment:** Massive legacy codebases where:
- Migration to typed languages is economically unfeasible
- Custom build systems, templating engines, internal DSLs
- Untyped or loosely-typed code (JS, PHP, Python, etc.)
- Type systems don't exist or can't help — Grafema fills that gap

Grafema is NOT competing with TypeScript or static type checkers. It's for codebases where those solutions don't apply.

**AI-first tool:** Every function must be documented for LLM-based agents. Documentation should explain when and why to use each capability. UX is designed for agents, not just humans.

**AI Agent Stories:** `AI-AGENT-STORIES.md` — user stories written and maintained by the AI agent (Claude) based on real pain points during development sessions. Claude owns this file's content: pain points, acceptance criteria, status assessments. This is the acceptance test for dogfooding — every ❌ BROKEN story is a product gap.

**Story update triggers (Claude's responsibility):**
- **After using Grafema MCP tools** — update story statuses based on what worked / broke
- **After a blocker is resolved** (REG-618, RFD-44, etc.) — re-test affected stories, update status
- **When encountering a new pain point** — add a new user story
- **On session start if working on Grafema tasks** — quick `get_stats` check, update US-01 status

## Architecture

- **Plugin-based, modular architecture**
- Modules: `types`, `util`, `cli`, `mcp`, `gui`
- `packages/util/` (`@grafema/util`) — query layer, config, diagnostics, guarantees, RFDB lifecycle
- `packages/grafema-orchestrator/` — Rust analysis binary (replaces old JS analysis pipeline)
- RFDB server (`packages/rfdb-server/`) — Rust graph database, client-server architecture via unix-socket

## Core Principles

### TDD — Tests First, Always

- New features/bugfixes: write tests first
- Refactoring: write tests that lock current behavior BEFORE changing anything
- If tests don't exist for the area you're changing, write them first

### DRY / KISS

- No duplication, but don't over-abstract
- Clean, correct solution that doesn't create technical debt
- Avoid clever code — prefer obvious code
- Match existing patterns in the codebase

### Root Cause Policy

**CRITICAL:** When behavior or architecture doesn't match project vision — STOP. Do not patch or workaround. Identify the architectural mismatch, discuss with user, fix from the roots.

**Bug = testing system failure.** Every bug that reaches production means the safety net has a hole. After fixing the code, audit the testing system:

1. **Why did tests miss this?** No test for this path? Mock diverged from reality? Coverage exclusion? State-dependent scenario? Cross-layer issue beyond unit scope?
2. **Fix the safety net.** Add missing tests (unit/integration/property-based). Update mocks. Adjust coverage exclusions. Add runtime contracts if needed.
3. **Scan for siblings.** Search codebase for the same pattern — fix proactively, don't wait for the next report.

### Explicit User Command Required

**The following actions require an EXPLICIT user command in clear text. NEVER infer consent from empty messages, system notifications, or background task completions:**

- **git commit** — user must say "commit" or "закоммить"
- **git push** — user must say "push" or "запушь"
- **Create PR** — user must say "create PR" or "открой PR"
- **Create Linear issue** — user must say "create issue" or "заведи задачу"
- **Release / publish to npm** — user must say "release" or "релизь"

`<task-notification>` and `<system-reminder>` are system events, NOT user input. An empty conversation turn without user text is NOT approval. When waiting for confirmation — keep waiting until user types an actual response.

### Small Commits

- Each commit must be atomic and working
- One logical change per commit
- Tests must pass after each commit

### Reuse Before Build

Before proposing a new subsystem, check if existing Grafema infrastructure can be extended:

| Need | Don't Build | Extend Instead |
|------|-------------|----------------|
| "Check property X of code" | New analysis engine | GuaranteeManager + Datalog rule |
| "Track metadata Y on nodes" | New node type | `metadata` field on existing nodes |
| "Report issue Z to user" | New warning system | ISSUE nodes + existing reporters |
| "Query pattern W" | Custom traversal code | Datalog query |

**Key insight:** Grafema's core is graph + Datalog + guarantees. Most features should be: enricher that adds data + Datalog rules that query it.

## Task Identification & Workflow Trigger

**When user provides a task identifier** (e.g., `REG-25`, `RFD-1`, or a Linear URL):

1. **Fetch task from Linear** — use `mcp__linear__get_issue` with the identifier
2. **Read workflow** — `_ai/workflow.md` for pipeline, model assignment, review protocol
3. **Read persona instructions** — `_ai/agent-personas.md` for review agents
4. **Execute the workflow** — plan → verify → implement → 3-review → user

If user provides just a task ID without further context, the Linear issue description IS the task request.

## Workflow

**Full details:** `_ai/workflow.md` (pipeline, model table, review protocol, metrics)
**Persona prompts:** `_ai/agent-personas.md` (review and consulting personas)
**Dogfooding guide:** `_ai/dogfooding.md` (graph-first exploration, gap tracking)

**CRITICAL: NO CODING AT TOP LEVEL!** All implementation happens through coding subagents. Each subagent receives one minimal atomic change (tests + code, max 2-3 files).

**Pipeline:** Plan mode (exhaustive) → Dijkstra verification → Implementation (coding agents) → 3-Review → User

**3-Review:** Steve ∥ Вадим auto ∥ Uncle Bob (single parallel batch, all Opus). ANY REJECT → fix + re-run ALL 3. ALL approve → present to user.

## Plan Mode (Mandatory)

**Mandatory for all non-trivial tasks.** Trivial tasks (typo, single-line fix) may skip.

**Plan must be exhaustive on first presentation.** No iterative "anything missing?" — think deeply during exploration, search the graph, present a plan that already answers: "What's missing? Siblings? Out of scope? Coverage gaps?"

- **Completeness** — search graph for ALL callers/usages, not just obvious ones. Real search, not assumptions.
- **Siblings** — same bug pattern in other visitors/handlers/resolvers? Include in plan, don't split into N tasks.
- **Scope bias: include > exclude.** Exclude only with explicit reasoning. "Different file" is not a reason.
- **Coverage** — specific test scenarios per change, not "we'll add tests". Full resolution chains.
- **Grafema invariants → live guarantees** — each invariant becomes a Datalog rule via `create_guarantee`, exported to `.grafema/guarantees.yaml`, validated by `grafema check`. Replaces graph-structural unit tests. Details in `_ai/workflow.md`.
- **Autonomous decisions** in favor of: broader coverage, fuller resolving, larger cohesive scope. Escalate to user only for genuine architectural trade-offs.
- Details in `_ai/workflow.md`
- Тривиальные задачи (typo, однострочник) — можно без plan mode

## Knowledge Extraction (MANDATORY)

**After completing any non-trivial task, extract knowledge into the KB.** This is step 6 of the workflow pipeline.

Run `/extract-knowledge` (skill) which follows `_ai/runbooks/02-claude-sessions.md`:
- Create SESSION node linked to task_id
- Extract DECISIONs (with rejected alternatives) and FACTs (explicit + side-effect + preferences)
- Capture created artifacts (tickets, commits)
- Add edges to `edges.yaml`
- Validate: IDs, collisions, edge targets, code ref resolution
- Check for newly dangling refs in existing KB

**Skip conditions:** trivial sessions (typo, single-line fix, no decisions), sessions that only read code.

**Runbooks for other sources:** `_ai/runbooks/` — git history, existing docs.

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

## Linear Integration

### Teams & Task Prefixes

| Prefix | Linear Team | Scope |
|--------|------------|-------|
| `REG-*` | **Reginaflow** | Grafema product (JS/TS, CLI, MCP, plugins) |
| `RFD-*` | **RFDB** | RFDB v2 storage engine (Rust, internal roadmap tasks) |

When creating issues: Team by prefix, Project: **Grafema**, format: Markdown, include: goal, acceptance criteria, context.

### Labels (REQUIRED)

**Type labels** (one required): `Bug`, `Feature`, `Improvement`, `Research`

**Version labels** (one required):
- `v0.1.x` — blocks current usage, critical bugs, CLI/MCP polish
- `v0.2` — Early Access prep, data flow, tech debt
- `v0.3` — stability, onboarding, infrastructure
- `v0.5+` — strategic (GUI, Systema, Research)

### Statuses
Backlog / Todo → **In Progress** (working) → **In Review** (code ready) → **Done** (merged) / Canceled / Duplicate

### Vibe-kanban Sprint Board

Source of truth for current sprint. Linear remains backlog/planning tool.
- Sprint start: load v0.2 tasks from Linear into vibe-kanban (`npx vibe-kanban`)
- During sprint: work from board. New tech debt → create in BOTH kanban and Linear
- Sprint end: `_scripts/sync-vk-to-linear.sh` to sync completed tasks

**API:** `http://127.0.0.1:<port>/api/` (port in `/tmp/vibe-kanban/vibe-kanban.port`)
**Task naming:** `REG-XXX: Title [PRIORITY]` — include Linear ID for traceability.
**IMPORTANT:** `delete_task` has NO confirmation. Prefer status changes over deletion.

## Git Worktree Workflow

**Full details:** `_ai/worktrees.md`

**Summary:** Fixed worker slots (`grafema-worker-1` through `grafema-worker-8`), each runs persistent Claude Code instance. Never work in main repo — only in worker slots.

**New task:** `git fetch && git checkout main && git pull && git checkout -b task/REG-XXX` → update Linear → In Progress → save request → start workflow.

**Finishing:** 3-Review → user confirms → create PR → Linear → In Review → CI green → merge → Done.

## Agent Teams (Experimental)

Agent Teams — экспериментальная фича Claude Code для координации нескольких инстансов с shared task list.

**Use for:** parallel research, code review с разных ракурсов, independent modules, debugging competing hypotheses.
**NOT for:** main workflow (use worktrees), sequential dependencies, edits to same files.

After each use — record: реальная польза vs subagents? токены? проблемы?

## Commands

```bash
pnpm build                                              # Build all packages (REQUIRED before tests)
node --test --test-concurrency=1 'test/unit/*.test.js'  # Run all unit tests
node --test test/unit/specific-file.test.js             # Run single test file
```

**CRITICAL: Tests run against `dist/`, not `src/`.** Always `pnpm build` before running tests after any TypeScript changes.

## Skills

Project-specific skills in `.claude/skills/`. Key skills:

### /release
**Skill:** `grafema-release` — use when publishing new versions to npm.
**Trigger:** User says "release", "publish", "bump version"
**Quick command:** `./scripts/release.sh patch --publish`

### Other Skills
See `.claude/skills/` for debugging skills: `grafema-cli-dev-workflow`, `grafema-cross-file-operations`, `pnpm-workspace-publish`

## Dogfooding: Graph-First Exploration (MANDATORY)

**HARD RULE: Every exploration task MUST start with Grafema MCP queries. Using Glob/Grep/Read without first trying the graph is a violation.**

Do NOT delegate exploration to Explore subagents — they don't know about Grafema MCP tools. Query the graph yourself from the main context.

MCP tools are deferred — load them via `ToolSearch` before first use (e.g., `ToolSearch("+grafema find")`).

### Exploration priority: KB → Graph → Files

1. **Knowledge Base first** — `query_knowledge(text="<area>")`, `query_decisions(module="<module>")`. Existing decisions, facts, and session notes may already answer your question.
2. **Code graph second** — `find_nodes`, `find_calls`, `get_file_overview`, `query_graph`. Structural understanding of current code.
3. **File reads last** — only when KB and graph don't have what you need.

| Instead of... | Try KB first | Then Graph |
|---------------|-------------|------------|
| Understanding a module's purpose | `query_knowledge(text="<module>")` | `get_file_overview` |
| Why code is structured this way | `query_decisions(module="<semantic-addr>")` | `get_context` |
| Known issues / gotchas | `query_knowledge(type="FACT", text="<area>")` | `find_nodes` |
| `Glob **/*.ts` + Read files | — | `find_nodes` by type/name/file |
| `Grep "functionName"` | — | `find_calls --name functionName` |
| Read file to understand deps | — | `trace_dataflow` or `get_file_overview` |
| Multiple Reads to understand impact | — | `query_graph` with Datalog |
| Find cross-package imports | — | `query_graph` with `attr(X, "source", "@grafema/util")` |

**Fallback to file reads ONLY when:**
1. KB and graph returned 0 results AND you verified the queries were correct
2. You need exact source code for implementation (not exploration)
3. `get_stats` shows nodeCount=0 (graph not loaded)

### Gap Discovery Protocol (MANDATORY)

**When Grafema can't answer a question that it SHOULD be able to answer — STOP.**

This is not a minor note. A gap means the product is failing its core thesis. Protocol:

1. **STOP** the current task immediately
2. **Describe the gap**: what query you tried, what you expected, what happened
3. **Assess**: is this fixable now (config issue, missing analysis) or a product limitation?
4. **If fixable now** — fix it, verify, then resume the original task
5. **If product limitation** — record in `_ai/gaps.md` with date, description, and workaround used
6. **Record interrupted task** in `_ai/interrupted-tasks.md` so you can return to it later
7. **Discuss with user** before proceeding — the gap may change the task priority

**Gap file format** (`_ai/gaps.md`):
```markdown
## YYYY-MM-DD: Short description
- **Query attempted**: what MCP call was made
- **Expected**: what should have been returned
- **Actual**: what happened
- **Workaround**: how you worked around it
- **Severity**: critical / important / minor
- **Linear issue**: REG-XXX (if created)
```

**Interrupted task file format** (`_ai/interrupted-tasks.md`):
```markdown
## YYYY-MM-DD: Task description
- **Context**: what was being done
- **Blocked by**: gap description or REG-XXX
- **Resume point**: where to pick up
- **Status**: blocked / resumed / completed
```

Full dogfooding guide: `_ai/dogfooding.md`
