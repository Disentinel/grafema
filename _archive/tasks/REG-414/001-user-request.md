# REG-414: Support Agent Skills Standard for Grafema

## Request

Add support for Agent Skills standard alongside existing MCP tools. This will make Grafema accessible to agents across different platforms (Claude Code, Cursor, Copilot, Gemini CLI, etc.).

## Background

Grafema currently has:
- **24 MCP tools** for code graph analysis
- **10 internal skills** in `.claude/skills/` (for Grafema development)
- **CLI with 18 commands**

## Requirements

1. **Public Grafema Skill** (`grafema-codebase-analysis/SKILL.md`)
   - Teaches agents WHEN and HOW to use Grafema MCP tools
   - Cross-platform compatible (not Claude Code-specific)

2. **Resource files**
   - Query examples for common tasks
   - Node/edge type cheat sheet

3. **CLI command** (`grafema setup-skill`)
   - Installs skill into user's project
   - Idempotent, safe to run multiple times

## Constraints

- Must follow Agent Skills specification (agentskills.io/specification)
- SKILL.md must be under 500 lines (move heavy reference to `references/`)
- Description field is critical for agent discovery
- Must work across multiple AI agent platforms
