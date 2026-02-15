# REG-413: Research Plan — Graph-Based Hints for AI Reasoning Augmentation

**Date:** 2026-02-15
**Author:** Don Melton (Tech Lead)
**Status:** Research plan, no implementation

## Executive Summary

SWE-bench experiments show Grafema cuts navigation cost by 50% but doesn't improve (and may hurt) resolve rates. The bottleneck is **model reasoning about WHAT to change**, not code navigation.

This research investigates whether Grafema's graph structure can encode hints that help models reason about multi-location changes, change propagation patterns, and architectural constraints.

## Problem Statement

### Current State (From SWE-bench Experiments)

**What works:**
- Grafema reduces file exploration by 34-100% (fewer cat/grep commands)
- Agents reach relevant code 2-3x faster
- Cost savings: 21-67% per task

**What doesn't work:**
- Resolve rate: Baseline 45% (5/11), Grafema 20% (2/10)
- Preact tasks: 0/5 both conditions — model reasoning bottleneck
- axios-5085: **Grafema PASS→FAIL** — found 1/3 required changes, baseline found all 3
- axios-5316: Both fail with different wrong patches — reasoning problem, not navigation

### The Core Issue

Grafema answers "WHERE is this code?" but not "WHAT else needs to change?"

**Evidence:**
1. **axios-5085** (Set-Cookie header normalization): Agent fixed `toJSON()` but missed `normalize()` — didn't realize bug required changes in 3 locations
2. **preact-4436** (ref cleanup functions): Both baseline and Grafema chose wrong storage location (vnode vs function object) — structural understanding ≠ design decisions
3. **preact-3345** (effect cleanup error handling): Agent added try/catch in callee, gold patch changes forEach caller pattern — wrong "where to fix"

### Hypothesis

Graph structure can encode **co-change patterns**, **dependency constraints**, and **similar code clusters** that help models reason about:
- Multi-location bugs requiring consistent changes
- Change propagation (if you change A, you likely need to change B)
- Architectural patterns (how similar code is typically modified)

## Prior Art & Research Landscape

### 1. Change Coupling & Logical Coupling

**Core Concept:**
Mine version history to find code entities that frequently change together. If files A and B are modified in the same commits 80% of the time, they have high logical coupling.

