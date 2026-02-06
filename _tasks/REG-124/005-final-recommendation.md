# REG-124: Final Recommendation

**Author:** Research Team
**Date:** 2026-02-06
**Status:** Research Complete

---

## Executive Summary

**Recommendation: Rust** as the primary language for Grafema core rewrite.

| Criterion | OCaml | Rust | Winner |
|-----------|-------|------|--------|
| Code Reduction | 63% | 58% | OCaml |
| WASM Maturity | Good | Excellent | **Rust** |
| AI Code Generation | Poor | Good | **Rust** |
| Ecosystem Size | Medium | Large | **Rust** |
| Existing Codebase | None | RFDB Server (14.5K LOC) | **Rust** |
| Learning Curve | Medium | Steep | OCaml |
| Static Analysis Track Record | Semgrep, Flow, Infer | Ruff, SWC, Biome, Oxc | Tie |

**Key Decision Factor:** Grafema already has 14.5K LOC of production Rust in `rfdb-server`. Choosing Rust means:
- One language for the entire core (analysis engine + graph database)
- Existing patterns and infrastructure to build on
- No FFI boundary between analysis and storage

---

## Quantitative Results

### Benchmark: ExpressionNode

| Language | LOC | Reduction vs TypeScript |
|----------|-----|-------------------------|
| TypeScript (current) | 233 | baseline |
| Rust | 98 | **-58%** |
| OCaml | 87 | **-63%** |

Both languages achieve significant reduction through ADTs (Algebraic Data Types), pattern matching, and compile-time validation.

### Projected Full Migration

Based on codebase analysis (47.9K LOC in core):

| Scenario | Rust LOC | OCaml LOC | TypeScript Remaining |
|----------|----------|-----------|---------------------|
| Optimistic (60% reduction) | 5,400 | 4,800 | 17,500 |
| Realistic (50% reduction) | 6,750 | 6,000 | 17,500 |
| Conservative (40% reduction) | 8,100 | 7,200 | 17,500 |

**Note:** TypeScript remaining = CLI + MCP + Types boundary + TS-based plugins (~17.5K LOC).

---

## Why Rust Over OCaml

### 1. Existing Investment (Critical Factor)

```
grafema/
├── packages/
│   ├── rfdb-server/     # 14.5K LOC Rust - ALREADY EXISTS
│   ├── core/            # 47.9K LOC TypeScript - TO MIGRATE
│   └── ...
```

RFDB Server is production Rust code with:
- Unix socket communication
- Graph storage operations
- Node/edge CRUD
- Query execution

Choosing Rust means the entire core stack (analysis + storage) speaks one language.

### 2. WASM Ecosystem Maturity

| Aspect | Rust | OCaml |
|--------|------|-------|
| Primary tool | wasm-bindgen (Tier 2) | wasm_of_ocaml (recent) |
| Production usage | SWC, Biome, Ruff, Figma | Semgrep (via workaround) |
| JS interop | First-class | Requires careful setup |
| Bundle size | Optimized | Larger |
| Documentation | Extensive | Limited |

### 3. AI Code Generation

| LLM Performance | Rust | OCaml |
|-----------------|------|-------|
| DevQualityEval success rate | 99%+ | Not measured |
| Training data availability | Extensive (GitHub, crates.io) | Sparse |
| Claude/GPT familiarity | High | Low |

For an AI-first tool where Claude generates code, this matters significantly.

### 4. Ecosystem & Hiring

| Metric | Rust | OCaml |
|--------|------|-------|
| GitHub repos | 500K+ | ~50K |
| Package registry | 150K+ crates | ~5K opam packages |
| Stack Overflow questions | 150K+ | ~15K |
| Job postings (2025) | Growing rapidly | Niche |

### 5. When OCaml Would Win

OCaml would be the better choice if:
- Starting from scratch (no existing Rust code)
- Team has ML/Haskell background
- Primary goal is maximum code conciseness
- Academic/research context

---

## Trade-offs to Accept

### With Rust

**Accepting:**
- Steeper learning curve (ownership, borrowing)
- Slightly more verbose than OCaml (~5% more LOC)
- Longer compilation times for large projects
- Pattern matching not as elegant as OCaml

**Gaining:**
- Unified codebase with RFDB
- Best-in-class WASM story
- Strong AI code generation support
- Growing ecosystem and community
- Excellent tooling (rust-analyzer, cargo)

### Migration Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Learning curve | Start with simple node types, learn incrementally |
| Swc compatibility | Run full test suite against Babel baseline |
| WASM overhead | Batch graph operations, measure latency early |
| Plugin ecosystem | Keep TS plugin interface stable, deprecate gradually |

---

## Implementation Strategy

### Phase 1: Node Types (Month 1-2)

