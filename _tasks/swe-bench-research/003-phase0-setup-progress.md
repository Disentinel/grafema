# Phase 0: Setup Progress

## Environment Status

| Component | Status | Notes |
|-----------|--------|-------|
| Docker | OK | v27.5.1 |
| Disk space | **70GB free** | Need 120GB recommended, tight |
| Python 3.12 | OK | brew python@3.12 |
| git-lfs | Installing... | brew compiling from source |
| ANTHROPIC_API_KEY | OK | Set in env |
| OPENAI_API_KEY | OK | Set in env |

## Installed Components

### mini-SWE-agent v2.0.0a3
- **Location:** `/Users/vadimr/swe-bench-research/mini-swe-agent/`
- **Venv:** `.venv/` (Python 3.12)
- **Activate:** `source /Users/vadimr/swe-bench-research/mini-swe-agent/.venv/bin/activate`
- **Default model:** `anthropic/claude-sonnet-4-5-20250929`
- **SWE-bench support:** Built-in, supports `--subset multilingual` natively
- **Step limit:** 250 steps, **Cost limit:** $3/task

### Multi-SWE-bench
- **Location:** `/Users/vadimr/swe-bench-research/multi-swe-bench/`
- **66 JS repos + 92 TS repos** in harness (full RL dataset)
- **Curated benchmark:** 580 JS/TS tasks (svelte 272, MUI 174, dayjs 56, vue 48...)

## Dataset: SWE-bench Multilingual (pilot choice)

Loaded from HuggingFace: `swe-bench/SWE-Bench_Multilingual`

**300 total tasks, 43 JS/TS tasks:**

| Repo | Tasks | Language |
|------|-------|----------|
| preactjs/preact | 17 | JS |
| axios/axios | 6 | JS |
| babel/babel | 5 | JS |
| facebook/docusaurus | 5 | JS |
| vuejs/core | 5 | TS |
| mrdoob/three.js | 3 | JS |
| immutable-js/immutable-js | 2 | JS |

**Format (compatible with mini-SWE-agent):**
- `instance_id` — e.g., `axios__axios-4731`
- `problem_statement` — issue description
- `repo` — e.g., `axios/axios`
- `base_commit` — git commit SHA
- `patch` — solution patch
- `test_patch` — test changes
- `FAIL_TO_PASS` — tests that must pass after fix
- `PASS_TO_PASS` — tests that must not break

## Key Architecture Insight

**Two separate flows:**

1. **Agent flow** (mini-SWE-agent):
   - Gets issue from dataset (`problem_statement`)
   - Spins Docker container with repo at `base_commit`
   - Agent explores code, generates patch via bash commands
   - Outputs `preds.json` with patches

2. **Evaluation flow** (SWE-bench harness):
   - Takes `preds.json` + original dataset
   - Applies patches in Docker
   - Runs FAIL_TO_PASS + PASS_TO_PASS tests
   - Reports resolve rate

**For our experiment:**
- Run mini-SWE-agent on 43 JS/TS tasks WITHOUT Grafema → baseline
- Run same agent WITH Grafema MCP → experimental
- Compare metrics

## Стратегия стартового эксперимента

### Simplest path: SWE-bench Multilingual

**Почему не Multi-SWE-bench:**
- SWE-bench Multilingual уже нативно поддерживается mini-SWE-agent
- 43 JS/TS задачи — достаточно для pilot (p<0.05 при delta >15%)
- Zero integration work — просто `--subset multilingual`
- Docker images уже на Docker Hub (swebench/sweb.eval.x86_64.*)

**Почему не Multi-SWE-bench mini/flash:**
- Нужна адаптация dataset format для mini-SWE-agent
- Docker images другой naming scheme (mswebench/* vs swebench/*)
- Лучше сначала validate pipeline на чём-то готовом

### Run command (baseline, one task)
```bash
source /Users/vadimr/swe-bench-research/mini-swe-agent/.venv/bin/activate
python -m minisweagent.run.benchmarks.swebench \
    --subset multilingual \
    --split test \
    --filter "axios__axios" \
    --slice "0:1" \
    -o /Users/vadimr/swe-bench-research/results/baseline \
    -m "anthropic/claude-sonnet-4-5-20250929"
```

## First Test Run Results (2026-02-09)

**Task:** `axios__axios-4731` (maxBodyLength issue with follow-redirects)

| Metric | Value |
|--------|-------|
| Steps | 50 (hit limit) |
| Cost | $0.52 |
| API calls | 50 |
| Duration | ~5 minutes |
| Exit status | LimitsExceeded |
| Patch generated | No (ran out of steps before git diff) |

**Agent behavior:**
- Successfully identified the bug (maxBodyLength not passed to follow-redirects)
- Wrote reproduction test, confirmed issue
- Implemented fix in http adapter
- Tests passed
- Was verifying edge cases when step limit hit
- **Did not reach git diff/submit step**

**Config adjustment:** step_limit 50→75, cost_limit $2→$3

## Second Test Run (step_limit=75)

| Metric | Value |
|--------|-------|
| Steps | 49 (из 75) |
| Cost | **$0.51** |
| Duration | ~4 min |
| Exit status | **Submitted** |
| Patch | 437 chars (correct fix) |

**Agent generated correct patch:** `maxBodyLength === -1` → `Infinity` for `follow-redirects`.

## Evaluation Result

```
swebench.harness.run_evaluation → ✓=1, ✖=0, error=0
Instances resolved: 1/1 (100%)
```

**Full pipeline validated end-to-end:**
1. mini-SWE-agent → explores repo → generates patch
2. swebench evaluation → applies patch → runs tests → PASS

## Next Steps

1. [x] Clone Multi-SWE-bench
2. [x] Clone mini-SWE-agent
3. [x] Install mini-SWE-agent (Python 3.12 venv)
4. [x] Load SWE-bench Multilingual dataset, identify 43 JS/TS tasks
5. [x] **Run single task end-to-end** — PASS, resolved
6. [x] Validate evaluation pipeline — swebench eval works
7. [ ] **Run baseline on all 43 JS/TS tasks** (~$22, ~3 hours)
8. [ ] Plan Grafema integration into Docker images
9. [ ] Run experimental (with Grafema) on same 43 tasks
10. [ ] Compare results
