# REG-413: Formal Analysis — Graph-Based Hints for AI Reasoning Augmentation

**Date:** 2026-02-15
**Author:** Patrick Cousot (Static Analysis & Abstract Interpretation)
**Focus:** Directions 2 (Graph-Derived Change Impact) and 3 (Constraint-Based Reasoning)
**Status:** Formal framework analysis

## Executive Summary

From the perspective of abstract interpretation and formal program analysis, the hint problem can be formalized as computing **sound approximations** of two abstract domains:

1. **Change Impact Domain**: A lattice over co-change relationships that soundly approximates "if you change A, you likely need to change B"
2. **Pattern Constraint Domain**: A lattice over architectural conventions that soundly approximates "in this codebase, solutions typically follow pattern P"

The fundamental tradeoff is between **soundness** (never miss a required co-change) and **completeness** (never suggest irrelevant co-changes). For AI assistance, **soundness is more valuable** — false positives are acceptable, false negatives are catastrophic.

**Key insight from recent research**: [Interactive abstract interpretation with demanded summarization](https://dl.acm.org/doi/full/10.1145/3648441) shows that incremental compositional analysis can provide from-scratch consistency guarantees while maintaining low latency. This framework is directly applicable to Grafema's hint computation problem.

**Recommendation**: Direction 2 (Graph-Derived Impact) has solid formal foundations via program slicing and dependency analysis. Direction 3 (Constraint-Based Reasoning) is theoretically weaker but practically valuable — requires careful formalization to avoid overfitting.

---

## 1. Formal Framework for Change Impact Hints (Direction 2)

### 1.1 Problem Formalization

**Given:**
- Program P represented as dependency graph G = (N, E) where:
  - N = set of program entities (functions, variables, classes)
  - E ⊆ N × L × N where L is a set of edge labels (CALLS, DEPENDS_ON, ASSIGNED_FROM, etc.)
- Change operation Δ: N → N' (modification to entity)
- Agent A about to apply Δ to entity n ∈ N

**Compute:**
- Impact set I(n) ⊆ N: set of entities that may require co-modification when n is changed
- Confidence score c: I(n) → [0,1] measuring likelihood of co-change necessity

**Correctness criterion:**
- Soundness: ∀n' ∈ Must-Change(n), n' ∈ I(n)
- Precision: |I(n) ∩ Must-Change(n)| / |I(n)| ≥ threshold

Where Must-Change(n) is the ground truth set of entities that MUST be modified for semantic correctness when n changes.

### 1.2 Theoretical Foundation: Program Slicing

[Program slicing](https://en.wikipedia.org/wiki/Program_slicing) provides the formal foundation for change impact analysis. Given a slicing criterion <n, V> (entity n, variable set V), a program slice is the minimal subset of program statements that can affect the values of V at n.

**Key results:**
- **Static slicing** (Weiser 1981): Computes over-approximation of all possible executions
- **Dynamic slicing** (Korel & Laski 1988): Computes exact slice for specific execution trace
- **Forward slicing**: What can be affected by this change? (change impact)
- **Backward slicing**: What can affect this point? (dependency tracing)

**Formal connection to change impact:**

```
Impact(n) = ForwardSlice(n) ∪ BackwardSlice(n)
```

Where:
- ForwardSlice(n) = {m ∈ N | ∃ path n →* m in dependency graph}
- BackwardSlice(n) = {m ∈ N | ∃ path m →* n in dependency graph}

**Grafema implementation:**
- Graph structure provides static dependency information
- Forward traversal: "What depends on this?"
- Backward traversal: "What does this depend on?"
- Datalog queries can express reachability: `impact(X, Y) :- depends_on(X, Y). impact(X, Z) :- impact(X, Y), depends_on(Y, Z).`

### 1.3 Abstract Domain for Change Impact

Define abstract domain **Impact** as a complete lattice:

```
Impact = (2^N, ⊆, ∪, ∩, ∅, N)
```

Where:
- Concrete domain: actual sets of entities requiring co-change
- Abstract elements: over-approximations computed from graph structure
- Ordering: ⊆ (subset relation)
- Join: ∪ (union — conservative approximation)
- Meet: ∩ (intersection — precise but possibly unsound)
- Bottom: ∅ (no impact)
- Top: N (everything may need to change)

**Abstraction function α**:

```
α: Must-Change → Impact
α(actual_cochanges) = graph_reachable_entities ∪ logical_coupling_entities
```

**Concretization function γ**:

```
γ: Impact → 2^N
γ(hint_set) = {entities that actually require modification}
```

**Soundness condition**: α(Must-Change(n)) ⊆ I(n)

This ensures we never miss required co-changes (at cost of potential false positives).

### 1.4 Hybrid Approach: Static + Historical Analysis

Recent research ([Integrating conceptual and logical couplings for change impact analysis](https://link.springer.com/article/10.1007/s10664-012-9233-9)) shows that combining structural (static) and evolutionary (historical) couplings improves precision without sacrificing soundness.

**Formal hybrid model:**

```
Impact_hybrid(n) = Impact_static(n) ∩ Impact_evolutionary(n)

Where:
- Impact_static(n) = graph-based dependency closure (sound over-approximation)
- Impact_evolutionary(n) = historically co-changed entities (empirical approximation)
```

**Key insight**: Intersection improves precision while maintaining soundness if Impact_static is sound.

**Proof sketch**:
1. Impact_static(n) is sound by construction (dependency closure)
2. Impact_evolutionary(n) may miss novel co-changes (not sound alone)
3. Impact_static(n) ∩ Impact_evolutionary(n) ⊆ Impact_static(n) (still sound)
4. Precision improves: |hybrid ∩ actual| / |hybrid| ≥ |static ∩ actual| / |static|

### 1.5 Incremental Computation via Demanded Summarization

[Demanded summarization](https://plv.colorado.edu/bec/papers/demanded-summarization-toplas24.pdf) provides a framework for incremental compositional analysis with from-scratch consistency guarantees.

**Key concepts applicable to Grafema hints:**

1. **Summary dependency graph (SDG)**: Reifies dependencies between computed summaries
   - In Grafema: dependencies between hint computations
   - When code changes, only invalidate affected summaries

2. **Demand-driven computation**: Compute hints only when requested
   - Avoids precomputing all possible hints
   - Scales to large codebases

3. **From-scratch consistency**: Incremental results match full reanalysis
   - Critical for correctness: hints must reflect current code state
   - Achieved via careful invalidation strategy

**Grafema application:**

```
HintSummary(entity n):
  if cached(n) and not invalidated(n):
    return cache[n]
  else:
    compute Impact_static(n) using dependency graph
    compute Impact_evolutionary(n) from git history
    result = Impact_static(n) ∩ Impact_evolutionary(n)
    cache[n] = result
    return result

Invalidate(changed_entities):
  for each n in changed_entities:
    invalidate cache[n]
    invalidate cache[all entities in Impact_static(n)]  # forward propagation
    invalidate cache[all entities with n in their Impact_static]  # backward propagation
```

### 1.6 Complexity Analysis

**Static impact computation:**
- Forward/backward slicing: O(|N| + |E|) via graph traversal (BFS/DFS)
- Transitive closure: O(|N|³) naive, O(|N|^2.373) optimized (matrix multiplication)
- Datalog evaluation: O(|N| × |E|) for linear Datalog programs

**Evolutionary coupling:**
- Co-change frequency: O(C × F) where C = commits, F = files per commit
- One-time preprocessing, then O(1) lookup per entity

**Hybrid computation:**
- O(|N| + |E| + C × F) total
- Incremental: O(k) where k = number of invalidated summaries

**Scalability for Grafema:**
- Graph size: ~10K-100K nodes typical
- Commits: ~1K-10K typical
- Incremental updates essential for interactive use

---

## 2. Formalization of Architectural Pattern Detection (Direction 3)

### 2.1 Problem Formalization

**Given:**
- Program P with dependency graph G
- Pattern type τ ∈ {storage_location, error_handling, guard_prevalence, ...}
- Context c (e.g., file, module, class)

**Compute:**
- Pattern distribution D_τ(c): probability distribution over pattern variants
- Dominant pattern P*_τ(c): argmax_p D_τ(c)(p)
- Confidence score: D_τ(c)(P*_τ(c))

**Correctness criterion:**
- Precision: P*_τ(c) accurately reflects actual codebase convention
- Avoid overfitting: pattern should generalize to new code in same context

### 2.2 Lattice Structure Over Patterns

Unlike change impact (which has natural lattice structure via set inclusion), architectural patterns require careful formalization.

**Pattern as Abstraction:**

Following [abstract interpretation theory](https://en.wikipedia.org/wiki/Abstract_interpretation), we can define a lattice over patterns if we identify the concrete and abstract domains:

**Concrete domain**: Actual code implementations
```
Concrete = {all possible implementations of feature F}
```

**Abstract domain**: Pattern classes
```
Abstract = {pattern_1, pattern_2, ..., pattern_n, ⊤}
```

Where ⊤ represents "no discernible pattern" (top element).

**Example for cleanup function storage:**

```
Concrete:
  - cleanup stored on vnode._cleanup
  - cleanup stored on function._unmount
  - cleanup stored in WeakMap
  - cleanup stored in closure variable
  ...

Abstract (simplified):
  - object_property pattern: {vnode._cleanup, function._unmount, ...}
  - external_storage pattern: {WeakMap, Map, ...}
  - closure_storage pattern: {captured in closure}
  - ⊤: no clear pattern
```

**Ordering:**

Pattern lattice is NOT a simple subset lattice. Instead, we define ordering by **specificity**:

```
pattern_1 ⊑ pattern_2  iff  pattern_1 is more specific than pattern_2

Example:
  function._unmount ⊑ object_property ⊑ ⊤
```

This creates a hierarchy where ⊤ is the most general (top) and specific instances are lower in the lattice.

**Caveat**: Unlike traditional abstract interpretation lattices, pattern lattices may not have unique least upper bounds for arbitrary pairs. This makes pattern domains **semi-lattices** rather than complete lattices.

### 2.3 Pattern vs. Convention: Formal Distinction

**Pattern**: Structural similarity in code artifacts
- Formal: Equivalence class under some similarity metric
- Computable: via AST comparison, graph isomorphism
- Objective: two code fragments either match or don't

**Convention**: Dominant practice in codebase
- Formal: Mode of distribution over pattern classes
- Statistical: requires frequency analysis
- Context-dependent: what's conventional in file A may not be in file B

**Formalization:**

```
Pattern_class(code_fragment) = equivalence class under ~
  where a ~ b iff similarity(a, b) ≥ threshold

Convention_in_context(c) = argmax_p |{fragments in c : Pattern_class(fragment) = p}|
```

**Key difference**: Pattern is syntactic, convention is pragmatic.

### 2.4 Detecting Dominant Patterns Without Overfitting

This is the core challenge of Direction 3. We need patterns that:
1. Capture actual codebase conventions (not spurious correlations)
2. Generalize to new code (not overfit to existing examples)
3. Are interpretable for AI agents

**Statistical approach:**

```
D_τ(c) = empirical distribution over pattern classes

D_τ(c)(p) = |{fragments in c matching pattern p}| / |{all fragments in c}|

Dominant pattern: P*_τ(c) = argmax_p D_τ(c)(p)

Confidence threshold: only report if D_τ(c)(P*_τ(c)) ≥ 0.6  (60% prevalence)
```

**Avoiding overfitting:**

1. **Minimum sample size**: Require ≥10 instances before declaring pattern
2. **Cross-validation**: Split codebase into train/test, verify pattern holds
3. **Stability**: Pattern should be stable across modules (not just one file)

**Formal guarantees we CANNOT provide:**

- We cannot prove a convention will continue to hold for NEW code
- We cannot prove the convention is "correct" (it may be a widespread anti-pattern)
- We can only observe what IS, not what SHOULD BE

This is fundamentally different from change impact analysis (where we have soundness proofs).

### 2.5 Abstract Domain for Code Patterns

Recent work on [pattern detection in object-oriented source code](https://link.springer.com/chapter/10.1007/978-3-540-88655-6_11) and [mining coding patterns](https://ieeexplore.ieee.org/document/4656401/) suggests using **formal concept analysis** and **frequent subtree mining**.

**Abstract domain: Frequent Pattern Lattice**

```
Pattern_lattice = (Patterns, ⊑, ∨, ∧, ⊥, ⊤)

Where:
  Patterns = {subtrees with frequency ≥ min_support}
  p1 ⊑ p2 iff p1 is more specific than p2 (structural subsumption)
  p1 ∨ p2 = least general pattern that subsumes both
  p1 ∧ p2 = most specific pattern subsumed by both
  ⊥ = most specific pattern (concrete code)
  ⊤ = most general pattern (any code)
```

**Abstraction function α**:

```
α: AST → Pattern
α(concrete_code) = {
  match concrete_code against pattern database
  return most specific matching pattern with frequency ≥ threshold
}
```

**Key insight**: Patterns form a hierarchy from specific to general. AI agents should be shown the most specific applicable pattern (lowest in lattice) that has sufficient statistical support.

---

## 3. Soundness vs. Completeness Tradeoffs

### 3.1 Definitions in Context of Hints

**Sound hints**: Never miss a required co-change
```
Soundness: ∀n ∈ Must-Change(x), n ∈ Hints(x)
```
Equivalent to: **high recall, possibly low precision**

**Complete hints**: Never suggest irrelevant co-changes
```
Completeness: ∀n ∈ Hints(x), n ∈ Must-Change(x)
```
Equivalent to: **high precision, possibly low recall**

**Fundamental theorem** ([What Does It Mean for a Program Analysis to Be Sound?](https://blog.sigplan.org/2019/08/07/what-does-it-mean-for-a-program-analysis-to-be-sound/)): For undecidable problems (like "does this code require co-change"), we cannot have both perfect soundness and completeness.

### 3.2 Which is More Valuable for AI Assistance?

**Argument for soundness (favor recall):**

1. **False negatives are catastrophic**: If AI misses a required co-change, the patch is wrong
2. **False positives are manageable**: AI can evaluate each suggestion and reject irrelevant ones
3. **Model has reasoning capability**: AI can filter hints using its own judgment

**Argument for completeness (favor precision):**

1. **Cognitive overload**: Too many hints overwhelm the model (see [bias-variance tradeoffs in program analysis](https://dl.acm.org/doi/10.1145/2535838.2535853))
2. **Prompt budget**: Each hint consumes tokens, reducing space for actual reasoning
3. **False positives waste time**: Agent explores irrelevant code paths

**Empirical guidance** from [FCP2Vec: Deep Learning-Based Approach to Software Change Prediction](https://www.mdpi.com/2076-3417/13/11/6453):

- Co-change prediction systems in practice favor **precision over recall**
- Top-k recommendations (k=3-5) work better than exhaustive lists
- Confidence thresholds filter out low-quality hints

**Recommendation for Grafema:**

**Use soundness for Direction 2 (change impact), precision for Direction 3 (patterns)**

Rationale:
- Change impact: missing a co-change = wrong patch → soundness critical
- Pattern suggestions: showing irrelevant patterns = confusion → precision critical

### 3.3 Practical Soundiness

[Soundiness](https://cacm.acm.org/blogcacm/soundness-and-completeness-defined-with-precision/) is a pragmatic middle ground: "sound except for specific unsupported features."

**For Grafema hints:**

```
Soundiness statement: "Hints are sound for all code paths captured in the dependency graph,
except for dynamic code evaluation, reflection, and unresolved imports."
```

This is honest about limitations while maintaining formal guarantees for the supported subset.

### 3.4 Measuring Hint Quality Formally

**Precision-Recall Framework:**

```
Precision(hints) = |Hints ∩ Must-Change| / |Hints|
Recall(hints) = |Hints ∩ Must-Change| / |Must-Change|
F1 score = 2 × (Precision × Recall) / (Precision + Recall)
```

**ROC Curve Analysis:**

For parameterized hint systems (e.g., confidence threshold τ):
- Vary τ from 0 to 1
- Plot True Positive Rate vs. False Positive Rate
- Select τ that optimizes for use case (high recall for change impact, high precision for patterns)

**Grafema-specific metrics:**

```
Hint_utility = (Hints that agent used and were correct) / (Total hints provided)
Hint_noise = (Hints that agent ignored) / (Total hints provided)
```

These capture whether hints actually help AI reasoning, not just theoretical correctness.

---

## 4. Practical Recommendations for Grafema

### 4.1 Direction 2: Graph-Derived Change Impact Hints

**Implementation Strategy:**

1. **Static dependency closure** (MUST HAVE):
   - Implement as Datalog query: `impact(X,Y) :- path(X,Y).`
   - Guarantees soundness via transitive closure
   - Complexity: O(|N| + |E|) with memoization

2. **Fan-out analysis** (HIGH VALUE, LOW COST):
   - Compute in-degree and out-degree for each node
   - High fan-out (>5 callers) → "This function is called from N places, changes may require call-site updates"
   - Trivial complexity: O(|E|)

3. **Symmetry detection** (MEDIUM VALUE, HIGH COST):
   - Subgraph isomorphism is NP-hard in general
   - Use heuristic: structural hash + AST similarity
   - Limit to local scope (same file/module)

4. **Hybrid with evolutionary coupling** (HIGH VALUE if history available):
   - Precompute co-change matrix: O(C × F) where C=commits, F=files
   - Intersect with static closure for precision
   - Formula: `Hints = Static_closure ∩ Top_k(Cochange_scores)`

**Correctness guarantees:**

- Soundness: Provided by static dependency closure (proven via graph reachability)
- Precision: Improved by intersection with evolutionary coupling
- Incremental consistency: Use demanded summarization framework for updates

**Expected precision/recall:**

Based on [Enhancing Code Understanding for Impact Analysis](https://dl.acm.org/doi/10.1145/3643770):
- Static closure alone: ~40% precision, ~90% recall
- Hybrid (static + evolutionary): ~70% precision, ~85% recall
- Top-k ranking: ~85% precision, ~60% recall

**Recommendation**: Use hybrid approach with k=5 (show top 5 co-change candidates).

### 4.2 Direction 3: Constraint-Based Reasoning Hints

**Implementation Strategy:**

1. **Pattern extraction via frequent subtree mining**:
   - Use established algorithms: [PrefixSpan](https://arxiv.org/abs/2107.07212) or [TreeMiner](https://www.researchgate.net/publication/336660539_Mining_Patterns_in_Source_Code_Using_Tree_Mining_Algorithms)
   - Minimum support threshold: 60% (pattern appears in ≥60% of instances)
   - Minimum count: ≥10 instances (statistical significance)

2. **Context-specific pattern detection**:
   - Scope: file-level (not codebase-wide)
   - Rationale: conventions vary across modules
   - Formula: `Pattern_file(f, type) = argmax_p |{instances in f matching p}| / |{instances in f}|`

3. **Pattern categories to implement**:
   ```
   Priority 1 (high signal/noise):
   - Storage location (where is state typically stored?)
   - Error handling (try/catch vs early return vs propagation)

   Priority 2 (if Priority 1 shows value):
   - Guard patterns (null checks, type guards)
   - Naming conventions (prefix/suffix patterns)
   ```

**Theoretical limitations:**

- **No soundness guarantee**: Patterns are empirical, not logical
- **Overfitting risk**: Past patterns may not apply to new code
- **Interpretation ambiguity**: Same pattern may have different semantics

**Mitigation strategies:**

1. **Confidence reporting**: Always show pattern prevalence (e.g., "4/5 cases follow pattern A")
2. **Contrast reporting**: If multiple patterns exist, show distribution (e.g., "60% pattern A, 30% pattern B, 10% other")
3. **Stability checking**: Require pattern to appear in multiple files before declaring it codebase-wide

**Expected precision:**

Based on [Mining application-specific coding patterns](https://www.researchgate.net/publication/228525443_Mining_application-specific_coding_patterns_for_software_maintenance):
- Within-file patterns: ~80% precision
- Cross-file patterns: ~60% precision
- Codebase-wide patterns: ~40% precision (high noise)

**Recommendation**: Start with file-level patterns only. Expand to module-level if precision remains >70%.

### 4.3 Hybrid Architecture

**Layered hint system:**

```
Layer 1 (MUST CHECK): Static dependency closure
  - Soundness guaranteed
  - Shows: "These entities are structurally dependent"

Layer 2 (STRONG EVIDENCE): Evolutionary co-change
  - Empirical evidence
  - Shows: "These entities frequently change together (N/M commits)"

Layer 3 (SUGGESTION): Architectural patterns
  - Contextual guidance
  - Shows: "In this file, similar code typically follows pattern P"
```

**Information presentation to AI:**

```
Hint for: modifying AxiosHeaders.toJSON()

DEPENDENCY ANALYSIS (structural):
  - AxiosHeaders.normalize() [DEPENDS_ON]
  - AxiosHeaders.set() [CALLS]
  - 5 call sites across 3 files [CALLED_FROM]

CO-CHANGE HISTORY (empirical):
  - AxiosHeaders.normalize(): 3/5 recent commits
  - AxiosHeaders.set(): 2/5 recent commits

PATTERN ANALYSIS (convention):
  - Array-handling methods in AxiosHeaders typically modified together (4/6 cases)
  - Error handling pattern: early return (8/10 methods in this file)
```

Layered presentation allows AI to weight evidence appropriately.

---

## 5. Open Questions & Research Gaps

### 5.1 Theoretical Questions

1. **Pattern lattice completeness**:
   - Can we prove that the pattern lattice has a well-defined meet/join for arbitrary pattern pairs?
   - If not, what restrictions ensure lattice properties?

2. **Hint composition**:
   - If hint H1 is sound and hint H2 is sound, is H1 ∪ H2 sound?
   - Answer: Yes for change impact (monotonic), unclear for patterns (may conflict)

3. **Incremental pattern invalidation**:
   - When code changes, which pattern summaries need recomputation?
   - Can we bound the invalidation propagation?

### 5.2 Empirical Questions

1. **AI model sensitivity to hint format**:
   - Do LLMs reason better with structured hints (JSON) or natural language?
   - Does hint ordering matter?

2. **Cognitive load threshold**:
   - How many hints before model performance degrades?
   - Does it vary by model (Sonnet vs Opus)?

3. **Hint interactivity**:
   - Should hints be always-on or query-on-demand?
   - Does proactive hint presentation help or distract?

### 5.3 Engineering Questions

1. **Performance at scale**:
   - Can demanded summarization achieve <1s latency for hint computation on 100K-node graphs?
   - What caching strategies work best?

2. **Graph incompleteness handling**:
   - When imports are unresolved (REG-408), how to adjust hint confidence?
   - Can we detect and warn about incomplete dependency information?

3. **Pattern evolution**:
   - How to detect when codebase conventions are changing?
   - Should hints adapt over time or remain stable?

---

## 6. Comparison with Alternative Approaches

### 6.1 vs. Static Analysis Tools (ESLint, TypeScript)

**Static analyzers**: Check for errors, enforce style rules
- Formal foundation: type systems, control flow analysis
- Soundness: often sacrificed for performance (ESLint is heuristic)
- Goal: prevent bugs

**Grafema hints**: Suggest co-changes, surface patterns
- Formal foundation: dependency analysis, program slicing
- Soundness: achievable for structural hints, not for pattern hints
- Goal: augment AI reasoning

**Key difference**: Static analyzers enforce constraints, Grafema hints provide guidance.

### 6.2 vs. Machine Learning Approaches (FCP2Vec, etc.)

**ML-based co-change prediction**:
- Uses neural networks to learn change patterns from history
- High precision (can learn complex patterns)
- Requires large training data
- Black box (hard to explain why suggestion was made)

**Grafema formal approach**:
- Uses graph algorithms + statistical frequency
- Moderate precision (simpler patterns)
- Works with limited data (graph structure always available)
- White box (can explain via dependency path)

**Tradeoff**: ML may achieve higher precision but at cost of interpretability and data requirements.

**Recommendation for Grafema**: Start with formal approach (interpretable, no training required). Consider ML augmentation in Phase 3 if formal methods plateau.

### 6.3 vs. LLM-based Approaches (Ripple, ATHENA)

Recent work on [intent-aware impact analysis](https://arxiv.org/pdf/2104.01270) uses LLMs to connect natural language intent with code changes.

**LLM-based**: Model reasons about change intent directly
- Flexible: can handle ambiguous requirements
- Expensive: requires model inference for every hint
- Unstable: different responses on retry

**Grafema formal hints**: Pre-computed structural facts
- Deterministic: same input → same hints
- Cheap: graph query cost only
- Limited: can't reason about intent, only structure

**Hybrid opportunity**: Use Grafema for fast structural hints, LLM for intent interpretation when needed.

---

## 7. Conclusion & Actionable Recommendations

### 7.1 Direction 2 (Graph-Derived Impact): Strong Formal Foundation

**Theoretical assessment**: ✅ SOLID

- Grounded in program slicing theory (40+ years of research)
- Soundness achievable via dependency closure
- Precision improvable via hybrid structural + evolutionary analysis
- Incremental computation possible via demanded summarization
- Complexity acceptable: O(|N| + |E|) for basic queries

**Practical assessment**: ✅ HIGH CONFIDENCE

- Implementable with existing Grafema infrastructure (Datalog queries)
- Low engineering risk
- Expected precision 70-85% based on prior work
- Fails gracefully (worst case: shows too many hints)

**Recommendation**: PROCEED with Direction 2

**Implementation priority**:
1. Fan-out analysis (1 day, high value/cost ratio)
2. Static dependency closure (2 days, soundness foundation)
3. Evolutionary co-change integration (3-4 days, precision boost)
4. Top-k ranking (1 day, cognitive load mitigation)

### 7.2 Direction 3 (Constraint-Based Reasoning): Weaker but Valuable

**Theoretical assessment**: ⚠️ LIMITED

- No soundness guarantees (patterns are empirical)
- Overfitting risk (past patterns may not generalize)
- Pattern lattice may not be complete (mathematical structure unclear)
- Interpretation ambiguity (same pattern, different semantics)

**Practical assessment**: ✅ POTENTIALLY VALUABLE

- Addresses real pain point (design decision bugs like preact-4436)
- Precedent in research (frequent pattern mining, CodeScene)
- Testable: can measure precision on historical data
- Fails with warning (if precision <70%, disable this hint type)

**Recommendation**: CAUTIOUS PROCEED

**Risk mitigation**:
1. Start with narrow pattern types (storage location, error handling only)
2. File-level scope only (avoid overfitting to codebase-wide patterns)
3. High confidence threshold (≥60% prevalence)
4. Always show distribution, not just dominant pattern
5. Measure precision continuously, disable if <70%

### 7.3 Formal Framework Summary

**Change Impact Domain**:
```
Impact = (2^N, ⊆, ∪, ∩, ∅, N)
Soundness: achievable via static closure
Precision: improvable via hybrid approach
Computation: O(|N| + |E|) incremental
```

**Pattern Constraint Domain**:
```
Patterns = semi-lattice over frequent subtrees
Soundness: NOT achievable (empirical, not logical)
Precision: measurable, target 70%+
Computation: O(|N| × min_support) with caching
```

**Hint Quality Metrics**:
```
For change impact: optimize F1 score (balance precision/recall)
For patterns: optimize precision (avoid misleading AI)
For both: track Hint_utility = (correct hints used) / (hints provided)
```

### 7.4 Integration with Don's Research Plan

Don's phased approach aligns well with formal analysis:

**Phase 1 (Quick Validation)**:
- Direction 4 (Call Site Expansion): Not analyzed here, but theoretically sound (just provides more context, no inference)
- Manual hint baseline: Critical for measuring theoretical ceiling

**Phase 2 (Structural Hints)**:
- Direction 2 (Graph-Derived Impact): ✅ Formally sound, RECOMMEND
- Direction 1 (Co-Change Patterns): Subset of Direction 2 (evolutionary coupling component)

**Phase 3 (Advanced Patterns)**:
- Direction 3 (Constraint-Based Reasoning): ⚠️ Theoretically weaker, but worth trying if Phase 2 succeeds
- Direction 5 (Historical Diff Patterns): Similar to Direction 3, empirical not formal

**Alignment verdict**: Don's plan is consistent with formal analysis priorities.

---

## 8. Sources

**Abstract Interpretation & Program Analysis:**
- [Interactive Abstract Interpretation with Demanded Summarization](https://dl.acm.org/doi/full/10.1145/3648441) — Incremental compositional analysis framework
- [Incremental Static Program Analysis through Reified Computational Dependency](https://soft.vub.ac.be/Publications/2024/vub-soft-phd-20241104-Jens%20Van%20der%20Plas.pdf) — PhD thesis on incremental analysis
- [Abstract Interpretation (Wikipedia)](https://en.wikipedia.org/wiki/Abstract_interpretation) — Foundational theory
- [What Does It Mean for a Program Analysis to Be Sound?](https://blog.sigplan.org/2019/08/07/what-does-it-mean-for-a-program-analysis-to-be-sound/) — SIGPLAN blog on soundness
- [What is soundness (in static analysis)?](http://www.pl-enthusiast.net/2017/10/23/what-is-soundness-in-static-analysis/) — PL Enthusiast explanation
- [Soundness and Completeness: Defined With Precision](https://cacm.acm.org/blogcacm/soundness-and-completeness-defined-with-precision/) — CACM blog on soundiness

**Program Slicing:**
- [Program slicing (Wikipedia)](https://en.wikipedia.org/wiki/Program_slicing) — Overview and history
- [Wisconsin Program-Slicing Project](https://research.cs.wisc.edu/wpis/html/) — Historical research hub

**Change Impact Analysis:**
- [Enhancing Code Understanding for Impact Analysis by Combining Transformers and Program Dependence Graphs](https://dl.acm.org/doi/10.1145/3643770) — Recent hybrid approach
- [Integrating conceptual and logical couplings for change impact analysis](https://link.springer.com/article/10.1007/s10664-012-9233-9) — Combining structural and evolutionary analysis
- [A review of software change impact analysis](https://d-nb.info/1020114983/34) — Comprehensive survey

**Logical/Change Coupling:**
- [Reverse Engineering with Logical Coupling](https://www.inf.usi.ch/faculty/lanza/Downloads/DAmb06d.pdf) — Foundational paper
- [The evolution radar: Visualizing integrated logical coupling information](https://www.researchgate.net/publication/221657065_The_evolution_radar_Visualizing_integrated_logical_coupling_information) — Visualization techniques

**Co-Change Prediction:**
- [FCP2Vec: Deep Learning-Based Approach to Software Change Prediction](https://www.mdpi.com/2076-3417/13/11/6453) — ML-based co-change prediction
- [Pieces of contextual information suitable for predicting co-changes?](https://link.springer.com/article/10.1007/s11219-019-09456-3) — Empirical study

**Pattern Mining:**
- [Mining Coding Patterns to Detect Crosscutting Concerns](https://ieeexplore.ieee.org/document/4656401/) — Frequent pattern mining in code
- [Mining Patterns in Source Code Using Tree Mining Algorithms](https://www.researchgate.net/publication/336660539_Mining_Patterns_in_Source_Code_Using_Tree_Mining_Algorithms) — TreeMiner approach
- [7 Dimensions of software change patterns](https://www.nature.com/articles/s41598-024-54894-0) — Pattern categorization

**Soundness vs Completeness:**
- [Bias-variance tradeoffs in program analysis](https://dl.acm.org/doi/10.1145/2535838.2535853) — Why more precision can hurt
- [Sound, Complete and Scalable Path-Sensitive Analysis](https://theory.stanford.edu/~aiken/publications/papers/pldi08.pdf) — Balancing soundness and scalability

---

**End of Formal Analysis**
