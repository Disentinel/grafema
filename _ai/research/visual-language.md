# Visual Language for Grafema: Relation Alphabet Research

**Status:** Research / Active
**Date:** 2026-03-11
**Branch:** `research/visual-language`
**Origin:** Theoretical analysis of notation systems → application to code graph visualization

## Executive Summary

Grafema defines **97 edge types** across 12 semantic categories and **75+ node types**. This research reduces the full edge vocabulary to **7 base relation archetypes** — a minimal, composable core that:

- Maps to existing human intuitions from mathematics, circuits, transport, and grammar
- Passes the "understood without a legend" test
- Works across three surfaces: visual diagrams, terminal text, and query language
- Is computationally useful, not merely decorative

The key finding: **electrical circuit analogies are strongest for flow and gating** (data flow, control flow, conditionals), while **set theory and spatial intuition** dominate for structure, and **formal logic** anchors governance. No single donor system covers everything — the visual language must be a deliberate composite.

---

## I. The Four Criteria

From the foundational analysis of successful notation systems (musical staff, chemical formulas, Arabic numerals), four criteria distinguish notations that cause capability explosions from notations that merely exist:

| # | Criterion | Question |
|---|-----------|----------|
| 1 | **Externalization** | Does it move knowledge out of the head? |
| 2 | **Relations over things** | Does it describe connections, not objects? |
| 3 | **Cheap operations** | Can you combine, transform, query, verify cheaply? |
| 4 | **Natural naming** | Does it name things the way you already think? |

**Grafema's graph already satisfies #1 and #2.** The graph externalizes code understanding (you don't have to hold it in your head), and edges ARE relations. The visual language research is about #3 (making graph operations visually cheap) and #4 (making the visual vocabulary match programmer intuition).

### Why UML Failed These Criteria

| Criterion | UML's failure |
|-----------|--------------|
| Externalization | ✓ Works — diagrams are external |
| Relations | ✗ FAILS — focuses on boxes (classes, actors), relations are secondary |
| Cheap operations | ✗ FAILS — manual creation, instant obsolescence, no queries |
| Natural naming | ✗ FAILS — "actor", "use case", "association" ≠ how programmers think |

**Empirical evidence (Petre, ICSE 2013):** Interviewed 50 professional software engineers across 50 companies over 2 years. UML is NOT universally adopted even though viewed as "de facto standard." Usage is selective and contextual — mostly early-design sketching, then diagrams are discarded. 41% of developers stated UML was not important to how they work.

**Hillel Wayne's structural analysis:** UML failed for reasons deeper than "Agile killed it":
1. Backwards compatibility with 3 CASE tools (OOAD, OOSA, OMT) made it complex from birth
2. Under-specification — critical interactions between diagram types left undefined
3. Tied to declining CASE tool ecosystem

**Moody's cognitive analysis (2009):** UML's visual notation was designed by *expert consensus*, not cognitive science. Severe violations of perceptual discriminability (too many similar rectangles), graphic economy (too many symbol types), and semiotic clarity (same rectangle means different things in different diagrams).

UML's fatal flaw is NOT the notation itself — it's that maintaining UML costs more than the insight it provides. The diagram rots faster than you can draw it. Grafema sidesteps this entirely: the graph is auto-generated from code. The visual language rides on top of always-fresh data.

**But a visual language on top of Grafema could still fail criterion #4.** If the symbols require a legend, if the vocabulary feels foreign, if using it creates friction between thought and expression — it becomes decorative noise, not a thinking tool.

### Why Successful Notations Succeeded

From research on visual languages that achieved real adoption:

**LabVIEW (National Instruments):** Domain match. Engineers already think in flowcharts and block diagrams — G code maps directly to their mental models. Dataflow execution (not sequential text) makes parallelism automatic and visible. Non-programmers build programs because the notation matches their domain, not computer science.

**Wardley Maps (Simon Wardley):** Axes carry meaning. Y-axis = visibility in value chain (user-facing → infrastructure). X-axis = evolution stage (Genesis → Commodity). Position encodes semantics — not arbitrary decoration. Components *move* on the map as they evolve. This is why Wardley Maps are a *thinking tool*, not just a drawing tool.

**Lesson for Grafema:** Can position encode meaning in code graphs? Vertical = abstraction level (module → function → expression). Horizontal = stability/evolution? This deserves exploration.

**C4 Model (Simon Brown):** Only 4 levels, progressive disclosure, no specialized notation. Simple boxes and arrows with labels. Different levels tell different stories to different audiences. Taught to 10,000+ people in ~40 countries. **Simplicity + levels of detail = adoption.**

**Node-RED (IBM):** Circuit-like wires connecting nodes. 5000+ community-built modules. 40% professional use. The entire flow is visible on screen. Success comes from: auto-executing (not just drawing), domain-specific (IoT/integration), and circuit-intuitive (wire = data flow).

**Scratch/Blockly:** Jigsaw-puzzle metaphor — blocks only snap together in valid ways, physically preventing syntax errors. Students learned loops, conditionals, variables 40% faster than text-based. Focus on semantics, not syntax.

**Common pattern:** Every successful visual language is domain-specific, constrained to few symbols, and matches the audience's existing mental models. None tried to be universal.

### Three Deep Principles from Notation History

Beyond the four criteria and the domain-specific constraint, three deeper principles emerge from studying successful notations:

**1. Shimojima's "Free Rides" (1999):** Diagrams enable inferences that come *for free*. When you draw certain elements, other relationships become automatically visible without explicit reasoning. Example: three overlapping circles in a Venn diagram automatically show all 7 set intersections — you don't enumerate them. **Implication for Grafema:** If the visual layout is designed so that spatial proximity encodes semantic relatedness, users will discover relationships they didn't query for. This is the difference between a *display* (shows what you asked) and a *reasoning tool* (reveals what you didn't know to ask).

**2. Leibniz's "Suggestive Notation" principle:** Leibniz's dy/dx defeated Newton's ẏ not because it was more precise, but because it was *suggestive* — dy/dx *looks like* a fraction and in many contexts *behaves like* one (chain rule: dy/dx = dy/du · du/dx). The notation suggested valid operations. British mathematicians, loyal to Newton's notation, fell behind Continental mathematics for decades. **Implication for Grafema:** The visual form should suggest valid graph operations. If `A -> B -> C` visually suggests "chain," it should correspond to a valid path query. If `A { B, C }` visually suggests "containment," querying `A contains ?` should return B and C.

**3. Feynman's "Bijection" principle:** Feynman diagrams succeeded because each visual element has a precise mathematical correspondence. Drawing a diagram *is* writing an equation. Before Feynman, only elite physicists could do QED calculations. After, ordinary physicists could. **Implication for Grafema:** Each visual symbol in the relation alphabet must map to a specific graph operation — not approximately, but exactly. `->` IS a FLOWS query. `?>` IS a GATES query. The notation is the query language.

---

## II. Inventory: Grafema's 97 Edge Types by Semantic Domain

### Full Classification

| Domain | Count | Edge Types |
|--------|-------|------------|
| **Structure & Containment** | 11 | CONTAINS, DEPENDS_ON, HAS_SCOPE, HAS_BODY, HAS_MEMBER, HAS_PROPERTY, HAS_ELEMENT, HAS_PARAMETER, DECLARES, DEFINES, USES |
| **Control Flow** | 10 | HAS_CONDITION, HAS_CASE, HAS_DEFAULT, HAS_CONSEQUENT, HAS_ALTERNATE, HAS_INIT, HAS_UPDATE, HAS_CATCH, HAS_FINALLY, ITERATES_OVER |
| **Data Flow** | 11 | ASSIGNED_FROM, READS_FROM, WRITES_TO, PASSES_ARGUMENT, RECEIVES_ARGUMENT, DERIVES_FROM, FLOWS_INTO, SPREADS_FROM, ELEMENT_OF, KEY_OF, DESTRUCTURED_FROM |
| **Call Graph** | 7 | CALLS, HAS_CALLBACK, DELEGATES_TO, RETURNS, CALL_RETURNS, YIELDS, RESOLVES_TO |
| **Type System** | 3 | EXTENDS, IMPLEMENTS, INSTANCE_OF |
| **Module System** | 4 | IMPORTS, EXPORTS, IMPORTS_FROM, EXPORTS_TO |
| **Property Structure** | 3 | PROPERTY_KEY, PROPERTY_VALUE, ASSIGNS_TO |
| **HTTP/Routing** | 6 | ROUTES_TO, HANDLED_BY, MAKES_REQUEST, MOUNTS, EXPOSES, RESPONDS_WITH |
| **Events & Async** | 4 | LISTENS_TO, EMITS_EVENT, JOINS_ROOM, HTTP_RECEIVES |
| **Error Handling** | 3 | THROWS, REJECTS, CATCHES_FROM |
| **Infrastructure (USG)** | 13 | DEPLOYED_TO, SCHEDULED_BY, EXPOSED_VIA, USES_CONFIG, USES_SECRET, PUBLISHES_TO, SUBSCRIBES_TO, MONITORED_BY, MEASURED_BY, LOGS_TO, INVOKES_FUNCTION, PROVISIONED_BY, PERFORMS_REDIS |
| **Governance** | 3 | GOVERNS, VIOLATES, AFFECTS |
| **Other** | 4+ | CALLS_API, INTERACTS_WITH, REGISTERS_VIEW, UNKNOWN |

### The Problem

97 edge types is a vocabulary, not an alphabet. You can't build visual intuition for 97 distinct symbols. The human visual system can rapidly discriminate **6-8 categories** (Miller's 7±2), after which additional distinctions require conscious effort and legend lookup.

**Goal: reduce 97 → 7 base archetypes**, with the 97 being specific instances expressible as archetype + modifier.

### Prior Art: Minimal Relation Algebras

Other domains have solved the "minimal relation set" problem formally:

| Domain | Algebra | Relations | Property |
|--------|---------|-----------|----------|
| **Temporal** | Allen's Interval Algebra (1983) | 13 | JEPD — jointly exhaustive, pairwise disjoint |
| **Spatial** | RCC8 (Randell, Cui, Cohn) | 8 | JEPD — every pair of regions has exactly one relation |
| **Intra-procedural code** | PDG (Ferrante et al., 1987) | 2 | Control dependence + Data dependence — proved sufficient for optimization |
| **Code property graph** | Joern CPG | ~20 | Practical taxonomy across AST/CFG/DDG/type layers |
| **Code graph (general)** | **Does not exist** | ? | **OPEN RESEARCH GAP** |

**Additional baseline — Parnas's "Uses" Relation (1979):** Even more minimal than PDG. Parnas defined ONE fundamental software structuring relation: "Module A *uses* Module B if A requires a correct implementation of B to function." This single relation, organized into a hierarchy, provides the basis for identifying testable/usable subsets of a system. Our DEPENDS archetype is essentially Parnas's "uses."

**Critical observation:** The PDG proves that 2 relations (control + data) are sufficient for intra-procedural analysis. But Grafema's scope is much broader:
- Inter-module dependencies (DEPENDS)
- Type system relationships (DERIVES)
- Loose-coupled communication (PUBLISHES)
- Meta-level constraints (GOVERNS)
- Structural nesting (CONTAINS)

Each of these is orthogonal to PDG's 2. So **7 = 2 (PDG) + 5 (broader scope)** — the expansion is justified by the expanded domain.

**Research opportunity:** Grafema's 7 archetypes could be formalized as the first "relation algebra for code" analogous to Allen's interval algebra. If the 7 can be shown to be JEPD (every pair of code entities relates by exactly one archetype at the base level), this would be a publishable theoretical contribution.

---

## III. Reduction: 7 Base Relation Archetypes

### Method

Group the 97 edges by **structural shape** — not by domain, but by the kind of relationship they express. Two edges belong to the same archetype if they answer the same structural question, even if they come from different domains.

### The Seven Archetypes

#### 1. CONTAINS (∋) — Structural Nesting

**Question:** "What is inside what?"

**Covered edges (16):**
CONTAINS, HAS_MEMBER, HAS_PROPERTY, HAS_ELEMENT, HAS_PARAMETER, HAS_BODY, HAS_SCOPE, HAS_CALLBACK, HAS_INIT, HAS_UPDATE, DECLARES, DEFINES, MOUNTS, HAS_CATCH, HAS_FINALLY, PROPERTY_KEY/VALUE

**Structural shape:** A encloses B. B exists within A's boundary. Asymmetric (A contains B ≠ B contains A). Transitive (if A contains B and B contains C, then A contains C).

**Why one archetype:** All of these answer "what's inside X?" — whether X is a module, function, class, loop, or try-block. The specific *kind* of containment (member, property, parameter, scope) is a modifier, not a different archetype.

#### 2. FLOWS (→) — Directed Runtime Movement

**Question:** "What moves from where to where at runtime?"

**Covered edges (28):**
ASSIGNED_FROM, READS_FROM, WRITES_TO, PASSES_ARGUMENT, RECEIVES_ARGUMENT, FLOWS_INTO, SPREADS_FROM, CALLS, DELEGATES_TO, RETURNS, CALL_RETURNS, YIELDS, RESOLVES_TO, ROUTES_TO, HANDLED_BY, MAKES_REQUEST, RESPONDS_WITH, HTTP_RECEIVES, THROWS, REJECTS, CATCHES_FROM, LOGS_TO, INVOKES_FUNCTION, PERFORMS_REDIS, CALLS_API, INTERACTS_WITH, AFFECTS, ITERATES_OVER

**Structural shape:** Something (data, control, error, event) moves from A to B during execution. Directed. The thing that moves may be a value, control, signal, or exception.

**Sub-types (modifiers on FLOWS):**

| Modifier | What moves | Examples |
|----------|-----------|----------|
| `.data` | Values | ASSIGNED_FROM, READS_FROM, WRITES_TO, PASSES_ARGUMENT, RETURNS |
| `.ctrl` | Execution | CALLS, DELEGATES_TO, INVOKES_FUNCTION, ROUTES_TO |
| `.error` | Exceptions | THROWS, REJECTS, CATCHES_FROM |
| `.async` | Eventual values | RESOLVES_TO, YIELDS |

**Why one archetype:** All of these describe runtime movement. The difference between "data flows" and "control flows" is important but secondary — the primary visual gesture is the same: directed arrow.

#### 3. DEPENDS (⇢) — Static Requirement

**Question:** "What needs what to exist?"

**Covered edges (10):**
DEPENDS_ON, IMPORTS_FROM, IMPORTS, EXPORTS, EXPORTS_TO, USES, USES_CONFIG, USES_SECRET, DEPLOYED_TO, SCHEDULED_BY

**Structural shape:** A cannot function without B. This is a static, structural relationship — it exists whether or not the code is running. If B disappears, A breaks.

**Key distinction from FLOWS:** Dependency is potential, not actual. DEPENDS_ON means "if B changes, A might break." FLOWS means "at runtime, this value travels from A to B." A module can depend on another without any data ever flowing between them (e.g., type-only imports).

**Why EXPORTS belong here (not in PUBLISHES):** Imports and exports are a mirrored pair — the same compile-time module wiring seen from two directions. `o- imports X` and `o- exports X` share the same structural question ("what needs what to exist?"). Exports are guaranteed, compile-time, and known to both sides — the opposite of PUBLISHES (fire-and-forget, runtime, receivers unknown).

#### 4. DERIVES (◁) — Structural Origin

**Question:** "Where does A's identity/structure come from?"

**Covered edges (8):**
EXTENDS, IMPLEMENTS, INSTANCE_OF, DERIVES_FROM, DESTRUCTURED_FROM, ELEMENT_OF, KEY_OF, SPREADS_FROM

**Structural shape:** A's existence or structure is defined in terms of B. A is a specialization, instance, extract, or projection of B.

**Key distinction from DEPENDS:** Derivation is about identity — A IS (a kind of / part of / projection of) B. Dependency is about function — A NEEDS B to work. A class that extends another DERIVES its structure from the parent. A module that imports a utility DEPENDS on it.

#### 5. GATES (⊢) — Admission Control

**Question:** "What must be satisfied before something proceeds?"

**Covered edges (7+):**
HAS_CONDITION, HAS_CONSEQUENT, HAS_ALTERNATE, HAS_CASE, HAS_DEFAULT, (plus domain-level guards, validators, feature flags, circuit breakers, type constraints, null checks, pattern matching, readiness checks, compile-time flags)

**Structural shape:** A gate G determines whether entity E is admitted — whether a value passes, a type qualifies, a path executes, or a channel is ready. Binary (allows/blocks) or multi-way (selects among alternatives). The gate itself doesn't move — it controls what moves through it.

**This is the circuit switch.** The strongest analogy in the entire research. A switch doesn't carry current — it controls whether current flows. An if-statement doesn't execute code — it controls which code executes. Same structural role. Same visual intuition.

**Cross-language scope (validated across 21 languages):**

| Gate kind | Examples | Languages |
|-----------|----------|-----------|
| Boolean condition | `if (x > 0)` | All |
| Type constraint | `where T: Send`, `Monad m =>` | Rust, Haskell, Java, C++, Scala |
| Null check | `guard let x = opt` | Swift, Kotlin, TS, C# |
| Pattern match | `match x { ... }` | Rust, Scala, Haskell, Erlang |
| Readiness | `select { case <-ch }` | Go |
| Schema validation | `schema.validate(input)` | Any |
| Runtime type check | `respondsToSelector:` | ObjC, Ruby |
| Compile-time flag | `#[cfg(feature)]`, `//go:build` | Rust, Go |

