---
name: extract-knowledge
description: >
  Extract knowledge (decisions, facts, session metadata) from the current
  Claude Code session into the Grafema Knowledge Base. Run after completing
  a task or at any point when substantive knowledge was produced.
  Follows runbook _ai/runbooks/02-claude-sessions.md.
user_invocable: true
trigger: >
  User says "/extract-knowledge", "extract knowledge", "извлеки знания",
  or at the end of a substantive task per workflow step.
---

# Knowledge Extraction from Current Session

## Step 0: Detect context

```
TASK_ID = parse from current git branch (e.g., task/REG-629 → REG-629)
SESSION_DATE = today's date (YYYY-MM-DD)
SESSION_SLUG = <date>-<task-topic-slug>  (e.g., 2026-03-07-knowledge-runbooks)
```

If no task branch → use topic of the session for the slug.

## Step 1: Check existing session

Call `query_knowledge(type="SESSION", text="<SESSION_DATE>")`.

If a session for today + same task already exists → this is an UPDATE, not create.
Load existing session to avoid duplicating entities.

## Step 2: Extract decisions

Review the conversation for architectural decisions made. For each:

Ask yourself:
1. What was decided? (concise statement)
2. What alternatives were rejected and why?
3. What code does this affect? (semantic addresses: `file:name:TYPE`)
4. What facts informed this decision?

Create via `add_knowledge`:
```
add_knowledge(
  type="DECISION",
  slug="<descriptive-slug>",
  content="<decision statement + rejected alternatives>",
  status="active",
  projections=["epistemic"],
  relates_to=["<code semantic addresses>"]
)
```

## Step 3: Extract facts

Three prompts to self:

**A) Explicit facts:** What facts about the codebase were confirmed or discovered?
**B) Side-effect facts:** What non-obvious facts emerged as side effects of the main task?
**C) Preferences:** What conventions or preferences were established?

For each fact, create via `add_knowledge`:
```
add_knowledge(
  type="FACT",
  slug="<descriptive-slug>",
  content="<fact description with evidence>",
  confidence="high|medium|low",
  projections=["epistemic"],
  relates_to=["<code semantic addresses>"]
)
```

## Step 4: Collect created artifacts

Check what was created during this session:
- Linear tickets (REG-NNN, RFD-NNN patterns in conversation)
- Git commits (`git log --oneline --since="today"` on current branch)
- Files created/modified significantly

## Step 5: Create/update SESSION node

```
add_knowledge(
  type="SESSION",
  slug="<SESSION_SLUG>",
  content="<session summary: what was done, key outcomes>",
  task_id="<TASK_ID>",
  projections=["epistemic"]
)
```

Then manually update the session file's `produced:` list in frontmatter
to include all entity IDs from steps 2-4.

## Step 6: Create edges

Append to `knowledge/edges.yaml`:
- PRODUCED: session → each decision, fact
- CREATED_IN: each ticket/commit → session
- INFORMED_BY: decision → facts that informed it (with evidence)
- IMPLEMENTS: ticket → decision (if applicable)
- SUPERSEDES_APPROACH: decision → rejected approach (if applicable)

## Step 7: Validate

Run validation checks from `_ai/runbooks/README.md`:
1. All IDs match `^kb:[a-z_]+:[a-z0-9][a-z0-9-]*[a-z0-9]$`
2. No slug collisions (check existing KB)
3. All edge endpoints exist
4. Code refs resolve via `find_nodes` (mark DANGLING if not)
5. No duplicate facts (`query_knowledge(type="FACT", text="<key phrases>")`)
6. All entities have `source` field

## Step 8: Invalidation check (optional)

If the session modified code that existing KB entities reference:
1. `query_knowledge(include_dangling_only=true)` — find newly broken refs
2. For each dangling ref: is the code gone, renamed, or moved?
3. If renamed/moved → update the `relates_to` in the KB entity
4. If gone → leave as dangling (staleness signal)

## Output summary

Print a summary:
```
Knowledge extracted:
  Session: kb:session:<slug>
  Decisions: N (list IDs)
  Facts: N (list IDs)
  Artifacts: N tickets, N commits
  Edges: N new
  Validation: N OK, N warnings
  Dangling refs: N (list if any)
```

## Skip conditions

Do NOT extract if:
- Session was trivial (typo fix, single-line change, no decisions made)
- Session only read code without producing knowledge
- All knowledge from this session was already extracted (update check in Step 1)
