# REG-526: AI QA агент: Claude тестирует Grafema extension через code-server

## Source
Linear issue REG-526, requested by Вадим Решетников.

## Request
Create a custom Claude Code agent and `/qa` skill that systematically QA-tests the Grafema VS Code extension in a code-server Docker environment.

The agent navigates files line-by-line using Playwright, checks all extension panels (cursor position, value trace, callers, edges explorer, issues, hover), cross-validates with CLI/MCP, and reports bugs with verdicts (UI-bug vs core-bug).

## Key Deliverables
1. `.claude/agents/qa-agent.md` — Full agent prompt with methodology
2. `.claude/skills/qa/SKILL.md` — Skill entry point with argument parsing
3. `_qa/qa-state.json` — Persistent state file
4. `_qa/screenshots/` — Gitignored screenshots directory

## Acceptance Criteria (from Linear)
- Custom agent with full prompt
- Skill `/qa` with argument support (file, --recheck, auto-resume, custom task)
- Agent traverses files line-by-line checking all 6 panels
- Bug verdict: UI-bug or core-bug with evidence
- Persistent state with auto-resume
- Version change detection triggers re-check
- Custom free-text tasks supported
