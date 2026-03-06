# Runbook 01: Extract from Git History

## Input

Git commit history, obtained via either:
- `grafema git-ingest` (automated — writes to `knowledge/derived/`)
- `git log --numstat --format="COMMIT_START%n%H%n%s%n%an%n%ae%n%aI"` (manual)

## When to Run

- After `grafema git-ingest --full` or incremental ingest
- When onboarding a new repository
- Periodically to update derived knowledge with recent history

## Lifecycle

**Derived** — fully rebuildable from git. On conflict: regenerate.
Storage: `knowledge/derived/`

## Projections

- **Temporal** — when things changed, in what order
- **Organizational** — who changed what, team ownership

---

## Pass 1: Entity Extraction

### COMMIT nodes

The `grafema git-ingest` command handles COMMIT extraction automatically, writing YAML files batched by month to `knowledge/derived/commits/YYYY-MM.yaml`.

Each commit entry contains:
```yaml
- type: COMMIT
  hash: <full SHA>
  message: <subject line>
  author_ref: kb:author:<slug>
  date: <ISO 8601>
  files:
    - path: <file path>
      added: <lines>
      removed: <lines>
  projections: [temporal, organizational]
```

**Conventional commit parsing** (manual enrichment step):

For repos using conventional commits (`type(scope): message`), extract structured metadata:

| Field | Source | Example |
|-------|--------|---------|
| `conv_type` | prefix before `(` or `:` | `feat`, `fix`, `refactor`, `test`, `docs` |
| `conv_scope` | text in `()` | `knowledge`, `cli`, `mcp` |
| `breaking` | `!` before `:` or `BREAKING CHANGE:` in body | `true`/`false` |
| `refs` | ticket patterns in message | `REG-123`, `RFD-47` |

Prompt for conventional commit enrichment:

```
Parse each commit message using conventional commit format.

For each commit, extract:
- conv_type: the type prefix (feat, fix, refactor, test, docs, chore, etc.)
- conv_scope: the scope in parentheses (if present)
- breaking: true if the commit has a ! before : or mentions BREAKING CHANGE
- refs: any ticket/issue references (patterns: REG-NNN, RFD-NNN, #NNN)

If the message does not follow conventional commit format, set conv_type to "other".

Output as YAML fields to be merged into the existing commit entry.
```

**Merge commit handling:**

- Merge commits (messages starting with `Merge`) are included in the data but should be marked: `merge: true`
- Merge commits are excluded from co-change analysis (they inflate coupling signals)
- File changes in merge commits are not counted toward authorship (they duplicate the merged branch's changes)

### AUTHOR nodes

The `grafema git-ingest` command handles AUTHOR extraction automatically, writing to `knowledge/derived/authors.yaml`.

Each author entry:
```yaml
- id: <slug>
  type: AUTHOR
  name: <primary name>
  emails: [<all known emails>]
  aliases: [<alternative names>]
  projections: [temporal, organizational]
```

**Author dedup** is handled by the ingest tool: emails are lowercased, and the most-frequently-used name becomes the primary name. Alternative names become `aliases`.

**Manual author dedup** (when automated dedup is insufficient):

Some contributors use different email addresses that don't auto-group:
- `dev@company.com` and `personal@gmail.com` for the same person
- GitHub noreply addresses: `12345+username@users.noreply.github.com`

To merge: manually edit `authors.yaml`, combine email lists under one entry, add the other names as aliases. The slug is derived from the primary name.

---

## Pass 2: Relationship Extraction

### AUTHORED_BY (implicit)

Each commit entry contains `author_ref: kb:author:<slug>`, which serves as the AUTHORED_BY relationship. No separate edge in `edges.yaml` needed — the reference is inline.

### MODIFIES (implicit)

Each commit entry contains `files:` with path, added, removed. This is the MODIFIES relationship. No separate edge needed — the data is inline in the commit YAML.

**Semantic address resolution** (optional enrichment):

For file paths in commit entries, attempt to resolve against the code graph:
1. Call `mcp__grafema__find_nodes(file="<path>")` for each unique file path
2. If resolved, the file path is already a valid reference
3. If not (file was deleted, renamed), mark as historical reference

### Co-change inference

Files modified in the same commit have an implicit coupling signal. This is **not** stored as separate edges (would cause O(n^2) explosion). Instead:

- Co-change data is queried at runtime via `git_cochange` MCP tool
- The tool computes co-change frequency from the stored commit data
- Threshold: `min_support=0.1` (files must co-change in at least 10% of commits touching either)

### Ticket references

When commit messages contain ticket references (e.g., `fix(REG-123): ...`):

```yaml
# In edges.yaml — only for explicitly referenced tickets
- type: RELATES_TO
  from: kb:commit:<short-hash>  # use first 7 chars of full hash
  to: kb:ticket:REG-123
  evidence: "referenced in commit message"
```

Note: only add edges for tickets that exist as KB entities. If the ticket hasn't been ingested yet, skip the edge — it can be added during a future `02-claude-sessions` or ticket ingestion pass.

---

## Pass 3: Cross-Reference Validation

### 1. Author consistency

- Every `author_ref` in commit entries must point to an existing entry in `authors.yaml`
- Check: parse all commit files, collect unique `author_ref` values, verify each exists in authors

### 2. File path resolution

- Spot-check: pick 10 random file paths from recent commits
- Call `mcp__grafema__find_nodes(file="<path>")` for each
- Expected: files from recent commits should resolve (unless deleted since)
- Deleted files are expected for old commits — not an error

### 3. Conventional commit refs

- Collect all ticket refs extracted in Pass 1
- Check which exist as KB entities (`query_knowledge(type="TICKET")`)
- Log unresolved refs — these are candidates for future ticket ingestion

### 4. Meta consistency

- `knowledge/derived/meta.yaml` must exist after ingest
- `last_commit` must match the most recent commit hash in the data
- `last_ingest` must be a valid ISO timestamp

---

## Output

| What | Where | Format |
|------|-------|--------|
| Commits | `knowledge/derived/commits/YYYY-MM.yaml` | YAML array |
| Authors | `knowledge/derived/authors.yaml` | YAML array |
| Meta | `knowledge/derived/meta.yaml` | YAML object |
| Ticket ref edges | `knowledge/edges.yaml` | YAML array (appended) |

---

## Testing

**Quick verification** (run on Grafema repo, last 20 commits):

```bash
grafema git-ingest --full --since "$(git log -20 --format=%aI | tail -1)"
```

Then verify:
1. `knowledge/derived/commits/` has YAML files with correct month grouping
2. `knowledge/derived/authors.yaml` has entries with emails and aliases
3. Each commit has a valid `author_ref` pointing to an author entry
4. Merge commits are present (check for "Merge" in messages)
5. Conventional commit types are parseable from messages (manual check: `grep -c "^  message: " knowledge/derived/commits/*.yaml`)

---

## Edge Cases

| Case | Handling |
|------|----------|
| Empty repo (no commits) | Ingest returns `{ commits: 0, authors: 0, filesChanged: 0 }` |
| Binary files | `added`/`removed` = 0 (git reports `-` for binary diffs) |
| Renamed files | Path resolved to new name via `{old => new}` pattern |
| Very large repos (100k+ commits) | Use `--since` flag to chunk by date range |
| Force-pushed branches | Full re-ingest (`--full`) rebuilds from current state |
| Author with no name | Slug derived from email prefix |
