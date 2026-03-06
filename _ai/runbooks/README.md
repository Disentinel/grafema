# Knowledge Extraction Runbooks

Formal procedures for extracting structured knowledge from historical data sources into the Grafema Knowledge Base. Each runbook ensures complete, consistent, and verifiable extraction.

## When to Run

| Trigger | Runbook |
|---------|---------|
| After `grafema git-ingest` or manual git analysis | [01-git-history.md](01-git-history.md) |
| After a Claude Code work session | [02-claude-sessions.md](02-claude-sessions.md) |
| When onboarding existing .md docs into KB | [03-existing-docs.md](03-existing-docs.md) |

## Who Runs Them

The AI agent (Claude) runs these runbooks. They are prompt engineering artifacts — step-by-step procedures that ensure the LLM extracts knowledge deterministically. A human may also follow them manually.

## 3-Pass Structure (Template)

Every runbook follows this structure:

### Pass 1: Entity Extraction

Extract discrete knowledge nodes from the source material.

For each entity:
- Assign a semantic ID: `kb:<type>:<slug>`
- Slug rules: lowercase, hyphens, digits only. Regex: `^[a-z0-9][a-z0-9-]*[a-z0-9]$`
- Full ID regex: `^kb:[a-z_]+:[a-z0-9][a-z0-9-]*[a-z0-9]$`
- Required frontmatter fields: `id`, `type`, `projections`, `source`, `created`
- Type-specific fields: `status` (DECISION), `confidence` (FACT), `task_id` (SESSION)

Entity types and their storage:

| Type | Lifecycle | Format | Directory |
|------|-----------|--------|-----------|
| DECISION | declared | .md + frontmatter | `knowledge/declared/decisions/` |
| FACT | declared | .md + frontmatter | `knowledge/declared/facts/` |
| SESSION | declared | .md + frontmatter | `knowledge/declared/sessions/` |
| COMMIT | derived | .yaml (batched by month) | `knowledge/derived/commits/` |
| AUTHOR | derived | .yaml (single file) | `knowledge/derived/authors.yaml` |
| TICKET | declared | .md + frontmatter | `knowledge/declared/tickets/` |
| INCIDENT | declared | .md + frontmatter | `knowledge/declared/incidents/` |

### Pass 2: Relationship Extraction

Extract edges between entities. All edges go in `knowledge/edges.yaml`.

Edge format:
```yaml
- type: EDGE_TYPE
  from: kb:<type>:<slug>
  to: kb:<type>:<slug>
  evidence: "optional justification"
```

Standard edge types:

| Edge Type | From | To | Meaning |
|-----------|------|----|---------|
| PRODUCED | SESSION | DECISION/FACT | Session produced this knowledge |
| CREATED_IN | TICKET/COMMIT | SESSION | Artifact was created during session |
| AUTHORED_BY | COMMIT | AUTHOR | Commit authored by |
| MODIFIES | COMMIT | code semantic address | Commit modifies this code |
| INFORMED_BY | DECISION | FACT | Decision informed by this fact |
| SUPERSEDES_APPROACH | DECISION | FACT/DECISION | New approach replaces old |
| IMPLEMENTS | TICKET | DECISION | Ticket implements this decision |
| DOCUMENTED_IN | DECISION/FACT | file path | Knowledge documented in this file |
| RELATES_TO | any | any | General relationship |

Code references use semantic addresses (`file:name:TYPE` format), not `kb:` IDs.

### Pass 3: Cross-Reference Validation

Validate all extracted entities and edges against the existing KB and code graph.

## Validation Framework

Run these 6 checks after every extraction pass:

### 1. ID Validation

Every entity ID must match: `^kb:[a-z_]+:[a-z0-9][a-z0-9-]*[a-z0-9]$`

