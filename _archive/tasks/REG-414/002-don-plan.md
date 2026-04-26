# Don Melton — High-Level Plan: REG-414

**Date:** 2026-02-14  
**Task:** Support Agent Skills standard for Grafema

---

## Analysis

This task is about **making Grafema discoverable and usable by AI agents** across platforms. The current MCP server is excellent for tool provision, but agents need **guidance on WHEN and HOW to use those tools**. That's what Agent Skills provides.

### Key Insight

**Agent Skills is NOT a replacement for MCP — it's a complement.**

- **MCP tools** = the "hands" (what agents can DO)
- **Agent Skill** = the "brain" (WHEN to use those hands, and HOW)

The skill teaches agents:
1. **Discovery**: "When should I activate Grafema?" (frontmatter description)
2. **Strategy**: "What tool should I use for this task?" (decision tree in body)
3. **Execution**: "How do I construct this query?" (examples in references/)

### What Makes This RIGHT vs. Just Working

**WRONG approaches:**
- Duplicate tool definitions in SKILL.md (creates sync problem)
- Put all 24 tools in SKILL.md (overwhelming, violates progressive disclosure)
- Make it Claude Code-specific (defeats cross-platform purpose)
- Create generic "use MCP tools" skill (agents already know that)

**RIGHT approach:**
- Skill focuses on STRATEGY and DECISION-MAKING
- Reference files contain TACTICAL details (queries, node types)
- Keep MCP tools as single source of truth for tool signatures
- Teach the GRAFEMA WAY of thinking about code

---

## Core Design Decisions

### 1. Where Should the Public Skill Live?

**Recommendation:** `packages/cli/skills/grafema-codebase-analysis/`

**Rationale:**
- **Part of published package**: `files: ["dist", "src", "skills"]` in package.json
- **Versioned with Grafema**: skill evolves with tool capabilities
- **Clear separation**: `.claude/skills/` = internal dev, `packages/cli/skills/` = public
- **Natural install path**: CLI can copy from its own bundled resources

**Directory structure:**
```
packages/cli/
├── skills/                                    # NEW: Public skills (bundled in npm)
│   └── grafema-codebase-analysis/
│       ├── SKILL.md                          # Main skill file (<500 lines)
│       ├── references/
│       │   ├── node-edge-types.md            # Schema reference
│       │   ├── query-patterns.md             # Common Datalog patterns
│       │   └── decision-tree.md              # Tool selection flowchart
│       └── assets/
│           └── workflow-diagram.md           # Visual guide (optional)
```

### 2. What Should SKILL.md Contain?

**Philosophy: Teach agents to THINK like Grafema users.**

**Frontmatter:**
```yaml
name: grafema-codebase-analysis
description: |
  Analyze codebases using graph queries instead of reading files. Use when:
  (1) understanding code architecture, dependencies, or data flow
  (2) finding functions, calls, or usage patterns
  (3) checking invariants or validating assumptions
  (4) user mentions "how does X work", "where is Y used", "trace Z"
  Grafema builds a queryable graph from code—prefer querying over reading.
license: Apache-2.0
compatibility: Requires Grafema MCP server running (npx @grafema/mcp --project .)
metadata:
  author: Grafema
  version: "0.2.5-beta"
```

**Body structure** (~400 lines, staying well under 500):

1. **The Grafema Philosophy** (~50 lines)
   - "AI should query the graph, not read code"
   - When to prefer Grafema over file reading
   - What Grafema CAN and CANNOT do

2. **Quick Start** (~50 lines)
   - Prerequisites (MCP server running)
   - First query examples
   - How to verify graph is ready

3. **Decision Tree: Which Tool to Use** (~150 lines)
   - "I want to find..." → use `find_nodes` or `find_calls`
   - "I want to trace..." → use `trace_dataflow` or `trace_alias`
   - "I want to understand..." → use `get_context` or `get_file_overview`
   - "I want to check..." → use `check_invariant` or `check_guarantees`
   - "I need raw power..." → use `query_graph` (Datalog)

