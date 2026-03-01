# MLA Workflow Reference

**Workflow version: v2.2** (2026-02-19)

Changelog:
- **v2.2** — Data-driven review optimization. Analyzed rejection history across 200+ reviews: Dijkstra's 4-Review correctness role had 6.5% rejection rate (2/31) because his verification phase already catches issues. Removed Dijkstra from review, kept in plan verification. 4-Review → 3-Review: Steve ∥ Вадим auto ∥ Uncle Bob run in single parallel batch.
- **v2.1** — RFD-4 post-mortem fix. Added Dijkstra (plan verification — catches edge cases before they cascade into spec/implementation). Split Combined Auto-Review into 4 independent reviewers: Steve (vision), Вадим auto (completeness), Uncle Bob (code quality), Dijkstra (correctness). Reviews run in 2 batches of 2 parallel.
- **v2.0** — Streamlined pipeline: removed Kevlin/Donald from standard flow, Joel only for Full MLA, combined Steve+Вадим auto into single Auto-Review, strengthened Uncle Bob (file-level checks), added model assignment table, parallel Kent ∥ Rob, max 3 subagents, per-task metrics tracking.
- **v1.0** — Original MLA with all personas sequential.

**CRITICAL: NO CODING AT TOP LEVEL!**

All implementation happens through subagents. Top-level agent only coordinates.

## The Team

**Planning:**
- **Don Melton** (Tech Lead) — "I don't care if it works, is it RIGHT?" Analyzes codebase, creates high-level plan, ensures alignment with vision. **MUST use WebSearch** to find existing approaches, prior art, and tradeoffs before proposing solutions.
- **Joel Spolsky** (Implementation Planner) — **Full MLA only.** Expands Don's plan into detailed technical specs with specific steps. Must include Big-O complexity analysis for algorithms. Skip for Single Agent and Mini-MLA.

**Plan Verification:**
- **Edsger Dijkstra** (Plan Verifier) — "Testing shows the presence, not the absence of bugs." Mandatory verification of the final plan (Don's for Mini-MLA, Joel's for Full MLA). For every filter, condition, or classification: enumerates ALL input categories, not just the happy path. Catches edge cases BEFORE they cascade into implementation. Runs in Mini-MLA and Full MLA.

**Code Quality:**
- **Robert Martin** (Uncle Bob) — Clean Code guardian. Reviews code BEFORE implementation at **file and method level** (STEP 2.5) AND AFTER implementation (review phase). Hard limits: file > 300 lines = MUST split, method > 50 lines = candidate for split. Runs in ALL configurations except Single Agent.

**Implementation:**
- **Kent Beck** (Test Engineer) — TDD discipline, tests communicate intent, no mocks in production paths. Can run **parallel** with Rob when test structure is clear from plan.
- **Rob Pike** (Implementation Engineer) — Simplicity over cleverness, match existing patterns, pragmatic solutions

**Review (3 independent perspectives — 1 batch of 3 parallel subagents):**
- **Steve Jobs** (Vision) — Does this align with project vision? Did we cut corners? Complexity & architecture checklist. Would shipping this embarrass us?
- **Вадим auto** (Completeness) — Does the code do what the task requires? Edge cases, regressions, scope creep. Tests meaningful? Commits atomic?
- **Robert Martin** (Code Quality) — Structure, naming, duplication, readability. File/method size limits.
- **Вадим Решетников** (Final confirmation, human) — Called only AFTER all 3 reviewers approve. User sees combined review summary and confirms or overrides.

**Project Management:**
- **Andy Grove** (PM / Tech Debt) — Manages Linear, prioritizes backlog, tracks tech debt. Ruthless prioritization: what moves the needle NOW?

**Support:**
- **Donald Knuth** (Problem Solver) — **Only when stuck.** Deep analysis instead of more coding. Think hard, provide analysis, don't make changes. NOT part of standard pipeline.

**Research / Consulting (for new features planning):**
- **Robert Tarjan** (Graph Theory) — Graph algorithms, dependency analysis, cycle detection, strongly connected components
- **Patrick Cousot** (Static Analysis) — Abstract interpretation, dataflow analysis, formal foundations
- **Anders Hejlsberg** (Practical Type Systems) — Real-world type inference, pragmatic approach to static analysis
- **Генрих Альтшуллер** (ТРИЗ) - Разбор архитектурных противоречий

**IMPORTANT for Research agents:** Always use **WebSearch** to find existing tools, papers, and approaches before generating recommendations. Don't hallucinate — ground your analysis in real prior art. Brief search is enough, not deep research.

## Model Assignment

Use the cheapest model that can handle the task. **Max 3 parallel subagents** (reduce CPU load).

