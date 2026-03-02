# Multi-Lens Analysis (MLA) Pattern Language

A decision-support framework for complex, high-stakes decisions.

## Core Concept

MLA examines decisions through multiple fundamentally different "lenses" (value systems) that work independently. You synthesize the result yourself: if all converge — high confidence; if not — conscious trade-off.

**What MLA does:**
- Surfaces hidden assumptions
- Makes trade-offs explicit
- Calibrates confidence through convergence/divergence
- Covers blind spots through diversity

**What MLA does NOT do:**
- Make decisions (synthesis is external)
- Create new information (explores existing space)
- Guarantee correctness (convergence ≠ truth)

---

## Pattern 1: Problem Worthy of Discourse

**When to use MLA:**
- High stakes (expensive to be wrong)
- Value pluralism (multiple legitimate concerns conflict)
- Under-specified (no objective "correct" answer)
- Time available (not urgent)
- Complex domain (not simple/chaotic)

**When NOT to use MLA:**
- Trivial decisions (tabs vs spaces)
- Well-defined problems (objective correct answer exists)
- Time-critical (production outage)
- Low reversibility cost (just try and iterate)
- Chaotic domain (act first, analyze later)

**Anti-pattern:** "Let's get five expert opinions on whether to rename this variable."

---

## Pattern 2: Lens Selection Grammar

### Rule 1: Complementary Opposition

Select lenses in pairs that see opposite forces:

| Lens A | Lens B | Dimension |
|--------|--------|-----------|
| Knuth (correctness) | Edison (pragmatism) | Rigor ↔ Speed |
| Jobs (user value) | Torvalds (simplicity) | Vision ↔ Constraints |
| Feynman (first principles) | Alexander (patterns) | Theory ↔ Practice |

### Rule 2: Dimensional Coverage

Ensure major dimensions are covered:
- **Values:** What is "good"?
- **Time:** Short-term vs long-term
- **Abstraction:** High-level vision vs low-level details
- **Risk:** Innovation vs safety

### Rule 3: Minimal Viable Set

| Count | Name | When to Use |
|-------|------|-------------|
| 1 | Single expert | Well-defined, low-stakes |
| 2 | Dialectic | Single tension to resolve |
| **3** | **Stable Triad** | **Sweet spot for most decisions** |
| 4-5 | Rich coverage | Complex, high-stakes |
| 6-7 | Maximum useful | Existential decisions only |
| 8+ | Pathological | Synthesis breaks down |

### Grafema Configurations

**Single Agent:** Rob Pike
- Trivial changes, hotfixes, well-defined tasks

**Mini-MLA:** Don → Rob → Linus
- Medium complexity, local scope

**Full MLA:** All personas
- Architectural decisions, complex debugging

---

## Pattern 3: True Independence

**Absolute rule:** Lenses do their work without knowing what other lenses found.

**Why this matters:**
- When Torvalds knows what Jobs said, he'll either agree (losing unique perspective) or argue against Jobs (not examining the problem)
- Either way, his lens is corrupted

**Implementation:**
- Each agent produces report independently
- No agent reads another's report during analysis
- Reports written as if author is only voice

**Anti-pattern:** Round table discussion where experts debate. This produces consensus, not multi-lens insight.

**Test:** Reading reports, you find surprising disagreements. If all say the same thing differently, independence failed.

---

## Pattern 4: Conscious Synthesis

### Stage 1: Map the Tensions

```
Knuth:    Values correctness → Found theoretical issue in approach B
Jobs:     Values UX → Found approach A confusing to users
Torvalds: Values simplicity → Found approach C adds complexity
Edison:   Values pragmatism → Can prototype approach A in 2 days
```

### Stage 2: Identify Agreement Zones

Strong convergence across different value systems = most reliable signal.

### Stage 3: Name the Trade-offs

```
Choose Approach A:
  ✓ Good user experience (Jobs)
  ✓ Quick to validate (Edison)
  ✗ Sacrifices theoretical elegance (Knuth)
  ✗ Adds some complexity (Torvalds)
```

### Stage 4: Decide with Eyes Open

You are not trying to make everyone happy. You are choosing the right trade-off for THIS context.

**Evidence of quality:** Your decision document includes "What we're giving up and why."

---

## Pattern 5: Decision Confidence Gradient

```
Confidence = f(Convergence, Coverage, Coherence)
```

| Confidence | Action | Reversibility |
|------------|--------|---------------|
| High (all lenses converge) | Commit, execute | Irreversible OK |
| Medium (partial convergence) | Proceed with monitoring | Keep exit path |
| Low (no convergence) | Experiment first OR expand lens set | Only reversible moves |

---

## Pattern 6: Reflective Learning

### Post-Decision Review

1. **Coverage:** Did lenses see the problem that actually mattered?
2. **Surprises:** Did reality surprise us? Which lens was closest?
3. **Waste:** Which reports didn't influence the decision?
4. **Trade-offs:** Did predicted trade-offs materialize?

### Learning Loop

Over time, develop intuition: "This problem feels like a Knuth-Jobs-Torvalds problem" vs "pure Rob territory."

---

## Optimal Conditions

### MLA Works Best When

**Problem characteristics:**
- High complexity (many interacting factors)
- High stakes (cost of wrong decision is large)
- Under-specified (no objective "correct" answer)
- Novel (no established best practices)

**Team characteristics:**
- Diverse expertise available
- Time for thorough analysis
- Culture of constructive criticism

**Decision maker characteristics:**
- Comfort with ambiguity
- Ability to synthesize conflicting views
- Willingness to make hard trade-offs

---

## The Meta-Pattern

The deepest pattern: knowing when NOT to use MLA.

**Signals to abandon MLA mid-process:**

1. **All lenses agree immediately** — Problem simpler than thought
2. **Wrong question** — Reframe, restart
3. **Missing critical lens** — Add it, even if re-doing analysis
4. **Decision already made** — Stop the theater
5. **Time ran out** — Make best decision with partial info

---

## Summary

MLA is ancient wisdom (dialectics, consilium, devil's advocate) operationalized for the LLM era.

**The key insight:**

> MLA's value is not in the number of lenses. It's in the **quality of the lenses** and the **integrity of the synthesis**.

Five mediocre perspectives are worth less than two excellent ones. And a biased synthesis negates all the independence.

The methodology is only as good as its practice.
