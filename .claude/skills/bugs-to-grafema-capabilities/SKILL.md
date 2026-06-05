---
name: bugs-to-grafema-capabilities
description: |
  Fires after fixing any non-trivial bug or regression. Asks: could the graph have caught this as a guarantee? Pairs with reflection-in-and-on-action — picks up after "earliest catchable signal" and asks the next question: was that signal expressible in graph?
  Triggers:
  (1) after any non-trivial bug fix is verified working,
  (2) after a regression report (something used to work, broke),
  (3) during step 6 (knowledge extraction) of the workflow,
  (4) when reflection-on-action surfaces a "would have been catchable" signal.
  Outcome is a triage decision (graph-reachable? rule expressible? rule sound?) and either a draft Linear issue + guarantee proposal, or a recorded "graph capability gap" note. Never auto-creates guarantees.
author: Claude Code
version: 1.0.0
date: 2026-04-28
---

# Bugs → Grafema capabilities

## Why this skill

Grafema's core thesis: **AI should query the graph, not read code.** A bug that was structurally visible — wrong call ordering, missing edge, dead branch, type mismatch — but never queried for is a missed guarantee. Every such bug is a chance to convert one-time pain into permanent CI protection.

Without this skill the loop breaks: bug fixed → moved on → next session repeats the same class. With this skill: bug fixed → pattern extracted → guarantee proposed → next sibling caught before merge.

**Anchored to project vision** (`CLAUDE.md`): "If reading code gives better results than querying Grafema — that's a product gap, not a workflow choice." A bug we caught by reading is exactly such a gap, until proven otherwise.

## Pair with reflection-in-and-on-action

`reflection-in-and-on-action` ends a fix with three questions: predicted vs actual, **earliest catchable signal**, reusable pattern. Read those answers, then run THIS skill on the second one.

If reflection said "no clear earliest signal" → record that and stop. Don't force a rule on a non-structural bug. That's an honest "not graph material" outcome, not a failure.

If reflection said "the signal was X visible at code-shape level" → continue below.

## Triggers (fire post-fix, NOT mid-fix)

- Any non-trivial bug fix has been verified working (build green, test passes, e2e confirms)
- A regression report just got resolved (something used to work, broke, was fixed)
- Step 6 of workflow — knowledge extraction — and the session contained at least one bug fix
- When `reflection-in-and-on-action` produces an "earliest catchable signal" and the signal is structural

DO NOT fire mid-fix. Premise reflection during the fix; capability reflection after. Mixing them blurs both.

## Procedure

### Step 1 — Triage scope: is the bug graph-reachable?

Stop and skip if:
- Bug is in a language Grafema doesn't analyze. Currently the orchestrator self-analyzes JS/TS/Haskell/Rust/Python/Go/Java/Kotlin/Swift/ObjC/BEAM. Check `spawn_analysis!` in `packages/grafema-orchestrator/src/main.rs` for the live list — anything else is out of reach.
- Bug is in build/CI/infrastructure (cargo flags, GitHub Actions, environment variables)
- Bug is environmental: timing, network, OS-level race, file-system contention
- Bug requires concrete runtime values (specific user input, specific data shapes only seen in prod)

Continue if the bug shape is structural: wrong call, missing edge, ordering of operations, scope/lifetime, type mismatch, dead code, resource lifecycle, dispatch-target mismatch, dependency cycle.

### Step 2 — Generalize the bug into TWO patterns

Forget the specific lines. Sketch:

1. **Narrow pattern** — captures THIS bug exactly. E.g. "function holding pool lock A then calling B which acquires A again."
2. **Broader pattern** — variants that share the same failure mode. E.g. "any function holding a finite-resource handle, then calling into a function that re-acquires the same resource type."

Both matter. Narrow tests viability of the rule; broad tests its value. A guarantee that fires only on the original bug location is solving the past, not the future.

### Step 3 — Express in Datalog (or surface why you can't)

Map the pattern to graph primitives:

- **Nodes**: FUNCTION, METHOD, MODULE, CALL, BRANCH, VARIABLE, PARAMETER, CLASS, ISSUE, METRIC
- **Edges**: CONTAINS, CALLS, ASSIGNED_FROM, GUARDED_WRITE, OBSERVES, DEPENDS_ON, INSTANCE_OF, PASSES_ARGUMENT
- **Numeric**: `lt`, `gt`, `lte`, `gte` on attributes (line, count)
- **Negation**: `\+` for "no edge of type X"

If the rule needs concepts that don't exist as nodes/edges yet — STOP. Record the gap. **A graph capability gap is more valuable than the rule itself**, because it points to product work, not just lint work. Examples of capability gaps caught this way:
- "Need a `RECEIVER_CALL` edge to detect `a().b()` chain receivers" (resolved Apr 2026)
- "Need cross-file call traversal via CALLS to detect dispatch-into-pool patterns" (open)

