# Autoresearch Log

Research journal for Grafema evaluation experiments.

## 2026-03-24: First iteration — baseline vs grafema

### Setup
- 30 questions (Sillito taxonomy): 15 deterministic, 10 judge, 5 adversarial
- Model: Sonnet 4.6, temperature default
- Grafema mode: MCP tools available, no explicit "use graph first" instruction
- Runs: baseline-v1, grafema-v1

### Results (deterministic only, 15 questions)

| Metric | Baseline | Grafema | Delta |
|--------|----------|---------|-------|
| Accuracy | **93% (14/15)** | 87% (13/15) | -7% |
| Avg tokens | 3027 | 3279 | +8% |
| Avg latency | 52s | 62s | +19% |
| MCP adoption | 13% | **70%** | +425% |
| Est. cost | $7.03 | $7.57 | +8% |

### Key observations

1. **Baseline wins on accuracy.** Grafema lost Q06 (commitBatch callers) — find_calls returned incomplete results, agent supplemented with Grep but still missed one file. Q07 tied (both got 83%).

2. **MCP adoption is high (70%) without explicit instructions.** This disproves the SWE-bench pilot finding (1/10 tasks). Difference: SWE-bench tasks are "fix this bug" (action-oriented), autoresearch questions are "find/explain this" (comprehension-oriented). MCP tools are naturally more useful for comprehension.

3. **Only 3 distinct MCP tools used:** get_stats (19x), find_nodes (6x), find_calls (3x). Out of 30 available tools: trace_dataflow, describe, get_context, get_file_overview, query_graph — all unused. The tool surface area is too large.

4. **ToolSearch overhead:** 34 calls to load deferred tool schemas. Each costs tokens. This is infrastructure tax, not value.

5. **get_stats as ritual:** Called 19 times. MCP instructions say "START HERE: call get_stats". Agent follows literally, calling it before most questions. Pure overhead.

6. **Grep dominates tool usage:** 85 Grep calls in grafema mode (vs 0 MCP text search). Graph doesn't offer text search, so agent falls back to Grep for any "find this string" question. This is correct behavior — but means graph only adds value for structural/relational queries.

### Hypotheses generated

- **H001A**: Reduce tool count from 30 to 4-5 core tools → less overhead, better discoverability
- **H001B**: Single swiss-army tool → eliminate ToolSearch entirely
- **H001C**: Pre-load tools (non-deferred) → eliminate ToolSearch overhead
- **H002**: Agent prefers Grep over find_calls → **CONFIRMED** from Q06 session data
- **H003**: Graph advantage appears on cat 3 (tracing) not cat 1-2 → needs judge eval
- **H004**: find_calls returns incomplete results → specific bug to fix
- **H005**: get_stats called 19 times = overhead → remove or auto-include

### Judge results (Q16-Q30)

Added LLM judge (Haiku) for category 3 and 4 questions.

**Cat 3 (tracing, Q16-Q25) — avg score:**
- Baseline: 3.7/5
- Grafema: **4.3/5** (+16%)
- Grafema wins: Q17 (0→5), Q21 (3→4), Q23 (4→5)
- Baseline wins: Q19 (5→4)

**Cat 4 (adversarial, Q26-Q30):**
- Mostly tied (4/5 both), except Q30 (test coverage): baseline 3/5, grafema **5/5**

**H003: CONFIRMED.** Grafema advantage appears on category 3 (cross-service tracing, concurrency, error propagation). Baseline better on category 1-2 (simple structure/location). The overhead of MCP tools hurts on simple questions but pays off on complex ones.

### Next steps

1. Test H001A/B/C in separate branches on remote server
2. Fix find_calls completeness (H004) — product bug
3. Each change → re-run benchmark → compare

## 2026-03-24: Hypothesis experiments (remote, parallel)

### Setup
5 experiments run on remote dev VM via tmux + claude --dangerously-skip-permissions. Each in separate git branch. 3 completed, 2 failed (H001A npm error, H001C still running).

### Results: Cost vs Accuracy

| Condition | Accuracy | Cost (30q) | Cost/Q | MCP calls |
|-----------|----------|------------|--------|-----------|
| Baseline (no MCP) | **93%** | $7.03 | $0.23 | 0 |
| Grafema-v1 (30 tools) | 87% | $7.57 | $0.25 | 29 |
| **H001B** (single tool) | **93.3%** | **$2.37** | **$0.08** | 0 |
| **H004** (fixed find_calls) | **93.3%** | $3.56 | $0.12 | some |
| H005 (no get_stats) | 89.5% | ~$3.13 | $0.10 | 0 |

### Key findings

**1. MCP overhead costs $4-5 per 30 questions (3x markup)**
Grafema-v1 ($7.57) vs H001B ($2.37). Same accuracy (93.3%), 3x cheaper. The overhead comes from: 30 tool schemas in context, ToolSearch calls (34), get_stats ritual (19), verbose MCP server instructions.

