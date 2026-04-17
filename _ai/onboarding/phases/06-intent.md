# Phase 6: Intent — Why Is It Built This Way

## Prerequisites
- Phase 2 complete (features/components known)
- Cognitive Load metrics computed

## What to do

Capture rationale for the most complex/surprising parts of the codebase.
This is intent debt reduction — Storey's third layer.

### 6.1 Prioritize by cognitive load

Don't ask about everything. Focus on functions/modules where understanding matters most:

```
Sort by CogLoadScore descending
Take top 20% (or top 10 items, whichever is smaller)
```

These are the places where lost rationale is most expensive.

### 6.2 Ask about surprising structure

For each high-CogLoad item, the question should surface WHY:

```
"checkout.ts has CogLoad 8.7/10 — it touches 14 files across 3 packages,
 with indirection depth 9. Was this always this complex, or did it grow?
 
 Any history on why it's structured this way?"
```

```
"payments/ and orders/ share 31 functions but are owned by different teams.
 Was this an intentional shared-kernel design, or accidental coupling?"
```

```
"workers/legacy-sync.ts hasn't been touched in 11 months, has 340 lines,
 and 0 documentation. Bus factor: 1 (Bob). What does it do? Why does it exist?"
```

### 6.3 Bootstrap from existing docs

Before asking the user, check for existing rationale:
- `/docs`, `/adr`, `ARCHITECTURE.md` → scan for relevant decisions
- git blame on high-CogLoad files → commit messages may have context
- PR descriptions for major changes → often contain rationale

```
"I found ADR-003 'Payment Gateway Selection' explaining why Stripe
 was chosen over Adyen. Captured as DECISION.
 
 There's no ADR for the checkout split across 3 packages though.
 Do you know the history?"
```

Offer to scan docs proactively:
```
"I see a /docs directory with 12 markdown files and 3 ADRs.
 Want me to scan these for architectural decisions and domain terms?
 It'll bootstrap the knowledge base."
```

### 6.4 Handling responses

| User says | Agent does |
|-----------|-----------|
| Gives rationale | KB: DECISION with rationale, linked to code node. Intent debt reduced. |
| "It just grew that way" | KB: DECISION "accidental complexity, no intentional design." This IS the rationale — absence of decision is also a decision. |
| "Bob built it, he's gone now" | KB: RISK lost_knowledge. KB: FACT "original author departed." Create task: "Reverse-engineer [module] rationale from code + git history." |
| "I don't know" | Create investigation task. Mark intent gap in KB. |
| "It's documented in Confluence/Notion" | KB: REFERENCE external_doc with URL. Offer: "Want me to fetch and extract key decisions?" |
| "We're planning to rewrite this" | KB: DECISION "module scheduled for rewrite." Don't spend more time on intent here. |

### 6.5 Generate documentation from graph

For modules with no rationale and no expert available, offer:
```
"Nobody knows why workers/legacy-sync.ts exists. 
 Want me to analyze it and generate a description from the graph?
 
 From the code: it reads from table:events, transforms dates,
 writes to table:legacy_reports. Runs on cron every 6 hours.
 Connected to: ReportingService, EventStore.
 
 I can write this up as a doc comment. It's not the WHY, but
 at least the WHAT won't be lost."
```

This is the one place where AI-generated docs are appropriate — capturing WHAT as a baseline when WHO and WHY are unavailable. Storey warns against substituting docs for understanding, but here there's genuinely no one to understand.

## Completion
- > 30% of high-CogLoad functions have DECISION in KB
- Major architectural questions documented (even if answer is "unknown")

## Artifacts
- KB: DECISION nodes with rationale
- KB: FACT entries from doc scanning
- KB: REFERENCE entries for external docs
- KB: RISK entries for lost knowledge
- Optional: code comments for orphaned modules
