# REG-124: Language Selection Research

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-06
**Status:** Research Complete

## 1. Research Methodology

### Sources Consulted
- Language benchmark comparisons (2024-2026)
- Production case studies: TypeScript rewrites (Microsoft TS->Go, OpenAI Codex->Rust, Ruff)
- Static analysis tool implementations (Semgrep, SWC, Biome, Oxc)
- WASM/FFI interop documentation and real-world usage
- AI code generation benchmarks (DevQualityEval, RustEvo2, Polyglot Benchmark)

### Search Queries Executed
1. "Rust vs OCaml vs Zig code analysis tools 2025 2026 comparison"
2. "best programming language for static analysis tools AST manipulation 2025"
3. "TypeScript rewrite to Rust success stories performance improvements 2024 2025"
4. "WASM FFI JavaScript interop Rust Go Zig OCaml comparison 2025"
5. "semgrep OCaml why choice language static analysis 2024"
6. "AI code generation quality Rust vs Python vs OCaml LLM benchmark 2025"
7. "Ruff Python linter Rust rewrite performance success 2024 2025"
8. "SWC Biome Rome tools Rust JavaScript rewrite success performance 2024 2025"
9. "OCaml compile WASM js_of_ocaml melange production 2025"

### Grafema Codebase Analysis
- **Total TypeScript:** ~70,000 lines
- **Core package:** ~48,000 lines
- **Key patterns:** Node type factories, AST traversal, graph operations, plugin system
- **Verbosity sources:** Boilerplate for node types, validation, option interfaces

---

## 2. Candidate Languages

Based on research, I've identified **5 viable candidates** ranked by overall fit for Grafema's use case.

### 2.1 Rust

**Category:** Systems language with strong type system

#### Strengths for Grafema
- **Proven track record:** Ruff (Python linter) is 150-200x faster than Flake8; SWC is 20x faster than Babel single-threaded, 70x on 4 cores
- **Mature WASM ecosystem:** wasm-bindgen is production-ready (Tier 2), used by major projects
- **Excellent for graph operations:** Zero-cost abstractions, memory-efficient data structures
- **Strong AI code generation:** DevQualityEval shows top LLMs achieve 99%+ on Rust coding tasks
- **Pattern matching:** Exhaustive match, ADTs (enums with data), Result/Option monads

#### Weaknesses/Risks
- **Learning curve:** Ownership/borrowing model requires significant investment
- **Verbosity concern:** Rust is NOT necessarily more concise than TypeScript; lifetime annotations can add ceremony
- **Compilation times:** Large projects have slow incremental builds (though improving)
- **Plugin FFI complexity:** Calling JS plugins from Rust WASM adds overhead

#### Notable Tools Built in Rust
- **Ruff** - Python linter (Astral) - production success
- **SWC** - JavaScript/TypeScript compiler - production at Vercel
- **Oxc** - JavaScript parser, 3x faster than SWC
- **Biome** (ex-Rome) - JS/TS formatter/linter
- **tree-sitter** - parser generator (core in C, bindings in Rust)

#### WASM/JS Interop
- **wasm-bindgen:** Mature, production-ready
- **wasm-pack:** Build tooling is solid
- **Performance:** Near-native in WASM, good JS call overhead
- **Status:** Best-in-class WASM story

#### Code Reduction Estimate
**1.5-2x** - Rust is expressive but not significantly more concise than TypeScript. Pattern matching helps, but lifetime annotations and explicit error handling add lines.

---

### 2.2 OCaml

**Category:** Functional language, compiler-writer's choice