**Key Research:**
- [Integrating conceptual and logical couplings for change impact analysis](https://link.springer.com/article/10.1007/s10664-012-9233-9) — Combining dependency graphs with change history
- [Change coupling: visualize the cost of change](https://codescene.com/engineering-blog/change-coupling-visualize-the-cost-of-change) — CodeScene's practical application
- [Logical Coupling Based on Fine-Grained Change Information](https://www.researchgate.net/publication/221200077_Logical_Coupling_Based_on_Fine-Grained_Change_Information)

**Advantages:**
- Reveals hidden relationships structural analysis can't detect
- Lightweight: only needs commit logs, no code parsing
- Proven effective for change prediction

**Limitations:**
- Requires historical data (doesn't help on new code)
- Correlation ≠ causation (may find spurious co-changes)
- SWE-bench tasks are synthetic — no real commit history

**Grafema Application:**
Could extend Grafema with Git plugin to mine co-change patterns and annotate graph with "frequently changes together" metadata. For SWE-bench: could use PROJECT commit history, not just task-specific commits.

### 2. Graph-Based Reasoning Augmentation for LLMs

**CodeGraph** ([arXiv:2408.13863](https://arxiv.org/abs/2408.13863)):
Encodes graph problems as executable code instead of textual descriptions. Boosts performance 1.3-58.6% on graph reasoning tasks by:
- Mitigating arithmetic errors in LLM reasoning
- Providing interpretable, controlled reasoning process

**Key Insight:**
LLMs reason better when graph structure is encoded as **executable queries** rather than prose descriptions.

**Graph-RAG** (Graph-based Retrieval-Augmented Generation):
Uses graph-structured knowledge representation with explicit entity relationships. Enables context-preserving retrieval with multi-hop reasoning.

**Grafema Application:**
- Already provides Datalog queries (executable graph reasoning)
- Could surface pre-computed multi-hop patterns as hints
- Example: "Functions that call A also modify B in 4/5 cases"

### 3. SWE-bench Improvement Techniques Beyond Navigation

**Key Findings from Research:**

**Ensemble & Reasoning:**
- [Dissecting the SWE-Bench Leaderboards](https://arxiv.org/html/2506.17208v2) — 3-8% gain from ensembling (agent results highly unstable)

**Experience Reuse:**
- Correctly selected summarized experience improves accuracy and reduces cost on harder tasks
- Unfiltered experience provides limited/negative benefits

**Training Approaches:**
- **SVG (Soft Verified Generation)**: Teacher model makes random change → generates patch → attempts to reproduce patch from vague PR description → soft verification compares patches → training data
- **SWE-RL**: Reinforcement learning on open evolution data with rule-based rewards

**Agent Architecture:**
- **Agent-Computer Interface (ACI)**: Careful interface design substantially improves performance without changing model weights
- **AppMap Navie**: Structured workflow (planning → generation → validation), with detailed tracing of code dependencies

**Relevant for Grafema:**
- **Repograph plugin** for Agentless: "provides agents a structured way to analyze and interact with complex codebases, enabling detailed tracing of code dependencies, execution flow and structural relationships"
- This is EXACTLY what Grafema does — structured dependency analysis

### 4. Code Dependency Graphs for Impact Analysis

**Core Approaches:**
- **Static analysis**: Scans source for declared relationships (imports, calls, package usage)
- **Hybrid analysis**: Combines dependency graphs with deep learning for code representation

[Enhancing Code Understanding for Impact Analysis by Combining Transformers and Program Dependence Graphs](https://dl.acm.org/doi/10.1145/3643770):
Uses dependency graph information with conceptual coupling (deep representation learning) for impact analysis.

**Grafema's Position:**
Already has comprehensive dependency graph. Question: Can we **derive hints from dependency structure** that help models reason about change impact?

### 5. AI-Assisted Multi-Location Edits (2025-2026)

**Roo Code** (2025):
Multi-file context-aware edits. Plans refactoring → identifies affected files → makes coherent edits → auto-commits. Hit 1M users by solving multi-file consistency.

**Gemini Code Assist**:
Reads full codebase scope, applies structure-aware edits matching best practices.

**GPT-4.1 Prompt Cookbook** (April 2025):
OpenAI trained GPT-4.1 on specific patch formats for multi-location edits. Significant training investment.

**Grafema Opportunity:**
These tools rely on model reasoning + prompting. Grafema could provide **structural hints** that complement model reasoning:
- "These 3 methods have identical structure — consider applying fix to all"
- "Function A is called from 5 locations with different guard conditions"

## Research Directions

### Direction 1: Co-Change Pattern Hints

**Core Idea:**
When agent is about to modify node X, surface nodes that:
1. Have high structural coupling (CALLS, DEPENDS_ON, ASSIGNED_FROM)
2. Historically changed together (from git history)
3. Have similar code structure (AST similarity)

**Example Output:**
```
You're modifying: AxiosHeaders.toJSON()
Hint: Functions often changed together:
  - AxiosHeaders.normalize() [3/5 commits]
  - AxiosHeaders.set() [2/5 commits]
Consider reviewing these for consistency.
```

**How to Test:**
1. **Retroactive git analysis**: For each SWE-bench repo, mine commit history BEFORE the bug-fix commit
2. **Compute co-change scores** for all function pairs
3. **Simulate hint provision**: When agent identifies target function, provide top-3 co-change candidates
4. **Measure**: Does agent now find multi-location bugs like axios-5085?

**Expected Impact:**
- **High** for multi-location bugs (axios-5085 type)
- **Medium** for architectural changes requiring consistency
- **Low** for single-location bugs

**Effort:** 8-10 days
- Git mining infrastructure: 3-4 days
- Co-change scoring: 2 days
- Integration with MCP hints: 2 days
- SWE-bench validation experiments: 2-3 days

**Acceptance Criteria:**
- On multi-location bugs (manually identified in SWE-bench), resolve rate improves by >20%
- Hint precision >70% (suggested co-changes are actually relevant)

**Risks:**
- SWE-bench tasks are synthetic — commit history may not reflect real co-change patterns
- Requires sufficient history (repos with <50 commits may not work)

---

### Direction 2: Graph-Derived Change Impact Hints

**Core Idea:**
Use graph structure (without history) to identify change propagation patterns:
1. **Fan-out analysis**: "This function is called from N locations — changes may need handling at call sites"
2. **Symmetry detection**: "These 3 functions have identical CALLS/DEPENDS_ON patterns — consider applying fix to all"
3. **Dataflow boundary crossing**: "This change affects data flowing into external API — verify boundary validation"

**Example Output:**
```
You're modifying: invokeCleanup(hook)
Hint: Called from 4 locations via forEach pattern:
  - unmount() → pendingEffects.forEach(invokeCleanup)
  - component.__hooks cleanup → similar pattern
Consider: Does fix belong in callee or caller?
```

**How to Test:**
1. **Identify structural patterns** in Grafema graph:
   - High fan-out (called from >5 places)
   - Symmetrical structure (duplicate subgraphs)
   - Boundary crossings (http:request, db:query nodes)
2. **Annotate experiment tasks** with expected hints
3. **Provide hints via new MCP tool**: `get_change_hints(semanticId)`
4. **Run SWE-bench subset** with hint-aware prompts

**Expected Impact:**
- **High** for fan-out bugs (preact-3345 type — forEach caller pattern)
- **Medium** for symmetry-based bugs (duplicate code requiring consistent fixes)
- **Low** for isolated single-function bugs

**Effort:** 6-8 days
- Fan-out analysis: 1 day
- Symmetry detection (subgraph isomorphism): 3-4 days
- MCP tool integration: 1 day
- SWE-bench validation: 2 days

**Acceptance Criteria:**
- On caller/callee ambiguity bugs (preact-3345 type), hint correctness >80%
- On symmetrical code bugs, detect 100% of clusters with >90% AST similarity
- Resolve rate improvement >15% on hinted tasks

**Risks:**
- Symmetry detection computationally expensive (subgraph isomorphism is NP-hard)
- False positives: similar structure ≠ same bug

---

### Direction 3: Constraint-Based Reasoning Hints

**Core Idea:**
Surface architectural constraints from graph that help models avoid wrong design decisions:
1. **Storage pattern detection**: "In this codebase, cleanup functions are stored on function objects (3/4 cases), not vnodes"
2. **Error handling patterns**: "Functions in this file use early return, not try/catch (8/10 cases)"
3. **Guard pattern prevalence**: "Property access on `obj.prop` is null-guarded in 90% of cases"

**Example Output:**
```
You're adding ref cleanup storage.
Hint: Cleanup pattern analysis in this codebase:
  - 4/5 cleanup functions stored on function object (_cleanup, _unmount)
  - 1/5 stored on vnode (_refCleanup)
Dominant pattern: function object storage.
```

**How to Test:**
1. **Pattern mining**: Analyze SWE-bench repos to extract:
   - Storage location patterns (where is state typically stored?)
   - Error handling patterns (try/catch vs early return)
   - Guard prevalence (null checks, type guards)
2. **Encode as graph metadata**: Annotate nodes with pattern statistics
3. **Provide via MCP**: `get_architectural_patterns(file, pattern_type)`
4. **Validate on design-decision bugs** (preact-4436 type)

**Expected Impact:**
- **High** for design decision bugs (preact-4436: vnode vs function storage)
- **Medium** for error handling strategy bugs (preact-3345: try/catch vs caller pattern)
- **Low** for bugs that don't involve design choices

**Effort:** 10-12 days
- Pattern mining algorithms: 5-6 days (complex — need heuristics)
- Graph annotation: 2 days
- MCP integration: 1 day
- Validation experiments: 3 days

**Acceptance Criteria:**
- Pattern detection precision >75% (correct dominant pattern)
- On design-decision bugs, agent chooses pattern-aligned approach in >60% of cases
- Resolve rate improvement >10% on design-heavy tasks

**Risks:**
- Pattern extraction may require domain knowledge (hard to automate)
- Small codebases (<1000 LOC) may not have clear dominant patterns
- Risk of overfitting to existing patterns (inhibits innovation)

---

### Direction 4: Minimal Viable Hint — Call Site Context Expansion

**Core Idea:**
The simplest intervention: When agent queries a function, automatically show **code at ALL call sites**, not just call site locations.

**Current behavior (axios-5085 issue):**
- `get_context("AxiosHeaders.toJSON")` shows toJSON source + list of callers
- Agent must explicitly `cat` each caller to see calling context
- Agent reads less → misses that callers also pass through `normalize()`

**Proposed behavior:**
- `get_context("AxiosHeaders.toJSON", expand_callers=true)` shows:
  - toJSON source
  - Code snippet at EACH call site (3 lines context)
  - FUNCTIONS that call toJSON AND other related methods

**How to Test:**
1. **Extend existing `get_context` MCP tool** with `expand_callers` flag
2. **Re-run axios-5085** with expanded context
3. **Measure**: Does agent now find all 3 change locations?

**Expected Impact:**
- **High** for multi-method bugs within same class (axios-5085 type)
- **Medium** for bugs requiring understanding call patterns
- **Low** for single-method bugs

**Effort:** 3-4 days
- MCP tool extension: 1 day
- Context aggregation logic: 1 day
- SWE-bench re-run: 1-2 days

**Acceptance Criteria:**
- axios-5085 FAIL→PASS with expanded context
- No significant increase in token cost (<10%)
- Agent doesn't get overwhelmed by too much context (test on 5 tasks)

**Risks:**
- May increase context size significantly (more tokens)
- Agent may still miss patterns if reasoning is weak

---

### Direction 5: Explicit "What Changed" Diff Hints

**Core Idea:**
For bugs with clear gold patches, extract **change patterns** from similar historical fixes and surface as hints.

**Example:** (based on axios-5085)
```
Bug type: Array value corruption
Historical fixes for similar bugs:
  - Issue #4523: Modified both normalize() and serialize()
  - Issue #3891: Fixed getter AND setter together
Pattern: Array-handling bugs often require changes in 2-3 related methods.
```

**How to Test:**
1. **Mine SWE-bench gold patches** for patterns:
   - Multi-file changes
   - Multi-method changes within same class
   - Symmetrical changes (same fix in N places)
2. **Cluster by similarity** (diff embeddings)
3. **Surface pattern when agent identifies bug type**

**Expected Impact:**
- **High** if bug matches known pattern
- **Zero** if bug is novel

**Effort:** 12-15 days
- Gold patch analysis: 4-5 days
- Pattern clustering: 4-5 days
- Hint generation: 2 days
- Validation: 2-3 days

**Acceptance Criteria:**
- Pattern library covers >40% of SWE-bench bugs
- On pattern-matched bugs, hint precision >80%

**Risks:**
- Requires labeled training data (SWE-bench gold patches)
- May not generalize beyond benchmark
- Risk of teaching agent to pattern-match instead of reason

---

## Recommended Prioritization

### Phase 1: Quick Validation (1-2 weeks)

**Goal:** Determine if ANY hint approach improves resolve rate.

**Experiments:**
1. **Direction 4 (Call Site Expansion)** — simplest, 3-4 days
   - Extend `get_context` with `expand_callers=true`
   - Re-run axios-5085, axios-5316, preact-4436
   - If PASS rate improves → continue
   - If no improvement → hints may not help reasoning

2. **Manual hint baseline** — 2-3 days
   - Manually craft perfect hints for 5 failed tasks
   - Re-run with hints in system prompt
   - Measures **ceiling** of hint approach
   - If manual hints don't help → problem is model reasoning, not hint availability

### Phase 2: Structural Hints (2-3 weeks)

**If Phase 1 shows promise:**

**Direction 2 (Graph-Derived Impact Hints)** — 6-8 days
- Fan-out analysis (immediate)
- Symmetry detection (if fan-out helps)

**Direction 1 (Co-Change Patterns)** — 8-10 days (parallel track)
- Mine git history for co-change scores
- Test on multi-location bugs

### Phase 3: Advanced Patterns (3-4 weeks)

**If Phase 2 validates structural hints:**

**Direction 3 (Constraint-Based Reasoning)** — 10-12 days
- Pattern mining for design decisions
- Test on preact design-heavy tasks

**Direction 5 (Historical Diff Patterns)** — 12-15 days
- Only if we want benchmark-specific optimization

## Success Metrics

### Primary Metrics

**Resolve Rate:**
- Baseline: 45% (5/11 SWE-bench tasks)
- Target with hints: 55%+ (6+/11)
- Improvement threshold: +20% relative (+10pp absolute)

**Multi-Location Bug Performance:**
- Currently: 0% (axios-5085 FAIL)
- Target: 50%+ (find at least half of required change locations)

### Secondary Metrics

**Hint Precision:**
- What % of surfaced hints are relevant?
- Target: >70% precision

**Hint Coverage:**
- What % of bugs have applicable hints?
- Target: >50% coverage

**Cost Impact:**
- Grafema currently saves 50% cost via efficient navigation
- Target: Maintain cost savings while improving resolve rate
- Acceptable: +20% cost if resolve rate improves >30%

### Qualitative Signals

**Agent behavior changes to look for:**
1. Agent explicitly references hints in reasoning ("The hint suggests checking normalize() as well")
2. Agent explores co-change candidates before finalizing patch
3. Agent compares proposed fix against architectural patterns

**Red flags:**
1. Agent ignores hints entirely (appears in logs but not used)
2. Agent blindly follows hints without reasoning (pattern matching, not understanding)
3. Hints introduce confusion (agent spends more steps debating)

## Validation Methodology

### Experimental Setup

**Dataset:** SWE-bench Multilingual (JS/TS subset)
- Focus on failed tasks from current experiments: preact (0/5), axios (2/5)
- Expand to full JS/TS set (43 tasks) for statistical significance

**Conditions:**
1. **Baseline:** Current Grafema MCP tools (no hints)
2. **Hint-augmented:** Same tools + hint provision
3. **Manual hint ceiling:** Perfect hand-crafted hints (upper bound)

**Controls:**
- Same model (Sonnet 4.5)
- Same agent (mini-SWE-agent v2.0.0a3)
- Same budget (step_limit=75, cost_limit=$3)
- Same random seed (for reproducibility)

**Statistical significance:**
- Minimum 20 tasks per condition
- Paired t-test for resolve rate comparison
- p < 0.05 for significance

### Per-Direction Validation

Each research direction has specific validation criteria (see "Acceptance Criteria" above). General approach:

1. **Unit test hints**: Verify hint correctness on ground truth (gold patches)
2. **Integration test**: Re-run failed tasks with hints
3. **Ablation study**: Which hint components matter most?
4. **Generalization**: Test on unseen tasks (not in development set)

## Known Challenges & Limitations

### 1. SWE-bench Synthetic Nature

**Issue:** Tasks are derived from real bugs but with synthetic PR descriptions. Commit history may not reflect real development patterns.

**Mitigation:**
- Use FULL repo history, not task-specific commits
- Validate on real-world tasks outside SWE-bench

### 2. Model Reasoning Ceiling

**Issue:** If model can't reason about multi-location changes even WITH perfect hints, hints won't help.

**Mitigation:**
- Phase 1 manual hint baseline measures this ceiling
- If ceiling is low → problem is model, not hints

### 3. Hint Overload

**Issue:** Too many hints = cognitive overload for model.

**Mitigation:**
- Start with minimal hints (Direction 4)
- Measure token usage and agent confusion signals
- Rank hints by confidence, surface top-3 only

### 4. Graph Completeness

**Issue:** Grafema graph has known gaps (import resolution, class extraction). Hints derived from incomplete graph may be wrong.

**Mitigation:**
- Document graph coverage per task
- Correlate hint quality with graph completeness
- Fix graph gaps in parallel (REG-408, REG-409)

### 5. Generalization Beyond Benchmark

**Issue:** Hints optimized for SWE-bench may not help real-world tasks.

**Mitigation:**
- Design hints based on graph structure, not benchmark specifics
- Test on real Grafema development tasks (dogfooding)
- Avoid Direction 5 (benchmark-specific patterns) unless other directions fail

## Related Grafema Limitations (Out of Scope)

These are **product gaps**, not research questions:

1. **Import resolution** (REG-408): `.js` → `.ts` redirects not followed
2. **Class method extraction**: TypeScript classes not fully analyzed
3. **Incremental analysis**: Full re-analyze after changes (RFDBv2 will fix)

These should be fixed in product roadmap, independent of hint research.

## Decision Framework

### Go/No-Go Criteria After Phase 1

**GO (proceed to Phase 2) if:**
- Manual hint baseline shows >30% resolve rate improvement
- Call site expansion shows >15% improvement on multi-location bugs
- Agent demonstrably uses hints (appears in reasoning logs)

**NO-GO (halt research) if:**
- Manual hints show <10% improvement → model reasoning is bottleneck
- Agent ignores hints entirely → prompt engineering problem, not hint problem
- Cost increase >50% with no resolve rate improvement

### Resource Allocation

**Total research budget:** 6-8 weeks (one worker)
- Phase 1: 1-2 weeks (quick validation)
- Phase 2: 2-3 weeks (structural hints)
- Phase 3: 3-4 weeks (advanced patterns)

**Parallel tracks:**
- Product fixes (REG-408, REG-409) continue separately
- Research results inform product roadmap (if hints work → prioritize hint infrastructure)

## Expected Deliverables

### Research Outputs

1. **Hint taxonomy**: Classification of hint types and applicability
2. **Effectiveness report**: Per-direction results with statistical analysis
3. **Integration spec**: If successful, detailed spec for production hint system
4. **SWE-bench leaderboard submission**: If resolve rate improves significantly

### Product Implications

**If hints prove effective:**
- New MCP tools: `get_change_hints`, `get_cochange_candidates`, `get_architectural_patterns`
- Graph enrichment: Co-change scores, pattern metadata
- Documentation: When to use hints, how to interpret them

**If hints don't help:**
- Documented boundary: "Grafema improves navigation, not reasoning"
- Focus product on what works: Cost reduction, faster exploration
- Investigate alternative approaches (e.g., fine-tuned models, different agent architectures)

## Conclusion

Grafema currently solves the **navigation problem** (50% cost reduction). This research investigates whether we can also help with the **reasoning problem** (multi-location changes, design decisions).

**Strongest hypothesis:** Direction 4 (Call Site Expansion) — simplest, highest likelihood of quick win.

**Highest ceiling:** Direction 2 (Graph-Derived Impact) + Direction 1 (Co-Change Patterns) — leverages Grafema's core strength (graph structure) without requiring external data.

**Most uncertain:** Direction 3 (Constraint-Based Reasoning) — requires complex pattern mining, may not generalize.

**Recommended approach:** Phase 1 quick validation → decide → Phase 2 structural hints → measure → potentially Phase 3 advanced patterns.

**Key risk:** Model reasoning ceiling. If models can't use perfect hints, no amount of hint engineering will help. Phase 1 measures this.

---

## Sources

- [Code Surgery: How AI Assistants Make Precise Edits to Your Files](https://fabianhertwig.com/blog/coding-assistants-file-edits/)
- [Let the Code LLM Edit Itself When You Edit the Code](https://arxiv.org/abs/2407.03157)
- [CodeGraph: Enhancing Graph Reasoning of LLMs with Code](https://arxiv.org/abs/2408.13863)
- [Dissecting the SWE-Bench Leaderboards](https://arxiv.org/html/2506.17208v2)
- [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf)
- [Integrating conceptual and logical couplings for change impact analysis](https://link.springer.com/article/10.1007/s10664-012-9233-9)
- [Change coupling: visualize the cost of change](https://codescene.com/engineering-blog/change-coupling-visualize-the-cost-of-change)
- [Enhancing Code Understanding for Impact Analysis by Combining Transformers and Program Dependence Graphs](https://dl.acm.org/doi/10.1145/3643770)
- [Software Dependency Graphs: Definition, Use Cases, and Implementation](https://www.puppygraph.com/blog/software-dependency-graph)
