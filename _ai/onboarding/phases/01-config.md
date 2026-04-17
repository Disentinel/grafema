# Phase 1: Config — Make the Graph Work

## Prerequisites
- Grafema installed
- Project directory accessible

## What to do

Follow existing instructions: `packages/util/src/instructions/onboarding.md`

This phase is already implemented as MCP prompt `onboard_project`.
Use tools: `read_project_structure`, `write_config`, `analyze_project`.

## Quick checklist
1. `read_project_structure` → identify services, entry points, languages
2. Write `.grafema/config.yaml` with include/exclude patterns
3. `analyze_project`
4. `get_stats` → verify nodeCount > 0
5. `get_coverage` → verify > 80% source files analyzed

## When to ask the user
- Multiple potential entry points → "Which is the main one?"
- Deployment configs mention services not visible in code → "Should I investigate?"
- Coverage < 80% → "These files are excluded: [list]. Intentional?"

## Completion
- `get_stats` returns nodeCount > 0
- `get_coverage` > 80%

## Artifacts
- `.grafema/config.yaml`