4. **Common Patterns** (~100 lines)
   - Finding entry points
   - Tracing user input to database
   - Finding all uses of a function
   - Checking for security issues
   - Understanding service boundaries

5. **Anti-Patterns** (~30 lines)
   - DON'T: Read file → search manually → build mental model
   - DO: Query graph → get structured results → ask follow-ups
   - DON'T: Use Grafema for single-file analysis (Read tool faster)
   - DO: Use Grafema for cross-file relationships

6. **Troubleshooting** (~20 lines)
   - Graph not analyzed → run `analyze_project`
   - Query returns nothing → check `get_schema` for available types
   - Unexpected results → use `explain: true` flag

**Key principle:** SKILL.md is for STRATEGY. Tactical details go in `references/`.

### 3. What Reference Files?

#### `references/node-edge-types.md` (~200 lines)
Generated from `get_schema`, but human-curated for agent consumption:
- Node types with descriptions and examples
- Edge types with semantics
- Common attributes per node type
- Quick lookup table

#### `references/query-patterns.md` (~300 lines)
Datalog query cookbook:
- Basic patterns (find function, find calls, find dependencies)
- Intermediate patterns (transitive closure, recursive queries)
- Advanced patterns (inter-procedural analysis, taint tracking)
- Each pattern with explanation + example

#### `references/decision-tree.md` (~150 lines)
Detailed flowchart for tool selection:
- Input: user's question
- Output: which tool(s) to use + order
- Examples: "Where is X used?" → `find_calls` → `get_context` on results

### 4. CLI Command Design

**Command:** `grafema setup-skill`

**What it does:**
```bash
# Default: install in .claude/skills/ (Claude Code)
grafema setup-skill

# Support other platforms
grafema setup-skill --cursor    # Install in .cursor/skills/
grafema setup-skill --copilot   # Install in .github/copilot/skills/
grafema setup-skill --path ./custom/path/skills/
```

**Implementation:**
1. Check if skill already exists (compare version in metadata)
2. If outdated or missing → copy from `packages/cli/skills/grafema-codebase-analysis/`
3. Print confirmation + next steps
4. Idempotent: running twice = no-op if same version

**Edge cases:**
- No .claude/ dir → create it
- Skill exists but different version → prompt to upgrade
- Custom path → validate it exists

**Integration with `grafema init`:**
- After initial analysis, suggest: `grafema setup-skill` to enable AI assistance
- NOT automatic (user should opt-in)

### 5. Cross-Platform Compatibility

**CRITICAL: Use ONLY standard Agent Skills spec fields.**

**Avoid:**
- Claude Code-specific extensions
- Custom frontmatter fields not in spec
- References to Claude-only features

**Ensure:**
- Description uses generic language ("AI agents" not "Claude")
- Examples use standard MCP tool invocation
- No assumptions about agent capabilities beyond spec

**Testing cross-platform:**
- Validate with `skills-ref validate` (official validator)
- Test in Claude Code, Cursor (once they ship skills support)
- Document any platform-specific quirks in compatibility field

---

## What Could Go Wrong? (Architectural Risks)

### Risk 1: Skill Becomes Stale
**Problem:** MCP tools evolve, skill documentation lags behind.

**Mitigation:**
- Version skill in metadata (match Grafema version)
- CI check: fail if SKILL.md references undefined MCP tools
- Release checklist: update skill when tools change

### Risk 2: Too Much or Too Little Detail
**Problem:** Either agents ignore skill (too long) or don't know what to do (too vague).

**Mitigation:**
- Keep SKILL.md under 400 lines (target 350)
- Move ALL Datalog syntax to `references/query-patterns.md`
- Test with real tasks: "Find where req.body is used" — can agent do it?

### Risk 3: Duplication with MCP Tool Descriptions
**Problem:** Tool descriptions in `definitions.ts` vs skill body = sync nightmare.

**Mitigation:**
- SKILL.md does NOT repeat tool signatures
- SKILL.md focuses on WHEN to use each tool, not WHAT it does
- Link to MCP tool docs for parameter details

### Risk 4: Agents Don't Activate the Skill
**Problem:** Poor frontmatter description → agents never discover Grafema.

