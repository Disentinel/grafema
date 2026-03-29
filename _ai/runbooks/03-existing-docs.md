# Runbook 03: Extract from Existing Documentation

## Input

Markdown files in the repository: ADRs, READMEs, design docs, research files. Two categories:

1. **Files WITH YAML frontmatter** — already KB-formatted, validate and index
2. **Files WITHOUT frontmatter** — require LLM-assisted entity extraction

## When to Run

- When onboarding a repository into Grafema KB for the first time
- When new documentation files are added outside the KB workflow
- Periodically to check for staleness (docs referencing code that no longer exists)

## Lifecycle

**Declared** — human-authored knowledge, never auto-rebuilt.
Storage: `knowledge/declared/`

## Projections

- **Epistemic** (primary) — what is known, what decisions were made
- May touch **Intentional** (why things exist), **Organizational** (who is responsible)

---

## Pass 1: Entity Extraction

### Step 1: Inventory documentation files

Scan the repository for documentation files:

```bash
# Find all .md files, excluding generated/vendored content
find . -name "*.md" \
  -not -path "*/node_modules/*" \
  -not -path "*/dist/*" \
  -not -path "*/.grafema/*" \
  -not -path "*/knowledge/*"  # KB files are already indexed
```

Categorize each file:

| Category | Detection | Action |
|----------|-----------|--------|
| Already in KB | Path starts with `knowledge/` | Skip — already indexed |
| Has frontmatter | File starts with `---\n` | Validate and index (Step 2) |
| ADR | Title contains "ADR", "Decision", or has status/alternatives sections | Extract DECISION (Step 3) |
| README | Filename is `README.md` | Extract FACTs about module purpose (Step 4) |
| Research/Design doc | Path contains `research/`, `design/`, `docs/` | Extract DECISIONs and FACTs (Step 5) |
| Operational | Changelog, contributing guide, license | Skip — not epistemic knowledge |

### Step 2: Files WITH frontmatter

These files already follow the KB format. Validate:

1. `id` matches `kb:<type>:<slug>` regex
2. `type` is a valid KB entity type
3. Required fields present for the type (`status` for DECISION, `confidence` for FACT)
4. `projections` is a non-empty array
5. `source` field exists

If valid: the file can be moved/linked into `knowledge/declared/` or left in place with an edge pointing to it.

If invalid: fix frontmatter issues, then index.

### Step 3: ADR extraction

ADR detection heuristics:
- Title contains "ADR" (e.g., `# ADR-001: Use PostgreSQL`)
- File has a "Status" section (`## Status`, `**Status:**`)
- File has a "Decision" or "Context" section
- File has a "Consequences" or "Alternatives" section
- Path contains `adr/`, `decisions/`, `architecture/`

Extraction prompt:

```
You are extracting an Architecture Decision Record into the Grafema KB.

For each ADR file, extract:

1. DECISION entity:
   - id: kb:decision:<slug> (derive from the decision title, 3-6 words)
   - type: DECISION
   - status: map from ADR status field:
     - "Accepted"/"Active"/"Approved" → active
     - "Proposed"/"Draft"/"RFC" → proposed
     - "Superseded"/"Replaced" → superseded
     - "Deprecated"/"Rejected" → deprecated
   - projections: [epistemic]
   - source: path to the original ADR file
   - created: date from ADR (or file creation date if not specified)

2. Body content:
   - First paragraph: the decision statement (what was decided)
   - Remaining: context, consequences, alternatives
   - MUST include rejected alternatives with rationale

3. RELATES_TO references:
   - Code modules mentioned in the ADR → file:name:TYPE format
   - Other ADRs referenced → kb:decision:<slug> format

Example output:
---
id: kb:decision:use-postgresql-for-metadata
type: DECISION
status: active
projections: [epistemic]
source: docs/adr/001-use-postgresql.md
created: 2025-06-15
---

Use PostgreSQL for metadata storage instead of MongoDB.

Rejected alternatives:
- MongoDB: schema flexibility not needed, joins required for reports.
- SQLite: single-writer limitation blocks concurrent analysis.
```

### Step 4: README extraction

READMEs describe module purpose, entry points, and conventions. Extract as FACTs.

Extraction prompt:

```
You are extracting knowledge from a README file into the Grafema KB.

For each README, extract FACT entities for:

1. Module purpose — what does this module/package do?
   - id: kb:fact:<module-slug>-purpose
   - confidence: high (explicitly documented)

2. Entry points — what are the main exports or commands?
   - id: kb:fact:<module-slug>-entry-points
   - confidence: high

3. Conventions — any coding conventions, patterns, or constraints
   mentioned in the README?
   - id: kb:fact:<module-slug>-<convention-slug>
   - confidence: medium (may be aspirational, not enforced)

Skip:
- Installation instructions (operational, not epistemic)
- License information
- Badge/shield links
- Generic boilerplate

For each FACT, set:
- relates_to: semantic address of the module (file:name:TYPE)
- source: path to the README file
```

### Step 5: Research and design doc extraction