**Key insight from cross-language analysis:** GATES is not "conditional control flow" — it is **admission control**. The unifying question is "must be satisfied before proceeding", which covers boolean conditions, type qualification, null presence, pattern matching, channel readiness, and compile-time feature flags.

#### 6. PUBLISHES (⇝) — Runtime Broadcast

**Question:** "Who broadcasts/subscribes without direct coupling at runtime?"

**Covered edges (5):**
EMITS_EVENT, LISTENS_TO, PUBLISHES_TO, SUBSCRIBES_TO, EXPOSED_VIA

**Reclassified edges (moved out after cross-language stress test):**
- EXPORTS, EXPORTS_TO → moved to **DEPENDS** (mirror of IMPORTS — module system is one archetype)
- Channel send/receive (Go, Rust mpsc, Kotlin) → moved to **FLOWS** (typed, directed, point-to-point = flow with buffer, not broadcast)

**Structural shape:** A broadcasts a signal. Receivers may or may not exist. A doesn't know its consumers. Delivery is fire-and-forget — not guaranteed, not typed, not point-to-point. This is fundamentally different from FLOWS (direct, point-to-point) and from module exports (compile-time, guaranteed).

**Why separate from FLOWS:** This distinction is architecturally crucial. Direct flow = tight coupling. Broadcast = loose coupling. Seeing which is which on a diagram is one of the most important architectural insights. In circuits: wire (FLOWS) vs. radio (PUBLISHES). In transport: direct train (FLOWS) vs. posted schedule (PUBLISHES).

**Why exports were removed:** Module exports/imports are compile-time, guaranteed, and bidirectional (export ↔ import). They share the structural question of DEPENDS ("what needs what to exist?"), not PUBLISHES ("who broadcasts into the void?"). Keeping them in PUBLISHES conflated compile-time module wiring with runtime event broadcasting — architecturally misleading.

#### 7. GOVERNS (⊨) — Constraint / Contract

**Question:** "What rules constrain this code?"

**Covered edges (6+):**
GOVERNS, VIOLATES, MONITORED_BY, MEASURED_BY, PROVISIONED_BY, REGISTERS_VIEW, (plus cross-language: lifetimes, interceptors, DSL declarations, access control, compile checks)

**Structural shape:** A meta-level entity R constrains, monitors, or rules over code entity A. R is not part of A's execution — it's a cross-cutting concern that applies from outside.

**Why separate:** Governance is orthogonal to all other archetypes. A function can CONTAIN other functions, FLOW data, DEPEND on modules, DERIVE from classes, be GATED by conditions, and PUBLISH events — AND be GOVERNED by a guarantee that checks its behavior. The governance layer is meta.

**Three subcategories (from cross-language stress test across 21 languages):**

| Subcategory | Modifier | Question | Examples |
|-------------|----------|----------|----------|
| **Lifecycle** | `\|= lifecycle ...` | When is it created/destroyed? | RAII, defer, ARC, weak refs, GC roots, Rust lifetimes |
| **Access** | `\|= access ...` | Who can see/do what? | friend, unsafe, sealed, private, Sendable, actor isolation |
| **Rule** | `\|= rule ...` | What declarative rules apply? | DSL (has_many), formulas (R), zones (Dart), interceptors (Proxy, metatables, method_missing), annotations (@Transactional), checked exceptions, property wrappers |

All three answer the same structural question ("what rules constrain this?") but from different angles. They are modifiers, not separate archetypes. The risk of GOVERNS becoming a "junk drawer" is mitigated by requiring first-level subcategory on every GOVERNS edge.

### Coverage Test

Can every one of the 97 edge types be expressed as archetype + modifier?

| Edge Type | Archetype | Modifier |
|-----------|-----------|----------|
| CONTAINS | ∋ | — |
| DEPENDS_ON | ⇢ | — |
| HAS_MEMBER | ∋ | .member |
| HAS_PROPERTY | ∋ | .property |
| ASSIGNED_FROM | → | .data |
| READS_FROM | → | .data.in |
| WRITES_TO | → | .data.out |
| CALLS | → | .ctrl |
| EXTENDS | ◁ | .type |
| IMPLEMENTS | ◁ | .contract |
| INSTANCE_OF | ◁ | .instance |
| HAS_CONDITION | ⊢ | .condition |
| HAS_CONSEQUENT | ⊢ | .then |
| HAS_ALTERNATE | ⊢ | .else |
| EMITS_EVENT | ⇝ | .event |
| LISTENS_TO | ⇝ | .subscribe |
| PUBLISHES_TO | ⇝ | .queue |
| GOVERNS | ⊨ | — |
| VIOLATES | ⊨ | .violation |
| THROWS | → | .error |
| CATCHES_FROM | ⊢ | .error |
| RETURNS | → | .data.return |
| IMPORTS_FROM | ⇢ | .module |
| EXPORTS | ⇢ | .module (reclassified from ⇝ — exports mirror imports) |
| ROUTES_TO | → | .ctrl.http |
| RESOLVES_TO | → | .async |
| ... | ... | ... |

**Result:** 100% coverage. Every edge type maps to exactly one archetype with zero or more modifiers. No edge type requires a new archetype.

---

## IV. Donor System Analysis

For each archetype, which existing notation systems provide the strongest visual intuitions?

### Analysis by Donor System

#### A. Electrical Circuits

| Circuit Concept | Code Concept | Archetype | Analogy Strength |
|----------------|-------------|-----------|-----------------|
| Current flow | Data flow | FLOWS → | ★★★★★ Perfect |
| Wire | Direct connection | FLOWS → | ★★★★★ Perfect |
| Switch / Relay | if / guard / validator | GATES ⊢ | ★★★★★ Perfect |
| Transistor gate | Feature flag (small signal controls big current) | GATES ⊢ | ★★★★★ Perfect |
| Diode | One-way data flow | FLOWS → | ★★★★★ Perfect |
| Bus (shared conductor) | Event bus | PUBLISHES ⇝ | ★★★★★ Perfect |
| Fuse / Circuit breaker | Error handling / circuit breaker pattern | GATES ⊢ | ★★★★★ Perfect |
| Series circuit | Sequential execution | FLOWS → | ★★★★★ Perfect |
| Parallel circuit | Concurrent / async execution | FLOWS → | ★★★★★ Perfect |
| Battery / Source | Data source (API, DB, config) | FLOWS → | ★★★★☆ Strong |
| Ground / Sink | Logging, DB write, side effect | FLOWS → | ★★★★☆ Strong |
| Capacitor | Buffer / Queue | PUBLISHES ⇝ | ★★★★☆ Strong |
| Transformer | Data transformation (map, convert) | FLOWS → | ★★★★☆ Strong |
| Short circuit | Exception / early return | FLOWS →.error | ★★★★☆ Strong |
| Open circuit | Dead code | (absence) | ★★★★☆ Strong |
| Oscillator | Polling / heartbeat / cron | GOVERNS ⊨ | ★★★☆☆ Moderate |
| Resistor | Performance bottleneck | — | ★★☆☆☆ Weak |

**Assessment:** Circuits are the strongest single donor. Excellent for FLOWS (data movement = current) and GATES (conditional = switch). Weaker for structural and type-level relationships. **No good circuit analogy for containment, derivation, or governance.**

**Key insight:** The circuit analogy is strong precisely where UML is weak — in describing *dynamics* (what flows, what switches, what blocks). UML is better at statics (classes, interfaces). Grafema needs both.

#### B. Mathematics / Formal Logic

| Math/Logic Symbol | Meaning | Archetype | Analogy Strength |
|-------------------|---------|-----------|-----------------|
| ∈ (element of) | Membership | CONTAINS ∋ | ★★★★★ Perfect |
| ⊂ (subset) | Subtype | DERIVES ◁ | ★★★★★ Perfect |
| → (maps to) | Function, transformation | FLOWS → | ★★★★★ Perfect |
| ∘ (composition) | Function chaining | FLOWS → | ★★★★★ Perfect |
| ⊢ (entails) | Derivability, proof | GATES ⊢ | ★★★★★ Perfect |
| ⊨ (models) | Satisfies, validates | GOVERNS ⊨ | ★★★★★ Perfect |
| ∃ (exists) | Optionality | DEPENDS ⇢ | ★★★★☆ Strong |
| ∀ (for all) | Universality, iteration | FLOWS → | ★★★★☆ Strong |
| ≡ (identical) | Alias, same identity | DERIVES ◁ | ★★★★☆ Strong |
| ¬ (negation) | Guard inversion | GATES ⊢ | ★★★★☆ Strong |