**Mitigation:**
- Frontmatter description MUST contain trigger keywords:
  - "code analysis", "dependencies", "data flow", "find functions"
  - "architecture", "call graph", "trace", "query"
- Test: ask agent "How does authentication work in this codebase?"
  - If it reads files instead of activating Grafema → description failed

---

## High-Level Implementation Plan

### Phase 1: Skill Structure (~2 days)
1. Create `packages/cli/skills/grafema-codebase-analysis/` directory
2. Write SKILL.md frontmatter + body outline
3. Validate with `skills-ref validate`
4. Get Steve's approval on structure before filling content

### Phase 2: Reference Files (~3 days)
1. Generate `node-edge-types.md` from schema (script or manual)
2. Write `query-patterns.md` cookbook (curate from existing docs + tests)
3. Create `decision-tree.md` flowchart
4. Review: can agent solve 10 common tasks with these references?

### Phase 3: CLI Command (~2 days)
1. Implement `setup-skill` command in `packages/cli/src/commands/`
2. Handle platform detection (Claude Code, Cursor, Copilot)
3. Add tests (unit + integration)
4. Update `grafema init` to suggest setup-skill

### Phase 4: Integration & Publishing (~2 days)
1. Update `packages/cli/package.json` to include `skills/` in published files
2. Update CHANGELOG.md
3. Write blog post / announcement (how to use)
4. Test end-to-end: fresh install → setup-skill → agent uses it

### Phase 5: Validation (~1 day)
1. Test with real questions in Claude Code
2. Measure: % of time agent queries graph vs reads files
3. Iterate on skill description if activation rate low

**Total estimate:** 10-11 days (including iteration)

---

## Success Criteria

**Must have:**
1. ✅ SKILL.md validates with `skills-ref validate`
2. ✅ `grafema setup-skill` installs working skill
3. ✅ Agent can answer "Where is function X used?" without reading files
4. ✅ Skill works in Claude Code (primary target)

**Should have:**
5. ✅ Under 500 lines in SKILL.md, under 5000 tokens total
6. ✅ Decision tree covers 90% of common use cases
7. ✅ Agent activates skill for architecture questions

**Nice to have:**
8. ✅ Works in Cursor, Copilot (when they ship Agent Skills support)
9. ✅ Automated tests that SKILL.md references valid MCP tools

---

## Open Questions for User (Вадим)

1. **Skill naming:** `grafema-codebase-analysis` vs `grafema` vs `codebase-graph-query`?
   - Recommendation: `grafema-codebase-analysis` (descriptive, discoverable)

2. **Setup-skill auto-run:** Should `grafema init` automatically run `setup-skill`?
   - Recommendation: NO. Let users opt-in. Mention in output.

3. **Multiple skills:** Should we create SEPARATE skills for different use cases?
   - `grafema-security-analysis` (focus on taint tracking, invariants)
   - `grafema-architecture-review` (focus on dependencies, modules)
   - Recommendation: NO. Start with ONE skill. Split later if agents get confused.

4. **Skill versioning:** Match Grafema version (0.2.5-beta) or independent (1.0.0)?
   - Recommendation: Match Grafema. Skill is tightly coupled to tool capabilities.

---

## Alignment with Grafema Vision

**"AI should query the graph, not read code."**

This task is CORE to that vision. Without Agent Skills:
- Agents don't know Grafema exists
- Agents read files manually (defeating the purpose)
- Grafema is just "another tool" instead of the FIRST choice

With Agent Skills:
- Agents DISCOVER Grafema via frontmatter description
- Agents PREFER graph queries over file reading (decision tree guides them)
- Grafema becomes the STANDARD way agents understand code

**This is not a feature. This is the UX layer for Grafema's core thesis.**

---

## Next Steps

If this plan is approved:
1. Joel expands into detailed technical spec
2. Steve reviews for vision alignment
3. Вадим confirms or requests changes

If rejected:
- What's missing? What's wrong?
- Back to research phase.

---

**Don Melton**  
Tech Lead, Grafema
