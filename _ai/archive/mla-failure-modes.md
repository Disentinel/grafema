# MLA Failure Modes

Common ways Multi-Lens Analysis goes wrong and how to prevent them.

---

## 1. Authority Bias

**What breaks:** One lens (usually high-status persona) dominates due to authority, not argument quality.

**Symptoms:**
- Phrases like "but Linus said..." end discussions
- Other lenses become irrelevant
- Synthesis defaults to authority's opinion

**Prevention:**
- Judge arguments, not personas
- If Sheldon finds a logical flaw, the flaw exists regardless of status
- Blind synthesis: read outputs before seeing who wrote them

---

## 2. Hallucinated Problems

**What breaks:** Each lens invents problems to justify its existence.

**Symptoms:**
- Issues don't connect to real codebase evidence
- "UX expert says API isn't intuitive" for internal API used by 3 people
- Confident assertions without citations

**Prevention:**
- Require lenses to cite specific evidence
- Each lens must quantify IMPACT, not just identify issues
- "This is a problem IF X" where X is clearly stated

---

## 3. False Independence

**What breaks:** Lenses claim independence but actually reinforce each other.

**Example:** "Test Engineer says hard to test" + "Simplicity Engineer says too complex" — measuring same underlying problem from different angles.

**Symptoms:**
- Certain concerns appear in multiple lenses
- Reports use similar language/framing
- Overweighting concerns that sound different but aren't

**Prevention:**
- Before finalizing lenses, check for correlation
- If two lenses always agree, merge them
- Ensure lenses represent genuinely orthogonal value systems

---

## 4. Synthesis Collapse

**What breaks:** Synthesizer can't hold multiple perspectives, collapses to single lens.

**Symptoms:**
- Decision document only reflects 1-2 lenses
- Other lenses "mentioned but didn't influence"
- Synthesis is just "what I already thought + acknowledgment others spoke"

**Prevention:**
- Explicit tension mapping in synthesis
- Force yourself to name what each lens found
- Document which lenses influenced decision and which didn't (and why)

---

## 5. Analysis Paralysis

**What breaks:** More lenses = more perspectives = harder decision.

**Symptoms:**
- "We need more analysis" becomes permanent state
- Decision never made or constantly deferred
- Adding lenses hoping for convergence that never comes

**Prevention:**
- Accept that perfect confidence is impossible
- If lenses diverge after 5-7, they won't converge with more
- Set decision deadline; partial information is still information
- Use Decision Confidence Gradient to know when to commit

---

## 6. Mechanical Application

**What breaks:** MLA becomes checklist, not thinking tool.

**Symptoms:**
- Same process for trivial and critical decisions
- Process feels bureaucratic
- "Run these five personas, synthesize, done" without thought

**Prevention:**
- Consciously decide whether to use MLA at all
- Use Lens Selection decision tree
- Not every decision deserves MLA

---

## 7. Persona Hallucination

**What breaks:** Persona "says" things the real person never would.

**Symptoms:**
- Reports don't sound like the persona
- Jobs talking about algorithmic complexity
- Knuth discussing product-market fit
- Generic advice with persona name attached

**Prevention:**
- Deep understanding of what each persona actually cares about
- If persona is out of character, wrong lens for this problem
- Personas are shorthand for value systems, not oracles

---

## 8. Synthesis Averaging

**What breaks:** Synthesizer treats lens outputs as votes or scores.

**Symptoms:**
- "Three lenses said A, two said B, so we'll do A"
- Numerical weighting of opinions
- Phrases like "majority opinion"

**Prevention:**
- MLA is not voting
- A minority lens seeing critical flaw vetoes the majority
- Quality of argument matters, not quantity of lenses

---

## 9. Lens Homogeneity

**What breaks:** Selected lenses are superficially different but fundamentally similar.

**Example:** "Five different backend engineers" — all prioritize similar concerns.

**Symptoms:**
- All reports reach same conclusion with minor variations
- Easy consensus
- No surprising disagreements

**Prevention:**
- Use Lens Selection Grammar
- Ensure lenses are orthogonal on dimensions that matter
- If all experts agree easily, you chose wrong experts

---

## 10. Context Dependence Ignored

**What breaks:** Applying MLA to wrong problem type.

| Problem Type | MLA Appropriate? |
|--------------|-----------------|
| Simple, well-defined | NO — overkill |
| Complicated, knowable | MAYBE — if stakes high |
| Complex, emergent | YES — this is MLA's home |
| Chaotic, unpredictable | NO — act first, analyze later |

**Prevention:**
- Use Cynefin framework to classify problem first
- If problem is Simple or Chaotic, skip MLA
- Reserve MLA for Complex domain

---

## 11. Coordination Overhead Dominates

**What breaks:** More time spent on process than actual analysis.

**Evidence from data:** Simple tasks can have 80% coordination overhead (10 documents for 2 documents of value).

**Symptoms:**
- Most artifacts are "plan review" / "revision" / "re-review"
- Minimal unique insights per document
- Time multiplier >> value multiplier

**Prevention:**
- Use Mini-MLA for medium tasks
- Single agent for simple tasks
- Track documents-per-unique-insight ratio

---

## 12. Demo Stage Too Late

**What breaks:** Steve demos AFTER implementation complete.

**Problem:** If bug is architectural (not just missed test), wasted implementation time.

**Current risk:** Steve runs at STEP 3.5 (post-implementation). Catches integration bugs but misses architectural issues.

**Improvement:** Consider Steve reviewing PLAN (after Joel's spec) in addition to demo.

---

## Quick Reference: Detection and Fix

| Failure Mode | Detection Signal | Quick Fix |
|--------------|------------------|-----------|
| Authority bias | "But X said..." | Blind synthesis |
| Hallucinated problems | No evidence cited | Require citations |
| False independence | Lenses always agree | Check correlation |
| Synthesis collapse | One lens dominates | Force explicit mapping |
| Analysis paralysis | "Need more analysis" | Set deadline |
| Mechanical application | Same process always | Use decision tree |
| Persona hallucination | Out of character | Re-read persona values |
| Synthesis averaging | "Majority says..." | Quality > quantity |
| Lens homogeneity | Easy consensus | Add orthogonal lens |
| Context ignored | MLA on trivial | Cynefin check first |
| Overhead dominates | 80% coordination | Use Mini-MLA |
| Demo too late | Rework after demo | Demo the plan |