**Assessment:** Math provides the best symbols for CONTAINS, DERIVES, and GOVERNS. The turnstile ⊢ and double turnstile ⊨ are directly applicable. Weaker for dynamic/runtime concepts (math is atemporal) and for loose coupling (math doesn't have a "broadcast" concept).

#### C. Transport / Metro Maps

| Transport Concept | Code Concept | Archetype | Analogy Strength |
|------------------|-------------|-----------|-----------------|
| Route / Line | Execution path | FLOWS → | ★★★★★ Perfect |
| Station | Function / Service | (node type) | ★★★★★ Perfect |
| One-way street | Unidirectional dependency | DEPENDS ⇢ | ★★★★★ Perfect |
| Transfer / Interchange | Module boundary crossing | FLOWS → | ★★★★☆ Strong |
| Branch line | Conditional fork | GATES ⊢ | ★★★★☆ Strong |
| Terminal station | Entry / Exit point | (node metadata) | ★★★★☆ Strong |
| Express / Skip stop | Hot path | FLOWS → | ★★★☆☆ Moderate |
| Toll gate / Barrier | Auth / Validation | GATES ⊢ | ★★★★☆ Strong |
| Bus stop / Schedule | Published service | PUBLISHES ⇝ | ★★★★☆ Strong |
| Dead end | Dead code | (absence) | ★★★★★ Perfect |
| Traffic jam | Bottleneck | — | ★★★☆☆ Moderate |

**Assessment:** Transport is the best donor for understanding *paths* and *topology* at a high level. Excellent for flow and branching. The metro map paradigm (simplified topology, clear routes, transfer points) is a proven way to make complex networks legible.

#### D. Natural Language Grammar

| Grammar Role | Code Concept | Archetype | Analogy Strength |
|-------------|-------------|-----------|-----------------|
| Subject (agent) | Caller, producer, writer | FLOWS → | ★★★★★ Perfect |
| Object (patient) | Callee, consumer, target | FLOWS → | ★★★★★ Perfect |
| Verb | Relation type (calls, reads, writes) | ALL | ★★★★★ Perfect |
| Preposition (from, to, with, by) | Edge direction + role | ALL | ★★★★★ Perfect |
| Clause nesting | Scope nesting | CONTAINS ∋ | ★★★★★ Perfect |
| Conditional (if, when, unless) | Guard, gate | GATES ⊢ | ★★★★☆ Strong |
| Possession (has, owns, belongs to) | Containment, ownership | CONTAINS ∋ | ★★★★☆ Strong |

**Assessment:** Grammar provides the naming layer. The 97 edge types already use natural verbs: "calls", "reads", "writes", "contains", "depends". This is correct — the text layer of the notation should be verbs. Grammar doesn't help with visual form, but it's the strongest donor for criterion #4 (natural naming).

### Synthesis: Best Donor per Archetype

| Archetype | Primary Donor | Secondary Donor | Visual Source |
|-----------|--------------|-----------------|--------------|
| **CONTAINS ∋** | Set theory (∈, ⊂) | Spatial intuition | Nesting, brackets |
| **FLOWS →** | Circuits (current) | Transport (routes) | Directed arrow |
| **DEPENDS ⇢** | Transport (roads) | Logic (premise) | Dashed arrow |
| **DERIVES ◁** | Biology (phylogeny) | Math (⊂) | Heritage arrow |
| **GATES ⊢** | Circuits (switch) | Transport (barrier) | Break in line |
| **PUBLISHES ⇝** | Circuits (bus/radio) | Transport (schedule) | Wavy arrow |
| **GOVERNS ⊨** | Logic (⊨) | Law (regulation) | Double bar |

---

## V. The Electrical Circuit Hypothesis — Deep Analysis

### Hypothesis

Electrical circuit symbols are the strongest donor for representing code relationships because both systems share the same structural concerns: directed flow, conditional switching, parallel/serial composition, sources and sinks.

### Evidence: Structural Isomorphism

The circuit analogy is not metaphorical — it's structural. Both systems literally do the same thing at an abstract level:

```
Circuit:  Source → Wire → Switch → Wire → Load → Ground
Code:     Input  → Pipe → Guard  → Pipe → Handler → Output
```

Both have:
- **Conservation:** current/data is not created or destroyed (only transformed)
- **Direction:** flow has a defined direction
- **Branching:** flow can split (parallel) and merge
- **Gating:** switches/conditions control whether flow proceeds
- **Grounding:** final destinations where flow terminates (sinks)
- **Feedback:** output can loop back to input (recursion, retry)

### Where the Analogy Holds Strongly

**1. Conditional Semantics (★★★★★)**

The circuit switch IS the if-statement. Not metaphorically — structurally.

```
Circuit switch:
    ─── ╱ ───     (open = blocked)
    ─────────     (closed = flows)

Code guard:
    if (auth) {   (condition = switch position)
      proceed()   (closed circuit = execute)
    }             (open circuit = skip)
```

This extends naturally to:
- **Feature flag** = remotely controlled switch
- **Circuit breaker** = auto-opening fuse
- **Validation gate** = switch that checks signal quality before passing
- **Permission check** = lock that requires specific key to close
- **Guard clause** = early-exit switch (short circuit)

All are the same structural concept: **something that controls whether flow proceeds**.

**2. Data Flow (★★★★★)**

Current flow through wires IS data flow through function calls. The analogy is exact:
- Wire = direct function call or variable binding
- Current = the value being passed
- Voltage = the "pressure" to process (backpressure in streams)
- Series = sequential processing (`a(b(c(x)))`)
- Parallel = concurrent processing (`Promise.all([a(x), b(x)])`)

**3. Pub/Sub and Event Systems (★★★★★)**

- **Wire** (point-to-point) = direct function call
- **Bus** (shared conductor, multiple taps) = event emitter / pub-sub
- **Radio** (broadcast, no wire) = global events, webhooks

The distinction between wire, bus, and radio IS the distinction between direct calls, local events, and distributed messaging. Same physics, different coupling.

### Where the Analogy Breaks

**1. Structural Nesting (★★☆☆☆)**

Circuits are flat — components exist on a plane, connected by wires. Code is deeply nested — functions inside classes inside modules inside packages. The circuit analogy has no natural way to express "A is inside B."

**Mitigation:** Use spatial intuition (boxes-in-boxes) for containment. Circuits for flow. Two visual layers, not one.

**2. Type System / Inheritance (★★☆☆☆)**

No natural circuit analogy for "class Dog extends Animal." Circuits don't have inheritance, interfaces, or type hierarchies.

**Mitigation:** Use biological/mathematical intuition (family trees, ⊂ subset) for derivation.

**3. Naming / Binding (★☆☆☆☆)**

Circuits don't name their wires in a way that matters. In code, the name IS the mechanism — variables, imports, exports are all about naming. The circuit analogy contributes nothing here.

**Mitigation:** Use grammar (natural language verbs) for naming.

### Why the Circuit Metaphor Has Not Dominated Software Visualization

Despite the strong structural isomorphism, surprisingly **little formal research** treats software visualization with explicit circuit metaphors. The places where it HAS succeeded:

- **Flow-Based Programming (J. Paul Morrison, 1960s):** Programs as networks of black-box processes connected by wires. Proven in production at IBM since 1970s.
- **Node-RED (IBM, 2013):** Most successful modern circuit-like tool. Wire = data flow, node = processor.
- **LabVIEW:** Wires between virtual instrument blocks. Dataflow execution = signal propagation.
- **Unreal Blueprints:** Node-and-wire with real-time flow visualization.

All succeed at **one level of abstraction** — component-to-component dataflow. They fail when asked to show hierarchical structure (because circuits are flat).

**Why it hasn't dominated:**
1. Circuits are flat — no natural nesting. Code is deeply hierarchical.
2. Circuits are homogeneous — all wires carry signals. Code has heterogeneous relations.
3. Circuits don't show time — static diagrams for temporal behavior.
4. Scale — circuit diagrams work up to ~100 components, then unreadable.

**Grafema's approach:** Use circuit metaphors WHERE they're strong (flow, gating), not everywhere. The 7-archetype system takes the strongest insight from circuits (the switch/gate) and combines it with spatial intuition (containment), math (derivation), and logic (governance).

### Conclusion on Circuit Hypothesis

**CONFIRMED for flow and gating. Inapplicable for structure and types.** The visual language should use circuit-inspired symbols for archetypes 2 (FLOWS) and 5 (GATES), and draw from other donors for the rest.

The most valuable specific contribution: **the switch/gate symbol**. This is the single most important visual insight from the circuit world. It instantly communicates "conditional passage" without any legend.

---

## VI. Visual Archetype Candidates

### Design Constraints

The visual form must work on three surfaces:
1. **Diagrams** (SVG/Canvas) — full visual expressiveness
2. **Terminal/CLI** — Unicode characters
3. **Query language** — ASCII operators

And must satisfy:
- Understood without legend (semantic transparency)
- Discriminable from each other (perceptual discriminability)
- Composable (can combine with modifiers)
- Works in monochrome (not dependent on color)

### The Seven Visual Archetypes

#### 1. CONTAINS (∋) — Nesting

```
Diagram:   ┌─────────┐
           │  A       │    Box-in-box
           │  ┌───┐   │
           │  │ B │   │
           │  └───┘   │
           └─────────┘

Terminal:  A { B, C, D }
           Module { Function, Class }

Query:     A contains B
           A ∋ B
```

**Visual logic:** Universally spatial. Things inside other things. No learning needed.

**Donor:** Set theory (∈), spatial cognition, Russian dolls.

#### 2. FLOWS (→) — Directed Movement

> **Note:** The v2 ASCII operator for FLOWS is `>` (outward) / `<` (inward) / `>x` (exception). See section XIV.

```
Diagram:   A ──────→ B          (data flow: solid arrow)
           A ═══════→ B          (control flow: thick/double arrow)
           A ~~~→ B              (event/async: wavy arrow)
           A ──⚡──→ B           (error flow: lightning break)

Terminal (v2):
           A > calls B           (control)
           A < reads B           (inward data)
           A => writes B         (persist)
           A >x throws B         (exception)

Query:     A > B                 (any flow)
           A > calls B           (control flow)
           A < reads B           (data in)
           A >x throws B         (error flow)
```

**Visual logic:** Arrow = direction = something moves. Thickness/style = what kind of thing moves. Universally understood.

**Donor:** Circuits (current flow), transport (route arrows), physics (force vectors).

**Modifier system for flow subtypes (v2 operators):**

| What moves | Diagram line | v2 Terminal | Typical verbs |
|-----------|-------------|------------|---------------|
| Data (values) | ─── solid thin | `< reads`, `> passes` | reads, receives, passes |
| Control (execution) | ═══ solid thick | `> calls`, `> spawns` | calls, delegates, spawns |
| Persist (write) | ═══ heavy | `=> writes` | writes, stores, produces |
| Error (exception) | ─⚡─ broken/lightning | `>x throws` | throws, bails, rejects |
| Async (eventual) | - - - dashed | `> await` | await, resolves, yields |

#### 3. DEPENDS (⇢) — Static Requirement

> **Note:** The v2 ASCII operator for DEPENDS is `o-` (circuit plug). See section XIV.

```
Diagram:   A - - - -▷ B         (dashed arrow, open head)
           "A needs B"

Terminal (v2):
           A o- depends B
           A o- imports B
           A o- exports createOrder

Query:     A o- B
           A o- ?
```

**Visual logic:** Dashed = potential, not actual. "This connection exists structurally but nothing is flowing right now." Thinner than flow arrows because it's less dynamic.

**Key distinction from FLOWS:** A solid arrow (FLOWS) means runtime movement. A dashed arrow (DEPENDS) means structural requirement. You can see at a glance which connections are "live" (solid) and which are "structural" (dashed).

**Donor:** Architecture diagrams (dashed = dependency), transport maps (road must exist but no traffic shown).

#### 4. DERIVES (◁) — Structural Origin

```
Diagram:   A ────▷ B            (solid line, triangle head pointing to parent)
           Dog ────▷ Animal     "Dog derives from Animal"

Terminal:  A --|> B
           Dog <| Animal

Query:     A <| B
           A derives B
```

**Visual logic:** Triangle arrowhead is already the universal symbol for inheritance (even UML got this right). Points toward the origin/parent. This is one case where an existing convention is strong enough to reuse.

**Donor:** Biology (phylogenetic trees point toward ancestors), UML (one of the few UML conventions that stuck), math (⊂ subset).

#### 5. GATES (⊢) — Admission Control

> **Note:** This section describes the original v1 visual forms. After cross-language stress testing (section XVII), GATES was redefined from "conditional control" to **"admission control"** — a broader concept covering boolean conditions, type constraints, null checks, pattern matching, readiness, and compile-time flags. See section III.5 for the canonical definition. The v2 operator is `?|` (section XIV).

```
Diagram:   ──── ╱ ────          (switch: open = blocked)
           ────────────          (switch: closed = flows)

           More precisely:
                    ┌── then-path
           ── [C] ─┤
                    └── else-path

           Or circuit-style:
           ──── ◇ ────          (diamond = decision point)
                │
               [C]              (condition)

Terminal:  C ?| then
           C ?| then | else

Query:     C ?| then
           C gates then
           C ⊢ then
```

**Visual logic:** Gap/break in line = passage is not guaranteed. Diamond (from flowcharts) works but is heavier. The circuit switch symbol (╱ gap) is the most intuitive — it literally looks like something that can open or close.

**This is the crown jewel of the circuit analogy.** The switch symbol communicates "admission control" instantly:
- Closed switch (───) = condition met, flow proceeds
- Open switch (─╱─) = condition not met, flow blocked

**Extended gates vocabulary:**

| Gate type | Visual | Example |
|-----------|--------|---------|
| if/else | ──◇── fork | `if (auth)` |
| guard clause | ──╱── break | `if (!valid) return` |
| try/catch | ──⚡── fuse | `try { } catch { }` |
| feature flag | ──◈── switch | `if (flags.newUI)` |
| validation | ──▣── filter | `schema.validate(input)` |
| permission | ──🔒── lock | `if (user.can('write'))` |
| type constraint | ──╬── gate | `where T: Send` |
| null check | ──?── check | `guard let x = opt` |
| pattern match | ──⊞── select | `match x { ... }` |

**Donor:** Electrical circuits (switch, relay, transistor gate, fuse). This is the strongest single analogy in the entire research.

#### 6. PUBLISHES (⇝) — Runtime Broadcast

> **Note:** After cross-language stress testing (section XVII), PUBLISHES was purified to **runtime broadcast only**. Module exports were reclassified to DEPENDS (mirror of imports). Channels (Go, Rust mpsc) were reclassified to FLOWS (point-to-point). See section III.6 for the canonical definition. The v2 operator is `~>>` (section XIV).

```
Diagram:   A ≋≋≋≋▷ B            (wavy/radiated arrow)
           A )))  B              (broadcast waves)

           Or bus-style:
           ════════════          (shared bus line)
            ↑   ↑   ↑           (multiple subscribers tap in)
            A   B   C

Terminal:  A ~>> emits eventName
           A ~>> publishes queueName

Query:     A ~>> ?
           A publishes B
           A ⇝ B
```

**Visual logic:** Wavy = signal, not wire. The wave symbol suggests propagation without direct connection. The bus diagram (shared line with taps) is excellent for showing pub/sub architecture.

**Key distinction from FLOWS:** Solid arrow (FLOWS) = point-to-point wire. Wavy arrow (PUBLISHES) = broadcast signal. You can see at a glance which connections are tightly coupled (wires) and which are loosely coupled (signals). Channels (Go `chan`, Rust `mpsc`) are FLOWS, not PUBLISHES — they are typed, directed, point-to-point.

**Donor:** Circuits (radio vs wire, bus vs point-to-point), physics (wave propagation).

#### 7. GOVERNS (⊨) — Constraint / Contract

```
Diagram:   R ═══╪═══ A          (double bar crossing the governed entity)
           R ├────── A          (rule bracket spanning governed code)

           Or stamp-style:
           [✓ Rule] ──── A      (seal/stamp of approval)

Terminal:  R |= A
           R governs A

Query:     R |= A
           R governs A
           R ⊨ A
```

**Visual logic:** Double bar (⊨) from logic = "satisfies" / "models." Heavy, authoritative mark. Not a flow — a standing constraint.

**Three subcategories (see section III.7 for canonical definition):**

| Subcategory | Terminal | Example |
|-------------|----------|---------|
| Lifecycle | `\|= lifecycle ...` | RAII, defer, ARC, Rust lifetimes |
| Access | `\|= access ...` | friend, unsafe, sealed, actor isolation |
| Rule | `\|= rule ...` | DSL (has_many), interceptors, annotations |

**Donor:** Formal logic (⊨ semantic entailment), law (regulation, stamp of approval), engineering (specification sheet).

---

## VII. The Notation: ASCII Operators + Text Verbs

> **Note:** This section describes the v1 operator set. After stress-testing on a real system (grafema-orchestrator), several operators were revised. See **section XIV** for the v2 operator set, which supersedes the operators below.

### The Key Decision: Dual Encoding per Line

After exploring Unicode symbols, emoji, and abstract mathematical operators, the answer turned out to be the simplest: **ASCII operator + text verb, together on every line.**

```
-> calls UserDB
```

The operator (`->`) is the archetype — caught by peripheral vision, instant class recognition. The verb (`calls`) is the detail — read when you need precision. Together they create **productive redundancy**: like a road sign with a caption underneath.

This was reached by eliminating alternatives:
- **Unicode arrows** (→ ⇒ ↠ ⇢ ↯) — too small in most terminal fonts, impossible to type
- **Emoji** (📞 👀 💥) — instant recognition but aesthetically unserious, rendering inconsistent
- **Text only** (`calls UserDB`) — readable but no visual scanning structure
- **Operators only** (`-> UserDB`) — scannable but ambiguous without verb

**Both together** — best of both worlds. Operator for scanning, verb for understanding.

### The Eight ASCII Operators

All are 2-3 characters, typeable on any keyboard:

| Operator | Archetype | Reads as | Typical verbs |
|----------|-----------|----------|---------------|
| `->` | Flow (outward) | "goes to" | calls, sends, delegates |
| `<-` | Flow (inward) | "comes from" | reads, receives, fetches |
| `=>` | Flow (write/map) | "maps to" | writes, stores, assigns |
| `~>` | Dependency | "needs" | depends, imports, uses |
| `?=>` | Derivation | "inferred from" | derives, extends, implements |
| `~>>` | Publication | "broadcasts" | emits, publishes, exposes |
| `?\|` | Gate | "blocked by" | guards, validates, requires |
| `\|=` | Governance | "constrained by" | enforces, monitors, guarantees |

Plus containment via braces: `A { B, C, D }`

### Operator Design Rationale

Each operator encodes its archetype through ASCII mnemonics:

- `->` — **arrow** = something moves. Universal, every programmer knows it.
- `<-` — **reverse arrow** = something comes back. Direction flipped.
- `=>` — **fat arrow** = maps/writes. Familiar from JS arrow functions, pattern matching.
- `~>` — **tilde + arrow** = "approximately goes to." Tilde = "loosely" = dependency, not runtime flow.
- `?=>` — **question + fat arrow** = "conditionally implies." Not equality, not flow — derivation.
- `~>>` — **tilde + double arrow** = "loosely goes to many." Double `>` = fan-out.
- `?|` — **question + bar** = "passes the bar?" Bar = barrier, question = conditional.
- `|=` — **bar + equals** = "the bar is set." Constraint that must be satisfied.

### Full Display Format

```
AuthService {
  -> calls UserDB
  -> calls TokenService
  <- reads config.auth
  => writes session.store
  ~> depends @grafema/util
  ?=> derives BaseService
  ~>> emits 'auth:login'
  ~>> emits 'auth:logout'
  ?| guards isAuthenticated
  |= enforces no-plaintext-passwords
}
```

### Chain Format (for paths and traces)

```
client -> calls nginx -> calls express -> calls handler
  ?| guards auth.verified
  <- reads req.body -> calls validate ?| guards schema => writes db
  -> throws err ?| catches errorHandler
  => returns res.json(result)
```

### Query Input Format (operators without verbs)

When typing queries, verbs are optional — the operator alone is unambiguous:

```
? -> handler              # who calls handler?
? ~> changedModule         # who depends on this?
handler ~>> ?              # what does handler emit?
? ?| endpoint              # what guards this endpoint?
req.body -> * => db        # trace data from input to db
```

### Optional Layers (available but not primary)

For contexts where richer visual encoding is useful, two optional layers exist:

**Emoji layer** (for casual/marketing contexts — operator column shows v2 equivalents):

| Operator | Emoji | When to use |
|----------|-------|-------------|
| `>` | 📞 (calls), ➡️ (generic) | Slack summaries, issue descriptions |
| `<` | 👀 | Slack summaries |
| `=>` | ✏️ | Slack summaries |
| `o-` | 🔗 | Slack summaries |
| `>x` | 💥 | Slack summaries |
| `~>>` | 📡 | Slack summaries |
| `?|` | 🛡️ | Slack summaries |
| `|=` | ⚖️ | Slack summaries |

**Diagram layer** (for SVG/Canvas rendering): Line styles (solid, dashed, wavy, zigzag), arrow heads, nesting boxes. Defined in section VI.

---

## VIII. Compositionality — Building Complex from Simple

> **Note:** Examples below use the **v2 operators** (section XIV). The v1 operators (`->`, `~>`, `?=>`) that appeared in the original version of this section have been replaced.

### Principle

A complex relation = archetype + modifier(s). No new symbol needed for domain-specific relations.

### Examples

| Domain Relation | Decomposition | Compact Notation |
|----------------|---------------|-----------------|
| "Function A calls function B" | FLOWS + ctrl | `A > calls B` |
| "Module A imports from module B" | DEPENDS + module | `A o- imports B` |
| "Class Dog extends Animal" | DERIVES + type | `Dog <\|.type Animal` |
| "if (auth) then proceed()" | GATES + condition | `auth ?| guards proceed` |
| "EventEmitter emits 'data'" | PUBLISHES + event | `emitter ~>> emits 'data'` |
| "Guarantee G governs function F" | GOVERNS | `G \|= enforces F` |
| "try { A } catch(e) { B }" | GATES + error | `A >x throws B` |
| "A.map(fn)" | FLOWS + data, iterates | `A > calls[] fn` |
| "await fetch(url)" | FLOWS + async + ctrl | `fetch > await result` |
| "socket.on('msg', handler)" | PUBLISHES + subscribe | `socket ~>> subscribes 'msg' handler` |

### Chain Notation

For multi-step paths (the most common engineering question):

```
Request Path:
  client > calls nginx > calls express > calls router > calls handler
         < reads req                                   => writes res

Data Trace:
  input > calls validate ?| guards schema > calls transform => writes db

Error Path:
  handler >x throws err ?| catches retry >x bails deadLetter
```

### Compact Summary Format

**Primary format (v2 ASCII operator + verb):**
```
AuthService {
  > calls UserDB, TokenService
  < reads config.auth
  => writes session.store
  o- depends @grafema/util
  ~>> emits 'auth:login', 'auth:logout'
  ?| guards isAuthenticated
  |= enforces no-plaintext-passwords
}

OrderService {
  > calls PaymentGateway, InventoryService
  < reads OrderDB
  => writes OrderDB
  o- depends AuthService
  o- exports createOrder, getOrder
  ~>> emits 'order:created', 'order:completed'
  ?| guards auth.verified
  |= enforces idempotent-creation
}
```

**Request lifecycle (chain format):**
```
client > calls nginx > calls express > calls handler
  ?| guards auth.verified
  < reads req.body > calls validate ?| guards schema => writes db
  >x throws err ?| catches errorHandler
  => writes res.json(result)
```

The operator gives instant visual scanning (all `>` lines are outward flows, all `?|` lines are guards). The verb gives precision (calls vs sends vs delegates).

---

## IX. Engineering Questions in the New Notation

> **Note:** Query examples below use the **v2 operators** (section XIV).

The acid test: does the notation make common engineering questions cheaper to answer?

### Question 1: "Who calls this function?"

```
? > targetFunction
```
Returns all nodes that flow TO targetFunction. `?` is wildcard — "who calls this?"

### Question 2: "What will break if I change this module?"

```
? o- changedModule
```
Returns all nodes that DEPEND on the changed module. `o-` = dependency = what breaks.

### Question 3: "Trace data from user input to database"

```
req.body => * => db
```
Chain query: follow data writes from req.body through any number of hops to database.

### Question 4: "What guards protect this endpoint?"

```
? ?| targetEndpoint
```
Returns all GATES before the endpoint. `?|` = "what barriers must be passed?"

### Question 5: "What events does this service emit?"

```
targetService ~>> ?
```
Returns all publications from the service. `~>>` = broadcast.

### Question 6: "Show the full request lifecycle"

```
client > calls nginx > calls express > calls handler {
  ?| guards auth.verified
  < reads req.body > calls validate ?| guards schema => writes db
  >x throws err ?| catches errorHandler
  => writes res.json(result)
}
```

All 7 operators in one readable expression. Flows (`>`), reads (`<`), writes (`=>`), exceptions (`>x`), gates (`?|`), containment (`{}`), and governance where applicable.

### Question 7: "What guarantees apply to this code?"

```
? |= targetFunction
```
Returns all governance relations. `|=` = "what constrains this?"

---

## X. Comparison with Prior Art

### Why UML Failed (and Grafema Won't)

| UML Problem | Grafema Mitigation |
|------------|-------------------|
| Manual creation — expensive | Auto-generated from code |
| Instant obsolescence | Regenerated on every analysis |
| Fixed vocabulary of 13 diagram types | 7 composable archetypes, extensible |
| Object-centric (boxes first) | Relation-centric (edges first) |
| Foreign vocabulary ("actor", "use case") | Natural vocabulary ("calls", "reads", "gates") |
| Not queryable | Datalog queries over the graph |
| Not verifiable | `grafema check` validates guarantees |
| Not versionable (binary formats) | Text representation + graph DB |

### Grafema vs. Existing Tool Vocabularies

How does Grafema's 7-archetype proposal compare to the relation sets of existing tools?

| Tool | Edge Types | Categories | Auto-generated? | Visual? | Queryable? |
|------|-----------|------------|----------------|---------|-----------|
| **Joern CPG** | ~20 | 5 (structure, control, data, type, call) | ✓ | Limited | ✓ (CPGQL) |
| **CodeQL** | Predicates, not edges | 5 (structural, call, type, data flow, control) | ✓ | ✗ | ✓ (QL) |
| **Sourcetrail** | ~8 | 4 (calls, types, inheritance, containment) | ✓ | ✓ | ✗ |
| **Depends** | 13 | 5 (call, type, inheritance, dependency, data) | ✓ | Limited | ✗ |
| **SciTools Understand** | ~15 | 4 (structural, usage, type, file) | ✓ | ✓ | Limited |
| **Grafema (current)** | 97 | 12 domains | ✓ | ✗ (planned) | ✓ (Datalog) |
| **Grafema (proposed)** | 97 → 7 archetypes | 7 | ✓ | Planned | ✓ (Datalog; notation is output format) |

**Key differentiator:** No existing tool has a notation that is simultaneously *visual*, *textual*, and *auto-generated from a queryable graph*. Joern has queries but weak visuals. Sourcetrail has visuals but no query language. Grafema's system (Datalog queries → notation output) would be unique. The notation is a rendering of graph data, not a query language — Datalog remains the sole query mechanism.

### What Grafema Can Learn from Successful Notations

| Notation | Lesson for Grafema |
|---------|--------------------|
| **Musical staff** | Vertical position = pitch (spatial = semantic). Grafema: vertical nesting = scope depth |
| **Chemical formulas** | Small alphabet (elements) + bonds (edges) = infinite compounds. Grafema: 7 archetypes + modifiers = all relations |
| **Arabic numerals** | Positional notation (position = meaning). Grafema: position in chain = order of execution |
| **Feynman diagrams** | Particle interactions as simple line drawings. Grafema: code interactions as simple arrow drawings |
| **Metro maps** | Topological, not geographic (simplify what doesn't matter). Grafema: show relations, hide implementation details |
| **Circuit diagrams** | Standard symbols for components + wires for connections. Grafema: standard symbols for archetypes + arrows for relations |

### Moody's "Physics of Notations" — 9 Principles Applied

Daniel Moody (IEEE TSE 2009, one of the most cited works in SE visualization) identified 9 principles for cognitively effective visual notations. His core thesis: software engineering developed mature methods for evaluating semantics but lacks equivalent methods for visual syntax — yet the form of visual representations has an equal if not greater effect on understanding than their content.

| # | Principle | Moody's Definition | Grafema's 7 Archetypes |
|---|-----------|-------------------|----------------------|
| 1 | **Semiotic Clarity** | 1:1 mapping symbol↔concept. Violations: redundancy (multiple symbols, same concept), overload (same symbol, different concepts), excess (symbol without meaning), deficit (concept without symbol) | 7 archetypes, each with exactly one visual form. No overload (arrow always = flow, never = dependency). No deficit (all 97 edge types covered). |
| 2 | **Perceptual Discriminability** | Symbols must be clearly distinguishable from background and from each other | Solid/dashed/wavy/broken/nested = 5 visually distinct line treatments. Box-in-box = spatial, not linear. Double bar = unique weight. All distinguishable in monochrome. |
| 3 | **Semantic Transparency** | Symbol suggests its meaning. Transparent (appearance conveys meaning) > Opaque (arbitrary) > Perverse (suggests wrong meaning) | Arrow = movement (transparent). Break/switch = conditional (transparent). Nesting = containment (transparent). Wavy = indirect (moderate). Triangle = heritage (moderate, convention-dependent). Double bar = authority (opaque — weakest point). |
| 4 | **Complexity Management** | Explicit mechanisms for hierarchy, modularization, abstraction in large diagrams | Modifier system: archetype + modifier, not new symbols. Zoom levels: module→function→expression. Filter by archetype: show only flows, only dependencies, etc. |
| 5 | **Cognitive Integration** | Mechanisms to integrate information across multiple diagram types | Single diagram type with 7 co-existing archetypes. No need to cross-reference separate diagrams. Containment (∋) provides structural frame, other archetypes overlay. |
| 6 | **Visual Expressiveness** | Use full range of visual variables: position, size, brightness, color, orientation, shape, texture. (Most SE notations use only shape — "severely under-utilizing the visual channel.") | Position (nesting depth), line style (solid/dashed/wavy), thickness (ctrl vs data), direction (arrow), shape (triangle/diamond/box), labels (text). Color as optional secondary encoding. |
| 7 | **Dual Coding** | Text + graphics together, processed through two independent cognitive channels, improving understanding and recall | Every archetype has a triplet: visual symbol + text alias + query operator. Labels on edges in diagrams. Text notation in CLI. |
| 8 | **Graphic Economy** | Number of distinct symbols must be cognitively manageable | 7 base symbols — exactly within Miller's 7±2. Moody specifically warns against symbol vocabularies that grow beyond perceptual discrimination limits. |
| 9 | **Cognitive Fit** | Different representations for different tasks and audiences. Experts vs novices need different detail levels. | Zoom levels: executives see module-level (∋ + ⇢), developers see function-level (→ + ⊢ + ⇝), architects see all 7. Modifier depth is progressive. |

**Score: 8/9 strong, 1/9 moderate.** The weakest point is semantic transparency of the GOVERNS (⊨) archetype — the double bar/turnstile is not immediately obvious without context. All other archetypes score high on transparency.

---

## XI. Open Questions

### Resolved

1. **How many base archetypes?** → 7 (within Miller's 7±2)
2. **Can 97 edge types map to 7 archetypes?** → Yes, 100% coverage with modifiers
3. **Does the circuit analogy hold?** → Strongly for FLOWS and GATES, weakly for CONTAINS and DERIVES
4. **Is the notation learnable without a legend?** → Largely yes (arrows, nesting, dashes are universal)
5. **Can it work in text, visual, and query?** → Yes, triplet system covers all three
6. **Do 7 archetypes hold across languages?** → Yes, validated across 21 languages (section XVII). No 8th archetype required. Three refinements applied: PUBLISHES purified (exports→DEPENDS, channels→FLOWS), GATES redefined as admission control, GOVERNS structured into 3 subcategories.
7. **Is DSL a query language or output format?** → Output format only. Datalog remains the query language. Notation is a rendering of graph data, not user input.
8. **Does DSL need a formal grammar (PEG)?** → No. Read-only format needs renderer spec (edge type → operator + verb lookup table), not parser grammar.

### Open

1. **Color encoding:** Should archetypes have associated colors? (e.g., flow=blue, gate=orange, dependency=gray). Risk: color blindness, monochrome contexts. Recommendation: color as secondary encoding, never primary.

2. **Scale:** How does the notation behave with 10,000 nodes? Need filtering/zooming strategies. Metro map inspiration: show different "zoom levels" — city-wide (modules), district (functions), street-level (expressions).

3. **Animation:** For flow archetypes, animated particles (like current flow) could show runtime behavior. Valuable for debugging. Research needed on cognitive effectiveness of animated vs static diagrams.

4. **Interactive queries:** Can the visual notation serve as a query language? Click a node, type `->ctrl ?` to see all call targets. The notation becomes both display and input.

5. **Cross-layer composition:** How do CONTAINS (structural), FLOWS (runtime), and GOVERNS (meta) layers compose visually? Overlay? Side-by-side? Switchable layers?

6. **Domain-specific extensions:** The 7 archetypes cover code. The sociotechnical entity catalog (258 entities across 12 projections) may need additional archetypes for organizational, financial, and risk domains. Or these may decompose into the existing 7. Research needed.

7. **Empirical validation:** The "understood without legend" claim needs testing. Proposed experiment: show 20 programmers a diagram using the notation, ask them to describe what they see. Measure: % correct interpretation on first exposure. Target: >70% correct for archetype identification.

8. **Existing symbol conflicts:** ⊢ means "entails" in logic, ⊨ means "models" in model theory. These are precise technical terms. Using them for "gates" and "governs" may confuse logicians. But: the target audience is programmers, not logicians. And the structural mapping is correct (⊢ = derivability = "can you get there from here?" = gating).

---

## XII. The Meaningful Position Hypothesis

**Insight from Wardley Maps:** The most powerful visual notations encode meaning in *position*, not just in symbols. Wardley Maps succeeded where other strategy tools failed because the axes carry semantic weight — y = value chain visibility, x = evolution stage.

**Can Grafema use meaningful positioning?**

### Vertical Axis: Abstraction Level

Natural mapping (already intuitive from file trees and scope nesting):

```
Level 5: ┌─── Project ────────────────────┐     (architectural)
Level 4: │ ┌── Module ─────────────────┐   │
Level 3: │ │ ┌── Class ────────────┐   │   │
Level 2: │ │ │ ┌── Function ────┐  │   │   │
Level 1: │ │ │ │  expression    │  │   │   │     (implementation)
         │ │ │ └────────────────┘  │   │   │
         │ │ └─────────────────────┘   │   │
         │ └───────────────────────────┘   │
         └─────────────────────────────────┘
```

Higher = more architectural. Lower = more implementation detail. This is how most developers already think about code structure.

### Horizontal Axis: Candidate Semantics

Several candidates for what the x-axis could encode:

| Candidate | What it means | Pros | Cons |
|-----------|-------------|------|------|
| **Stability** | Left = stable core, Right = volatile edge | Matches intuition: core is "grounded", edge is "moving" | Hard to compute objectively |
| **Data flow direction** | Left = sources (inputs), Right = sinks (outputs) | Natural for pipeline architectures | Not meaningful for non-pipeline code |
| **Coupling** | Left = tightly coupled, Right = loosely coupled | Shows architecture at a glance | Hard to linearize multi-dimensional coupling |
| **Time/lifecycle** | Left = startup, Right = runtime | Shows initialization vs. steady-state | Only one dimension of time |
| **None** | Force-directed layout | No false semantic encoding | Misses the Wardley Maps insight |

**Recommendation:** Start with **vertical = abstraction level** (well-defined, computable, intuitive). Leave horizontal to force-directed layout initially. Explore stability or data-flow-direction as a horizontal semantic axis in future research.

The key lesson from Wardley Maps: **if you can encode meaning in position, the diagram becomes a thinking tool, not just a drawing.** The vertical axis is immediately available. The horizontal axis is a research opportunity.

---

## XIII. Next Steps

1. **Prototype:** Build a minimal visual renderer that takes a Grafema subgraph and displays it using the 7 archetypes. SVG output. Test with real codebases.

2. **Terminal renderer:** Implement the text notation in CLI output. When `grafema trace` shows a path, use the v2 operators (section XIV) instead of raw edge type names.

3. **Query language integration:** Extend Datalog or create a thin query syntax that uses the archetype operators (`>`, `o-`, `=>`, `>x`, `~>>`, `?|`, `|=`).

4. **User testing:** Show the notation to 5-10 developers. Measure first-exposure comprehension. Iterate.

5. **Documentation:** Every MCP tool response that shows edges should use the notation. Make it the default way Grafema communicates.

---

## XIV. Operator Revision: v2 (Stress-Test Driven)

### Origin

Applying the v1 operators (section VII) to a real system — the grafema-orchestrator pipeline — exposed four structural weaknesses:

1. **Ambiguity between `->` and `=>`** — both contain `>` with a prefix, visually too close. LLMs and fast-scanning humans confuse "flow" with "write."
2. **`~>` for dependency is semantically inverted** — tilde suggests instability/looseness, but dependency is the most stable relationship type. If B disappears, A breaks. Nothing "wavy" about that.
3. **No operator for exceptions/breaks** — flow interruption (throw, bail, reject) had no dedicated symbol.
4. **Missing execution semantics layer** — sequence, parallelism, and phases were expressed via comments, which are invisible to machine parsers.

### The v2 Operator Set

The revision keeps the 7 archetypes intact. Only the ASCII surface forms change, guided by three principles:

- **`>` is the atomic unit of direction.** Everything that moves uses `>`.
- **Absence of `>` signals absence of runtime flow.** Static relationships don't get arrows.
- **Verb is mandatory.** Bare operators are ambiguous; operator + verb is unambiguous.

| Operator | Archetype | Reads as | Mnemonic | Typical verbs |
|----------|-----------|----------|----------|---------------|
| `>` | Flow (outward) | "goes to" | bare direction | calls, sends, passes, spawns |
| `<` | Flow (inward) | "comes from" | reverse direction | reads, receives, fetches |
| `=>` | Write | "persists to" | heavy flow (`=` = weight) | writes, stores, produces |
| `>x` | Exception/Break | "breaks to" | flow + break (`x` = cross/stop) | throws, bails, rejects |
| `o-` | Dependency | "plugged into" | circuit plug (open circle + wire) | depends, imports, exports, uses |
| `~>>` | Publish/Broadcast | "broadcasts" | wavy + fan-out | emits, publishes, exposes |
| `?|` | Gate | "blocked by" | question + barrier | guards, validates, requires |
| `|=` | Governance | "constrained by" | bar + equals | enforces, monitors, guarantees |
| `{ }` | Containment | "contains" | nesting | — |

### Design Rationale for Changed Operators

**`>` replaces `->`:** Removing the dash eliminates one character of noise per line and makes `>` the irreducible atom. Every operator that involves runtime movement contains `>`. Every operator that doesn't (`o-`, `|=`) visibly lacks it. This is a **free ride** (Shimojima): the presence/absence of `>` automatically encodes runtime-vs-static without any legend.

**`o-` replaces `~>`:** The open-circle-plus-wire metaphor comes directly from electrical circuit diagrams — a component plugged into a power source. The connection is physical (structural) but no current flows until the circuit is activated. This matches dependency exactly: A is wired to B, but nothing moves until runtime. The absence of `>` in `o-` is semantically correct: dependency is not flow.

**`>x` is new:** Exception/break had no dedicated operator in v1. Exceptions were expressed as `-> throws`, overloading the flow operator for something that terminates flow. `>x` makes the break visible: the `x` is a visual cross/stop mark on the flow line. In circuit terms: a blown fuse.

**`~>>` unchanged:** Tilde IS appropriate for publish/broadcast — the signal is genuinely unstable (subscribers may or may not exist, delivery is not guaranteed). The wavy symbol correctly encodes the loose coupling. Double `>` = fan-out to multiple receivers.

### Verb-Mandatory Rule

In v1, verbs were "recommended." In v2, **verbs are mandatory in descriptive notation.** Operators alone are permitted only in query input.

```
# Descriptive (verb mandatory):
main > calls config::load < reads config.yaml
results > passes transform => writes rfdb
handler >x bails "stale binary"
module o- depends @grafema/util

# Query input (verb optional):
? > handler          # who calls handler?
? o- changedModule   # who depends on this?
handler ~>> ?        # what does handler emit?
```

Rationale: LLM stress-testing showed that bare `>` without a verb is ambiguous (calls? sends? delegates? passes?). The verb disambiguates at zero cost — it's already present in natural English descriptions.

### Execution Semantics Layer

The v1 notation mixed structural relations with execution semantics (sequence, parallelism, phases) in a single stream. v2 separates them into an explicit annotation layer:

| Annotation | Meaning | Example |
|------------|---------|---------|
| `[parallel]` | Block members execute concurrently | `[parallel] { A > calls X; B > calls Y }` |
| `[sequential]` | Block members execute in order, each depends on previous | `[sequential] { step1 => writes rfdb; step2 => writes rfdb }` |
| `[phase="name"]` | Logical pipeline phase | `[phase="resolve"]` |

Annotations are **metadata on blocks**, not operators on edges. They don't create new archetype relationships — they describe execution properties of groups.

**Why not new operators (`>>` for sequence, `||` for parallel)?** Because sequence and parallelism are not relations between two entities. They are properties of a group of operations. Adding them to the operator alphabet would violate Feynman's bijection principle: each operator must map to a graph edge type. "A runs before B" is not a graph edge — it's an execution constraint.

### Full Example: grafema-orchestrator in v2

```
grafema-orchestrator {
  o- depends anyhow, clap, tokio, serde, tracing, ignore

  [phase="init"] {
    main > calls config::load < reads config.yaml
    main > calls discovery::discover < reads filesystem
    main > calls rfdb::connect
    main > calls gc::filter_changed_files
      ?| guards changed_files.is_empty > returns early
    main > calls source_hash::verify_binary
      ?| guards binary_freshness >x bails "stale binary"
  }

  [phase="parse" mode=parallel] {
    js_files  > calls analyzer ?| guards !empty
    hs_files  > calls analyzer ?| guards !empty
    rs_files  > calls analyzer ?| guards !empty
    java_files > calls analyzer ?| guards !empty
    kt_files  > calls analyzer ?| guards !empty
    py_files  > calls analyzer ?| guards !empty
  }
  analyzer > calls process_pool > spawns external_daemons
    > calls parser::parse_file
    => produces FileAnalysis { nodes, edges, exports }

  [phase="ingest"] {
    results > passes relativize_paths > passes ensure_contains
      => writes rfdb.commit_batch
    rfdb > runs rebuild_indexes
  }

  [phase="resolve" mode=sequential] {
    js_resolve_nodes ?| guards !empty {
      > calls ProcessPool > spawns grafema-resolve
      "imports"          => writes rfdb
      "runtime-globals"  => writes rfdb
      "builtins"         => writes rfdb
      "cross-file-calls" => writes rfdb
      "same-file-calls"  => writes rfdb
      "property-access"  => writes rfdb
      "js-local-refs"    => writes rfdb
    }
  }

  [phase="plugins"] {
    user_plugins ?| guards !empty > calls plugin::run_plugins_dag => writes rfdb
  }

  [phase="cleanup"] {
    gc > calls detect_deleted_files => writes rfdb.commit_batch(empty)
    gc > calls update_mtimes
  }
}
```

### Comparison: v1 vs v2

| Aspect | v1 (section VII) | v2 |
|--------|-----------------|-----|
| Flow operator | `->` (2 chars) | `>` (1 char) |
| Read operator | `<-` (2 chars) | `<` (1 char) |
| Dependency | `~>` (tilde = wavy = wrong metaphor) | `o-` (plug = circuit = right metaphor) |
| Exception | overloaded on `->` | `>x` (dedicated, visible break) |
| Verb | recommended | mandatory in descriptive mode |
| Execution semantics | comments (`# Phase 1`) | formal annotations (`[phase="init"]`) |
| LLM ambiguity | moderate (bare operators confuse flow/write/dep) | low (each operator visually distinct class) |

### Operator Discriminability Matrix

Every pair of operators must be visually distinguishable at a glance. v2 achieves this:

| | `>` | `<` | `=>` | `>x` | `o-` | `~>>` | `?|` | `|=` |
|---|---|---|---|---|---|---|---|---|
| Has `>` | yes | no | yes | yes | **no** | yes | no | no |
| Has `=` | no | no | yes | no | no | no | no | yes |
| Has `~` | no | no | no | no | no | yes | no | no |
| Has `?` | no | no | no | no | no | no | yes | no |
| Has `x` | no | no | no | yes | no | no | no | no |
| Has `o` | no | no | no | no | yes | no | no | no |

No two operators share the same character set. Each is identifiable by a unique character: `o` → dependency, `x` → exception, `~` → broadcast, `?` → gate, `|=` → governance. For LLM tokenization, this means zero-ambiguity classification from any single token.

---

## XV. Graph-to-Notation Generation

### The Pipeline

```
Source code → Grafema graph (nodes + edges) → Notation text
```

This is a text-to-text translation through a graph intermediate representation. The graph is the semantic layer; the notation is the presentation layer. The rendering is deterministic — same graph, same query, same output.

### Mechanical Steps (Solved)

**Edge → operator mapping:** Direct lookup from the 97 edge types to 9 operators via the archetype classification (section III). Each edge type maps to exactly one archetype. Implementation: a map of ~100 entries.

**Edge → verb mapping:** Lowercase the edge type name, split on underscore, take the verb form. CALLS→"calls", WRITES_TO→"writes", DELEGATES_TO→"delegates", IMPORTS_FROM→"imports". Special cases: CONTAINS→omitted (expressed as `{ }`), HAS_CONDITION→"guards" (section-specific).

**Chain collapse:** Detect linear paths where intermediate nodes have degree=1 within the current view. Merge into single notation lines: `A > calls B > calls C > calls D`. Standard graph traversal; break chains at branching points (degree > 1).

**Ordering within blocks:** Render lines grouped by archetype, in this order:
1. `o-` (dependencies) — what this entity needs
2. `>` / `<` (flows) — what it calls and reads
3. `=>` (writes) — what it persists
4. `>x` (exceptions) — how it breaks
5. `~>>` (publishes) — what it broadcasts
6. `?|` (gates) — what guards it
7. `|=` (governance) — what constrains it

This creates a visual rhythm: structural → dynamic → meta. Consistent across all blocks.

**Name shortening:** Shortest-unambiguous-name algorithm within the current scope. If unique within the block, use bare name (`validateToken`). If ambiguous, add minimum prefix (`auth::validateToken` vs `payment::validateToken`). Full semantic ID available on hover/expand.

**Guard pattern detection:** Use existing graph patterns: HAS_CONDITION edge + early return (RETURNS edge from condition branch) = guard clause. Middleware before handler = middleware guard (CONTAINS + ordering). Enricher can pre-mark guard patterns as node metadata during analysis.

**Annotation inference:** `[parallel]` from Promise.all patterns, async concurrent calls, or explicit parallelism markers. `[sequential]` from chained awaits or pipeline patterns. `[phase]` from user-defined pipeline structure or from containment hierarchy. Hardest to infer automatically — may require config hints.

### The Hard Problem: Summarization

The graph contains thousands of nodes. A useful notation view contains 10-50 lines. **What to show and what to hide** is an editorial decision, not a rendering problem.

This is where the notation's value is created or destroyed. Show too much → information overload, no better than reading code. Show too little → missing critical relationships.

See section XVI for the summarization strategy based on progressive disclosure and cognitive load metrics.

### Markers Layer

Node properties (not inter-entity relations) are rendered as **markers** — prefix annotations on blocks or lines:

| Marker | Meaning | Source in graph |
|--------|---------|----------------|
| `!!` | Risk / danger | Node metadata: `risk`, `pci_scope`, etc. |
| `??` | Uncertainty / staleness | Node metadata: `last_verified`, `confidence` |
| `@key value` | Metadata tag | Node metadata: `team`, `sla`, `adr` |

```
AuthService {
  !! high-risk: handles PII
  @team auth-team
  @sla 99.9%
  @adr ADR-042, ADR-051

  o- depends @grafema/util
  > calls UserDB
  => writes session.store
  ?| guards isAuthenticated
  |= enforces no-plaintext-passwords
}
```

Markers don't create graph edges. They render existing node metadata. The distinction: **operators = edges, markers = node attributes, annotations = group properties.**

### Three Rendering Layers

| Layer | What it expresses | Syntax | Graph source |
|-------|------------------|--------|-------------|
| **Operators** (9) | Relations between entities | `>`, `=>`, `o-`, `?|`, `|=`, etc. | Edges |
| **Markers** | Properties of one entity | `!!`, `??`, `@key value` | Node metadata |
| **Annotations** | Properties of a group | `[parallel]`, `[phase="X"]` | Execution context |

---

## XVI. Progressive Disclosure: LOD + Summarization + Perspectives

### The Problem

The graph contains ~100K nodes and ~500K edges for a million-line codebase. A useful notation view contains 10-50 lines. The question is not rendering — it's **what to show at what depth**.

### Primary Mechanism: Level of Detail (LOD) via Scope Depth

The graph already has a CONTAINS-edge tree. Every node has a deterministic depth = distance from module root along CONTAINS edges. LOD = "show nodes up to depth N." One BFS, O(N), zero heuristics.

```
depth 0:  MODULE
depth 1:  ├── FUNCTION, CLASS, VARIABLE (top-level declarations)
depth 2:  │   ├── edges of those functions, methods of classes
depth 3:  │   │   ├── nested functions, inner blocks, callbacks
depth 4:  │   │   │   └── ...
```

#### LOD 0 — Names Only

```
auth-service {
  login()
  logout()
  validateToken()
  AuthMiddleware
}
```

#### LOD 1 — Edges of Top-Level Declarations

```
auth-service {
  login() {
    > calls UserDB.findByEmail
    > calls bcrypt.compare
    > calls createToken
    => writes session
    ?| guards isValidInput
    ~>> emits 'auth:login'
  }
  logout() {
    => deletes session
    ~>> emits 'auth:logout'
  }
}
```

#### LOD 2 — Nested Calls Expanded

```
auth-service {
  login() {
    > calls validateInput {
      ?| guards schema
      >x throws ValidationError
    }
    > calls UserDB.findByEmail < reads email
      ?| guards user !== null >x throws 401
    > calls bcrypt.compare < reads password
      ?| guards match >x throws 401
    > calls createToken > passes user.id
    => writes session
  }
}
```

Each LOD level opens one level of `{ }` nesting. Everything is shown at its depth — nothing is hidden, only collapsed.

#### CLI Usage

```bash
grafema describe auth-service              # LOD 1 (default)
grafema describe auth-service --depth=0    # just names
grafema describe auth-service --depth=2    # nested calls expanded
grafema describe auth-service::login       # LOD 1 for single function
grafema describe auth-service::login --depth=2  # deep nesting for one function
```

#### Why LOD is Superior to Ranking as Primary Mechanism

| | LOD (scope depth) | Summarization (ranking) |
|---|---|---|
| Deterministic | 100% — scope depth is a structural fact | 100% given weights, but weights are editorial choices |
| Heuristics | Zero | Importance weights, keyword matching |
| Implementation | BFS on CONTAINS edges | Scoring + sorting + budget + one-liner generation |
| "Correctness" | Objective — this IS the code structure | Subjective — "top-7 by importance" |
| Information loss | None — elements are collapsed, not removed | Hidden elements may be important |
| Cognitive model | Matches how humans read code (top-down) | Matches search (find the important thing) |

### Secondary Mechanism: Summarization (for Large Scopes)

LOD alone works when each scope level contains ≤ ~20 items. When a module has 200 functions, LOD 0 shows 200 names — too many for working memory (Miller's 7±2).

Summarization kicks in **only when LOD produces more items than the cognitive budget**:

**Budget:** 7 blocks per view (Miller's limit). If scope contains > 7 items at current depth, apply ranking.

#### Importance Scoring

```
importance(node) = w1 × fan_out_cross_module
                 + w2 × fan_in
                 + w3 × has_write
                 + w4 × has_guard
                 + w5 × has_exception
                 + w6 × total_edge_count
```

Each factor = one indexed lookup in RFDB. All deterministic. Weights are configurable.

**Algorithm:**
1. Compute importance score for all items at current depth
2. Sort descending
3. Show top-7 (or budget limit)
4. Append `...+N more` with link to expand

```
large-module {
  handlePayment()   > calls Stripe, DB  => writes ledger  ?| guards auth
  processRefund()   > calls Stripe  => writes ledger  >x throws RefundError
  validateOrder()   ?| guards schema, inventory
  createInvoice()   > calls PDF  => writes storage
  sendNotification() ~>> emits 'order:*'
  migrateSchema()   => writes DB [sequential]
  healthCheck()     < reads DB, Redis
  ...+43 more
}
```

#### One-Liner Generation

When showing a function as one summary line (LOD 0 with edges), pick edges by **max diversity × max weight**:

1. One edge per represented archetype (maximize archetype coverage)
2. Within each archetype, pick the heaviest (cross-module > internal, write > read)
3. Merge same-archetype targets: `> calls A, B, C`

Result: each one-liner shows the function's **archetype profile** — what it calls, writes, guards, emits — in one line.

### Tertiary Mechanism: Perspectives (Filtered Views)

Perspectives don't change depth or ranking — they **filter which archetypes are visible** at any LOD level.

#### Perspective = Datalog Rules over Graph

A perspective is a named configuration: importance weights + filter predicates. All predicates operate on data already in the graph — no new analysis needed.

```yaml
perspectives:
  security:
    description: "Security-relevant code paths"
    weights: { gate: 3.0, write: 2.0, exception: 2.0, flow: 1.0 }
    rules:
      - has_archetype: [gate, exception]
      - name_matches: [auth, password, token, session, secret, crypto, permission]
      - imports: [bcrypt, jsonwebtoken, helmet, cors, csurf, express-validator]

  data-mutation:
    description: "Data persistence and transformation"
    weights: { write: 3.0, flow: 2.0, gate: 1.5 }
    rules:
      - has_archetype: [write]
      - name_matches: [store, save, update, delete, migrate, seed]
      - imports: [knex, prisma, mongoose, typeorm, redis, pg]

  error-handling:
    description: "Error paths and resilience"
    weights: { exception: 3.0, gate: 2.0, flow: 1.0 }
    rules:
      - has_archetype: [exception]
      - name_matches: [error, catch, retry, fallback, circuit, timeout]

  api-surface:
    description: "Public API and entry points"
    weights: { flow: 2.0, gate: 2.0, publish: 2.0 }
    rules:
      - fan_in_cross_module: "> 3"
      - name_matches: [handler, controller, route, endpoint, api]
      - imports: [express, fastify, koa, hapi]
```

#### Signal Sources (All Already in Graph)

| Signal | Source | Cost | Quality |
|--------|--------|------|---------|
| Edge archetype distribution | Graph topology | O(1) per node | High — structural fact |
| Node name keywords | Node `name` attribute | O(1) per node | Medium — naming conventions |
| Import targets | `o-` dependency edges | O(1) per node | High — `imports bcrypt` = security |
| File path segments | Node `file` attribute | O(1) per node | Medium — project structure |

No new analysis pass needed. No ML. No embeddings. All signals are indexed graph lookups.

Vector embeddings offer fuzzy synonym matching (`authenticate` ≈ `verify_credentials`) but code identifiers within one project tend to use consistent naming. Embeddings left as future enhancement, not needed for MVP.

#### CLI Usage with Perspectives

```bash
grafema describe auth --depth=1 --perspective=security
grafema describe auth --depth=2 --perspective=data-mutation
grafema describe auth --perspective=error-handling
```

### Three Axes, Orthogonal

```
              depth 0      depth 1      depth 2
              (names)      (edges)      (nested)
             ────────────────────────────────────
all           LOD 0        LOD 1        LOD 2        ← everything at depth
security      LOD 0+sec    LOD 1+sec    LOD 2+sec    ← only ?| => >x
flows         LOD 0+flow   LOD 1+flow   LOD 2+flow   ← only > < =>
data          LOD 0+data   LOD 1+data   LOD 2+data   ← only => and targets
```

LOD = vertical axis (how deep). Perspective = horizontal axis (what to highlight). Summarization = budget enforcement (how many items when LOD produces too many).

### Computational Complexity

#### Pre-computation (once, after analysis)

| Step | Complexity | For 1M LOC codebase |
|------|-----------|---------------------|
| Module membership index (BFS on CONTAINS) | O(N + E) | ~600K ops, <100ms |
| Module adjacency matrix | O(E) | ~500K ops, <100ms |
| Importance scores (all nodes) | O(N × E_avg) | ~3M ops, <500ms |
| Scope depth assignment | O(N) | ~100K ops, <10ms |

#### Per-query (interactive)

| Step | Complexity | Time |
|------|-----------|------|
| LOD render (depth filter) | O(nodes at depth) | <1ms |
| Summarization (sort top-K) | O(F log F) per scope | <1ms |
| Perspective filter | O(edges in view) | <1ms |
| Chain collapse | O(E_func × D) | <1ms |
| Name shortening | O(nodes in view) | <1ms |

All query-time operations are sub-millisecond. The graph is already indexed in RFDB.

### CLI Progressive Disclosure Mechanisms

#### 1. Depth flag (LOD)

```bash
grafema describe module --depth=N
```

#### 2. Archetype filter (perspective)

```bash
grafema describe module --perspective=security
```

#### 3. Numbered expansion (drill-down)

```
$ grafema describe orchestrator

orchestrator {
  [1] main()     > calls analyze, config::load  ?| guards args
  [2] analyze()  > calls discover, parse, resolve  => writes rfdb
  [3] resolve()  > calls plugins [sequential]  => writes rfdb
  [4] gc()       > calls detect_deleted  => writes rfdb
}

$ grafema expand 2

analyze(config, rfdb) {
  < reads config.include, config.exclude
  > calls discover < reads filesystem
    ?| guards files.length > 0
  ...
}
```

Numbers in brackets = drill-down IDs. One depth level per `expand` command. Like `git log --oneline` → `git show <hash>`.

### For LLM Consumers

LLMs don't need TUI. They need MCP tools that return notation at the right LOD:

| MCP tool | LOD | Use case |
|----------|-----|----------|
| `get_file_overview(file)` | LOD 1 | Understand a file's structure |
| `get_function_details(node)` | LOD 2 | Understand one function deeply |
| `get_context(node)` | LOD 2 + neighbours | Function + what calls it / what it calls |
| `describe(module, depth=0)` | LOD 0 | System-level view |

LLM receives 10-30 lines of notation instead of 500 lines of source code. **Token economy = cost reduction + more room for reasoning.**

### Future: TUI Mode

For full interactive progressive disclosure:

```bash
grafema explore orchestrator   # opens TUI
```

- Tree on left (LOD 0-1), detail on right (LOD 2)
- Enter = expand block
- Tab = cycle perspective filter
- `/` = search nodes
- `q` = quit

Not required for MVP. Natural endpoint for the notation system: notation + graph + TUI = Grafema's exploration interface.

---

## XVII. Cross-Language Stress Test (21 Languages)

### Method

Each of the 97 edge types was originally derived from JavaScript. To validate that 7 archetypes are language-universal, the archetype system was stress-tested against 21 programming languages, focusing on constructs that don't map obviously to any archetype.

**Languages tested:** JavaScript, Haskell, Rust, Python, C#, Java, Objective-C, C, C++, TypeScript, Go, PHP, Swift, Kotlin, Ruby, Scala, Dart, R, Shell (Bash/Zsh), Lua, Perl.

### Result: No 8th Archetype Required

All 21 languages map to the 7 archetypes. The stress test produced:
- **3 archetype refinements** (PUBLISHES purified, GATES redefined, GOVERNS subcategorized)
- **~27 new modifiers** (`.constraint`, `.lifetime`, `.extension`, `.channel`, `.implicit`, `.intercept`, `.select`, `.defer`, `.pipe`, etc.)
- **1 new axis** (confidence: static vs dynamic edges)
- **1 new Linear issue** (REG-671: Decorator/Annotation KB)

### Language-Specific Findings (Problematic Constructs Only)

#### Haskell
| Construct | Archetype | Key Insight |
|-----------|-----------|-------------|
| Type class declaration (`class Monad m where`) | GOVERNS.typeclass | Type class ≠ interface. It's a contract that governs which types are admissible |
| Instance declaration (`instance Monad Maybe where`) | DERIVES.instance | Implementing the contract |
| Type class constraint (`Monad m =>`) | GATES.constraint | Admission: only types with instance allowed |
| Type families | DERIVES.computed | Type-level computation |
| GADTs | DERIVES + GATES | Constructor both creates and constrains type |

#### Rust
| Construct | Archetype | Key Insight |
|-----------|-----------|-------------|
| Lifetimes (`'a`) | GOVERNS.lifecycle | Meta-constraint on FLOWS — not a relation, a rule about relations |
| Ownership move (`let y = x`) | FLOWS.move | Destructive flow: source invalidated |
| Borrow (`&x` / `&mut x`) | FLOWS.borrow / FLOWS.borrow_mut | Modifiers on flow |
| Trait bounds (`where T: Send`) | GATES.constraint | Same as Haskell type class bounds |
| `unsafe { }` | GOVERNS.access | "Rules suspended here" |
| Channels (`mpsc::channel()`) | FLOWS.channel | Point-to-point, not broadcast → NOT PUBLISHES |
| `#[cfg(feature)]` | GATES.compile_time | Compile-time admission |

#### Go
| Construct | Archetype | Key Insight |
|-----------|-----------|-------------|
| `select { case <-ch }` | GATES.select | Multi-way gate by readiness, not boolean |
| Error-as-values (`if err != nil`) | FLOWS.data + GATES | No exceptions → `>x` operator barely used in Go |
| `defer` | GOVERNS.defer | Scheduled cleanup → lifecycle governance |
| Implicit interfaces | DERIVES (inferred) | No explicit `implements` — Grafema must infer |
| Goroutines (`go func()`) | FLOWS.concurrent | Flow forks into parallel path |

#### C / C++
| Construct | Archetype | Key Insight |
|-----------|-----------|-------------|
| Pointers (`*ptr`) | FLOWS.indirect | Indirection level on flow |
| `goto` | FLOWS.ctrl.unconditional | Anti-GATES: flow without admission check |
| Preprocessor macros | Outside graph | Analyzed post-expansion, marked `@macro` |
| `union` | CONTAINS.overlay | Elements overlap, not nest |
| Templates | DERIVES.template | Each instantiation derives from template |
| Concepts (C++20) | GATES.constraint | Same pattern as Haskell/Rust/Java |
| Operator overloading | FLOWS.ctrl | `a + b` → `operator+(a, b)` — notation shows real target |
| `friend` | GOVERNS.access | Inverted access: grantor, not grantee |
| RAII | GOVERNS.lifecycle | Automatic lifecycle via constructor/destructor |

#### Python
| Construct | Archetype | Key Insight |
|-----------|-----------|-------------|
| Decorators (`@`) | Depends on semantics | `@login_required` → GATES, `@dataclass` → DERIVES, `@Transactional` → GOVERNS. Needs per-framework KB (REG-671) |
| Metaclasses | GOVERNS.metaclass | Meta-level: controls how classes are created |
| Context managers (`with`) | CONTAINS.scope + GOVERNS.lifecycle | Scoped resource management |
| Duck typing | DERIVES (inferred) | No explicit edge in source code |

#### Objective-C
| Construct | Archetype | Key Insight |
|-----------|-----------|-------------|
| Categories | DERIVES.extension | Inverted: "I extend you without your knowledge" |
| Message passing (`[nil doSomething]`) | FLOWS.message | Nil receiver = silent no-op, not error |
| `NSNotificationCenter` | PUBLISHES.notification | Classic runtime broadcast |
| KVO | PUBLISHES.observe | Property observation |

#### Scala
| Construct | Archetype | Key Insight |
|-----------|-----------|-------------|
| Implicits / `given` + `using` | DEPENDS.implicit | **Invisible wiring** — most dangerous for graph completeness |
| Implicit conversions | FLOWS.implicit_conversion | Data transforms without visible call |
| Akka actors (`ref ! msg`) | PUBLISHES.actor | Fire-and-forget to mailbox |
| Path-dependent types | DERIVES.path_dependent | Type bound to specific instance |

#### Other Notable Findings
| Language | Construct | Archetype | Key Insight |
|----------|-----------|-----------|-------------|
| Swift | Actors | CONTAINS.isolated + GOVERNS.access | Isolation = containment + access rule |
| Swift | Property wrappers | GOVERNS.wrapper | Access goes through wrapper |
| Kotlin | Delegation `by` | DERIVES.delegate | Interface from I, implementation from B |
| Kotlin | Structured concurrency | CONTAINS + GOVERNS | Scope contains children + cancellation propagates |
| Ruby | `method_missing` | GOVERNS.intercept + FLOWS.dynamic | Method "created" at call time |
| Ruby | DSL (`has_many`) | GOVERNS.dsl | Declarative rule via method call |
| R | Formula (`y ~ x1 + x2`) | GOVERNS.formula | Specification, not computation |
| R | NSE | GOVERNS.captured_expression | Argument interpreted, not evaluated |
| Shell | Pipes (`\|`) | FLOWS.pipe | Inter-process dataflow |
| Shell | Environment vars (`export`) | PUBLISHES.env | Parent broadcasts to all children |
| Perl | Typeglobs (`*foo = \&bar`) | FLOWS.symbol_redirect | Runtime name redirection |
| Perl | `bless` | DERIVES.runtime | Class assigned at runtime |
| Lua | Metatables | DERIVES.prototype + GOVERNS.intercept | Two archetypes from one mechanism |

---

## XVIII. Cross-Language Patterns

Seven patterns emerged from the 21-language stress test:

### Pattern 1: Invisible Relations — Killer Feature or Killer Bug

**Languages:** Scala (implicits), C++ (operator overloading), Ruby (method_missing), Perl (typeglobs), Python (decorators partially)

Code contains no visible relation, but graph MUST have the edge. `val s: String = 42` actually calls `intToString(42)`. This is Grafema's **highest-value territory** for these languages — showing what's hidden. But if Grafema misses an implicit relation, the graph is silently incomplete.

**Action:** Confidence axis (Pattern 7). Mark inferred edges with `??` prefix.

### Pattern 2: GOVERNS — Three Subcategories, Not a Junk Drawer

Through 21 languages, GOVERNS accumulated: lifetimes, interceptors, access control, DSL declarations, formulas, zones, property wrappers, compile checks, defer, RAII, sealed, friend, unsafe.

All answer "what rules apply here?" but from three distinct angles: lifecycle (when), access (who), rule (what). Subcategories formalized in archetype definition (section III).

### Pattern 3: One Syntax → N Archetypes (The Decorator Problem)

**Languages:** Python (`@`), Java (`@`), C# (`[...]`), Swift (`@`), Kotlin (`@`)

Same syntactic form, different archetype depending on semantics. `@login_required` → GATES. `@dataclass` → DERIVES. `@Transactional` → GOVERNS.

**Action:** REG-671 — Decorator/Annotation Knowledge Base per framework.

### Pattern 4: Intercept — Universal Cross-Language Pattern

**Languages:** JS (Proxy), Lua (metatables), Ruby (method_missing), PHP (__call/__get), Perl (AUTOLOAD/tie), Python (__getattr__), ObjC (forwardInvocation:)

7 of 21 languages have the same mechanism: intercept access to undefined members. Different syntax, identical semantics. Maps to GOVERNS.intercept.

### Pattern 5: Channel ≠ Event ≠ Export — Three Distinct Mechanisms

Cross-language analysis cleanly separates three things previously conflated in PUBLISHES:

| Mechanism | Coupling | Guarantee | Archetype |
|-----------|----------|-----------|-----------|
| Export/import (module system) | Compile-time, guaranteed | Exists or compile error | **DEPENDS** (`o-`) |
| Channel (Go, Rust mpsc, Kotlin) | Typed, point-to-point, blocking | Delivery guaranteed | **FLOWS** (`>`) |
| Event/pub-sub (EventEmitter, NSNotification, Akka, Kafka) | Untyped, broadcast, fire-and-forget | Not guaranteed | **PUBLISHES** (`~>>`) |

**Action:** Reclassification applied in section III.

### Pattern 6: GATES = Admission Control (Broader Than if/else)

Across 21 languages, GATES covers: boolean conditions, type constraints (Haskell/Rust/Java/C++20), null checks (Swift/Kotlin), pattern matching (Rust/Scala/Haskell), readiness checks (Go select), compile-time flags (Rust cfg, Go build tags), schema validation.

Unifying principle: "must be satisfied before proceeding" — admission control, not conditional control.

**Action:** Definition updated in section III.

### Pattern 7: Static vs Dynamic — Confidence Axis

Every edge can be classified by how it was discovered:

| | Static (in source code) | Dynamic (inferred/runtime) |
|---|---|---|
| **FLOWS** | `a.call(b)` | `method_missing`, `performSelector:` |
| **DERIVES** | `class Dog extends Animal` | `bless $ref, 'Dog'`, duck typing |
| **DEPENDS** | `import x from 'y'` | `require(variable)`, Scala implicits |
| **GATES** | `if (condition)` | `respondsToSelector:` |
| **GOVERNS** | `@Override` | metatables, NSE |

This is not a modifier on the archetype — it's a **confidence level on the edge**. Separate axis: archetype (what kind of relation) × confidence (how sure we are it exists).

**Notation:**
```
> calls handler          # static, 100% confident
?? > calls handler       # inferred, might not exist
```

**In renderer:** `??` edges shown with dashed/faded style.
**In Datalog:** `confidence(EdgeId, "inferred")` — queryable attribute.

---

## XIX. Non-Goals and Limitations

### What the Notation Does NOT Express

1. **Ordering between siblings.** `> calls A` and `> calls B` in the same block — no guaranteed order. Use `[sequential]` annotation for explicit ordering.

2. **Exact cardinality.** "Calls exactly 1000 times" — not expressed. But "calls once" vs "calls many" IS expressed via the `[]` verb modifier (section XX).

3. **Dynamic edges with certainty.** `method_missing`, `eval()`, reflection — marked `??` but may be missing entirely. The graph is a best-effort static approximation.

4. **Performance characteristics.** No "this is slow" or "this is O(n^2)". The notation shows structure, not performance.

5. **Business logic semantics.** "This function calculates tax" — not in the graph. The notation shows relations between entities, not the meaning of values.

6. **Temporal ordering beyond annotations.** "A happens before B" requires `[sequential]`. Implicit ordering from source code line numbers is not represented.

### Escape Hatch for Future Languages

If a new edge type does not map to any of the 7 archetypes AND answers a structural question none of the 7 answer, it is a candidate for an 8th archetype. **Requirement:** at least 3 languages must exhibit the pattern. This prevents one-off exotics from inflating the alphabet.

Allen's Interval Algebra started with 13 relations, not 7. Expansion is legitimate if justified.

### Cross-Language Edge Type Candidates

Edge types discovered during the 21-language stress test that don't yet exist in Grafema's 97 but would map cleanly to archetypes:

| Pattern | Proposed Edge Type | Archetype | Languages |
|---------|-------------------|-----------|-----------|
| Implicit wiring | IMPLICIT_DEPENDS | `o-` (DEPENDS) | Scala, Spring DI |
| Interception | INTERCEPTS | `\|=` (GOVERNS) | JS, Lua, Ruby, PHP, Perl, Python, ObjC |
| Channel send/recv | CHANNEL_SEND/RECV | `>` / `<` (FLOWS) | Go, Rust, Kotlin |
| Delegation | DELEGATES_VIA | `◁` (DERIVES) | Kotlin, ObjC, Swift |
| Macro expansion | GENERATED_BY | `∋` (CONTAINS) | C, C++, Rust, Scala |
| Compile-time gate | COMPILE_GATES | `?|` (GATES) | Rust cfg, Go build tags |

---

## XX. Iteration, Recursion, and Cycles — The `[]` Verb Modifier

### The Problem

The notation shows topology (who connects to whom) but not **repetition**. Three distinct phenomena are invisible:

1. **Loop iteration** — `items.forEach(transform)` shows as `> calls transform` — indistinguishable from a single call
2. **Self-recursion** — `f()` calling `f()` shows as `> calls f` — looks like calling another function
3. **Mutual recursion** — `A calls B, B calls A` — shown in separate blocks, cycle invisible

All three are **back-edges** (flow returns to origin) but at different structural levels.

### Analysis: Not a New Archetype

A loop is not a relation between two entities. It's a **topological property of a flow path**. A `for` loop involves:
- CONTAINS (loop contains body)
- GATES (loop condition controls whether body executes again)
- FLOWS (data flows into body and back — the iteration variable)

The "back" part — the feedback — is what's missing from the notation. In compiler theory, natural loops are defined by back-edges in CFG (edges where target dominates source). This is a property of existing FLOWS edges, not a new edge type.

**No new operator needed.** The solution is a verb modifier.

### The `[]` Verb Modifier

`[]` is programmer-universal for "collection/many". Applied to a verb, it means "this action repeats":

```
> calls transform                 # single call
> calls[] transform               # calls many times (in a loop)
> calls[items] transform          # calls for each item in items
> calls[rows] db.insert           # N calls to db — N+1 problem immediately visible!
```

**Reading:**
- `calls[]` = "calls many" (like `items[]` in code)
- `calls[items]` = "calls for each item"

**Graph source:** `[]` is rendered when an ITERATES_OVER edge exists on the enclosing scope. `[items]` includes the iteration source from the ITERATES_OVER target.

### N+1 Query Detection (Free Ride)

The `[]` modifier creates a **Shimojima free ride**: patterns that become visible without explicit querying.

```
# N+1 problem — instantly visible:
[loop over users] {
  > calls[users] db.getProfile     # N queries!
  > calls[users] sendEmail         # N emails!
}

# Batched — no []:
> calls db.getProfiles             # single call (no [])
> calls[] sendEmail                # many, but batched
```

Any `> calls[X] db.*` or `=> writes[X] db.*` inside a loop is a potential N+1. The notation makes it scannable without analysis.

### Recursion

Self-recursion: the verb `recurses` (or `calls self`) with `[]` showing what decreases:

```
> recurses[n-1]                    # linear recursion, n shrinks
> recurses[left] + recurses[right] # tree recursion (fibonacci, tree traversal)
> recurses[tail]                   # list recursion
```

**Graph source:** Self-edge in call graph (CALLS edge where source node = target node).

### Mutual Recursion

Mutual recursion is a **graph-level property** (cycle in call graph), not an edge-level or block-level property. Detected algorithmically via SCC (Strongly Connected Components). Shown as a marker:

```
parseExpression() {
  !! cycle: parseExpression <-> parseTerm
  > calls parseTerm
  ?| guards token === '+'
}

parseTerm() {
  !! cycle: parseTerm <-> parseExpression
  > calls parseFactor
  ?| guards token === '('
    > calls parseExpression
}
```

### Summary

| Phenomenon | Notation | Level | Graph Source |
|-----------|----------|-------|-------------|
| Single call | `> calls X` | Edge (default) | CALLS edge |
| Loop (unknown source) | `> calls[] X` | Edge modifier | ITERATES_OVER edge exists |
| Loop (known source) | `> calls[items] X` | Edge modifier | ITERATES_OVER edge + target |
| Self-recursion | `> recurses[n-1]` | Edge (verb) | Self-edge in call graph |
| Tree recursion | `> recurses[L] + recurses[R]` | Edge (verb) | Multiple self-edges |
| Mutual recursion | `!! cycle: A <-> B` | Marker (subgraph) | SCC detection |

Zero new operators. `[]` is a modifier on the verb. The 9-operator system is preserved.

---

## XXI. Effect Propagation — `[external: ...]` and `!` Marker

### The Core Idea

If `processOrder()` calls `chargePayment()` which calls `stripe.charge()` which makes an HTTP request — then `processOrder` has an external side effect on Stripe, even though it never touches Stripe directly.

**Effect propagation = transitive closure of CALLS edges, collecting terminal side effects.**

This is the same concept as:
- Haskell's IO monad — one IO operation "infects" the whole chain
- Java checked exceptions — `throws` propagates up the call chain
- Taint analysis in security — user input "taints" everything it touches

### Two Levels: Leaf Effects and Propagated Effects

**Leaf effects** are direct — marked with `!` on the verb:

```
stripe.charge() {
  > calls! stripe.api.POST /charges     # direct external: HTTP to Stripe
}

ses.sendEmail() {
  > calls! aws.ses.POST /send           # direct external: HTTP to AWS SES
}

snowflake.insert() {
  => writes! snowflake.warehouse        # direct external: writes to Snowflake
}
```

**Propagated effects** are computed from the call graph — shown as `[external: ...]` annotation:

```
chargePayment(order) {
  [external: stripe]                     # propagated from stripe.charge()
  > calls validateCard
  > calls stripe.charge                  # <- stripe effect comes from here
  => writes db.payments                  # internal DB — not in [external]
}

processOrder(req) {
  [external: stripe, email, snowflake]   # union of all effects in call tree
  > calls validateOrder
  > calls chargePayment                  # <- [stripe]
  > calls sendConfirmation               # <- [email]
  => writes snowflake.orders             # <- [snowflake] (direct)
}
```

### Computation: Graph Already Has Everything

```prolog
has_effect(X, Effect) :- direct_effect(X, Effect).
has_effect(X, Effect) :- calls(X, Y), has_effect(Y, Effect).
```

Transitive closure over CALLS edges, collecting `!`-marked leaves. No new analysis pass — the call graph and leaf markers are sufficient.

### Leaf Effect Classification

Not all writes are external. `=> writes db` may be internal. Effects are classified via configuration:

```yaml
# .grafema/effects.yaml
effects:
  external_http:
    detect: [MAKES_REQUEST, CALLS_API]
    label: "http"

  external_db:
    detect: [WRITES_TO where target.type == "external_service"]
    services: [snowflake, bigquery, dynamodb]
    label: service_name

  email:
    detect: [calls where target.name matches "sendEmail|sendMail|ses.*"]
    label: "email"

  queue:
    detect: [PUBLISHES_TO]
    label: queue_name

  filesystem:
    detect: [calls where target.name matches "fs.write|writeFile"]
    label: "fs"
```

Configurable per project. Built-in defaults for popular services (AWS, GCP, Stripe, Twilio, etc.).

### Three LOD Levels for Effects

```
# LOD 0 — effect summary only:
processOrder()  [external: stripe, email, snowflake]

# LOD 1 — edges + effect source annotated:
processOrder() {
  [external: stripe, email, snowflake]
  > calls validateOrder
  > calls chargePayment                   # <- [stripe]
  > calls sendConfirmation                # <- [email]
  => writes snowflake.orders              # <- [snowflake]
}

# LOD 2 — full chain to leaf effects:
processOrder() {
  [external: stripe, email, snowflake]
  > calls chargePayment {
    [external: stripe]
    > calls stripe.charge {
      > calls! stripe.api.POST /charges
    }
  }
}
```

### Killer Use Cases

| Question | Query | What you get |
|----------|-------|-------------|
| "What breaks if Stripe is down?" | `? [external: stripe]` | All functions depending on Stripe |
| "Which endpoints send email?" | `? [external: email]` | All entry points with email in chain |
| "What do I mock in tests?" | `[external: ...]` on tested function | Complete mock list |
| "PCI compliance scope?" | `? [external: stripe\|paypal\|adyen]` | Payment perimeter |
| "What has network I/O?" | `? [external: http]` | All functions making HTTP calls |

---

## XXII. Data Shapes — Inline Contracts

### The Problem

```
> calls getUser -> ???
```

A developer **cannot work** without knowing what comes back. "What's the shape of the data?" is the most frequent question. Currently, answering it requires reading source code or TypeScript definitions. Grafema should show shapes inline in the notation.

### Syntax: JSON-Like with Shorthands

Full format — JSON Schema subset, readable like TypeScript interfaces:

```
# Primitive types:
> calls getId -> string
> calls getCount -> number
> calls isValid -> boolean

# Object shape (shorthand — field names only):
> calls getUser -> {id, name, email}

# Object shape (typed):
> calls getUser -> {id: string, name: string, email: string}

# Nested objects:
> calls getUser -> {
  id: string,
  name: string,
  email: string,
  posts: [{id: string, title: string, createdAt: Date}],
  settings: {theme: string, locale: string}
}

# Arrays:
> calls getUsers -> User[]
> calls getIds -> string[]

# Union / nullable:
> calls findUser -> User | null
> calls getStatus -> "active" | "inactive" | "banned"

# Optional fields:
> calls getUser -> {id, name, email?, avatar?}
```

### Two Directions: Input and Output

`<-` shows what is **consumed** (input shape). `->` shows what is **produced** (output shape).

```
processOrder(order: {id, items: [{sku, qty, price}], customer: {id, email}}) {
  > calls validateOrder <- {id, items} -> {valid: boolean}
  > calls calculateTotal <- {items} -> {subtotal, tax, total}
  > calls chargePayment <- {total, customer.id} -> {chargeId, status}
  => writes db.orders <- {id, items, total, chargeId, status: "completed"}
  ~>> emits 'order:completed' <- {id, total}
}
```

### Shape Sources

| Source | Languages | Reliability |
|--------|-----------|-------------|
| TypeScript types / interfaces | TS | 100% — structural types from AST |
| Java / C# / Kotlin types | Java, C#, Kotlin | 100% — nominal types |
| JSDoc `@param` / `@returns` | JS | High — if annotations present |
| Python type hints | Python | High — if annotations present |
| Grafema inference (property access) | Any | Medium — from `obj.field` usage patterns |
| Manual annotation | Any | User-defined — `.grafema/shapes.yaml` |

**For untyped JS/Python:** Grafema can **infer** shapes from property access patterns. If `user.name` and `user.email` appear in code, the inferred shape includes `{name, email}`. Not guaranteed complete, but useful. Inferred shapes marked with `??`:

```
> calls getUser -> ?? {id, name, email}    # inferred, may be incomplete
```

### LOD for Data Shapes

```
# LOD 0 — type name only:
> calls getUser -> User

# LOD 1 — top-level fields (shorthand):
> calls getUser -> {id, name, email, posts}

# LOD 2 — full typed schema:
> calls getUser -> {
  id: string,
  name: string,
  email: string,
  posts: [{id: string, title: string, body: string, createdAt: Date}]
}

# LOD 3 — JSON example (for API responses):
> calls getUser -> {
  "id": "usr_123",
  "name": "John",
  "email": "john@example.com",
  "posts": [{"id": "post_1", "title": "Hello World"}]
}
```

CLI flag: `grafema describe --shape=none|name|fields|full|example`

### Contract Validation (Free Ride)

When Grafema knows the shape on both ends of a flow, it can check **compatibility**:

```
# Producer:
getUser() -> {id, name, email, posts}

# Consumer:
renderProfile(user) <- {id, name, avatar}    # avatar NOT in getUser output!
```

Grafema flags the mismatch:
```
> calls getUser -> {id, name, email, posts}
> calls renderProfile <- {id, name, avatar}
  !! missing field: avatar not provided by getUser
```

This is **runtime contract checking without types** — a TypeScript replacement for legacy untyped codebases. The notation makes contract violations visible at a glance.

### Shape Diffing for Breaking Changes

When a function's output shape changes between versions, Grafema can show the diff:

```
# Before:
getUser() -> {id, name, email}

# After:
getUser() -> {id, name}    # email REMOVED

# All consumers that used email:
renderProfile() <- {id, name, email}
  !! breaking: email removed from getUser
sendWelcome() <- {email}
  !! breaking: email removed from getUser
```

---

## XXIII. Additional Verb Modifiers and Annotations

### Await Chains — `awaits(dep)` Modifier

Three sequential awaits are a **waterfall** (each waits for the previous). This is critical for performance but invisible in current notation.

```
# Waterfall — sequential awaits with dependency:
> awaits getUser -> user
> awaits(user) getPosts -> posts          # waits for user
> awaits(posts) getComments -> comments   # waits for posts

# Parallel — no dependencies:
[parallel] {
  > awaits getUser -> user
  > awaits getConfig -> config
}
```

`awaits(X)` = "waits for result X before executing." Causal chain is visible.

### CRUD Verbs — Standard Write Operations

Standardized verbs for write operations distinguish between creation, mutation, and deletion:

```
=> creates user in db.users           # INSERT — new record
=> updates user.name in db.users      # UPDATE — mutate existing
=> deletes session from db.sessions   # DELETE — remove
=> upserts user in db.users           # UPSERT — create or update
```

Architecturally significant: creates are idempotent-safe, updates may conflict, deletes are destructive.

### Nullable Calls — `calls?` Modifier

```
> calls? getUser -> User | null       # may return null/undefined
  ?| guards user !== null             # gate after nullable call
> calls getProfile -> Profile         # guaranteed to return
```

`calls?` = "calls, result may be absent." Signals where null checks are needed.

### Happy Path vs Error Path — `[error]` Block

```
processOrder() {
  > calls validateOrder
  > calls chargePayment
  > calls shipOrder
  => writes db.orders
  ~>> emits 'order:completed'

  [error] {
    >x throws ValidationError [from validateOrder]
    >x throws PaymentError [from chargePayment]
    >x throws ShippingError [from shipOrder]
  }
}
```

Happy path reads top-to-bottom without noise. Error paths grouped at the bottom. Like try/catch visually.

---

## XXIV. Two Consumers, One Graph — Design Principle

The notation has two primary consumers with fundamentally different needs:

| | **LLM** | **Human** |
|---|---|---|
| **Goal** | Maximum signal per token | Minimum cognitive load |
| **Default LOD** | 2 (full nesting, shapes, effects, errors) | 0-1 (names + top-level edges) |
| **Data shapes** | Always shown (LLM needs context) | On demand (human reads when needed) |
| **Effects** | Full `[external: ...]` with chain | Badge only: `[external: stripe]` |
| **Error paths** | Expanded `[error] { ... }` block | Collapsed: `[+3 errors]` |
| **Overload risk** | None — more tokens = more signal | High — Miller's 7±2 per scope |
| **Interaction** | Single response, no drill-down | Progressive disclosure, expand on click |

**Design principle:** The graph is the single source of truth. The notation is a **rendering** of the graph. Different consumers get different renderings from the same data.

```
# Human default (LOD 0 + badges):
processOrder()  [external: stripe, email, snowflake]  [3 errors]

# Human expanded (LOD 1):
processOrder() {
  [external: stripe, email, snowflake]
  > calls validateOrder
  > calls[items] calculateLineTotal
  > calls chargePayment                    # [stripe]
  > calls! sendConfirmation                # [email]
  => writes snowflake.orders
  [+3 errors]  [+shapes]
}

# LLM default (LOD 2 + everything):
processOrder(order: {id, items: [{sku, qty, price}], customer: {id, email}}) {
  [external: stripe, email, snowflake]
  > calls validateOrder <- {id, items} -> {valid: boolean}
    ?| guards valid
  > calls[items] calculateLineTotal <- {qty, price} -> {lineTotal: number}
  > calls calculateTotal <- {lineTotals} -> {subtotal, tax, total}
  > calls chargePayment <- {total, customer.id} -> {chargeId}    # [stripe]
  > calls shipOrder <- {items, customer} -> {trackingId}          # [shipping-api]
  => writes snowflake.orders <- {id, total, chargeId, trackingId}
  > calls! sendConfirmation <- {customer.email, trackingId}       # [email]
  ~>> emits 'order:completed' <- {id, total}
  [error] {
    >x throws ValidationError [from validateOrder]
    >x throws PaymentError [from chargePayment]
    >x throws ShippingError [from shipOrder]
  }
}
```

**Token economy:** The LLM version of `processOrder` is ~15 lines. The source code is ~80 lines. **5x compression** with zero information loss for the engineering questions that matter (what calls what, what data flows where, what breaks, what has side effects).

For MCP tool responses, this means:
- `get_file_overview` → human LOD (LOD 1, badges)
- `get_function_details` → LLM LOD (LOD 2, full shapes and effects)
- `get_context` → LLM LOD + neighbours

---

## XXV. Full Example — All Features Combined

```
processOrder(order: {id, items: [{sku, qty, price}], customer: {id, email}}) {
  [external: stripe, email, snowflake]

  > calls validateOrder <- {id, items} -> {valid: boolean}
    ?| guards valid

  > calls[items] calculateLineTotal <- {qty, price} -> {lineTotal: number}
  > calls calculateTotal <- {lineTotals} -> {subtotal, tax, total}

  > calls chargePayment <- {total, customer.id} -> {chargeId}    # [stripe]
  > calls shipOrder <- {items, customer} -> {trackingId}          # [shipping-api]

  => writes snowflake.orders <- {id, total, chargeId, trackingId, status: "completed"}
  > calls! sendConfirmation <- {customer.email, trackingId}       # [email]
  ~>> emits 'order:completed' <- {id, total}

  [error] {
    >x throws ValidationError [from validateOrder]
    >x throws PaymentError [from chargePayment]
    >x throws ShippingError [from shipOrder]
  }
}
```

**What is visible at a glance:**
- **External effects:** stripe, email, snowflake, shipping-api — full blast radius
- **Loop:** `calls[items]` — N calls to calculateLineTotal (N+1 risk if it hit DB)
- **Data shapes:** what goes in and comes out at every step
- **Happy path:** validate → calculate → charge → ship → write → notify → emit
- **Error paths:** three exceptions, separate block, traceable to source
- **Gates:** validation guard before main logic
- **Contract violations:** if any consumer expects a field not in producer's output — `!!` warning

---

## References

### Theoretical Foundations

- **Moody, D. (2009).** "The Physics of Notations: Toward a Scientific Basis for Constructing Visual Notations in Software Engineering." IEEE TSE, vol. 35, pp. 756-779. [IEEE Xplore](https://ieeexplore.ieee.org/document/5353439/)
- **Green, T.R.G., Petre, M. (1996).** "Usability Analysis of Visual Programming Environments." PPIG. [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S1045926X96900099)
- **Shimojima, A. (1999).** "Operational Constraints in Diagrammatic Reasoning." Free ride theory. [PhilPapers](https://philpapers.org/rec/SHIOCI)
- **Larkin, J., Simon, H. (1987).** "Why a Diagram is (Sometimes) Worth Ten Thousand Words." Computational advantage of diagrams.
- **Cousot, P., Cousot, R. (1977).** "Abstract Interpretation: A Unified Lattice Model." POPL.

### Minimal Relation Algebras

- **Allen, J. F. (1983).** "Maintaining Knowledge about Temporal Intervals." CACM. 13 interval relations.
- **Randell, D., Cui, Z., Cohn, A.** Region Connection Calculus (RCC8). 8 spatial relations.
- **Ferrante, J., Ottenstein, K., Warren, J. (1987).** "The Program Dependence Graph and Its Use in Optimization." ACM TOPLAS. 2 fundamental edge types.
- **Parnas, D. (1979).** "Designing Software for Ease of Extension and Contraction." The "uses" relation.

### UML Failure Analysis

- **Petre, M. (2013).** "UML in Practice." ICSE 2013. 50 engineers, 50 companies, 2 years. [Open Research](https://oro.open.ac.uk/35805/)
- **Tratt, L. (2022).** "UML: My Part in its Downfall." [Blog](https://tratt.net/laurie/blog/2022/uml_my_part_in_its_downfall.html)
- **Wayne, H.** "Why UML Really Died." [Buttondown](https://buttondown.com/hillelwayne/archive/why-uml-really-died/)
- **Fowler, M.** UML as Sketch / Blueprint / Programming Language. [martinfowler.com](https://martinfowler.com/bliki/UmlAsSketch.html)

### Successful Visual Languages

- **LabVIEW** — NI. Graphical dataflow programming for test & measurement.
- **Node-RED** — IBM (2013). Flow-based programming for IoT. 5000+ community nodes.
- **Wardley Maps** — Simon Wardley. Meaningful axes for strategic positioning.
- **C4 Model** — Simon Brown. 4-level progressive architecture. [c4model.com](https://c4model.com/)
- **Scratch/Blockly** — MIT Media Lab. Jigsaw blocks prevent syntax errors.
- **Feynman Diagrams** — Visual = mathematical bijection. [Quanta Magazine](https://www.quantamagazine.org/how-feynman-diagrams-revolutionized-physics-20190514/)
- **Beck's Underground Map (1933)** — Circuit draftsman applied topology-over-geography principle.
- **Flow-Based Programming** — J. Paul Morrison (1960s). Data factory metaphor. [jpaulm.github.io](https://jpaulm.github.io/fbp/)

### Code Analysis Tools Studied

- **Joern CPG** — ~20 edge types across 5 categories. [cpg.joern.io](https://cpg.joern.io/)
- **CodeQL** — Predicate-based relations. [codeql.github.com](https://codeql.github.com/)
- **Sourcetrail** — ~8 visual edge types. [github.com/CoatiSoftware/Sourcetrail](https://github.com/CoatiSoftware/Sourcetrail)
- **Depends** — 13 relation types. [github.com/multilang-depends/depends](https://github.com/multilang-depends/depends)
- **SciTools Understand** — ~15 relationship categories. [scitools.com](https://scitools.com/features)

### Visual Query Languages

- **Gatterbauer, W. (2023).** "Visual Representations of Relational Queries." VLDB Tutorial. [Paper](https://www.vldb.org/pvldb/vol16/p3890-gatterbauer.pdf)
- **VISAGE** — Interactive visual graph querying. [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC5444304/)
- **TU Wien** — Visual query language for graph databases.

### Notation History

- Musical staff evolution: Guido d'Arezzo's coordinate system (11th century)
- Chemical structural formulas: Kekule (1865) — topology, not just composition
- Leibniz vs Newton notation: suggestive form enables operations

### Related Project Documents

- [Theoretical Foundations](./theoretical-foundations.md) — 5 abstraction levels, Cognitive Dimensions
- [Declarative Semantic Rules](./declarative-semantic-rules.md) — AST × projection matrix
- [Sociotechnical Entity Catalog](./sociotechnical-entity-catalog.md) — 258 entities across 12 projections
- [Sociotechnical Graph Model](./sociotechnical-graph-model.md) — formal projection properties

---

## XVIII. Core Ontology — The Grapheme

The name "Grafema" is not decorative. It carries an internal ontology.

### Definition

> **Grapheme** (графема) — the minimal atomic record of program meaning.

A grapheme is:
- One **relation archetype** (from the Ennead)
- Between two **entities** (graph nodes)
- Constituting one **semantic fact**

```
module  >  calls  function
  │     │    │       │
entity  │  verb    entity
        │
   archetype operator
```

This is one grapheme. It records one fact: "module calls function." It cannot be decomposed further without losing meaning.

### The Compilation Chain

```
Source code  →  Graph  →  Graphemes  →  Patterns
   (syntax)     (data)    (atoms)      (compositions)
```

1. **Source code** contains syntactic noise and implementation details
2. **Grafema's graph** is the structural decomposition into entities and edges
3. **Graphemes** are the atomic semantic records — the DSL renders each edge as one grapheme
4. **Patterns** are compositions of graphemes — a DSL block is a semantic surface

Reading code through Grafema = reading sequences of graphemes, not source syntax.

### Formal Properties of a Grapheme

A grapheme `g = (e₁, a, e₂)` where:
- `e₁, e₂ ∈ Entities` — graph nodes (source and target)
- `a ∈ Ennead` — one of the 9 relation archetypes

**Atomicity:** A grapheme cannot be split into smaller meaningful units. `> calls A, B` is two graphemes merged for display: `(self, flow_out, A)` and `(self, flow_out, B)`.

**Completeness:** Every edge in the graph produces exactly one grapheme. No edge is "unrepresentable."

**Readability:** A grapheme is a single line of DSL notation: `operator verb target`.

### Vocabulary

| Term | Definition |
|------|-----------|
| **Grapheme** | Minimal atomic record of program meaning: `(entity, archetype, entity)` |
| **Ennead** | The 9 canonical relation archetypes (§XIX.Inv.4) |
| **DSL block** | Composition of graphemes for one entity: `name { grapheme* }` |
| **Semantic surface** | The full DSL output — all graphemes at a given LOD |
| **LOD** | Level of Detail — controls which graphemes are visible |
| **Modifier** | Prefix on a grapheme adding context: `[]` (loop), `??` (uncertain) |
| **Perspective** | Archetype filter — shows only graphemes of selected types |

### Why This Matters

This gives Grafema a precise language of explanation:

- "How complex is this function?" → Count its graphemes.
- "Are these two functions equivalent?" → Compare their grapheme multisets (Level B).
- "What changed in this refactoring?" → Diff the grapheme sets before/after.
- "Is this side-effect-free?" → Check for `{=>, >x, ~>>}` graphemes (Level A).

The grapheme is to Grafema what the atom is to chemistry: the level at which you stop decomposing and start composing.

---

## XIX. Model Invariants — From Representation to Base Model

The DSL implementation (§XIV–XVII) is a rendering engine: graph data → visual text. That makes it a *representation*. To become a *base model* — a foundation from which properties can be proved and equivalences can be established — it needs **invariants**: properties that must hold for ANY program in ANY language expressible by Grafema.

Without invariants, the archetype system is "a clever encoding." With invariants, it becomes "a formal semantic compression with provable properties."

### The Five Foundational Questions

| # | Question | What it establishes |
|---|----------|-------------------|
| 1 | What must every program have in the model? | **Existence axioms** |
| 2 | What must be preserved at every LOD level? | **LOD preservation invariants** |
| 3 | Which relations are mandatory? | **Relation completeness** |
| 4 | When are two fragments from different languages equivalent? | **Cross-language equivalence** |
| 5 | Where is the boundary between implementation detail and semantic structure? | **Abstraction boundary** |

### Invariant 1: Semantic Projectability

> **Any analyzable semantic fragment must map to a non-empty graph projection.**

This is broader than "executable code" — it covers configuration files, type declarations, module manifests, and any other artifact that carries semantic meaning within the system. If Grafema accepts a fragment for analysis, it must produce a non-empty projection.

Formally: for any source fragment `F` in any supported language, if `F` is within Grafema's analysis scope, then the analysis `A(F)` must produce a non-empty set of nodes `N = {n₁, ..., nₖ}` where `k ≥ 1`, and for `k > 1`, at least one edge `e ∈ E` connecting them.

**Corollary:** A program that produces zero nodes has not been analyzed — it is not "empty in the model." The empty program still has a MODULE node (the file exists). Zero nodes = analysis failure, not a valid model state.

**Why this matters:** Without this invariant, the model can silently drop code. Any fragment that produces zero graph output is a gap (per §XVII Gap Discovery Protocol), not an acceptable result.

### Invariant 2: Side Effect Visibility

> **Any external side effect must be representable as a write (=>), publish (~>>), or exception (>x) edge.**

If code writes to a database, emits an event, sends an HTTP response, writes to a file, or throws an error — there must exist at least one edge in the `{write, publishes, exception}` archetype set that captures it.

**Negation test:** If you remove all `=>`, `~>>`, and `>x` lines from a DSL block and the remaining lines suggest the function is pure — but it isn't — the model has failed this invariant.

**Why this matters:** This is the "no hidden mutations" guarantee. An AI agent reading the DSL output must be able to trust: "if there are no `=>` lines, this function doesn't write to external state." Without this, the DSL is decorative — it shows some things but you can't trust what's absent.

### Invariant 3: Scope Boundary Closure

> **Any named semantic boundary must have a containment relation to its contents.**

Every `{ }` block in the DSL corresponds to a node that CONTAINS (or HAS_SCOPE, HAS_MEMBER, etc.) its children. Conversely, every entity that has a name and encloses other entities must be expressible as a containment block.

**Formal:** For nodes `P` (parent) and `C` (child), if `C` is lexically inside `P` in source code and both are named semantic entities, then ∃ edge `P --[contains]--> C` in the graph.

**What this rules out:** "Orphan" nodes that have no scope parent. Functions floating without a module. Methods without a class. Variables without a function. (Synthetic/virtual nodes like `GLOBAL::console` are exempt — they have no lexical source.)

### Invariant 4: Relation Archetype Completeness — The Ennead

> **Any inter-entity influence must be expressible through the 9 relation archetypes (the Ennead).**

The **Grafema Ennead** is the canonical, closed set of relation archetypes. Every semantic relationship between code entities must classify into exactly one:

| # | Archetype | Operator | Intuition | Domain analog |
|---|-----------|----------|-----------|---------------|
| 1 | **contains** | `{ }` | Spatial enclosure | Set membership: A ∋ B |
| 2 | **depends** | `o-` | Supply line | Circuit: power rail |
| 3 | **flow_out** | `>` | Outward push | Circuit: current source |
| 4 | **flow_in** | `<` | Inward pull | Circuit: current sink |
| 5 | **write** | `=>` | Persistent mark | Physics: state change |
| 6 | **exception** | `>x` | Broken flow | Circuit: fault/short |
| 7 | **publishes** | `~>>` | Broadcast | Radio: transmitter |
| 8 | **gates** | `?|` | Conditional pass | Circuit: transistor gate |
| 9 | **governs** | `\|=` | Authority | Law: jurisdiction |

**Why "Ennead":** Greek ἐννεάς — "group of nine." Gives the concept a proper name instead of "the 9 archetypes." Analogous to how the OSI model has 7 layers, TCP has a 3-way handshake — naming the count makes it citable and canonical.

**Closure property:** If a new edge type cannot be mapped to any member of the Ennead, that's a gap in the archetype system, not a "miscellaneous" category. The Ennead must be sufficient. If it ever proves insufficient, the Ennead must be deliberately expanded (not patched with a fallback).

**Test:** For every `EDGE_TYPE` key in `@grafema/types`, `lookupEdge(type).archetype` must return a deliberate (non-fallback) mapping. The fallback path exists for forwards-compatibility, but in a correct model, it should never be exercised for known edge types.

**Structure of the Ennead:**
- **Structural** (2): `contains`, `governs` — define topology, not flow
- **Directional flow** (4): `flow_out`, `flow_in`, `write`, `exception` — directed data/control movement
- **Environmental** (2): `depends`, `publishes` — relationship to external world
- **Control** (1): `gates` — conditional access

This is not an arbitrary list. Each archetype answers a different question about code:

| Question | Archetype |
|----------|-----------|
| What's inside this? | contains |
| What does this need? | depends |
| What does this do? | flow_out |
| What feeds this? | flow_in |
| What does this change permanently? | write |
| How does this fail? | exception |
| What does this announce? | publishes |
| What controls access? | gates |
| What rules apply? | governs |

### Invariant 5: LOD Monotonicity

> **Higher LOD levels strictly add information; they never contradict lower levels.**

- **LOD 0** establishes **existence**: what entities exist and their containment tree.
- **LOD 1** adds **behavior**: what relations exist between entities.
- **LOD 2** adds **structure**: nested detail within entities.

**Formally:** `LOD(n) ⊂ LOD(n+1)` — every fact visible at level `n` is still visible at level `n+1`, plus additional facts. No edge or entity visible at LOD 0 disappears at LOD 1.

**What must be preserved at EVERY LOD:**
- Entity identity (name + type)
- Containment hierarchy (parent → child)
- The *existence* of non-containment edges (even if their detail is suppressed)

**What LOD 0 may omit:** Edge operators, target names, modifiers. But it must show that the entity EXISTS and WHERE it lives in the hierarchy.

### Invariant 6: Cross-Language Semantic Equivalence

> **Behaviorally equivalent constructs from different languages must reduce to the same archetype pattern at corresponding LOD.**

This is the hardest invariant and the one that makes the model *interesting*.

**Example:** These must produce identical DSL at LOD 1:

```javascript
// JavaScript
async function fetchUser(id) {
  const user = await db.query('SELECT * FROM users WHERE id = ?', [id]);
  return user;
}
```

```python
# Python
async def fetch_user(id):
    user = await db.query('SELECT * FROM users WHERE id = ?', [id])
    return user
```

Both must produce:
```
fetchUser {          |  fetch_user {
  > calls db.query   |    > calls db.query
  < reads id         |    < reads id
}                    |  }
```

**Three levels of "same":**

The word "equivalent" is dangerously vague. We need to be precise about which equivalence we mean. There are three distinct levels, each useful for different purposes:

**Level A: Effect Equivalence** (same observable effects)

> Two fragments are **effect-equivalent** iff they produce the same set of archetype operators in the `{write, exception, publishes}` subset.

This is the weakest equivalence. It answers: "do these two fragments have the same side effects on the outside world?" A function that writes to DB, throws errors, and emits events is effect-equivalent to another function in another language that does the same three things — regardless of internal structure.

**Testable:** Compare `{=>, >x, ~>>}` lines only. Ignore `{>, <, o-, ?|, |=}`.

**Level B: Topology Equivalence** (same archetype topology)

> Two fragments are **topology-equivalent** iff their Ennead archetype multisets are equal: same set of `(archetype, target_count)` pairs, and their containment depth is equal.

This is the medium equivalence. It answers: "do these two fragments have the same *shape* of relationships?" Not just effects, but also internal flow (calls, reads), dependencies, and gating structure.

**Formally:** `F₁ ≡_topo F₂` iff:
1. For each archetype `a ∈ Ennead`, the number of distinct `(a, verb)` groups is equal
2. The total target count per group matches
3. The containment tree depth is equal

**Testable:** Compare full DSL output, ignoring entity names and verb specifics. `> calls A, B` ≡ `> calls X, Y` (both have flow_out with 2 targets).

**Level C: Role Equivalence** (same role in enclosing system)

> Two fragments are **role-equivalent** iff they are topology-equivalent AND their incoming edges from the enclosing system match in archetype pattern.

This is the strongest equivalence. It answers: "are these two fragments interchangeable within a larger system?" Not just same internal shape, but same external interface — who calls them, who reads from them, who depends on them.

**Formally:** `F₁ ≡_role F₂` iff:
1. `F₁ ≡_topo F₂` (topology equivalence holds)
2. For each incoming archetype, the count matches

This is the "duck typing" of code semantics: if it has the same shape and the same interface, it's the same thing.

---

**Which level does Invariant 6 require?**

**Level B (Topology Equivalence) is the target for cross-language equivalence.**

Level A is too weak — it ignores internal structure, so `function that calls 10 helpers and reads config` would be equivalent to `function that does everything inline`. That loses too much information.

Level C is too strong for cross-language comparison — incoming edges depend on the rest of the codebase, which differs between language ecosystems.

Level B is the Goldilocks zone: same archetype shape, language-agnostic, testable.

**What this does NOT require:** Same AST structure, same number of intermediate nodes, same edge metadata, same entity names. The equivalence is at the archetype level, not the graph level.

**Why this matters:** This is the property that makes Grafema a *universal* code model rather than "a JS graph tool that also parses Python." If Level B equivalence holds across languages, agents can reason about code behavior independently of source language.

### Invariant 7: Abstraction Boundary — Implementation Detail vs. Semantic Structure

> **A detail is "implementation" (and may be omitted at lower LOD) iff changing it does not change the archetype pattern.**

**Semantic structure** = anything that changes which archetypes appear, which entities are targets, or which containment relationships exist.

**Implementation detail** = anything that can vary without changing the above.

| Semantic (must preserve) | Implementation (may elide) |
|-------------------------|---------------------------|
| Function calls another function | Which line the call is on |
| Variable reads from config | The config key name |
| Function throws an error class | The error message |
| Module imports a dependency | Whether it's `import` or `require()` |
| Loop iterates over collection | Whether it's `for-of` or `.forEach()` |
| Class extends another class | Whether it's `class` syntax or prototype chain |

**The test:** If you change a detail and the LOD 1 DSL output stays identical — it was an implementation detail. If the DSL changes — it was semantic structure.

### Summary: The Invariant Table

| # | Invariant | Short name | Testable? |
|---|-----------|-----------|-----------|
| 1 | Any analyzable fragment → non-empty projection | Semantic Projectability | Yes: `nodeCount > 0` for any analyzed file |
| 2 | Any external side effect → `{=>, ~>>, >x}` edge | Side Effect Visibility | Yes: compare known side effects vs archetype edges |
| 3 | Any named enclosure → containment edge | Scope Boundary Closure | Yes: every function/class/module has CONTAINS children |
| 4 | Any edge type → one of Ennead (9) | Ennead Completeness | Yes: `EDGE_TYPE` keys all in `EDGE_ARCHETYPE_MAP` |
| 5 | LOD(n) ⊂ LOD(n+1) | LOD Monotonicity | Yes: compare LOD 0/1/2 outputs |
| 6 | Same behavior + different language → Level B equivalence | Cross-Language Topology | Partially: requires multi-language test fixtures |
| 7 | Same archetype pattern under detail change → detail is implementation | Abstraction Boundary | Yes: mutation testing on source → check DSL stability |

### From Invariants to Guarantees

Each invariant can become a Grafema guarantee (Datalog rule via `create_guarantee`):

```
# Invariant 1: Entity Representability
guarantee "entity-representability"
  rule: node(M, "MODULE"), NOT edge(M, _, "CONTAINS")
  severity: warning
  description: "Module with no contained entities — analysis may have failed"

# Invariant 3: Scope Boundary Closure
guarantee "scope-closure"
  rule: node(F, "FUNCTION"), NOT incoming(F, _, "CONTAINS")
  severity: error
  description: "Function without a containing module/class — orphan node"

# Invariant 4: Relation Completeness (checked at build time, not runtime)
# See: test/unit/notation-archetypes.test.js — "should map every EDGE_TYPE"
```

### Open Questions

1. **Level B at which LOD?** Topology equivalence targets LOD 1. But LOD 0 (existence) and LOD 2 (nested structure) may require separate equivalence claims. Do we need `≡_topo@LOD1` notation?

2. **Invariant 2 completeness:** How do we handle *implicit* side effects? (e.g., `console.log` is a side effect but often not modeled as `=>` write. Should it be? Where's the line?)

3. **Invariant 7 operationalization:** Can we build a mutation-testing harness that automatically discovers the implementation/semantic boundary? (Change source → re-analyze → compare DSL → classify.)

4. **Invariant composition:** Do invariants 1-7 together form a *complete* axiom set, or are there model properties that require additional invariants? (Likely incomplete — control flow ordering, temporal sequencing, and concurrency are not yet addressed.)

5. **Ennead stability:** Is the Ennead truly closed? What's the process for proposing a 10th archetype? Criteria: (a) cannot be expressed as a combination of existing archetypes, (b) answers a question none of the 9 answer, (c) has at least 3 edge types that map to it. Current candidate that might force expansion: **temporal/ordering** (happens-before, precedes, triggers-after) — currently absorbed into flow_out but arguably distinct.

6. **Level C testing:** Role equivalence requires comparing incoming edges, which means you need the *enclosing system* to be analyzed in both languages. Is this feasible for testing? Or should Level C remain a theoretical construct until multi-repo analysis exists?
