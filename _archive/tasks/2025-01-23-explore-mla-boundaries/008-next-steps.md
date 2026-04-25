# Next Steps: MLA Boundaries Exploration

**Date:** 2026-01-23

---

## Assessment: Sufficient Understanding for Action?

**YES** — We have enough understanding to:
1. Define when to use MLA vs simpler approaches
2. Optimize current Grafema workflow
3. Document the methodology properly

**BUT** — Some questions need empirical validation (experiments).

---

## Recommended Actions

### Immediate: Update Grafema Workflow

Based on Edison's analysis and synthesis, update CLAUDE.md:

#### 1. Add Lens Selection Heuristic

```markdown
## Lens Selection Decision Tree

START
 ├─ Is production broken? → YES → Single agent (Rob) + post-mortem later
 └─ NO
     ├─ Is this well-understood? → YES → Single agent (Rob)
     └─ NO
         ├─ Does it change core architecture? → YES → Full MLA
         └─ NO → Mini-MLA (Don, Rob, Linus)
```

#### 2. Define Mini-MLA

For medium-complexity tasks:
- **Don Melton** (plan)
- **Rob Pike** (implement)
- **Linus Torvalds** (review)

Skip: Joel, Kent, Kevlin, Steve unless specifically needed.

#### 3. Add Stopping Condition

After each expert, ask: "Did this add new information?"
If NO for 2 consecutive experts → stop, signal saturation reached.

#### 4. Move Steve Earlier (Experiment)

Test moving Steve's demo review to PLAN stage (after Joel's spec) rather than post-implementation.

**Hypothesis:** Catches 20-30% of issues before implementation, reducing rework.

---

### Short-term: Run Experiments

#### Experiment A: A/B Test (Priority: HIGH)

- 20 medium-complexity tasks
- 10 tasks: Full MLA
- 10 tasks: Single agent (Rob)
- Measure: Time to completion, bugs caught, production bugs in 30 days

**Success criterion:** MLA catches 2x more bugs at <3x time cost → positive ROI.

#### Experiment B: Lens Redundancy Analysis (Priority: MEDIUM)

For 20 completed tasks:
- Classify each expert contribution: UNIQUE / REINFORCING / REDUNDANT / NOISE
- Calculate per-expert ratios
- Identify candidates for removal on simple tasks

**Expected outcome:** Some experts >30% redundant → reduce usage on simple tasks.

#### Experiment C: Pre-Implementation Demo (Priority: MEDIUM)

- 10 tasks: Steve demos at STEP 3.5 (current)
- 10 tasks: Steve reviews at STEP 2 (after plan)
- Measure: Issues caught at plan stage, implementation rework

**Hypothesis:** 30-40% of issues catchable at plan stage.

---

### Medium-term: Documentation

#### Document MLA Pattern Language

Based on Alexander's analysis, create `_ai/mla-patterns.md`:

1. **Multi-Perspective Synthesis** — root pattern
2. **Problem Worthy of Discourse** — when to use MLA
3. **Lens Selection Grammar** — how to choose lenses
4. **True Independence** — maintaining perspective integrity
5. **Conscious Synthesis** — integrating insights
6. **Decision Confidence Gradient** — how sure to be
7. **Reflective Learning** — improving over time

#### Document Failure Modes

Create `_ai/mla-failure-modes.md`:

1. Authority bias
2. Hallucinated problems
3. False independence
4. Synthesis collapse
5. Analysis paralysis
6. Mechanical application
7. Persona hallucination
8. Synthesis averaging

---

### Long-term: Formalization (Optional)

Based on Sheldon's analysis, consider partial formalization:

1. **Lens properties** — define what makes lenses "sufficiently different"
2. **Convergence criterion** — when do we say lenses converge?
3. **Synthesis decision rule** — how to handle divergence
4. **Applicability heuristic** — decision tree for when to use MLA

**But:** Don't over-formalize. Keep "quality without a name."

---

## Linear Issues to Create

### Issue 1: Implement Lens Selection Heuristic

**Title:** Add dynamic lens selection to CLAUDE.md
**Description:**
- Add decision tree for Mini-MLA vs Full MLA
- Update workflow to support both modes
- Document when to use each

**Labels:** Improvement, Process
**Team:** Reginaflow

### Issue 2: Run MLA A/B Test

**Title:** Validate MLA ROI with controlled experiment
**Description:**
- Design experiment with 20 tasks
- Define success metrics
- Track bugs, time, rework
- Report findings

**Labels:** Research
**Team:** Reginaflow

### Issue 3: Document MLA Pattern Language

**Title:** Create MLA patterns documentation
**Description:**
- Based on exploration findings
- Include patterns, anti-patterns, failure modes
- Add to _ai/ directory

**Labels:** Documentation
**Team:** Reginaflow

---

## Decision: What's Next?

Based on this exploration, recommend:

1. **Immediate:** Update CLAUDE.md with lens selection heuristic (LOW effort, HIGH value)
2. **This week:** Run first 5 tasks with Mini-MLA, track results
3. **This month:** Complete A/B test (10 full MLA, 10 mini-MLA)
4. **Later:** Document pattern language after empirical validation

---

## Meta-Observation

This exploration itself validates MLA:
- 5 lenses provided unique, non-redundant insights
- Convergence on core conclusions = high confidence
- Divergence on details = genuine uncertainty flagged
- Synthesis revealed integrative structure

**The methodology works for its intended purpose.**

The question now is: **How to apply it efficiently?**

Answer: Dynamic lens selection based on task complexity.

---

*Next steps documented: 2026-01-23*