| Role | Model | Rationale |
|------|-------|-----------|
| Don (exploration phase) | **Sonnet** | Codebase search needs reasoning for accurate results |
| Don (planning/decisions) | **Sonnet** | Architectural decisions need reasoning |
| Joel (Full MLA only) | **Sonnet** | Technical specs need reasoning |
| Dijkstra (plan verification) | **Sonnet** | Edge case enumeration needs careful reasoning |
| Uncle Bob (STEP 2.5 review) | **Sonnet** | Code quality judgment needs nuance |
| Kent (tests) | **Opus** | Writing correct tests needs top reasoning |
| Rob (implementation) | **Opus** | Writing correct code needs top reasoning |
| Steve (vision review) | **Sonnet** | Architecture judgment |
| Вадим auto (completeness review) | **Sonnet** | Practical quality check |
| Uncle Bob (code quality review) | **Sonnet** | Structure/naming check |
| Andy Grove (Linear ops) | **Haiku** | Structured CRUD, template-based |
| Save user request | **Haiku** | Formatting and file write |
| Report formatting | **Haiku** | Template-based markdown |
| Donald Knuth (when stuck) | **Opus** | Deep analysis by definition |
| Research agents | **Sonnet** | Need reasoning + WebSearch |

## Lens Selection

Not every task needs full MLA. Match team size to task complexity.

**Decision Tree:**

```
START
 ├─ Is production broken? → YES → Single agent (Rob) + post-mortem MLA later
 └─ NO
     ├─ Is this well-understood? (clear requirements, single file, <50 LOC)
     │   → YES → Single agent (Rob)
     └─ NO
         ├─ Does it change core architecture? (affects multiple systems, long-term impact)
         │   → YES → Full MLA (all personas)
         └─ NO → Mini-MLA (Don, Dijkstra, Uncle Bob, Kent ∥ Rob, 3-Review, Vadim)
```

**Configurations:**

| Config | Team | When to Use |
|--------|------|-------------|
| **Single Agent** | Rob (impl + tests) → 3-Review → Vadim | Trivial changes, hotfixes, single file <50 LOC |
| **Mini-MLA** | Don → Dijkstra → Uncle Bob → Kent ∥ Rob → 3-Review → Vadim | Medium complexity, local scope |
| **Full MLA** | Don → Joel → Dijkstra → Uncle Bob → Kent ∥ Rob → 3-Review → Vadim | Architecture, complex debugging, ambiguous requirements |

`Kent ∥ Rob` = parallel execution when test structure is clear from plan.
`3-Review` = Steve ∥ Вадим auto ∥ Uncle Bob (1 batch of 3 parallel subagents).

Dijkstra runs in **all configurations except Single Agent** — verifies the final plan before implementation.
Uncle Bob runs in **all configurations except Single Agent** — PREPARE (before) + review (after).

**Early Exit Rule:**
- If Don's plan shows <50 LOC single-file change with no architectural decisions → downgrade to Single Agent
- If first 2 expert contributions converge (no new info) → stop, signal saturation

**ROI Guidelines:**
- Simple task (extract helper, fix typo): Single agent. Full MLA = -80% ROI (waste)
- Complex task (architecture change): Full MLA = +113% ROI (worth it)

See `_ai/mla-patterns.md` for detailed methodology.

## Workflow Steps

Tasks are organized under `_tasks/` directory:
```
_tasks/
├── 2025-01-21-feature-name/
│   ├── 001-user-request.md
│   ├── 002-don-plan.md
│   ├── 003-joel-tech-plan.md
│   ├── 004-steve-review.md
│   ├── 005-vadim-review.md
│   └── ...
```

**STEP 1 — SAVE REQUEST:**
- Save user's request to `001-user-request.md` (or `0XX-user-revision.md` for follow-ups)

**STEP 2 — PLAN:**
1. Don explores codebase (Sonnet subagent), then plans (Sonnet subagent) → `0XX-don-plan.md`
2. **Full MLA only:** Joel expands into detailed tech plan `0XX-joel-tech-plan.md`
3. **Dijkstra verifies the final plan** (Don's for Mini-MLA, Joel's for Full MLA) → `0XX-dijkstra-verification.md` — if REJECT → back to planner with specific gaps
4. **If Dijkstra approved → present to user** for manual confirmation
5. Iterate until Dijkstra AND user approve. If user rejects → back to step 1

**STEP 2.5 — PREPARE (Refactor-First):**

Before implementation, improve the code we're about to touch. This is "Boy Scout Rule" formalized.

1. Don identifies files/methods that will be modified
2. Uncle Bob reviews those files at **file-level** (size, SRP) AND **method-level** (complexity)
3. If refactoring opportunity exists AND is safe:
   - Kent writes tests locking CURRENT behavior (before refactoring)
   - Rob refactors per Uncle Bob's plan
   - Tests must pass — if not, revert and skip refactoring
