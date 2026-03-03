# Sociotechnical Entity Catalog

**Status:** Research / Foundational
**Date:** 2026-03-03

**Principle:** An entity is worth modeling only if it enables cross-lens queries that are otherwise impossible. Each entity includes at least one cross-lens value statement demonstrating this.

## Projections (one file per projection)

| # | Projection | Question | Lenses | Entities | File |
|---|------------|----------|--------|----------|------|
| 1 | Semantic | What does the code *mean*? | 8 | 32 | [01-semantic.md](./projections/01-semantic.md) |
| 2 | Operational | How does code *execute*? | 6 | 25 | [02-operational.md](./projections/02-operational.md) |
| 3 | Causal | What *caused* what? | 6 | 24 | [03-causal.md](./projections/03-causal.md) |
| 4 | Contractual | What is *guaranteed*? | 5 | 19 | [04-contractual.md](./projections/04-contractual.md) |
| 5 | Intentional | *Why* does this exist? | 5 | 22 | [05-intentional.md](./projections/05-intentional.md) |
| 6 | Organizational | *Who* is responsible? | 6 | 22 | [06-organizational.md](./projections/06-organizational.md) |
| 7 | Temporal | *When* and in what order? | 9 | 25 | [07-temporal.md](./projections/07-temporal.md) |
| 8 | Epistemic | What is *known* and where? | 5 | 19 | [08-epistemic.md](./projections/08-epistemic.md) |
| 9 | Security | Who/what *can access* what? | 6 | 21 | [09-security.md](./projections/09-security.md) |
| 10 | Financial | How much does it *cost*? | 6 | 16 | [10-financial.md](./projections/10-financial.md) |
| 11 | Behavioral | How is it *actually used*? | 5 | 20 | [11-behavioral.md](./projections/11-behavioral.md) |
| 12 | Risk | What *could go wrong*? | 4 | 13 | [12-risk.md](./projections/12-risk.md) |
| | **Total** | | **71** | **258** | |

## Projection Discovery Protocol

When a new entity type appears that doesn't fit cleanly into existing projections:

1. **Formulate the question** the entity answers. What concern does it address?
2. **Test derivability** — can ANY existing projection answer this question? If yes → it's an entity within that projection, or at an intersection.
3. **Test orthogonality** — if no existing projection answers it, test pairwise against all 12: can the new concern's answer be derived from any existing projection? If no → candidate for a new projection.
4. **Formulate soundness** — what does "no false negatives" mean for this concern? If you can state it clearly → the projection is real.
5. **Identify sub-projections** — does the new projection decompose into ≥2 orthogonal sub-concerns?
6. **Update the relevant file** or create a new projection file.

**The list of 12 projections is not closed.** It is the current best model. New projections may emerge as the model encounters new entity types.

## Related

- [Sociotechnical Graph Model](./sociotechnical-graph-model.md) — projections, formal properties, inter-projection edges
- [Theoretical Foundations](./theoretical-foundations.md) — abstraction levels, cognitive dimensions
- [Declarative Semantic Rules](./declarative-semantic-rules.md) — completeness model for Semantic projection