**Goal:** Prove the pattern works.

1. Migrate 5 node types to Rust ADTs
2. Create WASM boundary with TypeScript type bindings
3. Measure: LOC, compile time, runtime performance
4. Validate: Tests pass, output identical to TypeScript

**Success Criteria:**
- 50%+ LOC reduction on node types
- All existing tests pass
- WASM boundary latency <1ms per operation

### Phase 2: AST Analysis (Month 2-3)

**Goal:** Replace Babel with Swc.

1. Integrate Swc parser
2. Migrate visitors to Rust pattern matching
3. Create parallel analysis pipeline
4. Benchmark against current TypeScript

**Success Criteria:**
- 2x+ performance improvement
- Feature parity with Babel-based analysis
- 40%+ LOC reduction in visitor code

### Phase 3: Graph Operations (Month 3-4)

**Goal:** Unify analysis engine with RFDB.

1. Direct Rust calls to RFDB (no unix socket for same-process)
2. Migrate graph builders
3. Implement enricher trait system

**Success Criteria:**
- 50%+ reduction in graph operation latency
- Simplified architecture (no IPC for core operations)

### Phase 4: Plugin System (Month 4-6)

**Goal:** Support both Rust and TypeScript plugins.

1. Define plugin trait in Rust
2. WASM bridge for TypeScript plugins
3. Migrate framework-specific plugins gradually
4. Maintain backward compatibility

**Success Criteria:**
- All current plugins work (via WASM)
- New plugins can be written in Rust
- No breaking changes to plugin API

---

## Architecture Comparison

### Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TypeScript (CLI/MCP)                      │
├─────────────────────────────────────────────────────────────┤
│                    TypeScript (Core)                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │  Nodes   │ │ Visitors │ │ Enrichers│ │ Orchestrator │   │
│  │  (4K)    │ │  (4K)    │ │  (3.5K)  │ │    (1K)      │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │
├─────────────────────────────────────────────────────────────┤
│              Unix Socket IPC                                 │
├─────────────────────────────────────────────────────────────┤
│                    Rust (RFDB Server)                        │
│                       14.5K LOC                              │
└─────────────────────────────────────────────────────────────┘
```

### Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TypeScript (CLI/MCP)                      │
│                       ~10K LOC                               │
├─────────────────────────────────────────────────────────────┤
│                    WASM Boundary                             │
├─────────────────────────────────────────────────────────────┤
│                    Rust (Unified Core)                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │  Nodes   │ │ Visitors │ │ Enrichers│ │ Orchestrator │   │
│  │  (~1.5K) │ │  (~2K)   │ │  (~1.5K) │ │   (~0.5K)    │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                  RFDB (Graph Storage)                 │   │
│  │                      14.5K LOC                        │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Benefits:**
- No IPC overhead for core operations
- Single language for debugging
- Shared types between analysis and storage
- Parallel analysis without worker thread overhead

---

## Decision Matrix

| Factor | Weight | Rust Score | OCaml Score |
|--------|--------|------------|-------------|
| Code reduction | 25% | 8/10 | 9/10 |
| WASM maturity | 20% | 10/10 | 7/10 |
| Existing codebase | 20% | 10/10 | 0/10 |
| AI code generation | 15% | 9/10 | 4/10 |
| Ecosystem | 10% | 9/10 | 6/10 |
| Learning curve | 10% | 5/10 | 7/10 |

**Weighted Score:**
- **Rust:** 8.45/10
- **OCaml:** 5.70/10

---

## Recommendation

**Primary:** Migrate Grafema core to Rust.

**Rationale:**
1. Already have 14.5K LOC production Rust in RFDB
2. Best WASM ecosystem for JS interop
3. Strong AI code generation support
4. Achieves ~58% code reduction (vs 63% for OCaml)
5. Unified language stack simplifies architecture

**Not Recommended:**
- OCaml: Despite better code reduction, no existing codebase and weaker WASM/AI story
- Go: Does not achieve code reduction goal
- Zig: Ecosystem too immature
- F#: .NET dependency, weak WASM story

---

## Next Steps

1. **Create REG-XXX:** "Migrate ExpressionNode to Rust" as proof-of-concept
2. **Set up Rust/WASM build pipeline** in monorepo
3. **Define WASM boundary types** in `@grafema/types`
4. **Benchmark real-world analysis** on sample project
5. **Document migration patterns** for other node types

---

## Appendix: Research Artifacts

| Document | Content |
|----------|---------|
| `002-don-language-research.md` | Language candidate analysis, prior art research |
| `003-codebase-migration-map.md` | What moves to Rust, what stays in TypeScript |
| `004-benchmark-expression-node.md` | Full Rust/OCaml implementations with LOC comparison |
| `005-final-recommendation.md` | This document |