#### Strengths for Grafema
- **Static analysis heritage:** Semgrep core is OCaml; Flow (Facebook's JS type checker) was OCaml
- **Pattern matching excellence:** Best-in-class ADTs, exhaustive matching, no runtime overhead
- **Conciseness:** Typically 2-3x fewer lines than equivalent Rust/TypeScript
- **Type inference:** Almost never need to write types explicitly
- **Fast native compilation:** Comparable to Rust for most workloads
- **WASM support maturing:** wasm_of_ocaml shows 2-8x speedup over js_of_ocaml

#### Weaknesses/Risks
- **Ecosystem size:** Smaller community than Rust
- **Windows support:** Historically problematic (Semgrep built WASM workaround for this)
- **AI code generation:** LLMs perform worse on OCaml than mainstream languages (sparse training data)
- **Hiring pool:** Fewer developers know OCaml

#### Notable Tools Built in OCaml
- **Semgrep** - polyglot static analysis (production at scale)
- **Flow** - JavaScript type checker (Meta)
- **Hack** - PHP type checker (Meta)
- **Infer** - static analyzer (Meta)
- **Coq** - proof assistant
- **Reason/ReScript** - JS-targeting ML variants

#### WASM/JS Interop
- **wasm_of_ocaml:** Production-ready as of 2025, merged with js_of_ocaml
- **Melange:** Alternative JS backend, used by Ahrefs
- **Performance:** 2-8x better than js_of_ocaml
- **Status:** Viable but requires more setup than Rust

#### Code Reduction Estimate
**2.5-4x** - OCaml's type inference, pattern matching, and functional style dramatically reduce boilerplate. Grafema's node type factories could be 1/3 the size.

---

### 2.3 Go

**Category:** Simple, pragmatic systems language

#### Strengths for Grafema
- **Proven for compilers:** Microsoft chose Go for TypeScript compiler rewrite (10x performance improvement)
- **Simplicity:** Easy to learn, easy to hire for
- **Fast compilation:** Near-instant builds
- **Strong concurrency:** Goroutines natural for parallel analysis
- **Built-in AST support:** Standard library has excellent go/ast, go/parser packages
- **Good AI code generation:** LLMs perform well on Go due to widespread training data

#### Weaknesses/Risks
- **No ADTs:** No sum types, pattern matching; must use interface{} or structs
- **Verbosity:** Error handling is repetitive (if err != nil)
- **Limited expressiveness:** No generics until recently, still limited
- **WASM story weaker:** Go WASM output is larger, slower than Rust

#### Notable Tools Built in Go
- **TypeScript compiler** (native port, in progress) - 10x faster
- **gopls** - Go language server
- **golangci-lint** - Go linter aggregator
- **go/analysis** - static analysis framework

#### WASM/JS Interop
- **TinyGo:** Better WASM output than standard Go
- **syscall/js:** Built-in JS interop, but clunky
- **Status:** Functional but not ideal

#### Code Reduction Estimate
**0.8-1.2x** - Go is often MORE verbose than TypeScript due to explicit error handling and lack of ADTs. Not recommended for code reduction.

---

### 2.4 Zig

**Category:** Modern systems language, C replacement

#### Strengths for Grafema
- **Performance:** Comparable to Rust, can outperform in specific cases
- **Simplicity:** Simpler than Rust (no borrow checker), more predictable
- **WASM target:** First-class WebAssembly support
- **No hidden allocations:** Explicit memory management, great for performance-critical code

#### Weaknesses/Risks
- **Immature ecosystem:** Much younger than Rust, fewer libraries
- **LLVM transition:** Moving away from LLVM may cause WASM stability issues temporarily
- **No ADTs:** Like Go, lacks sum types and pattern matching
- **Very small community:** Hard to hire, limited support
- **Poor AI code generation:** Very sparse training data for LLMs

#### Notable Tools Built in Zig
- **Bun** - JavaScript runtime (uses Zig for performance-critical parts)
- **zig-js** - JS interop library (but warns about stability)

#### WASM/JS Interop
- **Native support:** Zig compiles to WASM directly
- **zig-js:** Community library, not production-stable
- **Status:** Promising but immature

#### Code Reduction Estimate
**0.5-1x** - Zig is MORE verbose than TypeScript. Not suitable for code reduction goal.

---

### 2.5 F#

**Category:** Functional-first .NET language

#### Strengths for Grafema
- **ML heritage:** Pattern matching, ADTs, type inference like OCaml
- **Conciseness:** 2-3x more concise than C#/TypeScript
- **.NET ecosystem:** Access to mature libraries
- **Good tooling:** Ionide (VSCode), Fantomas (formatter)

#### Weaknesses/Risks
- **.NET dependency:** Requires .NET runtime, complicates deployment
- **WASM story unclear:** Blazor WASM exists but not ideal for CLI tools
- **Smaller community than OCaml:** In static analysis space
- **No major analysis tools:** Unlike OCaml (Semgrep) or Rust (Ruff)

#### Notable Tools Built in F#
- **Fantomas** - F# code formatter
- **FsAutocomplete** - F# language server
- **FAKE** - build system

#### WASM/JS Interop
- **Fable:** F# to JavaScript compiler (not WASM)
- **Blazor:** .NET WASM, but heavy runtime
- **Status:** Not recommended for our use case

#### Code Reduction Estimate
**2-3x** - Similar to OCaml but ecosystem concerns.

---

## 3. Comparison Matrix

| Criterion | Rust | OCaml | Go | Zig | F# |
|-----------|------|-------|----|----|-----|
| **Code Reduction** | 1.5-2x | 2.5-4x | 0.8-1.2x | 0.5-1x | 2-3x |
| **Performance** | Excellent | Very Good | Good | Excellent | Good |
| **Pattern Matching** | Good | Excellent | None | None | Excellent |
| **WASM Maturity** | Excellent | Good | Fair | Fair | Poor |
| **AI Code Gen** | Good | Poor | Good | Poor | Fair |
| **Ecosystem Size** | Large | Medium | Large | Small | Small |
| **Static Analysis Tools** | Many | Several | Some | Few | Few |
| **Learning Curve** | Steep | Medium | Easy | Medium | Medium |
| **Hiring Pool** | Growing | Small | Large | Tiny | Small |

---

## 4. Initial Recommendation: Top 3 for Benchmarks

### Primary Recommendation: OCaml

**Rationale:**
1. **Best code reduction potential (2.5-4x)** - directly addresses primary problem
2. **Proven for static analysis** - Semgrep demonstrates it works at scale
3. **Pattern matching excellence** - Grafema's node type handling would be dramatically simpler
4. **WASM story improved** - wasm_of_ocaml is now production-ready

**Risk Mitigation:**
- AI code generation weakness is concerning but manageable with good documentation
- Windows support solved via WASM (Semgrep's approach)

### Secondary Recommendation: Rust

**Rationale:**
1. **Proven at scale** - Ruff, SWC, Biome demonstrate viability
2. **Best WASM ecosystem** - lowest risk for JS plugin interop
3. **Strong AI code generation** - Claude/GPT perform well
4. **Growing ecosystem** - more libraries, more help available

**Risk Mitigation:**
- Lower code reduction (1.5-2x) than OCaml, may not hit 3-5x target
- Learning curve requires investment

### Tertiary Consideration: Hybrid Approach

Consider:
- **Rust for RFDB** (graph database core) - performance-critical, already Rust
- **OCaml for analysis engine** - pattern matching, code expressiveness
- **TypeScript for plugins** - maintain current plugin ecosystem

This would require FFI boundary design but plays to each language's strengths.

---

## 5. Key Trade-offs for Benchmark Phase

### OCaml vs Rust

| Factor | Favors OCaml | Favors Rust |
|--------|-------------|-------------|
| Code conciseness | Yes | No |
| Pattern matching | Yes | Partial |
| WASM maturity | No | Yes |
| AI assistance quality | No | Yes |
| Static analysis track record | Yes | Emerging |
| Team learning curve | Depends | Steeper |
| Long-term ecosystem | Stable | Growing |

### Benchmark Tasks to Evaluate

1. **Node Type Definition** - Compare boilerplate for 5 node types
2. **AST Visitor Pattern** - Implement tree traversal with pattern matching
3. **Graph Query** - Simple Datalog-like query on node graph
4. **WASM Interop** - Call JS function from compiled core, measure overhead
5. **AI Code Generation** - Have Claude generate same module in both, compare quality

### Success Criteria for Benchmarks

- **Code reduction:** Must achieve 2.5x+ to justify rewrite investment
- **Performance:** Must match or exceed current TypeScript (should be easy)
- **WASM overhead:** JS interop latency must be <1ms for typical operations
- **Maintainability:** Code must be readable by team after 1 week learning

---

## 6. Excluded Languages with Rationale

| Language | Reason for Exclusion |
|----------|---------------------|
| **Go** | Verbosity concern; no ADTs; WASM story weak; doesn't solve core problem |
| **Zig** | Immature ecosystem; no pattern matching; poor AI support |
| **F#** | .NET dependency; weak WASM story; no production precedent |
| **Haskell** | Too academic; lazy evaluation concerns; poor WASM support |
| **Nim** | Small ecosystem; limited static analysis tools; untested at scale |
| **Elixir** | Wrong paradigm (actor model); poor for graph operations |

---

## 7. Next Steps

1. **Joel (Implementation Planner):** Design benchmark protocol with specific code samples
2. **Benchmark Implementation:** Implement same module in OCaml and Rust
3. **Evaluation:** Measure LOC, performance, WASM overhead, AI generation quality
4. **Decision:** Based on benchmark results, recommend final language choice

---

## Sources

- [Ruff - Python linter in Rust](https://github.com/astral-sh/ruff)
- [Semgrep OCaml Tree-Sitter](https://github.com/semgrep/ocaml-tree-sitter-core)
- [Microsoft TypeScript Native Port](https://devblogs.microsoft.com/typescript/typescript-native-port/)
- [Rust wasm-bindgen Guide](https://rustwasm.github.io/docs/wasm-bindgen/)
- [wasm_of_ocaml](https://github.com/ocaml-wasm/wasm_of_ocaml)
- [Semgrep Static Analysis Journey](https://semgrep.dev/blog/2021/semgrep-a-static-analysis-journey/)
- [Go AST Tooling](https://eli.thegreenplace.net/2021/rewriting-go-source-code-with-ast-tooling/)
- [OpenAI Codex Rust Rewrite](https://www.infoq.com/news/2025/06/codex-cli-rust-native-rewrite/)
- [Zig WebAssembly](https://zigwasm.org/)
- [Oxc Benchmarks](https://oxc.rs/docs/guide/benchmarks)
- [JetBrains Rust vs JS/TS](https://blog.jetbrains.com/rust/2026/01/27/rust-vs-javascript-typescript/)
