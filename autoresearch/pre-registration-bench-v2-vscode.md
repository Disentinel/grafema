# Pre-registration: Benchmark v2 — VS Code (REG-1173)

**Date:** 2026-06-14
**Written BEFORE running any agent experiments.**
**Related:** REG-1173 (Linear), REG-1172 (skill v1.0.0 now in ai-dev)

---

## Background

Benchmark v1 (2026-03-25) showed on vscode (n=30, 2 conditions):
- Grafema (+MCP, unguided): 27% MCP adoption, +36% output tokens, +42% latency
- Quality: 28/30 both — no measurable accuracy difference (no LLM judge in v1)
- Key gap: agent defaulted to grep+read even with MCP available

**What v1 could not tell us:**
1. Whether a properly-guided agent (with tiering skill) avoids the overhead on Tier-1 questions
2. Whether forced graph use on Tier-3/4 questions improves quality enough to matter
3. Whether graph advantage depends on codebase scale (vscode >> grafema self >> small repos)

---

## Design v2

### Conditions (3)

| Condition | Prompt | MCP | Label |
|-----------|--------|-----|-------|
| a — baseline | `baseline.md` | No | "grep+read" |
| b — forced-graph | `grafema.md` (v1 original "use graph tools" prompt) | Yes | "forced-graph" |
| c — skill-guided | `skill-guided.md` (this PR, tiering table + de-escalation) | Yes | "skill-guided" |

Condition b replicates v1 grafema condition for longitudinal comparability.
Condition c tests the GTM hypothesis: *"evaluation agent beats obedience"*.

### Question battery (n=60 on vscode)

Combined battery:
- `_archive/experiment/autoresearch-vscode/questions.yaml` — v1 n=30 (L1/L4/Q01-Q20)
- `autoresearch/questions-vscode-v2.yaml` — new n=30 (T1-T4 explicit stratification)

Tier distribution (combined 60):
- Tier 1 (text): ~10 questions (L1-01..05, T1-01..05)
- Tier 2 (lookup): ~10 questions (T2-01..08 + 2 implicit from v1)
- Tier 3 (relations): ~18 questions
- Tier 4 (flow/arch): ~22 questions

### Scale axis (v2 addition)

Three codebase scales for the scale-dependence hypothesis:
1. **vscode** — 4.4M nodes / 9.1M edges (large, canon scale)
2. **grafema-self** — ~203K nodes / ~385K edges (medium)
3. **h3** (HTTP framework) — ~7K LOC (small)

Questions for grafema-self: `autoresearch/questions.yaml` (existing)
Questions for h3: `autoresearch/questions-h3.yaml` (existing)

Each scale × 3 conditions = 9 run configurations total (vscode is primary; others secondary).

### Repeats

- Primary (vscode): N=3 repeats per question per condition (180 agent runs for vscode alone)
- Secondary (grafema-self, h3): N=1 for scale validation (not for statistical power)

### Evaluation

Blind LLM judge (Opus 4.8) scores each answer 0–5 against `golden_answer_hint`.
Evaluator does not see which condition produced the answer.
Per-tier accuracy + tokens/session reported separately.

---

## Hypotheses (pre-registered)

### H1: Skill-guided routes correctly (Tier 1 → grep, Tier 3/4 → graph)
**Metric:** MCP adoption rate per tier — Tier 1 < 15%, Tier 3/4 > 60%
**Why falsifiable:** v1 forced-graph had 27% adoption on ALL questions; correct routing means Tier-1 adoption DROPS while Tier-3/4 adoption RISES vs forced-graph.

### H2: Skill-guided outperforms forced-graph on Tier-1 accuracy (or equal quality, lower cost)
**Metric:** Δ tokens on Tier-1: skill-guided uses ≤20% tokens vs baseline (not +36% like forced-graph)
**Why falsifiable:** if skill-guided still blows tokens on simple lookups, the skill prompt isn't working.