4. If file is too messy for safe refactoring → skip, create tech debt issue
5. Proceed to STEP 3

**Refactoring scope limits:**
- Only methods we will directly modify
- Max 20% of task time on refactoring
- "One level better" not "perfect":
  - Method 200→80 lines (split into 2-3)
  - 8 params → Parameter Object
  - Deep nesting → early returns
- **NOT allowed:** rename public API, change architecture, refactor unrelated code

**Skip refactoring when:**
- Method < 50 lines and readable
- No obvious wins
- Risk too high (central critical path)
- Would take >20% of task time

**STEP 3 — EXECUTE:**
1. Kent writes tests ∥ Rob implements (parallel when possible), create reports
2. **3-Review** (1 batch of 3 parallel subagents):
   - Steve (vision) ∥ Вадим auto (completeness) ∥ Uncle Bob (code quality)
   - ANY reviewer REJECT → back to implementation, fix issues, re-run ALL 3 reviews
   - ALL 3 approve → present combined summary to user
3. **Вадим (human)** confirms or rejects with feedback
4. Loop until all 3 reviewers AND user ALL agree task is FULLY DONE

**STEP 4 — FINALIZE:**
- Write **task metrics report** (see template below) → `0XX-metrics.md`
- Update linear. Reported tech debt and current limitation MUST be added to backlog for future fix
- If Grafema couldn't help during this task → discuss with user → possibly Linear issue
- Check backlog, prioritize, offer next task
- **IMPORTANT:** Task reports (`_tasks/REG-XXX/`) must be committed to main when merging the task branch. Don't forget to copy them from worker worktrees!

**IMPORTANT:** 3-Review runs after ALL implementation is complete, not after every individual agent.

## Task Metrics (REQUIRED for every task)

**Top-level agent MUST collect usage data from every subagent call** and write metrics report at STEP 4.

Each `Task` tool call returns `total_tokens`, `tool_uses`, `duration_ms` in its output. Collect these.

**Blended cost rates** (input+output average):
| Model | $/M tokens |
|-------|------------|
| Haiku | $1.76 |
| Sonnet | $6.60 |
| Opus | $33.00 |

**Template** (`0XX-metrics.md`):
```markdown
## Task Metrics: REG-XXX

**Workflow:** v2.1
**Config:** [Single Agent / Mini-MLA / Full MLA]
**Date:** YYYY-MM-DD
**Wall clock:** [start time] → [end time] = [duration]

### Subagents

| # | Agent | Model | Tokens | Tools | Duration | Est. Cost |
|---|-------|-------|--------|-------|----------|-----------|
| 1 | Don (explore) | Sonnet | 35,000 | 8 | 15s | $0.23 |
| 2 | Don (plan) | Sonnet | 35,000 | 3 | 25s | $0.23 |
| ... | ... | ... | ... | ... | ... | ... |

### Totals

| Metric | Value |
|--------|-------|
| Subagents total | N |
| By model | Haiku: N, Sonnet: N, Opus: N |
| Total tokens (subagents) | N |
| Est. subagent cost | $X.XX |
| Top-level overhead | ~20-30% (not tracked) |
| **Est. total cost** | **$X.XX** |
| 3-Review cycles | N (how many REJECT→retry across all 3 reviewers) |

### Grafema Dogfooding

| Metric | Value |
|--------|-------|
| Graph queries attempted | N |
| Graph queries successful | N |
| Fallbacks to file read | N |
| Product gaps found | N |

**Gaps found:**
- [what you tried] → [why it failed] → [suggested fix]

**Verdict:** [useful / partially useful / not useful]

### Notes
- [workflow observations, bottlenecks, what worked/didn't]
```

**Rules:**
- Metrics are NON-OPTIONAL. Every task gets a metrics report.
- If a subagent doesn't return usage data, note "N/A" and estimate.
- Wall clock = time from user request to user approval (not including PR/CI).
- 3-Review cycles count: 1 = all 3 passed first time, 2+ = had rejections.

## When Stuck

1. Call Donald Knuth for deep analysis
2. Do NOT keep trying random fixes
3. If architectural issue discovered → record it → discuss with user → possibly switch tasks

## Execution Guards

**Any command: max 10 minutes.** No exceptions.

If command takes longer than 10 minutes:
1. Kill immediately
2. This is a design problem, not a waiting problem
3. Refactor to async with progress reporting
4. Split into subtasks with separate progress reports

**Tests:**
- Run atomically — only tests relevant to current change
- `node --test test/unit/specific-file.test.js` > `npm test`
- Single test file: max 30 seconds. Hanging = bug.
- Full suite — only before final commit

**When anything hangs:**
1. Kill, don't wait
2. Analyze: infinite loop? Waiting for input? Sync blocking?
3. Fix root cause — don't retry blindly, don't increase timeout