Research files and design docs may contain both DECISIONs and FACTs.

Extraction prompt:

```
You are extracting knowledge from a research/design document into the Grafema KB.

Scan the document and extract:

1. DECISION entities — any architectural or design choices stated:
   - Look for: "we chose X", "the approach is Y", "decision: Z"
   - Include alternatives mentioned and why they were rejected
   - id: kb:decision:<descriptive-slug>
   - status: proposed (unless document says otherwise)

2. FACT entities — discovered truths, measurements, findings:
   - Look for: data points, benchmarks, comparisons, discovered patterns
   - Include the source/evidence for each fact
   - id: kb:fact:<descriptive-slug>
   - confidence: high (if backed by data), medium (if analysis), low (if hypothesis)

3. Skip:
   - TODO items and future plans (not yet knowledge)
   - Questions without answers
   - Speculative sections without conclusions

For each entity:
- projections: [epistemic]
- source: path to the document
- relates_to: any code references mentioned (use file:name:TYPE format)
```

---

## Pass 2: Relationship Extraction

### DOCUMENTED_IN edges

Every extracted entity gets a DOCUMENTED_IN edge pointing to its source file:

```yaml
- type: DOCUMENTED_IN
  from: kb:decision:use-postgresql-for-metadata
  to: docs/adr/001-use-postgresql.md
```

### RELATES_TO edges

Cross-references between entities and code:

```yaml
# Entity references code
- type: RELATES_TO
  from: kb:fact:cli-module-purpose
  to: "packages/cli:CLI:MODULE"

# Entity references another entity
- type: RELATES_TO
  from: kb:decision:use-postgresql-for-metadata
  to: kb:decision:three-lifecycle-types
  evidence: "both address storage architecture"
```

### SUPERSEDES edges

When a document explicitly states it replaces an older decision:

```yaml
- type: SUPERSEDES_APPROACH
  from: kb:decision:use-postgresql-v2
  to: kb:decision:use-postgresql-for-metadata
  evidence: "ADR-005 supersedes ADR-001 per status field"
```

Detection: look for "Superseded by", "Replaced by", or status = "superseded" in the source document.

---

## Pass 3: Cross-Reference Validation

### 1. Code reference resolution

Documents often mention modules, functions, or files by name. Validate:

1. Collect all code references from extracted entities (`relates_to`, `applies_to`)
2. For each, call `mcp__grafema__find_nodes` to resolve
3. Common issues:
   - Doc says "the UserService class" but class was renamed → DANGLING
   - Doc says "src/api.js" but file was moved to "packages/api/src/index.ts" → DANGLING
4. Dangling refs are staleness signals — flag the document as potentially outdated

### 2. Slug collision check

1. For each new entity, check if `kb:<type>:<slug>` already exists in `knowledge/`
2. Collision from the same source file = likely re-extraction, skip
3. Collision from different source = two docs describe the same thing, merge or supersede

### 3. Staleness detection

Flag documents where:
- More than 50% of code references are DANGLING
- Document references modules/functions that were deleted
- Document's last git modification date is >12 months ago AND it references active code

These documents are candidates for update or archival.

### 4. Empty extraction check

If a document yields zero extractable entities, it's likely:
- Operational (changelog, contributing guide) — expected, skip
- Too vague to extract concrete knowledge — flag for human review
- Already fully covered by existing KB entries — check for duplicates

---

## Output

| What | Where | Format |
|------|-------|--------|
| DECISION | `knowledge/declared/decisions/<slug>.md` | md + frontmatter |
| FACT | `knowledge/declared/facts/<slug>.md` | md + frontmatter |
| Edges | `knowledge/edges.yaml` | YAML array (appended) |

---

## Testing

**Test on `_ai/research/projections/` files:**

Run the research doc extraction (Step 5) on `_ai/research/projections/08-epistemic.md`.

Expected: FACT entities for key findings about the epistemic projection:
- `kb:fact:epistemic-projection-lenses` — the projection has 3 main lens categories (formal docs, inline knowledge, tribal knowledge)
- Entities should have `source: _ai/research/projections/08-epistemic.md`
- Entities should have `projections: [epistemic]`
- Code references in the doc (if any) should be resolved or marked DANGLING

**Test on any README with substantive content:**

Run README extraction (Step 4) on a package README. Verify:
- At least one FACT extracted (module purpose)
- `relates_to` contains the module's semantic address
- `source` points to the README path

---

## Edge Cases

| Case | Handling |
|------|----------|
| File has frontmatter but wrong format | Fix frontmatter, then index normally |
| ADR references another ADR that doesn't exist in KB yet | Create the edge anyway; the target will resolve when the other ADR is extracted |
| Document is a mix of ADR + research | Extract both DECISION and FACT entities |
| Document has no clear entities | Skip, log as "no extractable knowledge" |
| Very large document (>1000 lines) | Process section by section, not all at once |
| Non-English documentation | Extract in the document's language; slugs are always English |
| Document with code examples | Code in examples is illustrative, not references — don't try to resolve |