Common failures:
- Uppercase in slug: `kb:fact:Auth-Uses-Bcrypt` (wrong) vs `kb:fact:auth-uses-bcrypt` (correct)
- Spaces or underscores in slug: `kb:decision:file_based` (wrong) vs `kb:decision:file-based` (correct)
- File paths as IDs: `decisions/kb-file-based-storage.md` (wrong) vs `kb:decision:kb-file-based-storage` (correct)

### 2. Collision Check

No two entities may share the same `kb:<type>:<slug>` unless one explicitly supersedes the other.

Procedure:
1. Collect all IDs from new entities
2. Check each against existing `knowledge/` directory (grep frontmatter `id:` fields)
3. On collision: STOP. This is likely a duplicate. Either:
   - Use `supersede_fact` to create a new version
   - Skip the duplicate (it already exists)
   - Error if the content is genuinely different (slug needs adjustment)

### 3. Edge Validation

Every `from` and `to` in `edges.yaml` must reference a valid target:
- `kb:*` references must resolve to an existing entity file with matching `id:` in frontmatter
- Code semantic addresses (`file:name:TYPE`) are validated in check #4

Procedure:
1. Parse all edges from `edges.yaml`
2. Collect all `kb:*` IDs from entity files
3. Flag any edge endpoint that doesn't exist in either set

### 4. Semantic Address Resolution

Code references (in `relates_to`, `applies_to`, edge targets) should resolve against the current code graph.

Procedure:
1. Collect all non-`kb:` references from entities and edges
2. For each, call `mcp__grafema__find_nodes` with the file/name/type components
3. Mark as `[OK]` if resolved, `[DANGLING]` if not
4. Dangling refs are not errors — they're staleness signals. Log them but don't block extraction.

### 5. Duplicate Detection

Fuzzy match new entities against existing KB to catch near-duplicates with different slugs.

Procedure:
1. For each new entity, search existing KB: `query_knowledge(type=<same_type>, text=<key_phrases>)`
2. If a result has >80% content overlap, flag as potential duplicate
3. Human/agent decides: merge, supersede, or keep both

### 6. Provenance Check

Every entity must trace back to a source:
- `source` field in frontmatter (e.g., `kb:session:2026-03-06-kb-architecture-design`)
- For derived entities: implicit source is git history (provenance = the commit itself)
- For declared entities: source must be a SESSION or explicit reference

Flag entities with no `source` field.

## Quality Checklist

After running any runbook, verify:

- [ ] All entities have valid `kb:<type>:<slug>` IDs
- [ ] All edges use semantic IDs (not file paths) for KB references
- [ ] All edges have existing `from` and `to` targets
- [ ] Created artifacts captured (tickets, commits, PRs created during sessions)
- [ ] Rejected alternatives documented with rationale
- [ ] No slug collisions (or explicitly superseded)
- [ ] Provenance: every entity has a `source` field
- [ ] Code references resolved (or explicitly marked as dangling)
- [ ] No duplicate entities (or explicitly justified)

## Prompt Template (Base)

All runbooks include source-specific prompt templates. This is the base template that all extend:

```
You are extracting structured knowledge from [SOURCE_TYPE] into the Grafema Knowledge Base.

## Output Format

For each entity, output a markdown file with YAML frontmatter:

---
id: kb:<type>:<slug>
type: <TYPE>
projections: [<relevant projections>]
source: <provenance reference>
created: <YYYY-MM-DD>
[type-specific fields]
---

<Markdown body content>

## Rules

1. Generate meaningful slugs — they are permanent identifiers, not auto-incremented.
   On collision, STOP — it's likely a duplicate.
2. Use kb:<type>:<slug> for ALL inter-KB references.
3. Use file:name:TYPE for ALL code references.
4. Extract ALL created artifacts (tickets, commits, PRs, files), not just knowledge.
5. Document rejected alternatives with rationale.
6. Capture implicit/side-effect facts, not just explicitly discussed ones.
7. If unsure about a fact, set confidence: low.
```
