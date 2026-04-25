# Cognitive Debt, Feature Detection, and the Product–Code Rosetta Stone

**Status:** Research / Active
**Date:** 2026-04-04 (last refined 2026-04-25)
**Origin:** Onboarding gap analysis — "Grafema is installed, now what?" → cognitive debt metrics + automatic feature/service discovery + product–technical vocabulary

**2026-04-25 refinements** (after L0 entry-point detection shipped — cli:command, mcp:tool, vscode:command via libraryCallbackEnricher / mcpToolDefinitionEnricher):
- §2.2 — separated FEATURE (named product unit) from BEHAVIOR (implementation region) and CONTRACT (interface). The original 5-tuple conflated the three.
- §2.8 *(new)* — Feature variants and granularity. Features are fractal: top-level entry points, parameters, output formats, scheduling, flag-gated branches are all "features" by the product test. Multi-layer detection (L0/L1/L2/L3).
- §3.4 *(new)* — Feature Request → Graph Operation mapping (the write-direction dual of §3.3 query templates).
- §4.1 — Added BEHAVIOR and CONTRACT as auto-discovered entity types alongside FEATURE.
- §4.2 — Added IMPLEMENTED_BY (FEATURE→BEHAVIOR), HAS_CONTRACT, EXPOSED_AS, COMPRISES, SHARES_BEHAVIOR_WITH edges. Removed PRODUCES_EFFECT from FEATURE (moved to BEHAVIOR).
- §4.3 — Split monolithic Phase 2 into per-layer phases (L1 contract, L3 behavior, dedup linking). Original 8 phases → 10 phases mapped to detection layers.
- §4.5 — Rollout aligned to detection layers (v0.2 = L0 SHIPPED, v0.3 = L1+L3, v0.5 = L2+human-labeled).

## Problem

After `grafema analyze`, the user sees "117K nodes, 224K edges" — and has no idea what to do next. The graph is powerful but inert. It answers questions but doesn't **ask** them.

Three barriers to value:

1. **No actionable insights** — the graph doesn't tell you where the problems are
2. **No product-level abstraction** — the graph speaks in functions and modules, not features and services
3. **No vocabulary bridge** — product managers think in "features", engineers think in "modules", the graph thinks in "nodes"

This document addresses all three by:
- Formalizing **cognitive debt** as a computable graph metric (Storey et al.)
- Defining **feature** as a graph-native concept with auto-discovery algorithm
- Building the **Rosetta Stone** — bidirectional vocabulary between product and graph domains
- Proposing **graph enrichment** — abstract nodes (FEATURE, SERVICE, DOMAIN) derived from the Semantic projection

## Part 1: The Triple Debt Model

### 1.1 Storey's Three Layers (2026)

Margaret-Ann Storey's "From Technical Debt to Cognitive and Intent Debt" (March 2026, arXiv:2603.22106v3) proposes a triple debt model built on a key insight: **a software system exists across three distinct layers** (drawing on Naur 1985):

1. **Goals and intent** — requirements, constraints, objectives, as held by stakeholders and captured in specs/tests/docs
2. **Code and structure** — source code, architecture, dependencies, deployment infrastructure
3. **Shared understanding** — the mental models that developers, architects, PMs hold about how the code works and why it was built the way it was ("the theory of the system", Naur 1985)

Each layer has its debt type:

| Debt type | Lives in | What accumulates | Diagnosing signals |
|-----------|----------|-----------------|-------------------|
| **Technical** | Code | Shortcuts, architectural compromises | Linters, static analysis, code smells |
| **Cognitive** | People | Erosion of shared understanding across the team | Resistance to change, unexpected results, low bus factor, slow onboarding |
| **Intent** | Artifacts | Missing or eroded rationale, goals, constraints | Behaviour drift, AI agents struggle with context, lost articulated constraints |

### 1.2 Critical Distinction: Cognitive Load ≠ Cognitive Debt

Storey defines cognitive debt as **"inadequate shared mental models that allow developers across a team to reason about a system and what they need to understand to change it safely and confidently"** — it's a property of **people and teams**, not of code.

This is fundamentally different from code complexity or cognitive load:

```
Cognitive Load    = property of CODE — how much effort the code requires to understand
Cognitive Debt    = property of TEAM — how much understanding is actually missing
```

**These are related but distinct:**
- A team with excellent onboarding, walkthroughs, and pair programming can have **low cognitive debt** on **high complexity** code — they've invested in understanding.
- A team practicing **cognitive surrender** (Shaw & Nave 2026: accepting AI output without building understanding) can have **high cognitive debt** on **low complexity** code — the code is simple, but nobody actually understands it.

**Cognitive surrender** (Shaw & Nave 2026) ≠ cognitive offloading. Offloading = strategic delegation to a tool (linter, type checker). Surrender = bypassing both intuition and deliberate reasoning when accepting AI output. Critically, surrender inflates confidence even when the AI is wrong — the team *feels* they understand better than they do.

### 1.3 The Reinforcing Cycle

The three debts interact and amplify each other:

```
Intent debt ──→ Cognitive debt
  (can't form mental models         ↓
   without captured rationale)   Technical debt
                                    ↓
Cognitive debt ←── Technical debt
  (messy code is harder to understand,
   diminishing understanding further)
```

- **Intent → Cognitive:** When purpose isn't articulated, new team members can't form accurate mental models
- **Cognitive → Technical:** When developers don't understand a system, they make poor implementation decisions
- **Technical → Cognitive:** Messy code is harder to reason about, further eroding understanding
- **Cognitive ↔ Intent:** Developers who lack understanding can't externalize specifications; externalized intent helps repair understanding

### 1.4 What Grafema Can and Cannot Measure

Given the distinction above, Grafema's graph metrics fall into two categories:

| What we measure | Debt type | Storey's layer | Nature |
|----------------|-----------|---------------|--------|
| Code complexity, hidden dependencies, indirection | **Cognitive Load Potential** (risk factor for cognitive debt) | Code & Structure | Computable from graph |
| Effects, naming incongruence, coupling | **Technical debt signals** | Code & Structure | Computable from graph |
| KB/decision coverage, guarantee coverage | **Intent debt** (directly) | Goals & Intent | Computable from KB |
| Bus factor, onboarding time, team understanding | **Cognitive debt** (directly) | Shared Understanding | Requires organizational data |

**Key insight for Grafema:** Our C1–C6 metrics (below) measure **Cognitive Load Potential** — how much cognitive burden the code imposes. This is a **risk indicator** for cognitive debt, not cognitive debt itself. High Cognitive Load Potential means:
- Code is harder to understand → higher RISK of cognitive debt accumulating
- New team members will take longer to build mental models
- Cognitive surrender (accepting AI-generated changes without understanding) is more dangerous here

To measure actual cognitive debt, we would need organizational signals (Projection 6: Organizational):
- **Bus factor** per module (from git history: how many distinct authors?)
- **Knowledge freshness** (from git blame: when did current team last touch this code?)
- **Onboarding velocity** (from external data: how long until productive?)
- **Review depth** (from GitHub: are PRs rubber-stamped or deeply reviewed?)

The Cognitive Load Potential is the part we can compute from the graph alone. It's the **supply side** of cognitive debt — the demand the code places on understanding. The **demand side** — whether the team actually has that understanding — requires organizational data.

### 1.5 Cognitive Load Potential — Formal Definition

**Cognitive Load Potential** = the cognitive burden a piece of code places on anyone trying to understand it. Higher values mean the code demands more working memory, more context, and more effort to reason about safely.

This is distinct from Storey's cognitive debt (team-level understanding gap) but serves as a computable **leading indicator**: code with high load potential is where cognitive debt will accumulate first when team knowledge erodes.

### 1.6 Computable Components (from Graph)

Each component maps to a Cognitive Dimension (Green & Petre, 1996) and is computable from the code graph. Together they form the **Cognitive Load Potential** score — a risk indicator for cognitive debt accumulation.

#### C1: Hidden Dependency Load (→ CD: Hidden Dependencies)

**Definition:** Proportion of cross-module interactions that are not visible at the call site.

```
HiddenDepLoad(M) = |implicit_cross_module_edges(M)| / |total_cross_module_edges(M)|
```

Where `implicit_cross_module_edges` = edges that cross module boundaries through:
- Re-exports (import → re-export → re-export → actual definition)
- Callback injection (function A passes callback to B, B calls it — the A→B dependency is invisible)
- Event emitters (emitter.emit('X') in module A, emitter.on('X') in module B)
- Shared mutable state (module A writes global, module B reads it)
- Dynamic dispatch (strategy pattern, plugin systems)

**Graph computation:**
```
find all CALLS/READS_FROM edges where source.file ≠ target.file
for each: trace_alias to find indirection depth
HiddenDepLoad = count(indirection_depth > 1) / total
```

**Interpretation:** 0.0 = all dependencies are explicit imports. 1.0 = all dependencies are hidden. High values → "spooky action at a distance", code that can't be understood locally.

#### C2: Comprehension Span (→ CD: Hard Mental Operations)

**Definition:** Number of distinct **cognitively-heavy** files a developer must load into working memory to understand a single unit.

Naive version (`|files(transitive_deps)|`) overcounts. If a function calls `formatDate()` from `utils/date.js`, that's a resolved dependency — the developer doesn't need to "hold utils/date.js in working memory", they just need the function signature. The dependencies that actually burden working memory are those into **coupled, effectful** code where understanding the callee requires understanding its context.

```
ComprehensionSpan(fn) = |heavy_files(transitive_deps(fn, depth=3))|

heavy_files(deps) = { file ∈ files(deps) :
    InternalCoupling(file) > 0  // functions in file call each other
    OR EffectDensity(file) > 0.5  // majority of functions have side effects
    OR file = fn.file  // always count own file
}
```

This reuses the same InternalCoupling and EffectDensity from C4. Files that are "library-shaped" (pure, independent functions) are excluded — they're cognitively transparent, like calling `Math.max()`.

**Graph computation:**
```
trace_dataflow(source=fn, direction="forward", max_depth=3)
for each touched file: compute InternalCoupling + EffectDensity
count only files above threshold
```

**Examples:**
- `processOrder()` calls: `validateInput()` (same file), `chargeCard()` (payments/stripe.js — effectful), `formatDate()` (utils/date.js — pure) → Span = 2 (own file + stripe.js), NOT 3
- `renderDashboard()` calls: pure helpers from 5 utility files + 2 stateful services → Span = 3 (own file + 2 services), NOT 8

