# Phase 8: Verify — Report and Transition to Operational Mode

## Prerequisites
- Phases 1–7 attempted (some may be skipped or partial — that's OK)

## What to do

Compute final onboarding score, present summary, transition to operational mode.

### 8.1 Compute onboarding coverage

Read metrics from `_ai/onboarding/target-state.md` and compute each aspect's coverage.

Present as health report:
```
"Onboarding complete. Here's your project health:

 📊 Coverage
 Config:          94% files analyzed
 Features:        17 found, 14 named (82%)
 Components:      4 discovered, 4 validated
 Capabilities:    3 mapped to 2 products
 Custom patterns: 2 plugins written, unresolved calls 12%
 Ownership:       4/4 components owned
 Intent:          42% high-CogLoad functions documented
 Guarantees:      5 rules, catching 3 violations
 Bus factor:      2 risks (auth: Alice-only, sync: Bob-only)

 🧠 Cognitive Load Potential: 5.8/10 (project average)
    Hotspot: checkout.ts (8.7), workers/sync.ts (8.2)

 📝 Intent Debt: 58% uncovered
    Worst: workers/ (0% decisions captured)

 Overall Onboarding Score: 7.2/10"
```

### 8.2 Identify remaining gaps

```
"Remaining gaps (prioritized by impact):
 1. workers/sync.ts — highest CogLoad, 0 decisions, bus factor 1
 2. 3 unnamed features in admin/ 
 3. orders↔payments coupling — investigation task pending (REG-XXX)
 
 These can be addressed in future /onboard --continue sessions."
```

### 8.3 Suggest operational mode

```
"Your project is onboarded. Going forward:

 Daily:  grafema check catches guarantee violations in new code
 Weekly: /onboard --status shows drift, new features, stale knowledge  
 On PR:  'What's the blast radius?' → trace(along="data") from changed functions
 New dev: /onboard --for-new-dev generates personalized guide

 I'll also flag when:
 • New entry points appear that aren't assigned to a feature
 • CogLoad trends upward in a module
 • A guarantee starts failing
 • A team member leaves (bus factor change)"
```

### 8.4 Report Grafema issues found during onboarding

If any Grafema limitations were hit during phases 1–7:

```
"During onboarding I noticed [N] Grafema limitations:
 1. Ruby eval() not traced — workaround plugin written
 2. GraphQL resolvers not auto-detected — manual entry points added
 
 Want me to report these to Grafema developers? 
 Good reports help them prioritize fixes."
```

### 8.5 --status mode (post-onboarding)

When called with `--status` on an already-onboarded project:

```
"Changes since last check ([N] days ago):

 📊 Graph drift:
 • [N] new functions, [M] deleted
 • [X] new features detected (unnamed)
 • [Y] guarantee violations (new since last check)
 
 🧠 Cognitive Load trends:
 • [module]: [old] → [new] ([direction])
 
 📝 Knowledge freshness:
 • [N] decisions older than 6 months — review?
 • Plugin [X] — new method [Y] not handled
 • [person] left [N] weeks ago — bus factor impact on [components]
 
 Suggested actions: [prioritized list]"
```

### 8.6 --for-new-dev mode

Generate personalized onboarding guide from KB:

```
"Onboarding guide for a new developer:

 📖 Architecture (from knowledge base):
 • [N] components, [M] features, [K] products
 • Key terms: [domain vocabulary from KB]
 • Stack: [detected frameworks + custom patterns]
 
 ⚠️ Watch out (high cognitive load areas):
 • [module] — [why it's complex, from KB decisions]
 • [module] — [custom pattern, link to plugin docs]
 
 🎯 Suggested first tasks (learning-optimal):
 1. [small bug in well-understood area — teaches domain]
 2. [add tests to medium area — learns architecture]
 3. [document complex area — fills KB gap + builds understanding]
 
 📚 Required reading:
 • [ADR-003: Payment Gateway Selection]
 • [internal docs from KB REFERENCE entries]"
```

## Completion
- Onboarding score computed and reported
- Remaining gaps listed with priority
- Operational mode explained
- Grafema issues reported (if any)

## Artifacts
- Updated .grafema/onboarding-state.yaml (all phases status)
- Onboarding report (shown to user)
- Optional: GitHub issues for Grafema limitations
- Optional: new-dev onboarding guide