**2. H004 (fix find_calls) restores accuracy to baseline level**
Q06 fixed (0.5→1.0). Reverse CALLS edge lookup catches aliased/indirect calls. Overall 93.3% = baseline parity. Cost $3.56 — still 2x cheaper than grafema-v1.

**3. H005 reveals get_stats as MCP bootstrap mechanism**
Removing "START HERE: call get_stats" killed ALL MCP adoption (70%→0%). get_stats wasn't just overhead — it was the forcing function that made agents enter the MCP context. Without it, agents default to Grep/Read exclusively.

**4. Does MCP actually help? Nuanced answer.**
- Cat 3 judge scores: H005 (no MCP) = 4.2/5 (n=4) vs Grafema-v1 = 4.3/5 vs Baseline = 3.7/5
- H005 and Grafema-v1 are close → MCP may not be the cause of cat 3 improvement
- BUT: the MCP server instructions (describing the codebase architecture) are present in all grafema runs, even H005. The graph context in the system prompt may be doing the heavy lifting, not the MCP tool calls themselves.
- The hardest questions (Q17 baseline=0, grafema=5, H005=4) still show grafema advantage.

**5. The real value might be in context, not tools**
MCP server instructions describe the architecture (what handlers exist, how RFDB works, etc.). This context is injected regardless of whether MCP tools are called. H005 benefits from this context without calling any MCP tools. The tools are secondary to the architectural knowledge the server provides.

### Hypothesis status update

| ID | Status | Key evidence |
|----|--------|-------------|
| H001A | incomplete | npm build error on remote |
| H001B | **partially confirmed** | Tokens -20.8%, cost -69%, accuracy same. But MCP=0 in both conditions |
| H001C | incomplete | still running |
| H002 | **confirmed** (prev) | Q06 session data |
| H003 | **confirmed** (prev) | Cat 3: 4.3 vs 3.7 |
| H004 | **confirmed** | Q06 fixed, accuracy = baseline |
| H005 | **confirmed + surprise** | get_stats=0, but MCP adoption also=0 |

### New hypotheses

- **H006**: MCP value comes from server instructions (architecture context), not tool calls. Test: strip all tools but keep instructions → accuracy should hold.
- **H007**: Combining H004 (fix find_calls) + minimal tool surface → best of both worlds: accuracy + low cost.
- **H008**: For SWE-bench tasks (bug fixes), the context injection matters more than tools. Re-run SWE-bench pilot with good context but no MCP tools.

## 2026-03-24: External codebase experiments

### h3 smoke test (N=1, not significant)

| Metric | Baseline | Grafema |
|--------|----------|---------|
| Accuracy | 10/10 | 10/10 |
| Avg judge | **4.4/5** | 4.1/5 |

**h3 is too small (7k LOC).** Sonnet reads the entire project in a few calls.
Graph adds no value and slight overhead. Confirms: need 15k+ files to test the thesis.

### VS Code analysis

Analyzing microsoft/vscode on remote: 5747 files, **4M+ nodes, 8.3M+ edges**.
This is 200x the scale of h3. Resolution phase pending.

### VS Code OOM during resolution

Analysis phase completed: 5747 files → 4.15M nodes, 8.44M edges, 104 errors, ~13 min.
Resolution phase started (7 streaming workers) but **RFDB server OOM-killed** at ~3GB RSS.
VM has 16GB RAM. Resolution on 4M nodes requires more memory than available.

**Impact:** Graph has all per-file nodes/edges but NO cross-file edges (IMPORTS_FROM, CALLS, etc.). MCP tools like find_calls and trace_dataflow would return empty results. The graph is structurally incomplete.

**Root cause:** RFDB server loads indexes into memory during resolution. At 4M nodes, index size exceeds available RAM. This is a known scaling limit — needs fix (REG-XXX to be created).

**VS Code is ideal benchmark target:** 5.6k TS files, public, comparable to large private codebases. Once OOM is fixed, this becomes the primary benchmark.

**Actionable:** Need separate resolution phase CLI command (`grafema resolve`) to allow retry without re-analyzing all files.

### Pre-registration results

H-PR1 predicted baseline ≤60% on tracing. Actual: 100%. **Falsified** — questions too easy for this scale project. VS Code should provide the actual challenge once resolution works.

### Evaluator fixes during this iteration

- Q01 changed from eval_type `set` to `superset` (multiple files produce the error)
- Added extension-aware fuzzy matching (`.ts`/`.js` in mid-string positions)
- Fixed evaluate.mjs to skip missing questions silently in partial runs
- Fixed validate.mjs glob handling (grep doesn't expand `**`, use `--include` instead)
