---
id: kb:fact:claude-hooks-are-shell-only
type: FACT
confidence: high
subtype: domain
projections:
  - epistemic
created: 2026-03-06
---

Claude Code hooks (Stop, UserPromptSubmit, PreToolUse, etc.) execute shell commands, not LLM reasoning. They can influence Claude's behavior by returning text that appears in the conversation (like the continuous-learning hook does with system reminders), but they cannot perform complex extraction that requires understanding conversation context. This is why KB extraction is implemented as a skill (LLM-driven) rather than a hook (shell-driven).
