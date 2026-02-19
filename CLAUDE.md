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

## Architecture

- **Plugin-based, modular architecture**
- Modules: `types`, `core`, `cli`, `mcp`, `gui`
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
2. **Read MLA workflow** — `_ai/mla-workflow.md` for process steps, team roster, model assignment
3. **Select MLA configuration** using the Lens Selection decision tree:
   - Well-understood, single file, <50 LOC → **Single Agent**
   - Medium complexity, local scope → **Mini-MLA** (most common)
   - Core architecture change, multi-system, ambiguous → **Full MLA**
4. **Read persona instructions** — `_ai/agent-personas.md` for the specific agents you'll spawn
5. **Execute the workflow** — follow STEP 1 through STEP 4 from `_ai/mla-workflow.md`

If user provides just a task ID without further context, the Linear issue description IS the task request.

## MLA Workflow (Summary)

**Full details:** `_ai/mla-workflow.md` (team roster, model table, steps, metrics template)
**Persona prompts:** `_ai/agent-personas.md` (pass relevant section to each subagent)
**Dogfooding guide:** `_ai/dogfooding.md` (graph-first exploration, gap tracking)

**CRITICAL: NO CODING AT TOP LEVEL!** All implementation happens through subagents.

**Pipeline:** STEP 1 (save request) → STEP 2 (plan + verify) → STEP 2.5 (prepare/refactor) → STEP 3 (implement + 3-review) → STEP 4 (finalize + metrics)

**3-Review:** Steve ∥ Вадим auto ∥ Uncle Bob (single parallel batch). ANY REJECT → fix + re-run ALL 3. ALL approve → present to user.

**Configurations:**

| Config | Team | When to Use |
|--------|------|-------------|
| **Single Agent** | Rob → 3-Review → Vadim | Trivial, single file <50 LOC |
| **Mini-MLA** | Don → Dijkstra → Uncle Bob → Kent ∥ Rob → 3-Review → Vadim | Medium complexity |
| **Full MLA** | Don → Joel → Dijkstra → Uncle Bob → Kent ∥ Rob → 3-Review → Vadim | Architecture changes |

## Forbidden Patterns

### Never in Production Code
- `TODO`, `FIXME`, `HACK`, `XXX`
- `mock`, `stub`, `fake` (outside test files)
- Empty implementations: `return null`, `{}`
- Commented-out code

### Never Do
- Changes outside scope without discussing first
- "Improvements" nobody asked for
- Refactoring OUTSIDE of STEP 2.5
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

**New task:** `git fetch && git checkout main && git pull && git checkout -b task/REG-XXX` → update Linear → In Progress → save request → start MLA.

**Finishing:** 3-Review → user confirms → create PR → Linear → In Review → CI green → merge → Done.

## Agent Teams (Experimental)

Agent Teams — экспериментальная фича Claude Code для координации нескольких инстансов с shared task list.

**Use for:** parallel research, code review с разных ракурсов, independent modules, debugging competing hypotheses.
**NOT for:** MLA workflow (use worktrees), sequential dependencies, edits to same files.

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
