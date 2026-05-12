# The Superconductor Pattern: Self-Writing Software Through Friction

**Status:** Research / Early
**Date:** 2026-05-12
**Origin:** Soviet Code experiment → resonance framework → friction-guided translation → this

## Core Idea

A superconductor is not a product. It is a **method of generating products** from user friction.

The same system, encountering different users, grows different software around itself — like a conductor who builds the vehicle (tram, car, airplane, spaceship) based on where the passengers need to go.

## The Loop

```
User friction signal
  → Superconductor: via negativa hypothesis ("your pain is X?")
    → User: "no, it's Y" 
      → Superconductor: formulate intent from rejection
        → Claude Code: write code (tool, script, query, automation)
          → Grafema: verify invariants, check blast radius
            → Deploy to user
              → User: friction on the NEW thing
                → Loop
```

No programmer in the loop. Human-in-the-loop = the USER, not a developer.
The user is simultaneously stakeholder, tester, and product owner.

## Why This Works (Resonance Check)

| Principle | How it's satisfied |
|-----------|-------------------|
| Outside the head | Each cycle produces a persistent artifact (code, tool, invariant) |
| Relations | Friction map = graph of "what hurts" → "what was built" → "did it help" |
| Cheap to operate | One rejection = one update. User doesn't specify, just reacts |
| As you think | User speaks their language, superconductor translates to code |

## Why Friction = Value Signal (Not Goodhart)

For most metrics, optimizing the metric ≠ optimizing value (Goodhart's law).

Exception: **friction in a tool IS the failure of the tool**. If the user isn't in pain, the tool works. If they are, it doesn't. Friction is not a proxy for value — it is the direct inverse of value. Reducing friction = increasing value, tautologically.

This only holds for tools/software (where the purpose is to serve the user). Does NOT hold for: entertainment (friction can be the point), education (productive struggle), games (challenge = value).

## What the Superconductor Is Made Of

Four components (minimum, per resonance synergy analysis):

```
1. Graph (Grafema/RFDB)  — structural memory, relations, cheap traversal
2. Git integration       — temporal memory, change patterns
3. Metrics/Runtime       — behavioral memory, actual outcomes
4. LLM (Claude Code)     — translation layer, code generation, via negativa dialog
```

Each covers different resonance axes. Together = 4/4. Separately = incomplete.

## Unfair Advantages

1. **Nothing to copy.** No fixed product exists. Each installation is unique code grown from unique friction. Reverse engineering impossible.

2. **Switching cost grows with time.** Accumulated understanding of user's system + mental model in Enox. Leaving = losing all of it. Lock-in through knowledge, not format.

3. **Zero upfront product development.** No PM, no roadmap, no feature planning. Each user's friction IS the roadmap. Product development happens in real-time, funded by the user's subscription.

4. **Friction patterns transfer, solutions don't.** "Teams of 10 backend developers usually struggle with X" → next such team gets a head start. The pattern is reusable even though each team's solution is unique.

5. **Open source amplifies, doesn't threaten.** The method is open. The accumulated friction patterns (in Enox) are the moat. More users → more patterns → better initial hypotheses → faster convergence for next user.

## What Already Works (Evidence)

Soviet Code (5-day experiment, May 2026):
- Ираида received friction from AbstractDL chat
- Генсек formulated tasks from friction
- Стахановцы wrote code (44 commits in soviet-code, 6 in Grafema)
- Комиссар reflected, found bugs, created fix tasks autonomously
- НИИ (Opus) produced deep analysis, plugins, knowledge base
- No human developer in the coding loop (operator = curator only)

Result: working multi-agent system with Telegram bridge, ГАЗЕТА, KADRY characters, field-instance-resolver plugin, effects-db/python.yaml — all grown from friction signals, not from a spec.

## Scientific Method Connection

Via negativa interview = Popperian falsification on mental models:

```
Popper:          hypothesis → experiment → falsification → new hypothesis
Superconductor:  "your pain is X" → "no" → "then Y?" → "yes but Z" → refine
```

The superconductor conducts ongoing scientific research on one subject: the user's mental model. Each interaction = one experiment. Result = increasingly accurate model of what the user wants.

## Relationship to Existing Concepts

| Concept | Similarity | Difference |
|---------|-----------|------------|
| Low-code/no-code | Users don't write code | We don't simplify coding, we eliminate it |
| AutoML | System builds itself | AutoML optimizes model, we optimize UX |
| Product-led growth | Product sells itself | Product BUILDS itself |
| Lean Startup | Build-measure-learn | No "build" phase — friction IS the spec |
| DevOps | Continuous delivery | Continuous product generation |

## Risks

1. **Friction ≠ value for non-tool domains** (entertainment, education, games). Scope limited to productivity software.

2. **User doesn't know what they need** — via negativa helps (reaction > formulation) but doesn't eliminate. Some needs are invisible until shown.

3. **Code quality without human review** — Grafema invariants help but don't replace architectural judgment. Skill atrophy risk if humans stop understanding the grown system.

4. **Bias accumulation** in friction patterns without forgetting mechanism.

## Open Questions

- Can the loop run without ANY human curation, or is curation irreducible?
- What's the minimum viable superconductor? (Grafema + Claude Code + via negativa script?)
- How do friction patterns compose across teams/companies?
- Is there a category-theoretic formalization of "vehicle grown from friction"?

## Next Steps

1. Prototype: Claude Code + Grafema MCP + via negativa dialog script, one real user, one real repo
2. Measure: friction reduction over 5 sessions (does it converge?)
3. Publish: if it works, write up as "Friction-Guided Software Generation" paper
