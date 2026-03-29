# Pre-registration: External Codebase Experiment (v2)

**Date:** 2026-03-24
**Written BEFORE running any experiments.**

## Design

- **Projects:** h3 (HTTP framework, ~7k LOC), openworkflow (workflow engine, ~8k LOC), bullmq (job queue, ~14k LOC)
- **Conditions:** baseline (Grep/Read only, no CLAUDE.md) vs grafema (+ MCP graph tools)
- **Questions:** 10 per project, sourced from real onboarding exploration (not pre-designed)
- **Repeats:** N=3 per condition per project
- **Model:** Sonnet 4.6, temperature default
- **Isolation:** Run from /tmp (no CLAUDE.md loading)

## Hypotheses (pre-registered)

### H-PR1: Baseline accuracy ≤60% on tracing questions
**Rationale:** Without CLAUDE.md and on unfamiliar codebases, the agent should struggle with questions requiring understanding of cross-module flows. Simple grep-able questions will still work (~90%), but tracing/architecture questions should be much harder.
**Expected:** Baseline average judge score on tracing questions ≤ 3.0/5.

### H-PR2: Grafema improves tracing accuracy by ≥20%
**Rationale:** Graph provides pre-computed call graphs, data flow, and module relationships that are hard to reconstruct from file reads alone.
**Expected:** Grafema average judge score on tracing questions ≥ 3.6/5 (vs baseline ≤3.0).

### H-PR3: Grafema does NOT improve simple lookup questions
**Rationale:** Questions like "where is X defined" are solved by Grep equally well. Graph adds overhead without value here.
**Expected:** No significant difference in accuracy on simple questions (both ~80-90%).

### H-PR4: MCP adoption is lower on unfamiliar codebases
**Rationale:** On Grafema's own codebase, MCP instructions hinted at relevant tools. On unfamiliar code, the agent has less context about what to query.
**Expected:** MCP adoption < 50% (vs 70% on Grafema).

### H-PR5: Cost per question is lower with grafema on tracing questions
**Rationale:** If the graph provides direct answers for cross-module tracing, the agent should need fewer Grep+Read exploration cycles.
**Expected:** On tracing questions, grafema uses 20%+ fewer tokens than baseline.

## Falsification criteria

- If baseline scores ≥70% on tracing questions → our questions are too easy, need harder ones
- If grafema doesn't beat baseline on ANY category → MCP tools provide no value beyond what Grep/Read offer
- If N=3 runs show variance >15% between repeats → results are noise, need more repeats

## Statistical test

Paired sign test per question across conditions. Report p-value and 95% CI for mean difference.
