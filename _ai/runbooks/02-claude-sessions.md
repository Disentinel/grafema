# Runbook 02: Extract from Claude Code Sessions

## Input

- Session transcript (conversation context)
- Memory files (`~/.claude/projects/*/memory/`)
- Task context (Linear ticket, branch, commits made)

## When to Run

After every substantive Claude Code work session — one that produced decisions, discovered facts, or created artifacts. Skip for trivial sessions (typo fixes, single-command tasks).

## Lifecycle

**Declared** — human/AI-created, never auto-rebuilt. On conflict: human resolves.
Storage: `knowledge/declared/`

## Projections

- **Epistemic** — what is known, decisions made, facts discovered

---

## Pass 1: Entity Extraction

### SESSION node

One per work session. ID format: `kb:session:<YYYY-MM-DD>-<topic-slug>`

```yaml
---
id: kb:session:2026-03-06-kb-architecture-design
type: SESSION
projections: [epistemic]
task_id: REG-626
session_path: ~/.claude/projects/-Users-vadimr-grafema/sessions
produced:
  - kb:decision:kb-file-based-storage
  - kb:fact:rejected-shared-rfdb-server
  - kb:ticket:REG-627
created: 2026-03-06
---

Description of what the session accomplished.
```

Required fields: `id`, `type`, `projections`, `task_id` (if session was for a specific task), `produced` (list of all entities created), `created`.

If multiple sessions happen on the same day for different tasks, the topic slug disambiguates.

### DECISION nodes

Architectural choices made during the session. ID format: `kb:decision:<descriptive-slug>`

```yaml
---
id: kb:decision:kb-file-based-storage
type: DECISION
status: active
projections: [epistemic]
relates_to:
  - "packages/cli:CLI:MODULE"
source: kb:session:2026-03-06-kb-architecture-design
created: 2026-03-06
---

Knowledge Base is stored as git-tracked files, not persisted in RFDB.
RFDB is used only as a runtime read cache for fast queries.

Rejected alternatives:
- Shared RFDB server across worktrees: branch isolation impossible.
- Single RFDB with provenance tags: same identity problems when clearing.
```

Extraction prompt:

```
Review the session and extract all architectural decisions.

For each decision, answer:
1. What was decided? (concise statement)
2. What is the status? (active, proposed, deprecated, superseded)
3. What alternatives were considered and rejected? Include rationale for each.
4. What code modules does this affect? (use file:name:TYPE format)
5. What facts informed this decision?

Generate a descriptive slug that captures the essence of the decision.
Slug must be: lowercase, hyphens only, 3-6 words. Example: kb-file-based-storage

IMPORTANT: Include rejected alternatives in the markdown body.
A decision without documented alternatives is incomplete.
```

### FACT nodes

Discovered truths about the codebase, domain, or tooling. ID format: `kb:fact:<descriptive-slug>`

```yaml
---
id: kb:fact:clear-deletes-filesystem-directory
type: FACT
projections: [epistemic]
confidence: high
relates_to:
  - "packages/cli:CLI:MODULE"
source: kb:session:2026-03-06-kb-architecture-design
created: 2026-03-06
---

Current implementation of `--clear` deletes the `.grafema/` directory
via filesystem rm. Any persistent data stored there is destroyed.
```

Confidence levels:
- **high** — verified by code inspection or testing
- **medium** — inferred from behavior or documentation
- **low** — suspected but not verified

Extraction prompts (run all three):

```
Prompt A — Explicit facts:
What facts about the codebase or domain were explicitly stated or
confirmed during this session? Include: behavior of specific functions,
limitations discovered, error patterns identified, performance
characteristics measured.

Prompt B — Side-effect facts:
What non-obvious facts were discovered as side effects of the main task?
These are things that weren't the goal but were revealed incidentally.
Example: while designing KB storage, we discovered that --clear
deletes the entire .grafema/ directory.

Prompt C — Preference facts:
What user preferences or project conventions were established or
confirmed? These might be implicit in how the work was done rather
than explicitly stated. Example: "user prefers file-based storage
over database for human-readable data."
```

### Created artifacts

Capture everything the session produced beyond knowledge:

**Tickets created:**
```yaml
# In the SESSION node's produced list:
produced:
  - kb:ticket:REG-626
  - kb:ticket:REG-627
```

Ticket entities are lightweight — just record that they exist and were created in this session. Full ticket content lives in Linear (synced lifecycle, not declared).

**Commits made:**
If the session resulted in git commits, reference them:
```yaml
produced:
  - kb:commit:48ae46c
```

These link to derived commit data from runbook 01.

Extraction prompt:

```
What artifacts were created during this session?

Check for:
1. Linear tickets created (look for REG-NNN, RFD-NNN patterns)
2. Git commits made (check git log for the session date/branch)
3. Pull requests opened
4. Files created or significantly modified
5. Configuration changes

For each artifact: note what it is and why it was created.
```

---

## Pass 2: Relationship Extraction

### PRODUCED edges

SESSION → each DECISION, FACT, TICKET, COMMIT it produced:

```yaml
- type: PRODUCED
  from: kb:session:2026-03-06-kb-architecture-design
  to: kb:decision:kb-file-based-storage

- type: PRODUCED
  from: kb:session:2026-03-06-kb-architecture-design
  to: kb:fact:clear-deletes-filesystem-directory
```

### CREATED_IN edges

Reverse of PRODUCED for artifacts (tickets, commits) — emphasizes the artifact was born in this session:

```yaml
- type: CREATED_IN
  from: kb:ticket:REG-626
  to: kb:session:2026-03-06-kb-architecture-design
```

### INFORMED_BY edges

DECISION → FACT that informed it, with evidence:

