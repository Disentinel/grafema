---
name: swe-bench-grafema-experiments
description: |
  SWE-bench pipeline for A/B testing Grafema with Claude Code.
  Use when: (1) running SWE-bench experiments, (2) comparing baseline vs grafema conditions,
  (3) evaluating results, (4) debugging container issues.
author: Claude Code
version: 3.0.0
date: 2026-03-17
---

# SWE-bench Grafema Experiments

## Pipeline Overview

Uses `claude -p` inside SWE-bench Docker containers. Two conditions:
- **Baseline:** Claude Code + standard tools
- **Grafema:** Claude Code + `grafema` installed with pre-built graph + MCP tools

Same agent, same environment, same prompt (except tool docs section).

## Quick Commands

```bash
# Generate tasks.json (one-time)
python scripts/swe-bench/generate-tasks.py > scripts/swe-bench/tasks.json

# Run single task
./scripts/swe-bench/run.sh axios__axios-4731 --mode baseline
./scripts/swe-bench/run.sh axios__axios-4731 --mode grafema

# Run all JS/TS tasks (loop)
for task in $(jq -r '.[].instance_id' scripts/swe-bench/tasks.json); do
  ./scripts/swe-bench/run.sh "$task" --mode baseline
  ./scripts/swe-bench/run.sh "$task" --mode grafema
done

# Compare results
./scripts/swe-bench/compare.sh

# Evaluate with swebench
source /Users/vadimr/swe-bench-research/mini-swe-agent/.venv/bin/activate
python -m swebench.harness.run_evaluation \
  --dataset_name swe-bench/SWE-Bench_Multilingual \
  --predictions_path scripts/swe-bench/results/baseline/preds.jsonl \
  --max_workers 1 --run_id baseline
```

## Key Files

| File | Purpose |
|------|---------|
| `scripts/swe-bench/run.sh` | Main pipeline script |
| `scripts/swe-bench/compare.sh` | Results comparison |
| `scripts/swe-bench/generate-tasks.py` | Task generation from HuggingFace |
| `scripts/swe-bench/tasks.json` | Pre-cached 43 JS/TS tasks |
| `scripts/swe-bench/templates/prompt-baseline.md` | Baseline prompt |
| `scripts/swe-bench/templates/prompt-grafema.md` | Grafema prompt (with tool docs) |
| `_ai/swe-bench-runbook.md` | Full runbook |

## Debugging

### Container issues
```bash
# Check image exists
docker images | grep sweb.eval

# Check Node version
docker run --rm <image> node --version

# Debug inside container
docker run -it --name debug-swe -v ~/.claude:/root/.claude:ro <image> bash
```

### Auth issues
```bash
# Verify host auth
claude --version

# Check mount inside container
docker exec <container> ls -la /root/.claude/
```

### Grafema issues
```bash
# Check if grafema installed
docker exec <container> grafema --version

# Check if graph was built
docker exec <container> ls /testbed/.grafema/

# Check MCP config
docker exec <container> cat /testbed/.mcp.json
```

## Historical Results

Grafema consistently reduces file exploration (39-100%) but hasn't improved fix correctness in tested tasks. The new `claude -p` pipeline should provide cleaner measurements.
