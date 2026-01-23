# Skill: Strategy

Strategic thinking: direction, priorities, decision validation.

## When to use

- "Where should we go next?"
- "Are we doing X correctly?"
- "What's more important: A or B?"
- "Why isn't Y working?"
- Reflection after a major phase
- Preparing for release / pivot / major decision

## Input question

> **"Given [context], how do we achieve [goal]?"**

Variants:
- Direction: "Where should we go?"
- Priorities: "What to do next?"
- Validation: "Are we doing X correctly?"
- Diagnosis: "Why isn't Y working?"

## Team

| Role | Persona | Their question |
|------|---------|----------------|
| Long-term | **Jeff Bezos** | What will still matter in 5 years? What won't change? What to bet on? |
| Contrarian | **Peter Thiel** | What's our "secret knowledge"? What do we see that the market doesn't? What does everyone believe is true but isn't? |
| Threats | **Andy Grove** | What will kill the project if ignored? Where are blind spots? What can go wrong? |
| First Principles | **Richard Feynman** | What do we actually know vs assume? Where are gaps in understanding? Can we explain it simply? |
| Synthesis | **Charlie Munger** | What known pattern applies here? What if we invert the problem? Which mental models are relevant? |

## Process

### 1. Question formulation

Clearly formulate what we want to understand. Record in `001-user-request.md`.

### 2. Independent analysis (all in parallel)

Each expert writes their report, answering THEIR question applied to the common context.

**Bezos** focuses on:
- Customer obsession — what does the user need?
- Working backwards — from outcome to actions
- What won't change — invariants to build on

**Thiel** focuses on:
- Zero to one — what new thing are we creating?
- Secrets — what do we know that others don't?
- Monopoly — how to become the only choice?

**Grove** focuses on:
- Strategic inflection points — is the game changing?
- Paranoid thinking — worst case scenarios
- What signals problems?

**Feynman** focuses on:
- First principles — what is definitely true?
- Simple explanation — if we can't explain simply, we don't understand
- What did we actually measure vs assume?

**Munger** focuses on:
- Latticework of mental models — which models apply?
- Inversion — what if we ask the opposite?
- Second-order effects — what follows from the consequences?

### 3. Synthesis

Collect all reports:
- Where is consensus? → Strong signal
- Where are contradictions? → Requires trade-off choice
- What's unexpected? → Pay attention

### 4. Decision (user)

User reads synthesis and makes decision. AI doesn't make strategic decisions — AI provides the map, human chooses the route.

## Artifacts

```
_tasks/YYYY-MM-DD-strategy-name/
├── 001-user-request.md
├── 002-bezos-analysis.md
├── 003-thiel-analysis.md
├── 004-grove-analysis.md
├── 005-feynman-analysis.md
├── 006-munger-analysis.md
├── 007-synthesis.md
└── 008-decision.md (filled by user or captures decision after discussion)
```

## Principles

- **Independence over consensus** — don't smooth out contradictions
- **AI informs, human decides** — no "I recommend"
- **Long-term > short-term** — strategy isn't about tomorrow
- **Honesty > comfort** — Grove should scare, Thiel should provoke
