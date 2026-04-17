# ADR: Analysis-First Onboarding Design

**Status:** Accepted
**Date:** 2026-04-04
**Context:** Grafema installs, user sees "117K nodes" and doesn't know what to do next.

## Decision

Onboarding is an **analysis-first elicitation** flow driven by Claude Code via the `/onboard` skill. No custom assistant — CC already has MCP tools, file writing, memory, project context.

## Key Design Decisions

### 1. Analysis-First Elicitation (not cold-start questionnaire)

**Rejected:** "Describe your project" questionnaire.
**Accepted:** Show graph findings, ask for validation.

Evidence: backward/validational elicitation is 2–4x faster than forward (Shadbolt & Burton 1995, Cooke 1994). Active learning reduces queries by 50–90% (Settles 2012). Product analytics show 40–60% drop-off per question before value shown.

Each question is a micro-demo: specific numbers from the graph prove the tool works.

### 2. Claude Code as the Agent

**Rejected:** Custom onboarding assistant (months of UI/auth/conversation work).
**Accepted:** Extend existing `/onboard` skill in CC.

CC already has: MCP tools, file writing (plugins/configs), memory (persists across sessions), project context (CLAUDE.md, git), user trust, ecosystem (Linear, GitHub).

### 3. Three Outputs Per Answer

Every user answer can produce:
- **Knowledge** (KB entry, CLAUDE.md memory)
- **Capability** (plugin, config, effects-db entry)
- **Action** (Linear task, guarantee rule, refactoring ticket)

### 4. Entity Taxonomy — Structural vs Semantic

Auto-discovered (graph-only): FEATURE, COMPONENT, CROSS_CUTTING, FEATURE_FLAG, BUSINESS_RULE.
Human-labeled (from interview): CAPABILITY, PRODUCT, DOMAIN, DEPLOYMENT_UNIT.

COMPONENT is neutral structural cluster. Business/runtime/org meaning comes from the interview.

### 5. The Flywheel

```
analyze → interview → write plugins → re-analyze → deeper questions → ...
```
Converges in 3–4 sessions. Each round: graph gets smarter, questions get deeper, KB grows.

### 6. Cognitive Debt Framework (Storey 2026)

Three debt types, three detection methods:
- **Technical debt** → linters, static analysis (existing tools)
- **Cognitive Load Potential** → graph metrics C1–C6 (Grafema computes)
- **Intent debt** → KB coverage (Grafema measures)

Actual cognitive debt (team understanding) requires organizational signals — enterprise feature with Enox provenance.

### 7. Post-Onboarding = Operational Mode

Onboarding doesn't end. Graph drift detection, guarantee monitoring, knowledge freshness checks, new-dev guide generation — all from same infrastructure.

## Principles (9)

```
1. Start with user's goal. Pain → solve it. Curiosity → show what only the graph can see.
2. Show graph findings before asking. Numbers = trust.
3. Each answer → check: knowledge? capability? action?
4. Write findings to KB immediately. Session can die anytime.
5. Adapt: solo→debt, team→ownership, post-onboard→drift.
6. "Don't know" = task, not dead end.
7. Limitation? Workaround + report. Never block.
8. After every action: show what changed, quantified.
9. Ask before external actions (Linear, GitHub).
```

## Consequences

- Onboarding becomes the primary value demonstration for Grafema
- Plugin ecosystem grows organically from user interviews
- KB bootstraps from first session, not from manual documentation effort
- Enterprise path clear: multi-user interviews + Enox provenance for contradictions
- Every onboarding session simultaneously reduces cognitive + intent debt

## References

- Research doc: `_ai/research/cognitive-debt-and-feature-detection.md`
- Storey 2026: arXiv:2603.22106v3
- Analysis-first elicitation: Horvitz 1999, Shadbolt & Burton 1995, Settles 2012
- Existing config onboarding: `packages/util/src/instructions/onboarding.md`
