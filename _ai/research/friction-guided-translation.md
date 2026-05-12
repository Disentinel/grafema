# Friction-Guided Translation: Grafema as Universal Interface Between Intent and Formal Systems

**Status:** Research / Vision
**Date:** 2026-05-12
**Origin:** Soviet Code experiment → resonance framework → phenomenological analysis → this

## Core Thesis

Programming is translation between human intent and formal systems. The history of the profession is the translator moving up the stack while formal systems absorb the levels below. Grafema's role: the graph as intermediate representation between how humans think and how code works.

## The Translation Stack (historical)

```
1960: human → machine code
1970: human → assembler → machine code
1980: human → C → assembler → ...
2000: human → Python → ...
2020: human → "write a function" → Copilot → Python → ...
2026: human shows friction → agent extracts intent → graph → Claude Code → code → Grafema verifies
```

Each step: translator rises one level, formal system absorbs the level below. Each transition wins because it satisfies the resonance principles better than its predecessor:
- ASM → C: **names as you think** (principle 4)
- C → Python: **cheaper to operate** (principle 3)
- Python → LLM: **captures intent closer to the head** (principle 1)
- LLM → friction-guided agent: **eliminates translation entirely** — replaces formulation with reaction

## Three Roles, Cleanly Separated

| Role | What it does | Doesn't do |
|------|-------------|------------|
| **Agent** (translator) | Extracts intent from human via negativa, ensures translation accuracy | Write code, verify constraints |
| **Claude Code** (coder) | Writes code given precise intent + constraints | Understand what human wants, verify architecture |
| **Grafema** (guardrails) | Invariants, blast radius, structural verification | Write code, talk to human |

The agent's only metric: **"what was produced = what the human wanted"**.

## Three Operating Modes

### COLLECT — observe system, build projections
Agent continuously indexes code into 12 projections (organizational, temporal, epistemic, causal, intentional, risk, contractual, attentional, behavioral, operational, security, economic). Static analysis + git history + friction logs + deploy topology. Background, continuous.

### SERVE — answer questions through the right projection
Same graph, 12 lenses, different consumers. EM asks "whose is this" → organizational. On-call asks "what breaks" → causal. New hire asks "where to start" → epistemic + attentional. Agent selects lens based on detected friction type.

### SHAPE — modify system together with user
Not just code — constraints, invariants, architectural decisions:
- Invariants: "billing NEVER calls user DB directly" → `grafema check` enforces in CI
- Code: agent translates intent → graph shows impact → Claude Code writes → Grafema verifies
- Knowledge: "we decided X because Y" → Enox assertion → available to next person who asks

## Via Negativa as Core Mechanism

Standard approach: user formulates what they want → system delivers.
Our approach: system shows current state → user points to friction → system narrows → repeat.

Reaction is cheaper than formulation by an order of magnitude. The user who "doesn't know what they want" **does** know "where it's wrong". Intent emerges through a series of "no", not through one "yes".

```
Human: "I want payments to go through a queue"
Agent: "Currently payments go synchronously through 3 endpoints [from graph].
        All three through queue, or only X?"
Human: "Only X, leave the rest"
Agent: "If X goes async — Y stops getting synchronous response [blast radius from graph].
        Is that OK?"
Human: "No, Y must still get a response"
Agent: "Then X async + callback to Y. Constraint: Y gets response < 200ms.
        [passes to Claude Code + invariant to Grafema]"
```

Each step: agent presents concrete state, human says where it's wrong. Intent crystallizes through friction, not specification.

## The Invariant of the Profession

Programming doesn't disappear — it transforms from **translation** to **curation**. Not "write code" but "does this code match intent? no? where no?"

Graph + agent + Claude Code handle translation. Human handles curation. This is irreducible — because intent lives in the human, and only they know "yes, this is what I wanted".

## Resonance Framework Application

The four principles explain why this architecture works:

| Principle | How it's satisfied |
|-----------|-------------------|
| **Outside the head** | Graph persists understanding across sessions, teams, time |
| **Relations, not things** | Graph is edges-first; agent presents relationships, not files |
| **Cheap to operate** | Via negativa = reaction, not formulation. One friction signal → one query → one answer |
| **Names as you think** | Agent speaks user's vocabulary, translates to graph/code vocabulary internally |

Cascading resonance: when all four align for a specific user on a specific task, complexity disappears. The agent finds this alignment through friction-guided exploration.

## Emergent Properties

1. **Epistemic flywheel**: each dialog → better next dialog for another user of same repo
2. **Friction-inferred intent**: don't ask "what do you want", infer from friction pattern
3. **Pre-emptive friction**: after 100 dialogs, agent predicts where users will struggle
4. **Causal inversion**: agent actively shapes mental model, not passively serves
5. **Temporal asymmetry**: first session 30 min, tenth session 5 min (accumulated knowledge)
6. **Attention steering as learning**: directing attention = building germane cognitive load

## Theoretical Anchors

- **Cognitive Dimensions of Notations** (Green & Petre 1996) — dimensions as measurable axes
- **Abstract Interpretation** (Cousot & Cousot 1977) — each projection = abstract domain
- **Information Foraging** (Pirolli & Card 1999) — graph = map with direct paths
- **Cognitive Load Theory** (Sweller / Hermans) — extraneous (tool friction) + germane (mental model)
- **Externalization in LLM Agents** (arxiv 2604.08224) — memory/skills/protocols/harness + our addition: deliberation
- **Postphenomenology** (Don Ihde) — technology as mediator of experience
- **Resonance Framework** (Reshetnikov 2026) — four principles as conditions for cognitive phase transition

## Relationship to Existing Work

SourceGraph: SERVE only, text-level, no projections, no via negativa.
CodeScene: COLLECT (temporal/hotspot), no SERVE dialog, no SHAPE.
Cursor/Copilot: SHAPE (code generation), no COLLECT (no persistent graph), no guardrails.
Grafema vision: all three modes, 12 projections, friction-guided, graph as IR.

## Next Steps

1. `grafema onboard` — dialogic SERVE prototype (proves graph value through friction-guided exploration)
2. `grafema check` hardening — SHAPE via invariants (proves guardrails value)
3. Hosted instance on Hetzner — freemium funnel (proves business model)
4. Friction logs → Enox accumulation — epistemic flywheel (proves compounding value)
5. SHAPE into code — agent + Claude Code + Grafema constraints (proves full translation loop)