### Step 4 — Validate empirically (NON-NEGOTIABLE)

Write the Datalog. Run it. Three measurements:

1. **TP on origin** — does it fire on the specific function/file the bug lived in? If not, your model of the bug is wrong. Refine.
2. **TP elsewhere** — does it fire on at least 2 other locations? Inspect each. Are they real bugs you didn't know about, near-bugs, or false positives?
3. **FP rate** — manually classify all hits. A guarantee with >20% FP is **worse than no guarantee** — it desensitizes everyone to checks. Either tighten or abandon.

Pair with `break-new-abstractions-before-adopting`: sample widely. If you have <3 distinct true-positive hits, the rule isn't load-bearing yet. Don't propose it.

### Step 5 — Propose, don't auto-create

A graph guarantee gets wired into `grafema check` and CI — it's a product decision. Present:

- The Datalog rule (final form)
- Validation evidence: TP count with file:line refs, FP count with reasoning
- Originating bug (commit SHA, Linear issue if any)
- Draft Linear issue: REG-* (Reginaflow team) or RFD-* (RFDB team), labeled `Improvement` or `Bug`, version v0.2 or later

User decides. If green-lit:
1. `mcp__grafema__create_guarantee` — writes to `.grafema/guarantees.yaml`
2. File the Linear issue
3. Reference the originating bug commit in the guarantee description

### Step 6 — If not green-lit or fails Step 4

Record outcome in `_ai/gaps.md` (graph capability gap) or in memory (rule too noisy / pattern not structural). This is not a failure — it's calibration data for the next round. Pattern of repeated "not structural" outcomes in some domain → that domain may be inherently runtime-only and shouldn't be litigated again.

## Worked example — 2026-04-28 orchestrator deadlock

**Bug**: `acquire_all()` held the pool's only worker; `stream_and_resolve_single_worker` then called `pool.acquire()` on the same depleted pool; `drop(handles)` was unreachable. Deterministic deadlock.

**Step 1 — Graph-reachable?** Yes. Code lives in `packages/grafema-orchestrator/src/main.rs`, in-graph (1052 CALL nodes confirmed).

**Step 2 — Patterns:**
- Narrow: function calls `acquire_all()` then a later call to a function that internally calls `pool.acquire()`
- Broad: any function holding a resource at finite-pool capacity, then dispatching to code that re-enters the same pool

**Step 3 — Datalog draft:**
```datalog
violation(FnName, L1, L2) :-
  node(Fn, "FUNCTION"), attr(Fn, "name", FnName),
  edge(Fn, C1, "CONTAINS"), node(C1, "CALL"), attr(C1, "name", "acquire_all"), attr(C1, "line", L1),
  edge(Fn, C2, "CONTAINS"), node(C2, "CALL"), attr(C2, "name", "acquire"), attr(C2, "line", L2),
  lt(L1, L2).
```

**Step 4 — Validation:** Zero results. Initial diagnosis (and `_ai/gaps.md` entry) wrongly blamed missing analyzer; real cause: `pool.acquire()` is in `plugin.rs::stream_and_resolve_single_worker`, not in `main.rs`. Cross-file via CALLS edge required.

**Step 5 — Outcome:** No guarantee proposed. Recorded as graph capability gap: "cross-file call traversal for dispatch-into-pool patterns". Adding it depends on whether RFDB Datalog handles transitive CALLS efficiently — open product question.

**Lesson:** the validation step itself produced more value than the rule would have. The premature `_ai/gaps.md` entry blaming missing analyzer would have been pushed without Step 4.

## Anti-patterns

- **Auto-creating guarantees on first match.** No empirical sample → high FP risk → CI noise → desensitization. Always Step 4.
- **Skipping for "small" bugs.** Small bugs are exactly where guarantees pay off — cheap to add, easy to validate.
- **Forcing a rule when the pattern isn't structural.** "It just feels like the graph should catch this" — if you can't translate to nodes+edges, it can't, and that's fine.
- **Filing the task without validation.** A task to add a rule that doesn't fire even on the origin location is a false promise.
- **Reusing the bug-fix patch as the rule.** Patches reference specific lines; rules describe shapes. The skill is in the abstraction step, not the copying step.

## Connection to other skills

- `reflection-in-and-on-action` — predecessor; this skill consumes the "earliest catchable signal" answer
- `break-new-abstractions-before-adopting` — Step 4 borrows the "sample widely, ≥3 cases" bar
- `extract-knowledge` — Step 5 outcomes (rule, gap, or "not structural") are session-level findings worth saving regardless of whether a guarantee was proposed
- `materialize-only-what-queries-need` — sister principle for the graph: don't add edges/attrs for hypothetical rules; only add them when a concrete rule needs them
