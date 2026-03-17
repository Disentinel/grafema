# SWE-bench Pipeline Runbook

Measure whether Grafema helps AI agents solve SWE-bench tasks.
Uses `claude -p` inside Docker containers — same subscription, same agent, two conditions.

## Architecture

```
SWE-bench Docker image
  + npm install -g @anthropic-ai/claude-code  (both conditions)
  + npm install -g grafema                     (grafema condition only)
  + grafema init && grafema analyze            (grafema condition only)
  + ~/.claude/ auth mounted from host
  → claude -p "$prompt" --output-format json
  → git diff → patch
  → swebench evaluation
```

The ONLY difference between conditions: grafema is/isn't installed.

## Prerequisites

1. **Docker** running
2. **Claude Code auth** in `~/.claude/` (login on host first)
3. **SWE-bench Docker images** built for target tasks
4. **tasks.json** generated from HuggingFace (one-time)

## Quick Start

```bash
# 1. Generate tasks (one-time, requires `pip install datasets`)
python scripts/swe-bench/generate-tasks.py > scripts/swe-bench/tasks.json

# 2. Build SWE-bench images for target tasks
python -m swebench.harness.prepare_images \
  --dataset_name swe-bench/SWE-Bench_Multilingual \
  --instance_ids axios__axios-4731

# 3. Run baseline
./scripts/swe-bench/run.sh axios__axios-4731 --mode baseline

# 4. Run grafema
./scripts/swe-bench/run.sh axios__axios-4731 --mode grafema

# 5. Compare
./scripts/swe-bench/compare.sh
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/swe-bench/run.sh` | Main pipeline: setup container, run agent, capture results |
| `scripts/swe-bench/compare.sh` | Markdown table comparing baseline vs grafema metrics |
| `scripts/swe-bench/generate-tasks.py` | Generate tasks.json from HuggingFace dataset |
| `scripts/swe-bench/templates/prompt-baseline.md` | Prompt without Grafema tool docs |
| `scripts/swe-bench/templates/prompt-grafema.md` | Prompt with Grafema tool docs |

## run.sh Usage

```bash
./scripts/swe-bench/run.sh <task_id> [--mode baseline|grafema] [--results-dir ./results]
```

What it does:
1. Reads task from `tasks.json`
2. Finds SWE-bench Docker image
3. Starts container with `~/.claude` mounted
4. Installs Claude Code (`npm install -g @anthropic-ai/claude-code`)
5. **(grafema only)** Installs Grafema, runs `grafema init && grafema analyze`, writes `.mcp.json`, starts rfdb-server
6. Generates prompt from template + problem_statement
7. Runs `claude -p "$prompt" --output-format json`
8. Captures: `git diff` → patch, agent JSON output, stderr log
9. Writes swebench prediction to `preds.jsonl`
10. Cleans up container

## Evaluation

```bash
# Activate swebench venv
source /Users/vadimr/swe-bench-research/mini-swe-agent/.venv/bin/activate

# Run evaluation
python -m swebench.harness.run_evaluation \
    --dataset_name swe-bench/SWE-Bench_Multilingual \
    --predictions_path scripts/swe-bench/results/baseline/preds.jsonl \
    --max_workers 1 --run_id baseline
```

## Docker Image Naming

SWE-bench images: `sweb.eval.x86_64.<repo_slug>:<instance_id>`
- repo_slug: `axios/axios` → `axios__axios`
- Example: `sweb.eval.x86_64.axios__axios:axios__axios-4731`

Build missing images:
```bash
python -m swebench.harness.prepare_images \
  --dataset_name swe-bench/SWE-Bench_Multilingual \
  --instance_ids <instance_id>
```

## Results Structure

```
scripts/swe-bench/results/
├── baseline/
│   ├── preds.jsonl                    # All predictions (for swebench eval)
│   └── <task_id>/
│       ├── result.json                # Claude agent JSON output
│       ├── patch.diff                 # git diff
│       └── claude-stderr.log          # Agent stderr
└── grafema/
    ├── preds.jsonl
    └── <task_id>/
        ├── result.json
        ├── patch.diff
        └── claude-stderr.log
```

## Known Issues

### Claude Code auth in Docker
`~/.claude/` is mounted read-only. If auth doesn't work, check:
- Host has valid auth: `claude --version` on host
- Mount is correct: `docker exec <c> ls /root/.claude/`

### Node version in containers
Some repos use Node 16. `npm install -g @anthropic-ai/claude-code` may fail.
If so, install Node 20 alongside:
```bash
docker exec <c> bash -c '
  curl -fsSL https://nodejs.org/dist/v20.11.1/node-v20.11.1-linux-x64.tar.xz | tar xJ -C /opt &&
  export PATH=/opt/node-v20.11.1-linux-x64/bin:$PATH &&
  npm install -g @anthropic-ai/claude-code grafema
'
```

### Previous approach (mini-SWE-agent)
The old pipeline used mini-SWE-agent + Anthropic API with pnpm pack/tarball dance.
Results from that approach are documented in prior experiment results (see skill).
The new `claude -p` approach is simpler: uses subscription, same agent, metrics built-in.

## Metrics

From `claude -p --output-format json`:
- `input_tokens`, `output_tokens` — total cost
- Tool call counts by type
- Whether Grafema MCP tools were used
- Wall clock time (captured by run.sh)

## Historical Results (mini-SWE-agent era)

| Task | Baseline | Grafema | File ops delta |
|------|----------|---------|----------------|
| axios__axios-4731 | PASS | PASS | -25% steps |
| preactjs__preact-4436 | FAIL | FAIL | -100% file ops |
| preactjs__preact-2757 | FAIL | FAIL | -48% file ops |
| preactjs__preact-2927 | FAIL | FAIL | -39% file ops |

Key finding: Grafema consistently reduces file operations but doesn't change fix correctness.
