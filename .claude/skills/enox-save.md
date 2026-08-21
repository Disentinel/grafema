---
name: enox-save
description: Extract facts, findings, and relationships from the current conversation and save them to Enox knowledge graph
user_invocable: true
---

# /save — Extract Conversation Knowledge to Enox

Analyze the current conversation, extract valuable knowledge (facts, findings,
decisions, hypotheses, relationships), and persist them to the Enox knowledge
graph as structured nodes and assertions.

## When to Use

- After a research session that produced findings worth preserving
- After experiments with results (confirmed/rejected hypotheses)
- After architectural decisions with rationale
- After discovering non-obvious relationships between concepts
- When the user explicitly says `/save`

## Workflow

### Step 1: Load Enox tools

```
ToolSearch("+grafema recall")
ToolSearch("+grafema assert")
ToolSearch("+grafema retract")
```

### Step 2: Extract knowledge from conversation

Scan the full conversation and identify:

1. **Facts** — empirical findings with evidence (numbers, dates, sources)
2. **Decisions** — choices made with rejected alternatives
3. **Hypotheses** — confirmed or rejected, with evidence
4. **Relationships** — causal links, outperforms/fails_on/supersedes/contradicts
5. **Concepts** — new terms or frameworks introduced
6. **Sources** — papers, blog posts, tools referenced

For each item, determine:
- **Subject** (source node): what entity is this about?
- **Object** (target node): what is it related to?
- **Relation**: which Enox relation type fits? (see relation table below)
- **Context**: rich description with dates, numbers, URLs — this is what `recall` searches over
- **Confidence**: 0.0-1.0 based on evidence strength
- **Node types**: concept, decision, pattern, rejected_alternative, paper, event, effort, etc.

### Step 3: Deduplicate against existing knowledge

Before creating nodes, check if they already exist:

```
recall(query="<concept name or description>", top_k=3)
```

If a match exists with >0.8 similarity:
- **Same finding**: skip (don't duplicate)
- **Updated finding**: use `supersedes` relation
- **Contradicting finding**: use `contradicts` relation

### Step 4: Save to Enox

`assert` is BATCH-NATIVE — pass an array of assertions (group by theme, up to ~50
at once). One fact is an array of one; there is no separate `remember` /
`add_assertion` / `batch_assertions`:

```
assert(assertions=[
  {
    from: "<entity>",
    relation: "outperforms",      // see relation table
    to: "<related entity>",
    context: "<rich description with dates, numbers, evidence>",
    confidence: 0.9,
    domain: "<knowledge domain>"
  }
])
```

To replace an older finding, just assert with `relation: "supersedes"`. To delete a
fact, use `retract(fact_ids=[...])`.

### Step 5: Present summary to user

Show what was saved in a table:

| # | Source | Relation | Target | Confidence |
|---|--------|----------|--------|------------|
| 1 | ... | outperforms | ... | 0.9 |

And note any duplicates skipped or updates made.

## Relation Selection Guide

| Situation | Relation | Example |
|-----------|----------|---------|
| A is better than B (with metrics) | `outperforms` | grafema > grep on L3 questions |
| A doesn't work for B | `fails_on` | aggressive prompt fails on adoption |
| A replaces B (newer finding) | `supersedes` | new result replaces old |
| A contradicts B | `contradicts` | conflicting evidence |
| A caused B | `triggered_by` | experiment triggered by prior finding |
| A links to artifact | `references` | finding references a URL/paper |
| A is about topic B | `about` | session about autoresearch |
| A depends on B | `depends_on` | feature depends on fix |
| A blocks B | `blocks` | OOM blocks VS Code experiment |
| A supports B | `supports` | evidence supports hypothesis |
| A is an instance of B | `instance_of` | grep bias is instance of familiarity bias |
| A is part of B | `part_of` | tool avoidance part of tool adoption |
| A is alternative to B | `alternative_to` | context injection alternative to tool calls |

## Node Type Selection Guide

| Content | Type |
|---------|------|
| General idea, framework, phenomenon | `concept` |
| Choice with rationale | `decision` |
| Reusable approach/technique | `pattern` |
| Approach that was tried and rejected | `rejected_alternative` |
| Academic paper or blog post | `paper` |
| Strategic work stream | `effort` |
| Something that happened | `event` |
| A specific task or ticket | `task` |
| User preference or opinion | `preference` |

## Quality Criteria

Only save knowledge that is:
- **Non-obvious**: wouldn't be found by reading code or docs
- **Reusable**: relevant beyond this single conversation
- **Evidence-based**: has numbers, dates, sources, or clear reasoning
- **Correctly attributed**: source papers/people credited

Do NOT save:
- Trivial facts derivable from code
- Ephemeral task state (use tasks for that)
- Unverified speculation without evidence marker (use confidence < 0.5 if saving)

## Error Recovery

If Enox is unavailable (timeout, connection error):
1. Format the extracted knowledge as YAML
2. Save to `_ai/enox-pending/<date>-<topic>.yaml`
3. Tell user to run `/save` again when Enox is back