**Interpretation:** ComprehensionSpan=1 means self-contained. Span > 7 (Miller's 7±2) likely exceeds working memory → high error rate. Outliers are where cognitive debt concentrates.

#### C3: Scattered Responsibility (→ CD: Diffuseness)

**Definition:** How many **domain-specific** files does one conceptual operation touch?

Same filtering principle as C2: utility files don't count as scatter. A checkout flow that touches handler.js, cartService.js, paymentService.js, orderRepository.js + 10 pure utility files = scatter of 4, not 14. The utility files are infrastructure, not domain scatter.

```
ScatteredResp(feature) = |core_files(execution_subgraph(feature))|

core_files(subgraph) = heavy_files(subgraph)  // reuses C2's filter
  // = files with InternalCoupling > 0 OR EffectDensity > 0.5
```

Additionally, we can distinguish **healthy** scatter (one file per architectural layer — handler, service, repository) from **unhealthy** scatter (multiple files at the same layer):

```
UnhealthyScatter(feature) = max(|files_per_layer|) where layer ∈ {handler, service, repository, ...}
```

If a feature has 3 service-layer files doing related work, that's a stronger signal of scattered responsibility than 1 handler + 1 service + 1 repo.

**Interpretation:** ScatteredResp ≤ 4 per layer = healthy separation of concerns. Multiple files at the same architectural layer = responsibility that should be unified.

#### C4: Tangled Responsibility (→ CD: Viscosity)

**Definition:** How entangled are the concerns within one file, weighted by how many features depend on it?

Naive version (`|features(file)|`) is wrong. A file with 20 independent pure functions used by 15 features (e.g., `utils/date.js`) has zero cognitive debt — each function is self-contained, you understand `formatDate()` without knowing about `parseISO()`. The real problem is files where functions are **internally coupled** and **effectful** — changing one function requires understanding others in the same file.

```
TangledResp(file) = |features(file)| × InternalCoupling(file) × EffectDensity(file)

InternalCoupling(file) = |intra_file_edges| / (|functions| × (|functions| - 1))
  where intra_file_edges = CALLS ∪ READS_FROM edges between functions WITHIN the file

EffectDensity(file) = |functions_with_effects(IO ∪ MUTATION)| / |total_functions|
```

**Examples:**
- `utils/date.js`: 20 pure functions, 0 intra-file edges → InternalCoupling=0, EffectDensity=0 → **TangledResp=0** (correct: no cognitive debt despite high feature participation)
- `UserService.js`: 47 methods, 120 intra-file calls, 35 with IO/MUTATION effects → InternalCoupling=0.055, EffectDensity=0.74 → **TangledResp=12 × 0.055 × 0.74 = 0.49** (high: entangled god module)

**Key insight:** Pure, independent functions are "library-shaped" — high reuse is a feature, not a problem. The cognitive debt comes from **coupled, effectful code** shared across features. The multiplication ensures all three factors must be present for a high score.

**Relationship to Viscosity:** High TangledResp = high resistance to change. Changing one function in UserService risks side effects in 12 features because the functions share state and call each other.

#### C5: Indirection Depth (→ CD: Abstraction Gradient)

**Definition:** Number of hops from user-facing entry point to actual side effect (DB write, HTTP response, external call, etc.).

```
IndirectionDepth(entry) = p90(shortest_path(entry → effect))
  where effect ∈ {IO, MUTATION}  // NOT THROW — throws are control flow, not effects
```

Uses **p90** rather than average — average is dragged down by trivial short paths (e.g., direct `res.send()`), while we care about the longest chains that force deep comprehension.

THROW is excluded from the effect set: a `throw new ValidationError()` at hop 1 is normal guard logic, not an abstraction problem. IO and MUTATION are the effects that represent actual work done by the feature.

**Graph computation:**
```
for each entry point (HTTP handler, CLI command):
  trace_effects or trace_dataflow(forward) to find IO/MUTATION nodes
  measure path length (in call hops) to each
  take p90
```

**Interpretation:** IndirectionDepth ≤ 3 (handler → service → db.write) = clean. IndirectionDepth ≥ 6 (handler → middleware → adapter → factory → strategy → impl → wrapper → db.write) = over-abstraction, "astronaut architecture."

**Note:** Some indirection is structural and healthy (middleware chains in Express, decorator stacks in NestJS). Framework-injected hops could be discounted if we detect framework middleware patterns — but this is a v2 refinement.

#### C6: Naming Incongruence (→ CD: Role-Expressiveness)

**Definition:** Degree to which function names don't match their actual behavior.

```
NamingIncongruence(fn) = |actual_effects(fn) \ expected_effects(name(fn))|
```

Where `expected_effects` is derived from naming conventions:
- `get*`, `find*`, `fetch*` → expects: read-only (no MUTATION)
- `create*`, `save*`, `write*` → expects: MUTATION
- `validate*`, `check*`, `is*` → expects: PURE (no IO, no MUTATION)
- `delete*`, `remove*` → expects: MUTATION + IO

**Graph computation:** Compare effect annotations (from effects-db / manifest) against name-derived expectations.

**Interpretation:** `getUserById()` that also writes cache, emits events, and logs to external service = high naming incongruence. The name promises a simple read, the reality is a complex multi-effect operation. Developer will underestimate blast radius.

**Note:** This is heuristic and NLP-dependent. A fallback is effect count: `getX()` with 5 effects is suspicious regardless of exact naming analysis.

### 1.7 Composite Cognitive Load Potential Score

The six components have different scales and granularity levels:
- **C1** (HiddenDepLoad): ratio 0–1, module-level
- **C2** (ComprehensionSpan): count (1–N), function-level → aggregate to module
- **C3** (ScatteredResp): count (1–N), feature-level → attribute to participating modules
- **C4** (TangledResp): product of three values (0–N), file/module-level
- **C5** (IndirectionDepth): count (1–N), entry-point-level → aggregate to module
- **C6** (NamingIncongruence): count (0–N), function-level → aggregate to module

**Step 1: Aggregate to module level**

Function-level metrics (C2, C5, C6) must be aggregated per module. Use **p90** (90th percentile) rather than mean — we care about worst-case cognitive burden, not average:

```
C2_module(M) = p90({ ComprehensionSpan(fn) : fn ∈ M })
C5_module(M) = p90({ IndirectionDepth(fn) : fn ∈ M, fn is entry_point })
C6_module(M) = |{ fn ∈ M : NamingIncongruence(fn) > 0 }| / |functions(M)|
```

Feature-level metric (C3) is attributed to each participating module:
```
C3_module(M) = max({ ScatteredResp(f) : M ∈ core_files(f) })
```

**Step 2: Normalize to percentile rank**

Z-score has interpretation problems (what does z=2.3 mean to a PM?). Instead, use **percentile rank** within the project — each score becomes "worse than X% of modules":

```
prank(x, all_values) = |{ v ∈ all_values : v ≤ x }| / |all_values|  # 0.0–1.0
```

**Step 3: Composite score**

```
CogLoadScore(M) = Σ wᵢ · prank(Cᵢ_module(M))

Where:
  w₁..w₆ — weights summing to 1.0
  Initial weights: w₁=w₂=w₃=w₄=w₅=w₆ = 1/6
  
Output: 0.0–1.0, displayed as 0–10 for readability
```

**Why percentile rank works:** A module scoring 8.5/10 means "worse than 85% of modules in this project." This is self-calibrating — no need for cross-project baselines. The meaning is always relative to THIS codebase.

**Calibration strategy:**
1. Compute CogLoadScore for all modules in 5+ open-source projects
2. Survey developers: "rank these 10 modules by difficulty of understanding"
3. Correlate graph score with human ranking (Spearman's ρ)
4. Adjust weights to maximize correlation
5. Validate: LLM benchmark (see theoretical-foundations.md) as cheap proxy — token count to answer comprehension questions should correlate with CogLoadScore

**Output:** Module-level cognitive debt score, 0–10. Actionable: "these 5 modules carry 60% of cognitive debt in the project". Breakdown shows which components contribute most, pointing to specific remediation.

### 1.8 Intent Debt — Computable from Knowledge Base

Storey: intent debt lives in **artifacts** — "the absence or erosion of explicit rationale, goals, and constraints that guide how a system evolves." This is the layer Grafema can measure most directly through Knowledge Base coverage.

What practitioners call "context debt" (the missing information AI agents need to work effectively) is largely a symptom of intent debt. As AI generates more code, intent artifacts (specs, ADRs, tests-as-intent, domain models) become critical — both for humans who need to understand, and for AI agents who need context to make good decisions.

Intent debt = lost rationale. Measurable as coverage:

```
IntentDebt(project) = 1 - |functions_with_decisions| / |total_meaningful_functions|

Where:
  functions_with_decisions = functions linked to DECISION nodes in KB
  total_meaningful_functions = functions that are non-trivial (e.g., ComprehensionSpan > 1)
```

**Additional metrics:**
- **Guarantee coverage:** `|modules_with_guarantees| / |total_modules|`
- **Decision staleness:** `avg(age(DECISION nodes))` — old decisions without review = stale intent
- **Orphan code:** functions not traceable to any feature or requirement = "why does this exist?"

### 1.9 Connection to SPACE Framework

Storey co-authored SPACE (Forsgren et al. 2021) — Satisfaction, Performance, Activity, Communication, Efficiency. The triple debt model maps to SPACE:

| SPACE dimension | Cognitive Load Potential (code) | Cognitive Debt (team) | Intent Debt (artifacts) |
|----------------|-------------------------------|----------------------|------------------------|
| **Satisfaction** | High load → frustration | Low understanding → anxiety | Missing rationale → "why does this exist?" |
| **Performance** | IndirectionDepth → slower comprehension | Knowledge gaps → wrong decisions | Missing constraints → wrong optimizations |
| **Activity** | ScatteredResp → more files per change | Bus factor risk → bottlenecks | Behaviour drift → rework |
| **Communication** | HiddenDepLoad → surprise impacts | Cognitive surrender → false confidence | No ADRs → repeating debates |
| **Efficiency** | TangledResp → broader reviews needed | Slow onboarding → productivity loss | AI agents need more tokens/clarification |

### 1.10 AI Amplification Effect

Storey's central thesis: **AI may reduce technical debt while simultaneously accelerating cognitive and intent debt.**

```
AI generates code faster than teams can build understanding.
The code works. The code may even be well-architected.
But the team may not understand HOW it works or WHY it was built that way.
```

This has direct implications for Grafema:
- **Cognitive Load Potential (C1–C6)** becomes MORE important in AI-assisted codebases, not less — it's the risk surface where cognitive surrender is most dangerous
- **Intent coverage** (guarantees, decisions in KB) becomes the primary defense against intent debt
- **Grafema's graph** is itself an intent artifact — it externalizes structural understanding that would otherwise exist only in people's heads

The tool isn't just measuring debt — it's **reducing** cognitive and intent debt by making implicit structure explicit. This aligns with Storey's recommendation: "the practices that most effectively reduce cognitive debt are those that make implicit knowledge explicit."

## Part 2: Feature as Graph-Native Concept

### 2.1 Why "Feature" Needs Formal Definition

Product managers think in features. Engineers think in files. The graph thinks in nodes and edges. Without a formal bridge, these three worlds talk past each other.

"Feature" is one of the most overloaded terms in software. It can mean:
- A user story in Linear
- A feature flag in LaunchDarkly
- A directory in the repository
- A checkbox on the marketing page
- A route in the API

None of these definitions is graph-native. We need one that is.

### 2.2 Formal Definition

**Feature (product-native):** A named, externally-addressable variant of behavior — an item a user can request to add, modify, or remove.

The product test for "is X a feature?":
1. Has a stable, externally-known name
2. Is documented (or could be)
3. A user could write a feature request for it

This separates **FEATURE** (what the user sees) from **BEHAVIOR** (what the code does):

```
Feature   = ⟨ EntryPoint, ActivationCondition, Contract ⟩
              ──IMPLEMENTED_BY→  Behavior
              ──TOGGLED_BY→     FeatureFlag*

Behavior  = ⟨ ExecutionSubgraph, Effects, ExitPoints ⟩

Contract  = ⟨ Inputs, Outputs, Errors ⟩
              Inputs  = parameters, body schema, query string, options
              Outputs = return type(s), response shape, content-types
              Errors  = thrown exception types, error codes

EntryPoint ∈ { node : accepts_external_input(node) }
  = HTTP handler | CLI command | event listener | UI callback
  | scheduled job | message consumer | exported function

ActivationCondition = predicate(input) that selects this feature
  = route match | feature flag | user role | command name
  | event type | message topic

ExecutionSubgraph = reachable(EntryPoint, CALLS ∪ READS_FROM)
                    ∩ guarded_by(ActivationCondition)

Effects = { node ∈ ExecutionSubgraph : has_effect(node, IO ∪ MUTATION ∪ THROW) }

ExitPoints = { node ∈ ExecutionSubgraph : is_response(node) ∨ is_return_to_caller(node) }
```

**Why Feature ≠ Behavior:**

A single Behavior can be wrapped by multiple Features — different access modalities for the same logical action:

```
Feature: HTTP /api/parse        ─┐
Feature: CLI grafema parse       ─┼─→ Behavior: parse algorithm
Feature: parseFile() programmatic API ─┘
Feature: scheduled-parse cron    ─┘
```

All four are independent feature requests (each has a name, doc page, lifecycle), but they share one Behavior. The dedup signal is structural: two Features that share a Behavior are *related*, not *duplicate* — they are intentional access variants.

Conversely, one Feature can be backed by multiple Behaviors via FeatureFlag (A/B test, gradual rollout, kill switch). Same name, same contract, different implementations behind a config gate.

**Connection to Program Slicing (Weiser, 1984):**
- Forward slice from EntryPoint = all code this input can affect (the Behavior subgraph)
- Backward slice from Effects = all code that contributes to this effect
- Behavior ≈ forward_slice(EntryPoint) ∩ backward_slice(Effects)

**Connection to Feature Location (Dit et al., 2013):**
Feature location research identifies code implementing a feature using static analysis, dynamic traces, and IR techniques. Our definition is the **static** variant, enhanced by graph structure (vs. text-based IR), and explicitly separates the *named-product-unit* (Feature) from the *implementation-region* (Behavior).

### 2.3 Feature Taxonomy (from Graph Structure)

Not all features have the same graph shape. The shape tells us the feature type:

#### Linear Feature (request → response)
```
EntryPoint → Handler → Service → Repository → Effect
```
**Pattern:** Low fan-out, single path, clear entry/exit.
**Example:** `GET /api/users/:id`
**Detection:** `trace_dataflow(handler, forward)` produces a linear chain.

#### Branching Feature (conditional paths)
```
EntryPoint → Guard → Branch₁ → Effect₁
                   → Branch₂ → Effect₂
```
**Pattern:** Fan-out at guard node, multiple effect sets.
**Example:** Payment processing (card vs. bank transfer vs. crypto)
**Detection:** CFG branches after entry point, distinct effect sets per branch.

#### Saga Feature (multi-step, compensating)
```
Step₁ → Effect₁ → Step₂ → Effect₂ → Step₃ → Effect₃
                          ↓ failure
                   Compensate₂ → Compensate₁
```
**Pattern:** Sequential effects with compensation paths.
**Example:** Order fulfillment (charge → reserve → ship, with rollback)
**Detection:** Exception paths that undo prior effects.

#### Event-Driven Feature (publish → subscribe)
```
EntryPoint → emit('OrderPlaced')
                    ↓
    Listener₁ → Effect₁  (send email)
    Listener₂ → Effect₂  (update inventory)
    Listener₃ → Effect₃  (analytics)
```
**Pattern:** Fan-out at event emission, multiple independent effect chains.
**Example:** Order placement triggering notifications, inventory, analytics.
**Detection:** Event emitter edges with multiple listeners.

#### Cross-Cutting Feature (middleware / aspect)
```
Feature₁ → [AuthMiddleware] → Handler₁ → Effect₁
Feature₂ → [AuthMiddleware] → Handler₂ → Effect₂
Feature₃ → [AuthMiddleware] → Handler₃ → Effect₃
```
**Pattern:** Node with high in-degree from multiple feature subgraphs.
**Example:** Authentication, logging, rate limiting.
**Detection:** Functions called by 5+ distinct entry points from different modules.

#### Toggle Feature (feature-flagged)
```
EntryPoint → if(flag('new_checkout')) → NewPath → Effect_new
                                      → OldPath → Effect_old
```
**Pattern:** Boolean guard with two complete execution paths.
**Example:** Any A/B test or gradual rollout.
**Detection:** Guard node whose predicate references a configuration/flag value.

### 2.4 Auto-Discovery Algorithm

```
ALGORITHM: DiscoverFeatures(graph)

INPUT:  Code graph with nodes, edges, effects, metadata
OUTPUT: Set of Feature objects with core/periphery distinction

0. CLASSIFY FILES (pre-step, runs once)
   // Separate "library-shaped" files from "domain" files
   // Reuses InternalCoupling + EffectDensity from C2/C4
   for each file in graph:
     file.is_library = (InternalCoupling(file) == 0 AND EffectDensity(file) < 0.3)
     file.is_domain  = NOT file.is_library

1. FIND ENTRY POINTS
   entry_points = find_nodes(type ∈ {FUNCTION, METHOD})
     WHERE has_metadata("route") OR has_metadata("command")
        OR has_metadata("eventListener") OR has_metadata("export" AND file = entry_file)
        OR has_edge(INCOMING, "HANDLES_REQUEST")

   // Framework-specific heuristics (configurable via plugins):
   //
   // Express/Koa/Fastify:
   //   app.get/post/put/delete/all → handler argument is entry point
   //   router.route('/path').get(handler) → handler
   //   Pattern: CALL to app/router method with route string + function arg
   //
   // React/Vue/Angular:
   //   Default export from component file → entry point
   //   Pattern: EXPORT_DEFAULT from file matching component naming convention
   //
   // CLI (Commander/Yargs/Meow):
   //   .command('name').action(handler) → handler is entry point
   //   Pattern: CALL to .action/.handler with function arg
   //
   // Message queues (Bull/RabbitMQ/SQS):
   //   queue.process(handler) → handler is entry point
   //   consumer.on('message', handler) → handler
   //
   // GraphQL:
   //   Resolver functions in schema definition
   //   Pattern: FUNCTION assigned to Query/Mutation/Subscription field
   //
   // Cron/Scheduled:
   //   cron.schedule('* * * * *', handler) → handler
   //   @Scheduled annotation (Java/NestJS)

2. FOR EACH entry_point:
   full_subgraph = trace_dataflow(entry_point, direction="forward", max_depth=15)
   effects = filter(full_subgraph, has_effect(IO | MUTATION))
   
   // Separate core subgraph from utility periphery
   core_subgraph = filter(full_subgraph, node.file.is_domain)
   periphery     = filter(full_subgraph, node.file.is_library)
   
   feature = Feature {
     entry:      entry_point,
     activation: extract_route_or_condition(entry_point),
     core:       core_subgraph,    // domain code — what defines the feature
     periphery:  periphery,         // utility code — shared infrastructure
     effects:    effects,
     files: {
       core:  distinct_files(core_subgraph),
       all:   distinct_files(full_subgraph),
     },
     metrics: {
       span:         |core_files|,      // only core files count for scatter
       depth:        max_path_length(entry_point, effects),
       effect_count: |effects|,
       core_nodes:   |core_subgraph|,
       total_nodes:  |full_subgraph|,
       periphery_ratio: |periphery| / |full_subgraph|,  // high = mostly utility calls
     }
   }

3. CLUSTER FEATURES → COMPONENTs
   // Cluster on CORE subgraphs only — periphery (utils) is shared by definition
   // Using core nodes prevents "everything is connected through lodash"
   similarity_matrix = for each (f₁, f₂):
     jaccard(f₁.core.nodes, f₂.core.nodes)
   
   components = community_detection(similarity_matrix, threshold=0.3)
   // Each component = structural cluster (no business/runtime meaning yet)
   // Auto-named from: dominant route prefix, shared directory, or "Component-N"

4. DETECT CROSS-CUTTING (relative threshold)
   // Absolute threshold (5) is wrong for small projects with 8 features
   cross_cutting_threshold = max(3, |features| × 0.3)
   
   for each function in graph WHERE function.file.is_domain:
     participating_features = count(features where function ∈ core_subgraph)
     if participating_features > cross_cutting_threshold:
       mark as CROSS_CUTTING (middleware, shared service)
   
   // Library-shaped files are NOT cross-cutting — they're infrastructure.
   // Cross-cutting = domain code that appears in many features (auth middleware, 
   // validation layer), NOT utility functions like formatDate().

5. CREATE ABSTRACT NODES
   for each feature:
     create node type=FEATURE, name=feature.activation
     create edges FEATURE -IMPLEMENTED_BY-> each node in core_subgraph
     create edges FEATURE -USES_UTILITY-> each node in periphery
     create edges FEATURE -PRODUCES-> each effect
   
   for each component:
     create node type=COMPONENT, name=component.auto_label
     create edges COMPONENT -GROUPS-> each feature in component
   
   // Higher-level entities (CAPABILITY, PRODUCT, DOMAIN, DEPLOYMENT_UNIT)
   // are NOT created here — they require human input from interview (§6)

RETURN features, components, cross_cutting
```

### 2.5 The Core/Periphery Distinction

This is the central insight that makes all metrics honest.

**Periphery (library-shaped code):** Pure, independent functions with clear names. Calling them is cognitively transparent — you understand `formatDate(ts)` from the name alone. These don't contribute to cognitive debt, feature scatter, or tangling.

**Core (domain code):** Functions with side effects, internal coupling, or domain-specific logic. Understanding them requires context — you can't know what `processPayment()` does from the name alone, you need to know about the payment gateway, retry logic, idempotency keys, etc.

The same classification (InternalCoupling + EffectDensity) is reused consistently across:
- **C2** (ComprehensionSpan): only count core files in working memory
- **C3** (ScatteredResp): only count core files as scatter
- **C4** (TangledResp): multiplication already handles it
- **Feature Discovery**: cluster on core subgraphs, not full traces
- **Cross-cutting detection**: only flag domain code, not utilities

**Edge case — stateful utilities:** A cache module (`cache.js`) with `get()`, `set()`, `invalidate()` has side effects (MUTATION) but functions are independent (InternalCoupling ≈ 0). With the current formula: EffectDensity = 1.0 but InternalCoupling = 0, so `is_library = false` (because EffectDensity ≥ 0.3). This is correct — a cache mutation IS domain-relevant, and changing `cache.set()` behavior DOES require understanding its callers.

**Edge case — complex pure library:** A math library with 50 pure functions where some call each other (e.g., `normalize()` calls `magnitude()`). InternalCoupling > 0 but EffectDensity = 0, so `is_library = true`. This is correct — even though functions are coupled, they're pure and predictable. The coupling doesn't create hidden risks.

### 2.6 Existing Capabilities We Already Have

The algorithm is not purely theoretical — Grafema already has infrastructure for key steps:

**CALL_REMOTE edges.** Cross-service calls are already traced in the graph. A feature that calls `fetch('/api/payments')` in the frontend has a CALL_REMOTE edge to the backend handler. This means **cross-service feature tracing works today** — we don't need federation to start, just CALL_REMOTE resolution.

**Symbolic execution on partial ENUMs.** When `req.method` is a known or partially-known enum, Grafema's symbolic execution already forks the execution path. `if (req.method === 'POST')` creates two branches with known activation conditions. This directly feeds Feature Taxonomy §2.3 (Branching Feature) — we can auto-detect which branch corresponds to which HTTP method, feature flag value, etc.

**Effects taxonomy + transitive propagation.** The effects-db already classifies functions as PURE, IO, MUTATION, etc. with transitive propagation through the call graph. C6 (Naming Incongruence) is immediately computable: compare `get*` function name against its transitive effect set.

**Alias tracing.** `trace_alias` resolves `const handler = routes[method]` back to the actual function when the alias chain is statically determinable. Covers most Express/Koa routing patterns.

### 2.7 Remaining Limitations

1. **Fully dynamic dispatch** — `handler = plugins[userInput]` where the key is truly runtime-determined. Alias tracing can't resolve this. Mitigation: mark as UNKNOWN entry point, flag for user labeling.
2. **Feature naming** — route paths and command names provide automatic names for ~70% of features. The remaining 30% (internal features, scheduled jobs, event-driven flows) need LLM-assisted naming (see §5.2).
3. **Multi-language features beyond CALL_REMOTE** — shared-state coupling across languages (e.g., frontend writes to localStorage, backend reads from cookie) requires data-flow federation. CALL_REMOTE covers explicit API calls today.
4. **External feature flags** — LaunchDarkly, ConfigCat, etc. are invisible without integration. Mitigation: detect `if (config.featureX)` patterns as FEATURE_FLAG candidates even without knowing the flag service.

### 2.8 Feature Variants and Granularity

Features are not monolithic — they decompose recursively. A top-level feature has sub-features (parameters, output formats, scheduling modes, flag-gated branches), and each sub-feature is itself a **named, externally-addressable variant of behavior** that satisfies the product test in §2.2.

```
parser tool                                      ← top-level feature (entry point modality)
├── parameter: input encoding                   ← sub-feature (input dimension)
├── parameter: max_depth                        ← sub-feature
├── output: JSON                                 ← sub-feature (output dimension)
├── output: markdown                             ← sub-feature
├── output: graphviz                             ← sub-feature
├── modality: CLI invocation                     ← sub-feature (sibling top-level)
├── modality: programmatic API                   ← sub-feature (sibling top-level)
├── modality: scheduled cron trigger             ← sub-feature (sibling top-level)
├── flag: experimental_fast_path (5% rollout)   ← sub-feature (variation dimension)
└── flag: legacy_compat                          ← sub-feature
```

Each is a separate request shape. "Add markdown output" is a feature request; "add programmatic API" is a feature request; "gate the fast path with a flag" is a feature request. They differ in *which dimension* of the feature tree they touch.

#### Feature dimensions vs taxonomy types

The taxonomy in §2.3 classifies features by **shape** of their execution subgraph (Linear, Branching, Saga, Event-Driven, Cross-Cutting, Toggle). Variation dimensions are **orthogonal** — any Linear feature can also be flag-gated, any Saga feature can have multiple output formats. Toggle Feature is a *taxonomic shape* (CFG with paired branches under a guard), but flag-gating itself is a dimension that applies across all shapes.

Concrete decomposition for any feature:

| Dimension | Variant examples | Detection layer |
|-----------|------------------|-----------------|
| **Entry-point modality** | HTTP / CLI / scheduled / programmatic / event | L0 (effects-db ENTRY_POINT_CALLBACK) |
| **Inputs** | required / optional params, body schema, options | L1 (PARAMETER nodes + JSDoc/types) |
| **Outputs** | return type, content-types, response shape | L1 (RETURNS edges + type annotations) |
| **Errors** | exception types, error codes | L1 (THROWS edges, catch handlers) |
| **Flag-gated paths** | A/B, kill switch, gradual rollout | L2 (FEATURE_FLAG, §4.1) |
| **Implementation** | the BEHAVIOR subgraph(s) | L3 (forward slice, §2.2) |

#### Feature-request → graph-operation mapping

Real product feature requests map onto specific graph deltas. Examples:

| Product request | Graph delta |
|-----------------|-------------|
| "Add a new MCP tool foo" | new ENTRY_POINT + FEATURE + CONTRACT + BEHAVIOR |
| "Add markdown output to existing tool" | new Output variant in CONTRACT.outputs (no new BEHAVIOR if reusing) |
| "Add programmatic API alongside CLI" | new FEATURE (different modality), IMPLEMENTED_BY → existing BEHAVIOR |
| "Trigger dump on schedule" | new ENTRY_POINT (cron), new FEATURE, IMPLEMENTED_BY → existing BEHAVIOR |
| "Gate the new fast path under a flag" | new FEATURE_FLAG node, second BEHAVIOR, TOGGLES → existing FEATURE |
| "Deprecate the legacy modality" | mark FEATURE.lifecycle = deprecated (not a graph deletion) |

This mapping enables AI agents (and humans) to translate product asks into specific code-graph changes — and inversely, to surface "what kind of feature request is your PR fulfilling?" from a diff.

#### Implications for detection

A monolithic "find FEATURE per entry point" enricher (Phase 2 in §4.3 original draft) misses sub-features. The pipeline (revised in §4.3) decomposes detection into:
- **L0 ENTRY_POINT** — shipped (cli:command, mcp:tool, vscode:command)
- **L1 CONTRACT** — extract params/returns/errors per entry; surface as sub-FEATUREs or as feature attributes (open design choice — see §4.3)
- **L2 FEATURE_FLAG** — Phase 8 of §4.3
- **L3 BEHAVIOR** — forward slice, dedup-keyed (Phase 2 in §4.3)

Documentation generation requires L0 + L1. Dedup detection requires L3 (same Behavior under multiple Features = related access modalities). Cognitive-load metrics (C1–C6) operate on L3 Behaviors.

## Part 3: Product–Code Rosetta Stone

### 3.1 Vocabulary Mapping

Bidirectional dictionary between product/business language and graph/code language.

#### Core Entities

| Product term | Graph concept | Formal definition | How to compute |
|-------------|--------------|-------------------|----------------|
| **Feature** | Execution subgraph from entry point | §2.2 | `trace_dataflow(entry, forward)` |
| **Component** | Structural cluster of coupled modules | Community in feature-similarity graph | Auto-discovered, §2.4 step 3 |
| **Capability** | Business value area (group of features) | Human-labeled during interview | User maps COMPONENTs to business areas |
| **Domain** | Bounded context with team ownership | Human-labeled + org data | User assigns ownership + vocabulary |
| **Product** | External offering, consists of capabilities | Human-labeled | User defines product→capability mapping |
| **Deployment unit** | Separately deployed process | Infra config or user-labeled | Container/pod/lambda boundary |
| **API endpoint** | Entry point with HTTP route metadata | Node with `route` in metadata | `find_nodes(metadata.route)` |
| **User journey** | Ordered sequence of features | Chain: Feature₁.exit → Feature₂.entry | Cross-feature entry/exit linking |
| **Business rule** | Guard predicate on execution path | CFG branch with domain predicate | `find_guards(name="validate*")` |
| **Integration point** | Node with external IO effect | Function with IO effect to external service | Effects taxonomy: IO + external |

#### Quality & Debt

| Product term | Graph concept | Formal definition | How to compute |
|-------------|--------------|-------------------|----------------|
| **Technical debt** | Traditional code metrics | Cyclomatic complexity, duplication, smell count | Existing tools (ESLint, SonarQube) |
| **Cognitive debt** | Graph complexity metrics | §1.3: C1–C6 components | Graph traversal + statistics |
| **Intent debt** | KB coverage gap | §1.5: functions without DECISION nodes | KB query + function count |
| **Blast radius** | Transitive callers of changed node | `|transitive_callers(node)|` | `find_calls` recursive |
| **Dead feature** | Entry point with no external callers | Feature whose entry point is unreachable | Reachability from known external sources |
| **Feature coupling** | Subgraph overlap between features | Jaccard similarity of subgraph nodes | §2.4 step 3 |
| **Feature sprawl** | Feature across too many core files | `ScatteredResp(feature)` — excludes library files | §1.3 C3 |
| **God module** | Coupled, effectful file serving many features | `TangledResp(file)` — pure utility files score 0 | §1.3 C4 |

#### Architecture

| Product term | Graph concept | Formal definition | How to compute |
|-------------|--------------|-------------------|----------------|
| **Microservice boundary** | DEPLOYMENT_UNIT containing 1+ COMPONENTs | Process/container boundary | Infra config or interview |
| **Shared library** | Module used by 3+ COMPONENTs | Module with callers in 3+ clusters | Cross-cluster caller analysis |
| **Data pipeline** | Linear chain of transforms | Sequence: read → transform → transform → write | DFG pattern matching |
| **Event bus** | High-fan-out emitter node | Node with 5+ event listeners | Event edge analysis |
| **Feature flag** | Guard node with config-based predicate | Branch whose condition reads from config/flags | CFG + config access analysis |

### 3.2 Abstraction Levels in the Vocabulary

The same reality described at different levels of the stack:

```
L5 (Cognitive):     "Developer can't understand the checkout flow"
                     ↕ measures as
L4 (Product):       "Feature 'checkout' has ScatteredResp = 14 files"
                     ↕ computes from  
L3 (Graph):         |files(execution_subgraph(checkout_handler))| = 14
                     ↕ traverses
L2 (Semantic):      trace_dataflow(checkout_handler, forward).touched_files
                     ↕ built from
L1 (AST):           CallExpression, MemberExpression, ImportDeclaration
                     ↕ parsed from
L0 (Source):        app.post('/checkout', async (req, res) => { ... })
```

Each level is a **functor** (category theory) — a structure-preserving map from one domain to another. The chain is composable: L0→L1→L2→L3→L4→L5 can be automated end-to-end.

### 3.3 Query Templates (Product Questions → Graph Queries)

For each product-level question, the exact graph query:

**"What features does our product have?"**
```
→ DiscoverFeatures(graph)
→ Output: list of (entry_point, route/command, effect_count, file_count)
```

**"How complex is feature X?"**
```
→ CogLoadScore(feature_X.subgraph)
→ Output: composite score + component breakdown
```

**"What's the blast radius of changing function Y?"**
```
→ find_calls(name="Y", recursive=true)
→ For each caller: which feature does it belong to?
→ Output: affected features + their entry points
```

**"Where is cognitive debt concentrated?"**
```
→ For each module: compute CogLoadScore
→ Sort descending, show top 10
→ Output: ranked list with component breakdown
```

**"Which features are most coupled?"**
```
→ For each feature pair: jaccard(subgraph₁, subgraph₂)
→ Output: feature pairs ranked by coupling score
```

**"What knowledge is missing?"**
```
→ IntentDebt(project)
→ Modules without guarantees
→ Functions without DECISION coverage
→ Output: knowledge gaps ranked by traffic/criticality
```

### 3.4 Feature Request → Graph Operation

Where §3.3 maps product *questions* to graph *queries* (read), this section maps product *requests* to graph *deltas* (write). The dual is essential for AI agents that translate user asks into specific code-graph changes — and inversely, surface "what kind of feature request is this PR fulfilling?" from a diff.

| Product feature request | Graph delta | Touches dimension (§2.8) |
|-------------------------|-------------|---------------------------|
| "Add a new MCP tool `foo`" | new ENTRY_POINT node + new FEATURE + new CONTRACT + new BEHAVIOR | Entry-point modality |
| "Add markdown output to the existing tool" | extend existing CONTRACT.outputs with new content-type | Outputs |
| "Add a `--depth` parameter" | new PARAMETER on entry function + extend CONTRACT.inputs | Inputs |
| "Add a programmatic API alongside the CLI" | new FEATURE (different modality) + IMPLEMENTED_BY → existing BEHAVIOR + SHARES_BEHAVIOR_WITH ↔ CLI feature | Entry-point modality (same behavior) |
| "Trigger the dump on a schedule" | new ENTRY_POINT (cron) + new FEATURE + IMPLEMENTED_BY → existing BEHAVIOR | Entry-point modality (scheduled) |
| "Gate the new fast path under a flag" | new FEATURE_FLAG node + second BEHAVIOR + TOGGLES → existing FEATURE | Flag-gated paths |
| "Run 1% of traffic on the new code path" | as above, plus rollout-percent metadata on FEATURE_FLAG | Flag-gated paths |
| "Deprecate the legacy access modality" | mark FEATURE.lifecycle = deprecated (no graph deletion) | Lifecycle |
| "Remove the legacy access modality" | delete FEATURE node and EXPOSED_AS edge; BEHAVIOR is retained if any other FEATURE still references it | Lifecycle |
| "Rename the tool from `foo` to `find_foo`" | update FEATURE.name; all EXPOSED_AS / IMPLEMENTED_BY edges preserved | Identity |
| "Add a new error type" | extend CONTRACT.errors | Errors |
| "Group `find_*` tools under one section in docs" | new CAPABILITY node + PROVIDES → existing FEATUREs (interview-driven) | Capability grouping |

**Inverse direction: PR diff → request taxonomy.** Given a graph-delta from analyzing a PR, this table classifies what the PR *is*:
- New ENTRY_POINT + FEATURE + CONTRACT + BEHAVIOR → **new top-level feature**
- New BEHAVIOR + FEATURE_FLAG, no new FEATURE → **flag-gated rollout** (potential A/B or kill-switch)
- New FEATURE pointing to existing BEHAVIOR → **new access modality** (HTTP/CLI/programmatic alias)
- Extend CONTRACT only → **contract evolution** (output format, parameter, error type)
- BEHAVIOR change without CONTRACT change → **internal refactor** (not a feature request)

This dual mapping (request→delta, delta→request) is the foundation for `grafema review` — automated PR analysis that explains the change in product terms.

## Part 4: Graph Enrichment Strategy — Abstract Nodes

### 4.1 Entity Taxonomy — Separating Projections

The current document conflated "SERVICE" to mean four different things. The correct model separates auto-discovered (graph-only) entities from human-labeled (interview) entities, and places each in its proper projection.

#### Auto-discovered entities (graph-only, no human input needed)

| Node type | Projection | What it IS | Derived from | How |
|-----------|-----------|-----------|-------------|-----|
| **FEATURE** | Intentional | Named, externally-addressable variant of behavior (entry + name + contract) | Entry points + naming | §2.4 + L0 entry-point detection |
| **CONTRACT** | Intentional | Inputs / outputs / errors of a feature | PARAMETER, RETURNS, THROWS edges + type annotations | L1 enricher (Phase 2 in §4.3) |
| **BEHAVIOR** | Semantic | Execution subgraph implementing one or more features | Forward slice from entry point | L3 enricher (Phase 3 in §4.3) |
| **COMPONENT** | Semantic | Structural cluster of tightly-coupled modules | Community detection on behavior subgraph overlap | Jaccard similarity clustering |
| **CROSS_CUTTING** | Semantic | Code shared across many features | High in-degree from multiple behavior subgraphs | Caller analysis with relative threshold |
| **FEATURE_FLAG** | Operational | Config-conditional guard with two execution paths | CFG branches reading config/env values | Symbolic execution on partial ENUMs (L2) |
| **BUSINESS_RULE** | Intentional | Named guard predicate constraining execution | Guard detection + naming analysis | `validate*`, `check*`, `assert*` patterns |
| **DATA_PIPELINE** | Semantic | Linear chain of data transforms | DFG pattern matching | read → transform → ... → write pattern |

**FEATURE / BEHAVIOR / CONTRACT separation** (introduced in §2.2, §2.8): a FEATURE is the *named product unit* a user can request; a BEHAVIOR is the *implementation region* (subgraph); a CONTRACT is the *interface specification* (inputs/outputs/errors). The cardinality is many-to-one-to-one in the typical case but supports:
- 1 BEHAVIOR ← N FEATUREs (same behavior wrapped by HTTP / CLI / programmatic / scheduled access modalities)
- 1 FEATURE → N BEHAVIORs (gated by FEATURE_FLAG — kill switch, A/B, gradual rollout)
- 1 FEATURE → 1 CONTRACT (a feature has one effective contract per active code path; flagged behaviors may extend or restrict it)

**COMPONENT** is the neutral structural term for "cluster of modules with high internal coupling." It carries no business, runtime, or organizational semantics — it's a fact about code structure. Community detection discovers it; the interview assigns meaning.

#### Human-labeled entities (from interview, §6)

| Node type | Projection | What it IS | Source | Example |
|-----------|-----------|-----------|--------|---------|
| **CAPABILITY** | Intentional | Coherent business value area — group of related features | User labels during interview: "What value does this deliver?" | "Payment Processing" (includes: charge, refund, dispute features) |
| **PRODUCT** | Intentional | External offering with P&L, consists of capabilities | User labels: "What product does this belong to?" | "Enterprise Plan" (includes: SSO, RBAC, audit capabilities) |
| **DOMAIN** | Intentional + Organizational | Bounded context with its own model and vocabulary, owned by a team | User labels: "Who owns this? What do you call it?" | "Payments domain, owned by Fintech team" |
| **DEPLOYMENT_UNIT** | Operational | Separately deployed process/container | User labels or infra config: "How is this deployed?" | k8s pod, Lambda, monolith process |

#### Why the separation matters

The mappings between auto-discovered and human-labeled entities are **many-to-many** and reveal important architectural properties:

```
Healthy (Conway's law holds):
  1 COMPONENT ≈ 1 CAPABILITY ≈ 1 DOMAIN ≈ 1 DEPLOYMENT_UNIT
  → Clean boundaries, aligned team/code/deployment

Common reality:
  1 DEPLOYMENT_UNIT contains 3 COMPONENTs            → monolith
  1 CAPABILITY spans 2 DEPLOYMENT_UNITs               → distributed feature
  1 COMPONENT participates in 2 CAPABILITYs           → tangled code (bad sign)
  1 DOMAIN covers 2 CAPABILITYs                       → broad team scope
  2 DOMAINs share 1 COMPONENT                         → coupling across team boundaries (risk)
```

Each mismatch is a specific architectural signal:
- COMPONENT in 2+ CAPABILITYs → **code tangling** (TangledResp metric, C4)
- CAPABILITY across 2+ DEPLOYMENT_UNITs → **distributed complexity** (IndirectionDepth, C5)
- COMPONENT shared by 2+ DOMAINs → **cross-team coupling risk** (HiddenDepLoad, C1)
- DEPLOYMENT_UNIT with 1 COMPONENT → **right-sized service** (healthy)

### 4.2 New Edge Types

| Edge type | From → To | Meaning |
|-----------|----------|---------|
| **IMPLEMENTED_BY** | FEATURE → BEHAVIOR | This feature is realised by this implementation region (one feature can point to multiple behaviors when flag-gated) |
| **HAS_CONTRACT** | FEATURE → CONTRACT | This feature exposes this input/output/error specification |
| **EXPOSED_AS** | FEATURE → cli:command \| mcp:tool \| http:route \| ... | The access-modality node for this feature (one feature, one modality) |
| **PRODUCES_EFFECT** | BEHAVIOR → EFFECT_NODE | This behavior has this side effect |
| **COMPRISES** | BEHAVIOR → FUNCTION/MODULE | This behavior includes this code node in its subgraph |
| **GROUPS** | COMPONENT → FEATURE | This structural cluster contains this feature |
| **PROVIDES** | CAPABILITY → FEATURE | This capability is delivered through this feature |
| **PART_OF** | CAPABILITY → PRODUCT | This capability belongs to this product |
| **OWNS** | DOMAIN → COMPONENT | This bounded context contains this code cluster |
| **DEPLOYED_IN** | COMPONENT → DEPLOYMENT_UNIT | This code runs in this deployment |
| **GUARDS** | BUSINESS_RULE → FEATURE | This rule constrains this feature |
| **TOGGLES** | FEATURE_FLAG → FEATURE | This flag enables/disables this feature |
| **SHARES_BEHAVIOR_WITH** | FEATURE → FEATURE | Two features point to the same BEHAVIOR (different access modalities for one logical action — e.g. HTTP + CLI + programmatic API) |
| **STRUCTURALLY_COUPLED** | COMPONENT → COMPONENT | These clusters share significant code |

### 4.3 Implementation as Enrichment Pipeline

Following the existing Grafema pattern: **enricher that adds data + Datalog rules that query it**.

The pipeline is organised into **detection layers** (L0–L3) corresponding to the granularity dimensions in §2.8. Each layer is a separate phase and can ship independently:

```
Phase 1 — L0: Entry Point Detection (enricher) [SHIPPED for commander, MCP SDK, vscode]
  - Read effects-db YAML for ENTRY_POINT_CALLBACK role annotations
  - For each library method matching the index, create FEATURE + EXPOSED_AS edges
    to the modality node (cli:command, mcp:tool, vscode:command, http:route, ...)
  - Adding a framework = editing a YAML file (no per-library code)
  - Reference implementation: packages/util/src/enrichers/libraryCallbackEnricher.ts
                              packages/util/src/enrichers/mcpToolDefinitionEnricher.ts

Phase 2 — L1: Contract Extraction (enricher)
  - For each FEATURE's entry-point function, collect:
    * Inputs:  PARAMETER nodes + JSDoc/type annotations + Zod/JSON schemas
    * Outputs: RETURNS edge target type(s) + response-builder PASSES_ARGUMENT chains
    * Errors:  THROWS edges + caught exception types in the entry's scope
  - Create CONTRACT node, FEATURE -HAS_CONTRACT-> CONTRACT
  - Sub-features (per §2.8): each input parameter, output content-type, and error
    type can optionally be promoted to its own FEATURE under the parent (composition)
  - Output: enough metadata to auto-generate documentation pages

Phase 3 — L3: Behavior Subgraph Extraction (enricher)
  - For each entry point: trace_dataflow(forward, max_depth=15)
  - Collect the execution subgraph and effect set
  - Create BEHAVIOR node, FEATURE -IMPLEMENTED_BY-> BEHAVIOR,
    BEHAVIOR -COMPRISES-> {FUNCTION, MODULE, ...}
  - When two FEATUREs trace to the same (or near-identical) subgraph, link them
    via SHARES_BEHAVIOR_WITH — this is the dedup signal: same logical action
    exposed via multiple access modalities (HTTP + CLI + programmatic API)

Phase 4 — Behavior Identity & Dedup (enricher)
  - Behavior identity = stable hash of {entry-anchored function set, effect set}
  - Behaviors with Jaccard similarity ≥ threshold (e.g. 0.85) merge into one BEHAVIOR
  - Surfaces:
    * "different features, same behavior" → access-modality variants (often intentional)
    * "different features, similar behavior" → potential consolidation target
    * "same feature, very different behaviors" → flag-gated divergence (links to Phase 8)

Phase 5: Component Clustering (enricher — graph-only)
  - Compute pairwise Jaccard similarity of BEHAVIOR subgraphs (use core nodes only,
    exclude library-shaped utility files per §2.5)
  - Community detection → COMPONENT nodes
  - Auto-label from route prefixes / directory paths
  - COMPONENT -GROUPS-> FEATURE edges

Phase 6: LLM-Assisted Naming + Refinement (optional, interactive)
  - LLM receives: component contents (entry points, routes, effects, key function names)
  - LLM proposes: component names, feature names, potential capability groupings
  - LLM identifies: ambiguous clusters that may need splitting/merging
  - Output: named components + confidence scores + questions for user

Phase 7: User Interview (optional, interactive — see §6)
  - Present discovered COMPONENTs + FEATUREs to user for validation
  - Map structural COMPONENTs to semantic entities:
    * CAPABILITY: "What business value does this cluster deliver?"
    * DOMAIN: "Who owns this? What's your internal name for it?"
    * PRODUCT: "Which product/offering does this belong to?"
    * DEPLOYMENT_UNIT: "How is this deployed?"
  - Extract organizational knowledge:
    * Ownership: "Who maintains payments?"
    * Intent: "Why is checkout split across 3 packages?"
    * Domain vocabulary: "What do you call this internally?"
  - All answers flow into Knowledge Base:
    * CAPABILITY / PRODUCT / DOMAIN / DEPLOYMENT_UNIT nodes
    * DECISION nodes with rationale
    * OWNERSHIP edges (team → component)
    * Cross-entity mappings (which mismatches signal risk)

Phase 8: Cross-Cutting Detection (enricher)
  - Functions participating in 5+ BEHAVIORs → CROSS_CUTTING tag
  - Functions with 10+ callers from different services → SHARED_SERVICE

Phase 9: Metrics Computation (enricher)
  - Per module: C1–C6 cognitive load components
  - Per feature: span, depth, effect_count (computed over BEHAVIOR.subgraph)
  - Store as METRIC nodes (existing infrastructure)

Phase 10 — L2: FEATURE_FLAG Detection (enricher)
  - Guards with config/environment reads → FEATURE_FLAG candidates
  - Symbolic execution on partial ENUMs → branch activation conditions
  - Connect FEATURE_FLAG -TOGGLES-> FEATURE
  - When a flag selects between two BEHAVIORs of one FEATURE, both BEHAVIORs are
    retained and linked: FEATURE -IMPLEMENTED_BY-> BEHAVIOR_A (gated by FLAG=on),
    FEATURE -IMPLEMENTED_BY-> BEHAVIOR_B (gated by FLAG=off)
```

**Key architectural decision:** Phases 1–5, 8–10 are fully automated (enrichers). Phases 6–7 are optional and interactive — they improve quality but aren't required. `grafema insights` works without them; `grafema onboard` triggers the full flow including interview.

**Detection-layer mapping to product use cases:**

| Use case | Required layers |
|----------|-----------------|
| "What features does Grafema have?" — feature inventory | L0 (Phase 1) |
| Auto-generated documentation (params, returns, errors) | L0 + L1 (Phases 1, 2) |
| Dedup: same behavior under multiple access modalities | L0 + L3 + Phase 4 |
| Dead-feature detection (entry point with no callers) | L0 + reachability analysis |
| Name-vs-behavior validation (`get*` with MUTATION effects) | L0 + L3 + Phase 9 (C6) |
| Cognitive-load metrics per feature | L0 + L3 + Phase 9 (C1–C6) |
| Flag-gated divergence audit | L0 + L3 + L2 (Phases 1, 3, 10) |
| Component clustering / Conway's-law analysis | L0 + L3 + Phases 5, 7 |

### 4.4 Relationship to 12 Projections

This enrichment pipeline **derives** fragments of higher projections from the Semantic projection:

| Enrichment step | Projection unlocked | What becomes queryable |
|----------------|--------------------|-----------------------|
| Entry point detection | Operational (partial) | "What are the API endpoints?" |
| Feature extraction | Intentional (5.2) | "What features exist? What code implements each?" |
| Component clustering | Semantic (structure) | "What are the structural boundaries in the code?" |
| Cognitive load metrics | Epistemic (8.5) | "Where is comprehension burden highest?" |
| Feature flags | Operational (Config State) | "What behavior changes without code changes?" |
| Business rules | Intentional (5.1) | "What rules constrain the system?" |
| Interview: capabilities | Intentional (5.2, 5.4) | "What business value does each component deliver?" |
| Interview: domains | Intentional + Organizational | "Who owns what, and what's the bounded context?" |
| Interview: products | Intentional (5.4) | "Which offering includes which capabilities?" |
| Interview: deployments | Operational (Topology) | "What runs where?" |

**Critical insight:** We don't need external data sources to start on projections 2–12. The Semantic projection alone, properly enriched, yields fragments of Intentional, Operational, Epistemic, and Risk projections. External sources (Linear, Datadog, PagerDuty) enrich these further, but the **bootstrap is code-only**.

### 4.5 Incremental Rollout

Versions are anchored to *which detection layer ships*, not "which abstraction levels exist":

```
v0.2: L0 ENTRY_POINT enrichment + METRIC scoring   [SHIPPED 2026-04]
      → cli:command, mcp:tool, vscode:command nodes detected via effects-db
      → libraryCallbackEnricher + mcpToolDefinitionEnricher in pipeline
      → grafema insights — text report on cognitive load + entry-point inventory

v0.3: L1 CONTRACT extraction + L3 BEHAVIOR + dedup linking
      → CONTRACT nodes (params/returns/errors) → enables auto-doc generation
      → BEHAVIOR nodes + SHARES_BEHAVIOR_WITH edges → enables dedup detection
      → grafema map — feature/behavior visual map (one node per feature, edges
        to shared behaviors and via TOGGLES to flags)
      → grafema insights enhanced with feature-level metrics
      → grafema onboard — LLM interview for COMPONENT validation + KB population

v0.5: L2 FEATURE_FLAG + BUSINESS_RULE + DOMAIN enrichment
      → grafema insights with full product-level vocabulary
      → Flag-gated divergence audit
      → Integration with external sources (Linear → features, Datadog → runtime)
      → Multi-role interview (tech lead / PM / SRE / new dev)
      → Coding agent that writes custom enrichment plugins based on interview
```

## Part 5: `grafema insights` — The Onboarding Product

### 5.1 Zero-Config Output

After `grafema analyze`, the user can immediately run `grafema insights`:

```
$ grafema insights

╭─ Project Health Report ──────────────────────────────────╮
│                                                          │
│  📊 Architecture Overview                                │
│  ─────────────────────                                   │
│  4 components detected: auth/, payments/, notify/, admin/│
│  17 features across 4 components                         │
│  3 cross-cutting concerns: auth-middleware, logging,     │
│                             error-handler                │
│  Component coupling: auth↔payments = 0.34 (review)      │
│                                                          │
│  🧠 Cognitive Load Potential: 6.2/10                      │
│  ─────────────────────────────                            │
│  Hidden deps:    23 cross-module implicit calls           │
│  Indirection:    p90 4.7 hops (entry → effect)           │
│  Scattered:      checkout spans 14 core files / 3 pkgs   │
│  Tangled:        UserService: 12 features × high coupling│
│  Naming:         3 get* functions with mutation effects   │
│                                                          │
│  ⚠️  Cognitive Debt Risk: HIGH for checkout, auth modules │
│  (high load potential + low bus factor from git history)  │
│                                                          │
│  📝 Intent Debt: 66% uncovered                           │
│  ─────────────────────────                                │
│  Functions with rationale:  174 / 512 (34% covered)      │
│  Guarantees defined:        3                            │
│  Guarantees recommended:    12 (patterns detected)       │
│  AI context risk:           high (agents will struggle    │
│                             without intent artifacts)    │
│                                                          │
│  ⚠️  Top Issues                                          │
│  ─────────────────────                                   │
│  1. UserService: god module (47 methods, 12 features)    │
│  2. Checkout: scattered (14 files, depth 8)              │
│  3. PaymentGateway: hidden deps (5 implicit callbacks)   │
│  4. Dead exports: 23 functions exported, never imported  │
│  5. Circular dep: payments → invoicing → payments        │
│                                                          │
│  Run `grafema insights --detail` for full breakdown.     │
│  Run `grafema map` for interactive feature map.          │
╰──────────────────────────────────────────────────────────╯
```

### 5.2 Competitive Differentiation

| Tool | What it measures | Triple debt coverage | Feature-level? |
|------|-----------------|---------------------|----------------|
| **SonarQube** | Code smells, bugs, duplications | Technical only | No |
| **CodeClimate** | Complexity, duplication, test coverage | Technical + partial cognitive load | No |
| **CodeQL** | Security vulnerabilities | Technical (security subset) | No |
| **Semgrep** | Pattern matching rules | Technical (custom rules) | No |
| **Grafema** | **Graph metrics + intent coverage + feature discovery** | **All three: load potential (C1–C6), intent (KB coverage), cognitive debt risk (+ git/org signals)** | **Yes** |

**Unique selling point — framed in Storey's terms:** "We don't just find bugs in the code layer. We measure the cognitive load your code places on developers, the intent debt accumulating in your project, and the risk of cognitive debt — where understanding is most likely to erode. We show this at the feature level, not just file level."

**Storey alignment:** Grafema is an **intent artifact** itself — it externalizes structural understanding. Using Grafema to explore code is a practice that reduces cognitive debt (making implicit knowledge explicit) rather than increasing it (unlike AI-generated documentation that creates "the appearance of understanding without the real thing").

## Part 6: `grafema onboard` — Interview-Driven Knowledge Extraction

### 6.1 The Insight: Onboarding IS Knowledge Extraction

The onboarding problem ("what does this project do?") and the knowledge extraction problem ("capture team knowledge into KB") are the **same problem from opposite directions**:

- Onboarding: user needs to understand → ask questions about the code
- Knowledge extraction: system needs knowledge → ask questions to the user

**Combined flow:** Grafema auto-discovers structure (features, services, clusters), presents findings to the user, asks validation questions, and uses the answers to populate the Knowledge Base. The user gets understanding; Grafema gets knowledge. Both debts (cognitive and intent) are reduced simultaneously.

### 6.2 Analysis-First Elicitation — Theoretical Foundation

The onboarding interview uses a pattern with strong support across multiple research traditions: **present the system's analysis first, then ask for validation** — rather than asking users to describe from scratch.

#### The pattern and its names

This pattern has no single established name but is well-described in at least five traditions:

| Tradition | Term | Key reference | Core finding |
|-----------|------|--------------|-------------|
| Knowledge Engineering | **Backward/validational elicitation** | Shadbolt & Burton (1995); Cooke (1994) | Experts critique 2–4x faster than they generate. Validational elicitation is also more complete — experts notice omissions they wouldn't have recalled unprompted. |
| Machine Learning | **Active learning / uncertainty sampling** | Settles (2012) | System selects most informative queries → 50–90% fewer questions needed vs. random. Our pattern: ask where graph analysis is ambiguous ("one service or two?"). |
| HCI | **Mixed-initiative interaction** | Horvitz (1999, CHI) | System takes initiative (analysis), yields to user (validation). 12 design principles, including "resolve key uncertainties through dialog." |
| Cognitive Psychology | **Informed anchoring** | Tversky & Kahneman (1974); Epley & Gilovich (2006) | Correction from an anchor is cognitively easier than generation from scratch. When the anchor is informed (based on real analysis), facilitation effect is stronger. |
| Communication Theory | **Proactive grounding** | Clark & Brennan (1991) | Efficient communication requires common ground. Demonstrating understanding first → user only needs to correct mismatches, not build shared model from zero. |

Additionally, Pirolli & Card (2005, Sensemaking) describe our pattern as **top-down sensemaking**: instead of the user building a model bottom-up (forage → schema → hypothesis), we present a candidate schema directly and the user corrects it top-down. This short-circuits the sensemaking loop.

#### Quantitative evidence

| Source | Measure | Finding |
|--------|---------|---------|
| Cooke (1994), Intl J Human-Computer Studies | Elicitation speed + completeness | Validational 2–4x faster, fewer omissions |
| Settles (2012), Morgan & Claypool | Queries to oracle | Active learning needs 50–90% fewer queries vs. random |
| Fails & Olsen (2003), IUI | Task speed + quality | Correcting system output 2–3x faster than specifying from scratch |
| Lim & Dey (2009), CHI | Trust + willingness to act | Systems that explain reasoning: large effect (d > 0.8) on trust |
| Amershi et al. (2014), AI Magazine | Engagement + feedback quality | Users correcting candidate models engage longer, provide higher-quality feedback |
| Product analytics (Amplitude, Mixpanel) | Onboarding drop-off | 40–60% drop-off per question BEFORE value shown. Show-first: 2–3x activation |

#### Industry precedents

Systems already using this pattern:

- **GitHub Copilot Workspace** — analyzes issue, proposes plan with specific files and changes, asks developer to validate before generating code
- **Sourcegraph Cody** — indexes codebase, demonstrates structural understanding in conversation before asking clarifying questions
- **Tableau Ask Data / Power BI Insights** — auto-generates insights (anomalies, trends), presents as cards for user to validate or drill into
- **Protege + Text2Onto** (Cimiano & Volker, 2005) — extracts candidate ontology from text, expert corrects rather than builds from scratch
- **Stripe onboarding** — analyzes developer's initial API calls, suggests integration approach (deliberate design choice per Patrick Collison)
- **Isabel Healthcare** (Graber & Mathew, 2008) — proposes differential diagnoses for clinician validation

#### Why this works for Grafema specifically

Two types of onboarding questions:

| Type | Example | User reaction | Drop-off risk |
|------|---------|--------------|---------------|
| **Forward** (cold start) | "Describe your project structure" | "Why should I? You're the tool." | HIGH |
| **Validational** (analysis-first) | "Checkout traverses 14 files across 3 packages. Cart and Orders share 23 functions. Are these one service or two?" | "Wait, you already know that? ...Actually, good question." | LOW |

The validational question simultaneously:
1. **Demonstrates competence** — exact numbers (14 files, 23 functions) prove the analysis is real
2. **Delivers value** — "I didn't realize checkout touches 14 files" is insight before the user even answers
3. **Builds trust** — the question targets a real architectural tension, showing domain awareness
4. **Reduces cognitive load** — user corrects rather than generates (anchoring effect)
5. **Collects knowledge** — answer flows into KB as DECISION/OWNERSHIP/DOMAIN entity

**Risk: anchoring bias.** Tversky & Kahneman's anchoring effect means users may under-correct wrong analyses. This connects directly to Shaw & Nave's (2026) cognitive surrender — accepting system output without critical engagement. Mitigation: for naming questions, ask open-ended first ("What do you call this area?"), show system suggestion only if user says "I don't know" (see Open Question 9).

#### Design principles (derived from literature)

1. **Lead with finding, follow with question** (validational elicitation). "I found X. Does that match?" — not "Tell me about X."
2. **Quantify** (grounding + credibility). "23 shared functions" is credible. "Some functions" is not.
3. **Ask where uncertain** (active learning / uncertainty sampling). Don't ask about things the analysis is confident about. Ask where it's ambiguous.
4. **Surface surprises** (sensemaking). The most engaging questions reveal something the user didn't know about their own code.
5. **Show value before asking** (progressive disclosure). Auto-discovered architecture is value. Interview is optional enrichment on top.
6. **Keep it short** (drop-off research). 5–7 questions max per session. User can `--continue` later.
7. **Make answers optional** (mixed-initiative). "I don't know" and "skip" are valid. The graph stands on its own.

### 6.3 Interview Flow

```
$ grafema onboard

Step 1: Auto-Discovery (silent, seconds)
  → grafema analyze + enrichment phases 1-3
  → Auto-discovered: 17 features, 4 service clusters, 3 cross-cutting

Step 2: LLM Proposes Structure (seconds)
  LLM receives cluster data, proposes:
  
  "I found 4 code components (structural clusters) in your codebase:
   
   Component A (7 features): routes /api/auth/*, /api/users/*
     → Auto-label: 'auth-users' (from route prefix)
   
   Component B (5 features): routes /api/orders/*, /api/cart/*
     → Auto-label: 'orders-cart' (from route prefix)
   
   Component C (3 features): routes /api/notify/*, event handlers for email/sms
     → Auto-label: 'notifications' (from route prefix)
   
   Component D (2 features): routes /api/admin/*
     → Auto-label: 'admin' (from route prefix)
   
   Cross-cutting: authMiddleware (used by 15/17 features),
                  errorHandler, requestLogger"

Step 3: User Maps Structure to Meaning (interactive)

  Q: "What capability does component 'orders-cart' deliver?
      What do you call this area internally?"
  A: "We call it 'Commerce'. Cart and Orders are separate teams."
  → KB: CAPABILITY 'Commerce' -PROVIDES-> features in Component B
  → KB: DOMAIN 'Cart' (Team: Frontend Commerce) -OWNS-> cart/ modules
  → KB: DOMAIN 'Orders' (Team: Backend Commerce) -OWNS-> orders/ modules
  → KB: DECISION "Cart and Orders split by team boundary" (Conway's law)
  → Signal: 1 COMPONENT spans 2 DOMAINs → cross-team coupling risk

  Q: "Who owns the Authentication service?"
  A: "Platform team. Alice is the tech lead, she's the only one
      who understands the OAuth flow."
  → KB: OWNERSHIP Platform → auth/
  → KB: RISK bus_factor=1 for OAuth flow (Alice)
  → KB: FACT "OAuth flow is complex, single expert" → flag for CogDebt

  Q: "I see checkout spans 14 files across 3 packages. Was this intentional?"
  A: "No, it grew organically. We've been meaning to refactor it."
  → KB: DECISION "checkout scatter is accidental, refactoring planned"
  → KB: TECHNICAL_DEBT checkout_scatter, priority=medium

  Q: "There's a feature flag pattern: if(config.newCheckoutFlow).
      What is this?"
  A: "A/B test we ran last quarter. The old path is dead code now."
  → KB: FEATURE_FLAG newCheckoutFlow, status=completed
  → ISSUE: dead_code in old checkout path

Step 4: Report + Knowledge Base Summary

  "Onboarding complete. Here's what I learned:
   
   📊 4 components → mapped to:
      2 capabilities (Commerce, Platform Services)
      3 domains (Cart, Orders, Platform) across 3 teams
      1 deployment unit (monolith — all components in one process)
   ⚠️  Architecture signals:
      Component 'orders-cart' spans 2 domains → cross-team coupling risk
      All components in 1 deployment unit → monolith
   👥 3 teams: Platform, Frontend Commerce, Backend Commerce
   ⚠️  1 bus factor risk: Alice / OAuth
   🧠 Cognitive Load hotspots: checkout (scattered), UserService (tangled)
   📝 5 decisions, 2 risks, 1 dead code flagged
   
   Knowledge Base populated with 23 new entries.
   Run `grafema insights` for full health report.
   Run `grafema check` to validate guarantees."
```

### 6.4 What the Interview Extracts (Mapping to Projections)

Each question type maps to a specific projection and KB entity:

| Question type | Example | Projection | KB entity |
|--------------|---------|-----------|-----------|
| **Naming validation** | "Is 'Order Processing' the right name?" | Intentional (5.3: ubiquitous_language) | DOMAIN vocabulary |
| **Ownership** | "Who maintains auth?" | Organizational (6.1: ownership) | TEAM → MODULE edges |
| **Bus factor** | "Only Alice knows OAuth" | Risk (12.3: exposure) | RISK single_point_of_failure |
| **Architecture rationale** | "Why is checkout split?" | Intentional (5.3: domain_model) | DECISION + rationale |
| **Team boundaries** | "Cart and Orders are separate teams" | Organizational (6.4: interaction) | Conway's law validation |
| **Feature flag status** | "That A/B test is done" | Operational (2.4: config_state) | FEATURE_FLAG lifecycle |
| **Dead code** | "Old path is unused" | Semantic + Risk | ISSUE dead_code |
| **Product mapping** | "This belongs to Enterprise tier" | Intentional (5.4: product) | PRODUCT → SERVICE edges |

### 6.5 LLM Role: Structured Interviewer, Not Generator

Critical distinction from Storey's warning about cognitive surrender:

The LLM here is NOT generating knowledge — it's **structuring questions** based on graph data and **recording answers** into the KB. The human provides the understanding; the LLM provides the interview structure. This is **cognitive offloading** (strategic tool use), not **cognitive surrender** (accepting AI output uncritically).

Specifically, the LLM:
- **Reads** graph structure (features, clusters, metrics, anomalies)
- **Identifies** ambiguities and gaps that need human input
- **Formulates** questions in natural language
- **Parses** answers into KB-structured entities (DECISION, FACT, OWNERSHIP, RISK)
- **Does NOT** invent rationale, guess ownership, or fabricate intent

### 6.6 Incremental Interview

The interview doesn't need to happen all at once. `grafema onboard` tracks what's been validated and what hasn't:

```
$ grafema onboard --status

Onboarding Progress:
  Services:     4/4 validated ✓
  Features:     12/17 validated (5 need naming)
  Ownership:    2/4 services assigned
  Bus factor:   1 risk identified, 0 mitigated
  Intent debt:  34% → 48% covered (14% added from interview)
  
  Next: run `grafema onboard --continue` to validate remaining features
```

Each conversation enriches the KB incrementally. Over time, `grafema onboard` converges to full coverage. New features detected by `grafema analyze` are flagged as "unvalidated" and queued for the next interview session.

### 6.7 Multi-User Interview

Different roles have different knowledge. The interview can target questions by role:

| Role | Questions they can answer | Projection |
|------|-------------------------|-----------|
| **Tech Lead** | Architecture decisions, ownership, tech debt rationale | Intentional, Organizational |
| **Product Manager** | Feature purpose, product mapping, business rules | Intentional (5.2, 5.4) |
| **SRE/DevOps** | Service topology, deployment, SLOs | Operational, Contractual |
| **Security** | Access policies, vulnerability context | Security |
| **New Developer** | "I don't understand X" → reveals cognitive debt | Epistemic (knowledge gaps) |

The new developer's confusion is itself signal — questions they can't answer reveal where cognitive debt is highest. Their onboarding experience is a **cognitive debt probe**.

## Part 7: Implementation — Claude Code as the Onboarding Agent

### 7.1 No New Assistant Needed

The original vision (§6) assumed a custom AI assistant for the interview. But the agent already exists: **Claude Code**.

Claude Code already has:
- LLM reasoning + conversation management
- Grafema MCP tools (find_nodes, trace_dataflow, describe, etc.)
- File writing (for plugins, configs, KB entries)
- Skill system (extensible, persistent)
- Project context (CLAUDE.md, memory, git history)
- User trust (already adopted, already in the workflow)

Building a separate assistant = months of work on UI, auth, conversation state, LLM integration. Extending the onboarding skill = days.

### 7.2 The Skill: `/onboard`

The existing onboarding skill in `.claude/skills/` gets extended with the analysis-first elicitation flow:

```
User types: /onboard

CC: *calls grafema analyze if not fresh*
CC: *calls get_stats, find_nodes, trace_dataflow*
CC: *discovers 17 features, 4 components, 3 cross-cutting*

CC: "I analyzed your codebase. Here's what I found:

     4 structural components:
     - auth/ (7 features, 12 modules)
     - orders-cart/ (5 features, 18 modules, coupling 0.67)
     - notifications/ (3 features, 4 modules)
     - admin/ (2 features, 6 modules)
     
     I have a few questions to understand your project better.
     Each answer helps me write better plugins and KB entries.
     Say 'skip' anytime.

     Q1: orders-cart/ has high internal coupling (Jaccard 0.67).
         Cart and Orders share 23 functions and 4 DB access patterns.
         Does your team treat this as one domain or two?"

User: "Two teams — Frontend Commerce (cart) and Backend Commerce (orders).
       But yeah, the coupling is a problem."

CC: *writes to KB*
CC: *writes to CLAUDE.md memory*
CC: *considers: high coupling + 2 teams = plugin opportunity*

CC: "Got it. I'll note that as a cross-team coupling risk.
     
     Q2: I see 34 calls to DataPipe.query() but don't know what DataPipe is.
         The calls contain SQL strings. Is this your ORM?"

User: "Yes, internal ORM wrapping PostgreSQL."

CC: *writes enricher plugin recognizing DataPipe patterns*
CC: *writes KB entry: FACT 'DataPipe = internal ORM'*

CC: "I wrote a plugin that traces DataPipe.query() calls to their
     SQL table references. Want me to re-analyze to see the new edges?
     
     Preview: 34 new READS_FROM edges to 8 tables.
     Example: OrderService.getOrders() → READS_FROM → table:orders"

User: "Yes, and also handle DataPipe.rawQuery()"

CC: *updates plugin*
CC: *re-runs grafema analyze*
CC: *queries graph for improved metrics*

CC: "Done. Re-analyzed with DataPipe plugin.
     Cognitive Load Potential for orders/ dropped from 7.1 to 5.3
     — the hidden DB dependencies are now visible.
     
     Q3: ..."
```

### 7.3 Four Outputs Per Answer

Every user answer can produce up to four artifacts. The core principle: **make implicit explicit**.

```
User answer
  ├─→ Knowledge    (KB / Memory)   — implicit understanding → explicit fact
  │     CLAUDE.md memory entry, KB FACT/DECISION node
  │
  ├─→ Capability   (Plugin / Config) — implicit pattern → explicit analyzer
  │     .grafema/plugins/*.ts enricher
  │     grafema.config.yaml updates
  │     effects-db custom entries
  │
  ├─→ Guarantee    (Datalog rule)    — implicit rule → explicit CI gate
  │     .grafema/guarantees.yaml
  │     Executable invariant: grafema check catches violations
  │
  └─→ Action       (Task / Issue)    — implicit problem → explicit task
        Linear issue for refactoring
        Structured prompt for coding agent
```

Not every answer produces all four. "We call it Commerce" → knowledge. "DataPipe is our ORM" → knowledge + capability. "Every POST handler should have auth" → knowledge + guarantee. "UserService is a mess" → knowledge + action. The agent checks all four on every answer.

Guarantees are the strongest form of "implicit → explicit": a rule in one person's head (implicit) becomes a Datalog rule in CI (explicit, executable, enforced). Examples:

| Interview finding | Guarantee rule |
|------------------|---------------|
| "All POST handlers have auth... except two" | `every POST handler MUST have auth middleware` |
| "DataPipe.query() should always be in try/catch" | `every DataPipe.query() MUST be wrapped in error handling` |
| "Payments and Orders must not access each other's DB" | `no cross-domain direct DB access` |
| "Service X writes to S3 but its IAM role lacks PutObject" | cross-projection permission check (Semantic × Operational × Security) |

### 7.4 The Flywheel

```
/onboard (session 1)
  → analyze → interview → write 3 plugins → populate KB
  → re-analyze (graph smarter now)
  
/onboard --continue (session 2, next week)
  → CC reads memory + KB from session 1
  → re-analyzes with plugins from session 1
  → deeper questions (now understands DataPipe, knows team structure)
  → writes 2 more plugins (custom event bus, validation decorators)
  → generates 3 refactoring tasks
  
/onboard --continue (session 3)
  → most structure validated, few new questions
  → focus shifts to intent debt: "Why is auth implemented twice?"
  → focus on guarantees: "Should every handler have auth middleware?"
  → writes guarantee rules for grafema check
  
Session 4+: no /onboard needed
  → CC already knows the project deeply
  → plugins handle project-specific patterns
  → KB has decisions, ownership, vocabulary
  → grafema insights gives accurate project health
  → regular tasks: "refactor checkout" informed by full context
```

Convergence: 3–4 sessions cover ~80% of project-specific patterns. After that, `/onboard --continue` returns "No new questions — your project is well-understood."

### 7.5 Dual Learning

The key insight: **both CC and the user learn simultaneously**.

```
What CC learns:                      What user learns:
─────────────                        ────────────────
DataPipe is an ORM                   Checkout spans 14 files
Cart ≠ Orders (different teams)      Cart↔Orders coupling = 0.67
@RequireRole is auth decorator       3 handlers missing auth
EventBridge is custom event bus      getUserById has 5 hidden effects
validators/ = business rules         Auth bus factor = 1 (Alice)
```

CC's learning persists in: CLAUDE.md memory, KB, plugins, grafema config, guarantees.
User's learning persists in: their brain (cognitive debt reduced), KB (intent debt reduced), guarantees (intent → executable).

This is **Storey's prescription implemented**: "make implicit knowledge explicit, not as an afterthought, but as part of the development process itself." The onboarding flow makes both the human's implicit knowledge (intent) and the code's implicit structure (graph) explicit simultaneously.

### 7.6 Why Claude Code Specifically

This wouldn't work with a generic chatbot because:

1. **File writing** — CC can write plugins, configs, KB entries directly. No "export to file" step.
2. **MCP tools** — CC calls Grafema MCP tools natively. No API wrapper needed.
3. **Project context** — CC already has CLAUDE.md, git history, existing code knowledge. Warm start.
4. **Memory** — CC's memory system persists across sessions. The flywheel works because session 2 remembers session 1.
5. **Skill system** — The onboarding flow is a skill, not a separate product. Upgradeable, customizable.
6. **Trust** — User already trusts CC with code changes. Writing a plugin is natural, not scary.
7. **Ecosystem** — CC can create Linear issues, commit code, open PRs. The action output flows into existing workflow.

## Part 8: Skill Prompt Design

### 8.1 Core Principle

```
Make implicit explicit.
```

Every action in the onboarding flow is an instance of this:

```
Implicit structure  → explicit graph         (analysis)
Implicit features   → explicit FEATURE nodes (discovery)
Implicit boundaries → explicit COMPONENTs   (clustering)
Implicit rules      → explicit guarantees    (codification)
Implicit rationale  → explicit KB decisions  (interview)
Implicit ownership  → explicit DOMAIN→OWNS  (interview)
Implicit patterns   → explicit plugins       (self-extension)
Implicit complexity → explicit CogLoadScore  (metrics)
```

This is Storey's prescription implemented: "the practices that most effectively reduce cognitive debt are those that make implicit knowledge explicit."

### 8.2 The Prompt

```markdown
# /onboard — Learn Your Project Together

## Core
Make implicit explicit. Every implicit structure, rule, pattern,
decision, or boundary in the codebase should become an explicit,
queryable, enforceable artifact.

## Principles
1. Don't ask what user wants. Show the most surprising findings
   first. User's reaction tells you where to go deeper.
2. Show graph findings before asking. Numbers = trust.
3. Each answer → check: knowledge? capability? guarantee? action?
4. Write findings to KB immediately. Session can die anytime.
5. Adapt: solo → debt. Team → ownership. Post-onboard → drift.
6. "Don't know" = task, not dead end.
7. Limitation? Workaround + report. Never block.
8. After every action: show what changed, quantified.
9. Ask before external actions (Linear, GitHub, push).

## Ideal end state
Read: _ai/onboarding/target-state.md

## Context detection
- get_stats → 0 nodes? Start with config.
- git log --format='%an' | sort -u | wc -l → 1? Solo mode.
- .grafema/onboarding-state.yaml exists? Continue / operational.
- User stated a pain point? Focus everything on it.
- Else: full team onboarding.

## Phases
Follow: _ai/onboarding/phases/
Start from first incomplete phase. Skip irrelevant phases
(e.g., ownership for solo dev).

## Four outputs per answer
1. Knowledge — KB entry, CLAUDE.md memory (implicit understanding → explicit fact)
2. Capability — plugin, config, effects-db (implicit pattern → explicit analyzer)
3. Guarantee — Datalog rule in guarantees.yaml (implicit rule → CI gate)
4. Action — Linear issue, refactoring task (implicit problem → explicit task)
Check all four. Not every answer produces all four.

## References
- Theoretical backing: _ai/research/cognitive-debt-and-feature-detection.md
- Analysis-first elicitation: §6.2 (Shadbolt, Settles, Horvitz, Clark & Brennan)
- Entity taxonomy: §4.1 (COMPONENT vs CAPABILITY vs DOMAIN vs DEPLOYMENT_UNIT)
- Cognitive load metrics: §1.6 (C1–C6)
```

### 8.3 Why This Prompt Is Minimal

- **30 lines.** Everything else lives in referenced docs.
- **Core principle won't age.** "Make implicit explicit" is the mission, not an implementation detail.
- **Principles are stable.** They derive from research (§6.2), not from current code.
- **Details are in docs.** When we update entity taxonomy or metrics, the prompt doesn't change.
- **Context detection is heuristic.** CC uses judgment, not rigid if/else.

## Part 9: Multi-User Interview and Contradictions (Enterprise)

### 7.1 The Problem: Fragmented Knowledge Across People

In a team of 10+ developers, each person holds a fragment of the system's "theory" (Naur 1985). Interviewing each person independently will produce **contradictions** — not because someone is wrong, but because their mental models diverged. This is cognitive debt made visible.

```
Alice (Tech Lead):   "Cart and Orders are one service — Commerce"
Bob (Backend Lead):  "Cart is Frontend team, Orders is Backend team — separate services"
Carol (PM):          "It's one product called 'Checkout', I don't care about service boundaries"
```

Three people, three incompatible models of the same code. Traditional documentation hides this — one person writes the doc, their model wins, contradictions are invisible. The interview process surfaces them.

### 7.2 Contradictions as Cognitive Debt Signal

A contradiction between two users is not a bug to be fixed — it's a **measurement** of cognitive debt at that specific system boundary. The Storey framework predicts exactly this: "cognitive debt accumulates when shared understanding erodes."

Each contradiction maps to a specific claim:

```
When Alice says "Commerce is one service" and Bob says "Cart and Orders are separate":
  → Cognitive debt exists at the Cart/Orders boundary
  → The team lacks shared mental model for this area
  → Changes here carry elevated risk of unexpected consequences
```

**Severity of contradictions varies:**

| Contradiction type | Severity | Example |
|-------------------|----------|---------|
| **Naming only** | Low | "We call it Commerce" vs "We call it Checkout" (same boundary, different label) |
| **Boundary disagreement** | Medium | "One service" vs "two services" (different models of the same code) |
| **Ownership conflict** | High | "Platform owns auth" vs "Each team owns their own auth middleware" |
| **Intent conflict** | Critical | "This feature is going away" vs "This is our core product" |

### 7.3 Provenance Chain (Enox Architecture)

This is where Enox's provenance model becomes load-bearing. Each assertion from an interview carries:

```
ASSERTION {
  claim:      "Cart and Orders are one service called Commerce"
  source:     { person: "Alice", role: "Tech Lead", date: "2026-04-04" }
  confidence: 0.8
  evidence:   "stated during onboarding interview"
  scope:      "architecture/service-boundaries"
}

ASSERTION {
  claim:      "Cart and Orders are separate services owned by different teams"
  source:     { person: "Bob", role: "Backend Lead", date: "2026-04-04" }
  confidence: 0.9
  relation:   CONTRADICTS assertion_above
  evidence:   "stated during onboarding interview"
  scope:      "architecture/service-boundaries"
}
```

The `CONTRADICTS` relation creates a **visible tension** in the knowledge graph. It's not resolved by picking a winner — it's resolved by either:
1. **Facilitated discussion** — Grafema provides graph data to ground the debate
2. **Authoritative decision** — someone with authority makes a call, recorded as DECISION with SUPERSEDES edges
3. **Acknowledged ambiguity** — the contradiction is real and intentional (different perspectives that coexist)

### 7.4 Graph-Grounded Resolution

When a contradiction is surfaced, Grafema can provide **objective data** from the graph to inform resolution:

```
Contradiction: "Cart and Orders — one service or two?"

Graph evidence:
  Coupling:         Cart↔Orders Jaccard = 0.67 (high overlap)
  Shared functions: 23 functions used by both
  Shared data:      4 database tables accessed by both
  CALL_REMOTE:      0 (no API calls between them — same process)
  Team boundaries:  git blame shows 60% Alice's team, 40% Bob's team
  
  → Graph data suggests high coupling, consistent with single-service model
  → But git history shows two distinct contributor groups
  → Possible resolution: technically one service, organizationally two teams
    (Conway's law tension)
```

The graph doesn't decide — it provides evidence. The decision is human, recorded as:

```
DECISION {
  claim:      "Cart and Orders are one bounded context 'Commerce',
               maintained by two sub-teams (Frontend Commerce, Backend Commerce)"
  decided_by: "Alice + Bob, facilitated by Grafema onboard"
  date:       "2026-04-05"
  rationale:  "High code coupling (Jaccard 0.67) makes separate-service
               model risky. Team split preserved for organizational clarity."
  supersedes: [Alice's assertion, Bob's assertion]
  evidence:   "graph coupling analysis"
}
```

### 7.5 Enterprise Feature Scoping

This multi-user interview with provenance and contradiction detection is clearly an **enterprise feature**. It clarifies what the enterprise Grafema tier needs and why:

| Feature | Why enterprise | Single-user workaround |
|---------|---------------|----------------------|
| Multi-user interview | Multiple team members with different models | Single user validates all clusters |
| Provenance chains | Track who said what, when, with what confidence | Implicit — one user, one source |
| Contradiction detection | Surface cognitive debt between team members | N/A — no contradictions possible |
| Graph-grounded resolution | Provide data for team discussions | User self-validates against graph |
| Role-based questions | Route questions to right expert | Single user answers all |
| Temporal provenance | Track how understanding evolves over time | Session history only |

**Business justification (Storey-aligned):** Cognitive debt is a **team-level** phenomenon. Single-user Grafema measures cognitive load potential (code property). Enterprise Grafema measures actual cognitive debt (team property) by surfacing where shared understanding has fragmented.

### 7.6 Connection to Enox Federation

The Enox federated knowledge protocol (see `project_enox.md` in memory) is designed for exactly this pattern:

- **Multiple sources** → multiple users, each contributing assertions
- **Provenance** → who said what, with what evidence
- **Contradiction handling** → `CONTRADICTS` relation with resolution workflow
- **Temporal evolution** → assertions have `age_days`, supersession chains
- **Confidence scoring** → assertions from domain experts weighted higher

The single-user `grafema onboard` is the **MVP** that validates the interview flow. Multi-user with Enox provenance is the **enterprise evolution** that turns it into a cognitive debt measurement instrument.

## Part 10: Benchmark Implications (Note)

SWE-bench measures cold-start performance (solve issue in unfamiliar repo). Grafema's value prop is warm-start: agent that has been onboarded, has plugins, KB, tribal knowledge. The right comparison is CC-after-onboarding vs CC-without on the SAME project's tasks — not random issues in random repos. Current SWE-bench results (baseline 89% vs Grafema 78%) are misleading because overhead doesn't pay off on cold-start. However, an automated benchmark for this is premature — the right validation is on real users in real projects. The onboarding flow itself generates measurable data (intent coverage before/after, CogLoad changes, plugin count, tasks generated) which serves as organic metrics without a synthetic benchmark.

## Part 11: Open Questions

1. **Weight calibration** — How to set w₁..w₆ in CogLoadScore without a human study? Bootstrap: use LLM as cognitive proxy (see theoretical-foundations.md §LLM as Cognitive Proxy).

2. ~~**Feature naming**~~ → **Resolved:** LLM-assisted naming (§4.3 Phase 4) + user interview (§6.2 Step 3). Route paths provide automatic names for ~70% of features; LLM proposes names for the rest; user validates.

3. **Incremental computation** — Feature subgraphs change with every code change. Can we incrementally update features or must we recompute from scratch? Likely: recompute on `grafema analyze`, cache between runs. Feature identity = entry point semantic ID (stable across minor changes).

4. ~~**Cross-language features**~~ → **Partially resolved:** CALL_REMOTE edges already link cross-service calls. Frontend `fetch('/api/x')` → backend handler is traceable today. Remaining gap: shared-state coupling (localStorage, cookies, shared DB).

5. **Ground truth** — To validate the algorithm, we need projects where features are already labeled. Options: well-documented OSS projects (e.g., VS Code which has explicit feature areas), or user-labeled features from `grafema onboard` sessions with early adopters.

6. **Intent debt vs. intent freedom** — Not all code needs documented rationale. Utility functions are self-explanatory. **Proposed resolution:** only flag intent debt on functions with ComprehensionSpan > 2 (non-trivial). Library-shaped files (core/periphery distinction from §2.5) are exempt.

7. **CogLoadScore threshold** — When is "too high"? Percentile rank is self-calibrating within a project, but cross-project comparison needs empirical data. LLM benchmark could provide initial thresholds.

8. **Interview convergence** — How many interview sessions until KB is "complete enough"? Need to define a coverage threshold (e.g., 80% of features validated, 60% of services with ownership). Track intent debt reduction per session.

9. **Cognitive surrender in the interview itself** — If the LLM proposes cluster names, the user may accept without thinking critically (Shaw & Nave's finding). Mitigation: ask open-ended questions first ("What do you call this area?"), present LLM suggestions only after user has answered or said "I don't know."

10. **Contradiction resolution authority** — When two users disagree, who resolves? Options: (a) role-based authority (tech lead > developer), (b) evidence-based (graph data + expert weight), (c) explicit escalation to designated decision-maker. Probably needs configurable policy per organization.

11. **Provenance trust decay** — Assertions from someone who left the company 2 years ago should carry lower weight than fresh assertions from active team members. Enox has `age_days` but needs a model for **source trust decay** beyond simple age.

## Related

- [Theoretical Foundations](./theoretical-foundations.md) — 5 abstraction levels, Cognitive Dimensions, LLM benchmark design
- [Sociotechnical Graph Model](./sociotechnical-graph-model.md) — 12 projections, inter-projection edges
- [Projection 5: Intentional](./projections/05-intentional.md) — Feature, Hypothesis, Domain Model entities
- [Projection 8: Epistemic](./projections/08-epistemic.md) — Knowledge health, knowledge gaps
- [Declarative Semantic Rules](./declarative-semantic-rules.md) — completeness model for Semantic projection
- [Effects Pipeline Architecture](./effects-pipeline-architecture.md) — effect taxonomy used in feature effect analysis

## References

### Primary source
- **Storey, M.-A. "From Technical Debt to Cognitive and Intent Debt: Rethinking Software Health in the Age of AI." arXiv:2603.22106v3, March 2026.** — The foundational paper for this document's debt taxonomy.

### Cited by Storey
- Naur, P. "Programming as Theory Building." Microprocessing and Microprogramming, 1985. (Software understanding as "theory of the system" — cognitive debt erodes this theory)
- Shaw, S.D. & Nave, G. "Thinking-Fast, Slow, and Artificial: How AI is Reshaping Human Reasoning and the Rise of Cognitive Surrender." SSRN, 2026. (Cognitive surrender: accepting AI output without critical engagement, inflates confidence)
- Starr, A. & Storey, M.-A. "Theory of Troubleshooting: The Developer's Cognitive Experience of Overcoming Confusion." ACM TOSEM, 2026. (Resistance to change and unexpected results as cognitive debt signals)
- Kosmyna, N., et al. "Cognitive Debt in the Era of Generative AI: Evidence from Writing Assistance Using LLMs." CHI'24 Workshop, 2024. (Neural evidence of reduced engagement during AI-assisted tasks)
- Alakmeh, T., et al. "Grasping AI Reliance in Program Comprehension and Coding through the AIRELI Persona Taxonomy." IEEE ICPC, 2026. (Comprehension debt: gap between producible and understood code)
- Cunningham, W. "The WyCash Portfolio Management System." ACM SIGPLAN OOPS Messenger, 1993. (Original technical debt metaphor)
- Hermans, F. "The Programmer's Brain." Manning, 2021. (Cognitive load: intrinsic/extraneous/germane)
- Evans, E. "Domain-Driven Design." Addison-Wesley, 2003. (Ubiquitous language, bounded contexts — intent externalization)
- Böckeler, B. "Context Engineering." martinfowler.com, 2026. (Context artifacts for AI-assisted development)

### Analysis-first elicitation (§6.2)
- Horvitz, E. "Principles of Mixed-Initiative User Interfaces." CHI, 1999. (12 principles for human-AI collaboration)
- Shadbolt, N. & Burton, A.M. "Knowledge Elicitation: A Systematic Approach." In Evaluation of Human Work, 1995. (Forward vs. backward elicitation — backward is 2–4x faster)
- Cooke, N.J. "Varieties of Knowledge Elicitation Techniques." Intl J Human-Computer Studies, 41(6), 1994. (Validational outperforms generative on time, completeness, accuracy)
- Settles, B. "Active Learning." Synthesis Lectures on AI and ML, Morgan & Claypool, 2012. (Uncertainty sampling — 50–90% fewer queries)
- Clark, H.H. & Brennan, S.E. "Grounding in Communication." In Perspectives on Socially Shared Cognition, APA, 1991. (Common ground theory)
- Tversky, A. & Kahneman, D. "Judgment Under Uncertainty: Heuristics and Biases." Science, 185(4157), 1974. (Anchoring effect)
- Pirolli, P. & Card, S. "The Sensemaking Process and Leverage Points for Analyst Technology." PARC/CHI, 2005. (Top-down vs. bottom-up sensemaking)
- Lim, B.Y. & Dey, A.K. "Assessing Demand for Intelligibility in Context-Aware Applications." UbiComp, 2009. (Explaining reasoning → trust, d > 0.8)
- Amershi, S., et al. "Power to the People: The Role of Humans in Interactive Machine Learning." AI Magazine, 35(4), 2014. (Correcting candidate models → higher engagement)
- Fails, J.A. & Olsen, D.R. "Interactive Machine Learning." IUI, 2003. (Correction 2–3x faster than specification)
- Cimiano, P. & Volker, J. "Text2Onto." NLDB, 2005. (Ontology extraction + expert validation)
- Graber, M.L. & Mathew, A. "Performance of a Web-Based Clinical Diagnosis Support System." J Gen Intern Med, 2008. (Diagnosis validation pattern)

### Our additional references
- Forsgren, N., Storey, M.-A., et al. "The SPACE of Developer Productivity." ACM Queue, 2021. (SPACE framework)
- Green, T.R.G. & Petre, M. "Usability analysis of visual programming environments." JVLC, 1996. (Cognitive Dimensions)
- Weiser, M. "Program Slicing." IEEE TSE, 1984. (Program slicing — basis for feature definition)
- Dit, B., et al. "Feature Location in Source Code: A Taxonomy and Survey." JSS, 2013. (Feature location survey)
- Miller, G.A. "The Magical Number Seven." Psychological Review, 1956. (Working memory capacity)
- Rajlich, V. & Wilde, N. "The Role of Concepts in Program Comprehension." IWPC, 2002. (Concept-based comprehension)
- Xia, X., et al. "Measuring Program Comprehension: A Large-Scale Field Study with Professionals." IEEE TSE, 2018. (The 58% number)
