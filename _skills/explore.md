# Skill: Explore

Topic exploration: understanding problems, gathering knowledge, analyzing possibilities.

## When to use

- "What do we need to understand about X?"
- "How does this actually work?"
- "What approaches exist for solving Y?"
- "What already exists in this area?"
- Before starting a major feature
- When stuck and need fresh perspective

## Input question

> **"What do we need to understand about [topic]?"**

Variants:
- Understanding: "How does this work?"
- Landscape: "What already exists?"
- Approaches: "What ways are there to solve this?"
- Feasibility: "Is X possible?"

## Team

| Role | Persona | Their question |
|------|---------|----------------|
| First Principles | **Richard Feynman** | What do we actually know? How to explain this simply? What are the basic principles? |
| Patterns | **Christopher Alexander** | What patterns work here? What's already been solved? What's the "grammar" of this domain? |
| Adjacent | **Stuart Kauffman** | What's adjacent to this? Adjacent possible? What combinations haven't been tried? |
| Practical | **Thomas Edison** | What can we quickly try? What's the minimum experiment? |
| Pedantic | **Sheldon Cooper** | Actually... what did we miss? Where's the imprecision in reasoning? What edge cases? |

## Process

### 1. Topic formulation

Clearly formulate what we want to explore. Record in `001-user-request.md`.

### 2. Independent analysis (all in parallel)

Each expert explores the topic through their lens.

**Feynman** focuses on:
- Breaking down to atomic components
- "If I were explaining to a student..."
- What's known precisely, what's hypothesis?
- Analogies from other fields

**Alexander** focuses on:
- Existing patterns and their "forces"
- How have others solved similar problems?
- Quality without a name — what makes a solution "alive"?
- Pattern composition

**Kauffman** focuses on:
- Adjacent possible — what becomes achievable?
- Combinatorics — what elements can be combined?
- Emergent properties — what arises from combination?
- Where are the boundaries of what's possible now?

**Edison** focuses on:
- Minimum experiment for validation
- "I have not failed, I've found 10,000 ways that won't work"
- Practical constraints
- What can be done in a day/hour?

**Sheldon** focuses on:
- Terminological precision ("That's not X, that's Y")
- Logical holes in reasoning
- Edge cases everyone ignores
- "But if that's true, then..." — consequences
- Formal definitions

### 3. Synthesis

Collect findings:
- What do we now understand?
- Which approaches look promising?
- What requires further research?
- Which experiments are worth running?

### 4. Next steps

Determine:
- Enough understanding for action? → Transition to `/build` or `/strategy`
- Need to dig deeper? → Another `/explore` iteration
- Need experiment? → Spike/prototype

## Artifacts

```
_tasks/YYYY-MM-DD-explore-name/
├── 001-user-request.md
├── 002-feynman-analysis.md
├── 003-alexander-analysis.md
├── 004-kauffman-analysis.md
├── 005-edison-analysis.md
├── 006-sheldon-analysis.md
├── 007-synthesis.md
└── 008-next-steps.md
```

## When to Use Full Explore (5 Lenses)

Use full explore skill when:
- Topic is complex with multiple valid perspectives
- High stakes (decision based on exploration is important)
- Novel territory (no established patterns to follow)
- Time available for thorough analysis

For simpler questions, consider:
- **Single lens:** Quick answer to focused question
- **Dialectic (2 lenses):** Binary trade-off analysis
- **Direct research:** When answer is factual, not value-laden

See `_ai/mla-patterns.md` for lens selection guidance and `_ai/mla-failure-modes.md` for common pitfalls.

## Principles

- **Understanding > solution** — goal is to understand, not to solve
- **Breadth > depth** (on first iteration) — map first, details later
- **Sheldon is right** — if he found a hole, it exists
- **Edison is practical** — exploration without ability to verify is useless
- **No stupid questions** — Feynman asked "what is an electron?" as a Nobel laureate
- **Convergence = confidence** — if lenses agree, high confidence; if not, genuine uncertainty
