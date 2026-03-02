# Theoretical Foundations for Grafema

**Status:** Research / Reference
**Date:** 2026-03-03
**Origin:** Brainstorm session — multi-language → Haskell → completeness → formal foundations

## The Five Abstraction Levels

```
Level 5:  COGNITIVE MODEL
          "How humans think about code"
          Theory: Cognitive Dimensions of Notations (Green & Petre, 1996)

Level 4:  PARADIGM
          "Imperative / Functional / OOP / Reactive"
          Theory: Denotational Semantics

Level 3:  SEMANTIC PROJECTIONS (CFG, DFG, Scope, Types, Structure, ...)
          "What MEANINGS we extract from code"
          Theory: Abstract Interpretation (Cousot & Cousot, 1977)

Level 2:  SEMANTIC ROLES (Callable, Invocation, Declaration, ...)
          "Cross-language operation superclasses"
          Theory: Operational Semantics

Level 1:  AST NODE TYPES (FunctionDeclaration, IfStatement, ...)
          "Concrete syntax of a specific language"
          Theory: Formal Grammars (Chomsky hierarchy)

Level 0:  SOURCE CODE (text)
```

## Key Terms and What They Mean for Grafema

### Semantic Projection

Each analysis (DFG, CFG, Scope, etc.) is a **projection** of the full program semantics onto one specific concern. Like engineering drawings: top view, side view, front view — each loses information but makes one property visible.

```
Program (full semantics)
  ├── projection → Data Flow      "where do values go"
  ├── projection → Control Flow   "in what order does code execute"
  ├── projection → Scope          "where are names visible"
  ├── projection → Call Graph     "who calls whom"
  ├── projection → Types          "what transforms into what"
  └── projection → Structure      "what is composed of what"
```

Formalized in **Abstract Interpretation**: every static analysis is an approximation of real program semantics.

### Abstract Interpretation (Cousot & Cousot, 1977)

Core concepts:
- **Concrete domain** — all possible program states (infinite)
- **Abstract domain** — simplified representation (finite, computable)
- **Galois connection** — formal link between concrete and abstract
- **Soundness** — abstraction doesn't miss real cases (may give false positives but not false negatives)

Each Grafema projection = an abstract domain. DFG abstracts "where values flow". CFG abstracts "execution order". Soundness = completeness of edge coverage.

### Operational Semantics

Formal rules for "what does this construct DO":

```
     e₁ → v₁    e₂ → v₂    v₁ + v₂ = v₃
     ────────────────────────────────────
          e₁ + e₂ → v₃
```

This IS the flow rules matrix. `AssignmentExpression: right → left` = operational semantics for assignment. Each rule in the matrix = one operational semantics rule.

### Denotational Semantics

Program = mathematical function. Not "sequence of steps" but "mapping from inputs to outputs":
- Imperative: sequence of state transformations `State → State → State`
- Functional: function composition `f ∘ g ∘ h`
- OOP: type-based dispatch `Type → Method → Result`

At this level JS and Java are the same (imperative), Haskell is different (functional). This is the level where cross-paradigm abstraction happens.

### Cognitive Dimensions of Notations (Green & Petre, 1996)

Formal vocabulary for "how humans think about code":
- **Visibility** — how easy to see the needed part → Grafema: graph queries make things findable
- **Juxtaposability** — can you compare two parts side by side → Grafema: multi-node queries
- **Hidden dependencies** — are there invisible connections → Grafema: edges make them VISIBLE
- **Progressive evaluation** — can you check incomplete results → Grafema: partial graph still useful
- **Abstraction gradient** — available abstraction levels → Grafema: node types at different granularity
- **Role-expressiveness** — how obvious is each element's role → Grafema: semantic roles on nodes

**Grafema's mission restated in Cognitive Dimensions: make hidden dependencies visible, maximize role-expressiveness, enable juxtaposability through graph queries.**

### Category Theory — The Unifying Language

Category theory describes structures and relationships BETWEEN structures:
- **Objects** = types, domains, sets (at any abstraction level)
- **Morphisms** = functions, transformations, edges
- **Functors** = mappings between abstraction levels
- **Natural transformations** = systematic ways to convert between projections

Translation AST → Graph = **functor**. Projection Graph → DFG = **functor**. Generation Graph → Haskell types = **functor**. Category theory provides unified language for all these transformations.

Steep learning curve, but provides the vocabulary to reason about ALL levels simultaneously.

## Practical Toolkit

| Level | Theory | What Grafema takes from it |
|-------|--------|---------------------------|
| AST nodes | Formal grammars | `@babel/types` spec as formal grammar |
| Semantic roles | Operational semantics | Flow rules: "what each construct does" |
| Projections | Abstract interpretation | Each analysis = abstraction, soundness = completeness |
| Paradigms | Denotational semantics | Imperative vs functional model |
| Human thinking | Cognitive Dimensions | "Make hidden dependencies visible" |
| Cross-level | Category Theory | Functors between abstraction levels |

## Grafema as "Haskell for Untyped Code"

The deeper insight: Grafema is building what Haskell's type system provides natively, but for languages that don't have it.

| Haskell (native) | Grafema (builds) |
|-------------------|------------------|
| Type signature `A -> Either E B` | Edge `FUNCTION --RETURNS--> TYPE, --THROWS--> ERROR` |
| Exhaustiveness checking | Semantic rules matrix (all cases covered) |
| Type class laws | Grafema guarantees |
| Hoogle (search by type) | `find_nodes` (search by graph) |
| Compiler rejects inconsistencies | `grafema check` rejects broken guarantees |

## Reading List (prioritized)

1. **Cognitive Dimensions of Notations** — Green & Petre (1996). Short, readable, directly applicable.
2. **Abstract Interpretation** — Cousot & Cousot (1977). Foundational paper, but dense. Start with tutorials.
3. **Operational Semantics** — Benjamin Pierce "Types and Programming Languages" (chapters 3-5). Practical intro.
4. **Category Theory for Programmers** — Bartosz Milewski. Free online book. Best intro for developers.
5. **Denotational Semantics** — Schmidt "Denotational Semantics" or Stoy. More academic.

## Related

- [Declarative Semantic Rules Matrix](./declarative-semantic-rules.md) — the concrete spec idea
- REG-613: Java analyzer MVP
- Spoofax/FlowSpec: https://spoofax.dev/references/flowspec/
- Spoofax/Statix: https://spoofax.dev/references/statix/