```yaml
- type: INFORMED_BY
  from: kb:decision:three-lifecycle-types
  to: kb:fact:twelve-projection-ontology
  evidence: "soundness levels from paper mapped to lifecycle types"
```

### SUPERSEDES_APPROACH edges

When a decision explicitly replaces a rejected approach:

```yaml
- type: SUPERSEDES_APPROACH
  from: kb:decision:kb-file-based-storage
  to: kb:fact:rejected-shared-rfdb-server
```

### IMPLEMENTS edges

When tickets implement decisions:

```yaml
- type: IMPLEMENTS
  from: kb:ticket:REG-626
  to: kb:decision:kb-file-based-storage
```

### RELATES_TO edges

General relationships between entities and code:

```yaml
- type: RELATES_TO
  from: kb:fact:clear-deletes-filesystem-directory
  to: "packages/cli:CLI:MODULE"
  evidence: "fact about CLI's --clear behavior"
```

---

## Pass 3: Cross-Reference Validation

### 1. Slug collision check

For each new entity:
1. Scan `knowledge/declared/` for existing files with same `kb:<type>:<slug>`
2. On collision: this is likely a duplicate from a previous session extraction
3. Compare content — if identical, skip. If different, the slug needs adjustment or one supersedes the other.

### 2. Code reference resolution

For each `relates_to` and `applies_to` entry that uses code semantic addresses:
1. Call `mcp__grafema__find_nodes(file="<file>", name="<name>", type="<type>")`
2. Mark as `[OK]` or `[DANGLING]`
3. Dangling refs are expected if code was refactored since the decision was made

### 3. Artifact verification

For each created artifact:
- **Tickets:** Verify the ticket exists in Linear (`mcp__linear__get_issue(id="REG-NNN")`)
- **Commits:** Verify the commit exists in git (`git log --oneline <hash>`)
- If artifact doesn't exist, remove from `produced` list and log the discrepancy

### 4. Duplicate fact detection

For each new FACT:
1. Call `query_knowledge(type="FACT", text="<key phrases>")`
2. Review results for semantic overlap
3. If a match exists: decide whether to supersede, merge, or skip

### 5. Session completeness audit

After extraction, verify the session entity's `produced` list is complete:
- Does it include ALL decisions extracted? (count must match)
- Does it include ALL facts extracted?
- Does it include ALL tickets/commits referenced?

---

## Output

| What | Where | Format |
|------|-------|--------|
| SESSION | `knowledge/declared/sessions/<date>-<slug>.md` | md + frontmatter |
| DECISION | `knowledge/declared/decisions/<slug>.md` | md + frontmatter |
| FACT | `knowledge/declared/facts/<slug>.md` | md + frontmatter |
| Edges | `knowledge/edges.yaml` | YAML array (appended) |

---

## Testing

**Reproduction test:** Run this runbook on the 2026-03-06 KB architecture design session.

Expected output (matches existing `knowledge/declared/`):

| Entity | ID | Exists |
|--------|----|--------|
| SESSION | `kb:session:2026-03-06-kb-architecture-design` | `knowledge/declared/sessions/2026-03-06-kb-architecture-design.md` |
| DECISION | `kb:decision:kb-file-based-storage` | `knowledge/declared/decisions/kb-file-based-storage.md` |
| DECISION | `kb:decision:three-lifecycle-types` | `knowledge/declared/decisions/three-lifecycle-types.md` |
| DECISION | `kb:decision:frontmatter-and-yaml-formats` | `knowledge/declared/decisions/frontmatter-and-yaml-formats.md` |
| DECISION | `kb:decision:semantic-address-lazy-rebind` | `knowledge/declared/decisions/semantic-address-lazy-rebind.md` |
| DECISION | `kb:decision:projections-are-lenses-not-storage` | `knowledge/declared/decisions/projections-are-lenses-not-storage.md` |
| DECISION | `kb:decision:kb-semantic-id-format` | `knowledge/declared/decisions/kb-semantic-id-format.md` |
| DECISION | `kb:decision:knowledge-dir-at-project-root` | `knowledge/declared/decisions/knowledge-dir-at-project-root.md` |
| FACT | `kb:fact:clear-deletes-filesystem-directory` | `knowledge/declared/facts/clear-deletes-filesystem-directory.md` |
| FACT | `kb:fact:rejected-shared-rfdb-server` | `knowledge/declared/facts/rejected-shared-rfdb-server.md` |
| FACT | `kb:fact:twelve-projection-ontology` | `knowledge/declared/facts/twelve-projection-ontology.md` |

Expected edges: 7 PRODUCED (session -> decisions), 3 PRODUCED (session -> facts), 6 CREATED_IN (tickets -> session), 3 IMPLEMENTS (tickets -> decisions), 2 INFORMED_BY, 1 SUPERSEDES_APPROACH = **22 edges total**.

The 6 tickets (RFD-47, REG-626 through REG-630) were missed on the first manual extraction pass — the runbook's "created artifacts" prompt should catch them.

---

## Common Extraction Failures (from POC)

These failures were observed during the 2026-03-06 manual extraction and motivated this runbook:

| Failure | Root Cause | Runbook Fix |
|---------|-----------|-------------|
| 6 tickets not extracted | No "created artifacts" prompt | Pass 1 includes explicit artifact extraction prompt |
| File paths used as IDs in edges | No ID format standard | All IDs must be `kb:<type>:<slug>`, validated in Pass 3 |
| Inconsistent edge from/to formats | No format standard | Edge format documented, validated in Pass 3 |
| Implicit fact missed (--clear = rm) | Only explicit facts extracted | "Side-effect facts" prompt (Prompt B) in Pass 1 |
| Rejected alternatives lost | No "alternatives" prompt | Decision template requires rejected alternatives |