### H3: Forced-graph wins on Tier-4 quality vs baseline
**Metric:** LLM judge score on Tier-4 questions: forced-graph and skill-guided both ≥20% improvement vs baseline
**Why falsifiable:** v1 had no quality data; this is the core product claim.

### H4: Graph advantage requires scale (grafema-self > h3, vscode ≈ grafema-self)
**Metric:** Δ accuracy (grafema-vs-baseline) larger on vscode and grafema-self than on h3
**Why:** on 142-file repos, grep+read closes even Tier-4 questions (from REG-1172 comment by Vadim 2026-06-10)

### H5: Skill-guided matches or beats v1 forced-graph on Tier-3/4 quality with fewer tokens
**Metric:** Tier-3/4 LLM judge score: skill-guided ≥ forced-graph; tokens: skill-guided < forced-graph
**Why:** the skill de-escalates after graph answers → avoids over-querying spiral (Q07, Q20 in v1 had MCP spirals)

---

## Falsification criteria

- If baseline scores ≥70% on Tier-4 questions across ALL scales → graph provides no quality signal
- If skill-guided MCP adoption on Tier-1 ≥ 40% → tier routing in skill prompt isn't working; revise
- If N=3 variance on any question > 30% judge-score spread → noise floor too high; increase N to 5
- If vscode graph is empty/degraded → re-run grafema analyze --clear, check rfdb-server version parity

---

## Infrastructure

- **Codebase:** microsoft/vscode at commit 1955c9d7 → `/home/ops/vscode-clone`
- **Graph:** pre-built 2026-06-13 → `/home/ops/vscode-clone/.grafema/` (4.4M nodes, 9.1M edges)
- **grafema version:** 0.3.31 (pinned on VPS)
- **Model:** claude-sonnet-4-6 (Sonnet 4.6) — same as v1 for comparability
- **Harness:** `autoresearch/harness/run.mjs` with `--project-root /home/ops/vscode-clone`
- **MCP config:** needs `.mcp.json` pointing to `/home/ops/vscode-clone/.grafema/` (see heavy task)

### Run commands (one per condition, vscode primary)
```bash
cd /opt/launch-ops/grafema

# Condition a: baseline
node autoresearch/harness/run.mjs \
  --mode baseline \
  --model sonnet \
  --questions autoresearch/questions-vscode-combined.yaml \
  --project-root /home/ops/vscode-clone \
  --repeats 3 \
  --run-id bench-v2-vscode-baseline

# Condition b: forced-graph (replicates v1)
node autoresearch/harness/run.mjs \
  --mode grafema \
  --model sonnet \
  --questions autoresearch/questions-vscode-combined.yaml \
  --project-root /home/ops/vscode-clone \
  --repeats 3 \
  --run-id bench-v2-vscode-forced-graph

# Condition c: skill-guided (new)
node autoresearch/harness/run.mjs \
  --mode skill-guided \
  --model sonnet \
  --questions autoresearch/questions-vscode-combined.yaml \
  --project-root /home/ops/vscode-clone \
  --repeats 3 \
  --run-id bench-v2-vscode-skill-guided
```

---

## Timeline

- 2026-06-14: pre-registration committed to ai-dev (this document)
- Pending: heavy task runs (6-8h on VPS, 3 × 60 × 3 = 540 agent calls + Opus judge calls)
- Pending: report generation via `autoresearch/harness/report.mjs`
- Pending: REG-1173 → Done after Vadim reviews and approves methodology

---

## Canon constraints (from HANDOFF.md)

- v1 numbers (77/67, n=30) must NOT be overwritten — v2 published alongside with dates/versions
- v1 numbers: 77% = grafema accuracy (LLM judge retrospective), 67% = baseline accuracy (n=30 vscode, March 2026)
- v2 uses same vscode questions (for comparability) + 30 new ones
- Honest reporting: negative results published alongside positive
