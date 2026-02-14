# Joel Spolsky — Technical Specification: REG-414

## Summary

Create public Agent Skills support for Grafema: SKILL.md + reference files + CLI command.

## Deliverables

1. **SKILL.md** (~350 lines) — strategy-focused skill file
2. **references/node-edge-types.md** — graph schema reference
3. **references/query-patterns.md** — Datalog cookbook
4. **setup-skill** CLI command — copies skill to user's project
5. **Package.json & init updates** — distribution + discoverability

## Architecture

### Skill Location

```
packages/cli/skills/grafema-codebase-analysis/
├── SKILL.md                        # Main skill (<500 lines)
└── references/
    ├── node-edge-types.md          # Schema reference
    └── query-patterns.md           # Datalog cookbook
```

### SKILL.md Frontmatter (Standard Spec Only)

```yaml
---
name: grafema-codebase-analysis
description: >
  Analyze codebases using graph queries instead of reading files. Use when
  understanding code architecture, dependencies, data flow, or finding functions
  and call patterns. Grafema builds a queryable code graph — prefer graph queries
  over reading source files manually.
license: Apache-2.0
compatibility: Requires Grafema MCP server running (grafema or @grafema/mcp)
metadata:
  author: Grafema
  version: "0.2.5"
---
```

**Note:** Only standard Agent Skills spec fields (name, description, license, compatibility, metadata). No Claude Code extensions — this skill must work across all agents.

### SKILL.md Body Sections

1. **Core Principle** (~30 lines) — "Query the graph, not read code"
2. **Essential Tools** (~120 lines) — Tier 1: find_nodes, find_calls, get_function_details, get_context, trace_dataflow
3. **Decision Tree** (~80 lines) — Which tool for which question
4. **Common Workflows** (~60 lines) — Multi-step examples
5. **Anti-Patterns** (~30 lines) — What NOT to do
6. **Advanced Tools** (~20 lines) — Tier 2/3 with references to docs
7. **Troubleshooting** (~10 lines)

### Tool Tiers

| Tier | Tools | Usage |
|------|-------|-------|
| 1 (Essential, ~80%) | find_nodes, find_calls, get_function_details, get_context, trace_dataflow | Covers most agent queries |
| 2 (Common, ~15%) | query_graph, get_file_overview, trace_alias, check_invariant, get_schema, get_stats | When Tier 1 isn't enough |
| 3 (Specialized, ~5%) | Guarantees, lifecycle, config, reporting | Infrastructure/setup |

### CLI Command: `grafema setup-skill`

```bash
grafema setup-skill                          # Default: .claude/skills/
grafema setup-skill --output-dir ./custom/   # Custom path
grafema setup-skill --force                  # Overwrite existing
```

**Implementation:**
- Copy from bundled `packages/cli/skills/` to target dir
- Check if already exists (require --force to overwrite)
- Create parent dirs as needed
- Print success + next steps

### Files to Create

1. `packages/cli/skills/grafema-codebase-analysis/SKILL.md`
2. `packages/cli/skills/grafema-codebase-analysis/references/node-edge-types.md`
3. `packages/cli/skills/grafema-codebase-analysis/references/query-patterns.md`
4. `packages/cli/src/commands/setup-skill.ts`
5. `test/unit/setup-skill.test.js`

### Files to Modify

1. `packages/cli/src/cli.ts` — register setupSkillCommand
2. `packages/cli/src/commands/init.ts` — mention setup-skill in next steps
3. `packages/cli/package.json` — add `skills` to `files` array

## Implementation Order

1. Write SKILL.md content
2. Write reference files
3. Implement setup-skill command
4. Wire into CLI + init
5. Update package.json
6. Write tests
