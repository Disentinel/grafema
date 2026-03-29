---
name: autoresearch
description: Run autoresearch benchmark cycle — questions, harness, eval, hypotheses, experiments
user_invocable: true
---

# Autoresearch: Data-Driven Grafema Evaluation

Run evaluation experiments measuring whether Grafema graph tools help AI agents
understand code better/faster/cheaper than file-only tools.

## Quick Reference

```bash
# Validate questions (check staleness)
node autoresearch/harness/validate.mjs --questions autoresearch/questions.yaml

# Run benchmark
node autoresearch/harness/run.mjs --mode baseline --model sonnet --questions autoresearch/questions-h3.yaml --project-root ~/autoresearch-repos/h3
node autoresearch/harness/run.mjs --mode grafema --model sonnet --questions autoresearch/questions-h3.yaml --project-root ~/autoresearch-repos/h3

# Evaluate (--judge enables LLM judge for cat 3+ questions)
node autoresearch/harness/evaluate.mjs --run autoresearch/results/<run-id> --questions <questions.yaml> --judge

# Compare two runs
node autoresearch/harness/report.mjs --runs autoresearch/results/<baseline>,autoresearch/results/<grafema>

# Phase 3: end-to-end task (bug fix)
node autoresearch/harness/run-task.mjs --mode baseline --task-id T01
```

## Before Every Experiment

1. **Read `autoresearch/REVIEWER-NOTES.md`** — methodology issues from independent reviewer
2. **Pre-register hypotheses** in `autoresearch/pre-registration-v2.md` BEFORE running
3. **Check question staleness**: `node autoresearch/harness/validate.mjs`
4. **N >= 3 per condition** — single runs are noise, not signal
5. **Clean-room**: harness runs claude from /tmp (no CLAUDE.md loading)

## Key Files

| File | Purpose |
|------|---------|
| `autoresearch/questions.yaml` | Original 30 questions (Grafema codebase) |
| `autoresearch/questions-h3.yaml` | h3 project questions |
| `autoresearch/questions-hard.yaml` | Hard questions (WIP) |
| `autoresearch/tasks.yaml` | Phase 3 end-to-end bug fix tasks |
| `autoresearch/hypotheses.yaml` | All hypotheses with status |
| `autoresearch/research-log.md` | Chronological findings journal |
| `autoresearch/REVIEWER-NOTES.md` | Independent reviewer methodology critiques |
| `autoresearch/pre-registration-v2.md` | Pre-registered hypotheses for external repos |

## Current Status & Blockers

**Blocker: RFD-60** — RFDB OOM on VS Code (4M nodes). Resolution phase crashes at ~3GB RSS.
Until fixed, can only benchmark on small codebases (<3k files) where graph adds no value.

**REG-812** — Need separate `grafema resolve` CLI command for retry without re-analysis.

## Session Findings (2026-03-24)

- Small codebases (h3, 7k LOC): baseline 10/10, graph unnecessary
- Own codebase (Grafema): CLAUDE.md confound, N=1 noise, some results were artifacts
- H004 (fix find_calls): CONFIRMED — real product bug fix, accuracy restored
- H005 (remove get_stats): get_stats was MCP bootstrap mechanism, not just overhead
- VS Code (240k LOC): right scale, analysis works, resolution OOM-killed

## External Repos

Cloned to `~/autoresearch-repos/`:
- h3 (unjs/h3) — 7k LOC, 17k nodes. Analyzed locally. Too small.
- bullmq (taskforcesh/bullmq) — 14k LOC, 26k nodes. Analyzed locally.
- openworkflow — 8k LOC, 30k nodes. Analyzed locally.
- VS Code (microsoft/vscode) — 240k LOC, 4M nodes. On remote VM. Resolution blocked by OOM.

## Remote Experiments

Dev VM at Hetzner (see `~/grafema-cloud/infra/hetzner/`). Access via `ssh root@$(cd ~/grafema-cloud/infra/hetzner && terraform output -raw dev_ip)`.

tmux session `autoresearch` has experiment windows. Claude Code + grafema installed for dev user.
