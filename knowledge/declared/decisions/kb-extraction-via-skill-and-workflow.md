---
id: kb:decision:kb-extraction-via-skill-and-workflow
type: DECISION
status: active
projections:
  - epistemic
relates_to:
  - .claude/skills/extract-knowledge/SKILL.md
  - _ai/workflow.md
created: 2026-03-06
---

Knowledge extraction from Claude Code sessions is automated via two mechanisms:

1. **Workflow step** — step 6 in the pipeline, after user confirmation. Runs `/extract-knowledge` skill as part of every non-trivial task.
2. **Manual command** — `/extract-knowledge` can be invoked by the user at any time for ad-hoc sessions.

Rejected alternatives:
- Pure shell hook on Stop: cannot do LLM reasoning in a shell command. Hooks can only output reminders, not perform extraction.
- Workflow-only: misses ad-hoc sessions that don't follow the full workflow pipeline.
- Stop hook with heuristic: too noisy (fires on every Claude response), requires flag-file dedup complexity.
