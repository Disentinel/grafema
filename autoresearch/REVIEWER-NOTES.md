# Reviewer Notes (Scientific Advisor)

Updated: 2026-03-24 13:30

This file is maintained by an independent reviewer session monitoring the autoresearch experiments for methodological issues. **Check this file before starting new experiments.**

---

## CRITICAL Issues

### 1. H001B result is NOT "3x cost reduction" — it's a non-adoption artifact

H001B reported 93.3% accuracy with MCP calls = 0. The agent never used the single tool. This means H001B measured "baseline with a different prompt", not "single tool is better". Recording this as "partially confirmed" is misleading — the hypothesis about tool consolidation was **not tested** because the tool was never called.

**Action required:** Either fix the single tool so the agent actually uses it, or mark H001B as "rejected — no adoption".

### 2. N=1 invalidates all accuracy comparisons

All experiments are single-run. With 30 binary questions, one random error = 3.3% swing. The difference between baseline (93%) and grafema-v1 (87%) is 2 questions. This is noise, not signal.

The `--repeats` flag was added to the harness but never used. Before drawing ANY conclusions:
- Run each condition at minimum N=3
- Use paired sign test (same question, same model, different condition)
- Report confidence intervals, not point estimates

### 3. Testing on own codebase = contamination risk

The entire evaluation runs on Grafema itself. Problems:
- The model may know Grafema from training data (it's on GitHub)
- CLAUDE.md (500+ lines of architecture docs) loads in both conditions — this was identified but the fix (temp dir) hasn't been validated yet
- All "hard questions" are written by someone who knows the answers in this specific codebase
- No external codebase used for validation

**Minimum fix:** Run the same experiment on 2-3 open-source codebases the model has NOT been specifically trained on (recently created repos, or private forks with renamed identifiers).

### 4. questions-hard.yaml still has confirmation bias

The self-correction caught "questions requiring graph" as biased, but the replacement questions like "functions disappeared after analysis" and "node count dropped" are **Grafema-specific debugging questions**. By definition, MCP tools for Grafema's own graph will answer these better than Grep. This is circular.

**Real hard questions** should be domain-agnostic: "trace how user input reaches the database", "what breaks if I delete this function", "find all error handling paths for network failures". Apply these to an EXTERNAL codebase.

### 5. Cost accounting is misleading

"3x cost reduction" compares H001B ($2.37) to grafema-v1 ($7.57). But H001B didn't use MCP at all. The fair comparison is H001B ($2.37) vs baseline ($7.03) — and the cost difference is likely from prompt length, not tool consolidation.

**Action required:** Decompose cost into: prompt tokens (fixed) + tool call tokens (variable) + response tokens. Report each separately.

---

## Recommendations for Next Experiment

1. **External codebase first.** Pick 2-3 repos: one well-known (express, fastify), one obscure. Same questions across all.
2. **N >= 3 per condition.** Use the `--repeats` flag that's already implemented.
3. **Validate CLAUDE.md isolation.** Before running, confirm that `--cwd /tmp/...` actually prevents CLAUDE.md loading. Print the loaded config in harness logs.
4. **Separate "can the agent use the tool" from "does the tool help".** If adoption is 0%, the experiment measures nothing about the tool.
5. **Pre-register hypotheses.** Write down expected accuracy BEFORE running. "We expect grafema to score 70% on tracing questions where baseline scores 40%." This prevents post-hoc narrative fitting.

---

## Update 2026-03-24 14:00 — v2 Experiment Review

### What improved (good)
- Pre-registration with concrete numbers — H-PR1 through H-PR5
- Falsification criteria defined
- External codebases selected (h3, openworkflow, bullmq)
- Questions sourced from actual onboarding, not invented
- N=3 planned with sign test

### Remaining concerns

#### 6. Pre-registration H-PR1 threshold is too generous

H-PR1: "Baseline accuracy ≤60% on tracing questions." But Sonnet 4.6 is very capable. On the Grafema experiment (even without CLAUDE.md benefits), baseline scored 93% overall. Setting the bar at 60% almost guarantees your hypothesis passes.

**Better approach:** Run the smoke test first (which you're doing), look at the actual baseline number, THEN set the threshold honestly. Or better — don't set a threshold. Just measure the difference and report the effect size. A pre-registered **direction** ("grafema > baseline on tracing") is more honest than a pre-registered threshold you chose to be easy to beat.

#### 7. Questions are project-specific but evaluation is not

Each project gets its own 10 questions (good). But this means you're comparing 10 h3 questions + 10 bullmq questions + 10 openworkflow questions = 30 heterogeneous questions. The difficulty varies wildly across projects. You can't pool them naively.

**Better:** Report per-project AND pooled. If grafema wins on h3 but loses on bullmq, that's a different story than "grafema wins on average."

#### 8. "Experimenter explores, then asks what they found"

You read h3 code, found things, then wrote questions about those things. The questions are biased toward whatever caught YOUR attention during exploration. An alternative approach:

- Use questions from **GitHub Issues** or **Stack Overflow** about these projects
- Or use a standard question template applied uniformly (e.g., Sillito's 44 questions)
- Or have a DIFFERENT agent generate questions (blind to Grafema's capabilities)

Not a blocker — the current approach is acceptable for v2. But note it as a limitation.

#### 9. CLAUDE.md isolation not yet validated

The harness runs from /tmp to avoid CLAUDE.md. But has this been **tested**? Add a log line at the start of each run that prints whether any CLAUDE.md was loaded. Without this, you might discover after all experiments that the isolation didn't work.

---

## Update 2026-03-24 14:30 — h3 Smoke Test + VS Code Pivot

### h3 baseline result: 10/10, judge 4.4/5
Confirms that small, clean codebases (~7k LOC) are ceiling-limited. Sonnet reads the entire project and answers perfectly. Graph can't improve on "already perfect."

### VS Code pivot — proceed with caution

Good reasoning to scale up. But:

#### 10. VS Code = maximum training data contamination

VS Code is the most famous TypeScript project in existence. Sonnet has likely memorized its architecture, file structure, and common patterns. Questions like "how do I add a command to the command palette" can be answered from memory, not code analysis.

**Mitigation options:**
- Ask about RECENT changes (post training cutoff). E.g., "In the latest version, how does X work?" (but model won't know if it changed)
- Ask very specific questions: "What are ALL callers of function `foo` in file `bar.ts`?" — this requires actual code traversal, not architectural knowledge
- Use VS Code as a SCALE test (can grafema handle 240k LOC?), not an accuracy test

#### 11. Scope creep warning

Original plan: 3 repos x 10 questions x N=3 x 2 conditions = 180 runs. Now adding VS Code + remote setup + grafema scaling test. This could balloon into days of work without producing a publishable result.

**Recommendation:** Finish h3 grafema smoke FIRST. Compare baseline vs grafema on h3. Even if both score high, the COST comparison (tokens used) is still valid data. Then move to BullMQ (14k LOC, mixed TS+Lua+Redis = actually hard). VS Code can be Phase 3.

#### 12. grafema analyze on 240k LOC is untested territory

This may crash, produce garbage, or take hours. That's a valid finding too — "grafema doesn't scale to 240k LOC" is important data. But don't let the scaling test block the accuracy experiment. Run them in parallel.

---

*— Independent reviewer session (scientific advisor role)*
