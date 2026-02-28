# Plugin Development Workflow

How to build a Grafema language plugin — from syntax corpus to working analyzer.

## Prior Art & Theoretical Foundation

This workflow is informed by research in program analysis and multi-language tooling.
Key references that validate and extend our approach:

### Graph as Primary Representation

- **Code Property Graphs** (Yamaguchi et al., IEEE S&P 2014) — merges AST+CFG+PDG into one property graph. Closest academic precedent to Grafema's graph model. Their "overlays" (optional analysis passes) = our enrichers. Key difference: CPGs are AST-level (expression nodes); Grafema is semantic-level (FUNCTION, CLASS, VARIABLE nodes).
- **Program Analysis via Graph Reachability** (Reps, 1997) — proved that interprocedural analysis reduces to graph reachability. Grafema's graph + Datalog architecture directly implements this insight.
- **System Dependence Graphs** (Horwitz, Reps, Binkley, 1988) — introduced "summary edges" for transitive dependences. Suggests Grafema should pre-compute transitive relationships as cached edges.

### Datalog for Queries

- **Doop** (Bravenboer & Smaragdakis, OOPSLA 2009) — expressed pointer analysis entirely in Datalog, achieved 15x better performance than imperative implementations. Validates pushing more analysis logic into Datalog rules rather than imperative enricher code.

### Multi-Language Architecture

- **CodeQL** (GitHub/Semmle) — industry gold standard. Architecture: language-specific extractors → relational database → QL queries. **"Models as Data" (MaD)** allows modeling library/framework behavior via declarative CSV/YAML — no source code needed. This is the pattern Grafema should adopt for framework plugins.
- **Joern** (open-source CPG platform) — 18-layer CPG schema, language frontends built on common `x2cpg` base. Supports 12+ languages. Plugins can extend the schema with new node/edge types.
- **Semgrep** — uses tree-sitter → Generic AST → pattern matching. Shallower than CodeQL/Grafema but supports 30+ languages quickly.
- **LiSA** (Negrini, Ferrara et al., 2023) — generic framework for multilanguage static analysis via abstract interpretation. Language frontends → common IR → pluggable abstract domains.

### JavaScript-Specific

- **TAJS** (Jensen, Møller, Thiemann, SAS 2009) — type analysis for JS. **Explicitly separates** ECMAScript semantics from browser/DOM model. The DOM paper (ESEC/FSE 2011) adds browser API as a separate layer. Direct validation of our layered approach.
- **Madsen, Tip, Lhoták (OOPSLA 2015)** — static analysis for Node.js. Showed that server-side JS requires modeling async execution semantics, not just API signatures. Runtime layers must capture execution models.
- **Feldthaus et al. (ICSE 2013)** — approximate call graphs for JS. Proved that unsound/approximate analysis is pragmatically sufficient for IDE services. Validates Grafema's pragmatic approach.
- **Jelly** (Møller et al., 2023-2024) — latest JS/TS analyzer. "Approximate interpretation" technique bridges static and dynamic analysis.
- **SAFE** (KAIST) — automatic modeling from API specifications. Suggests generating runtime/library models semi-automatically from TypeScript type definitions.

### Test Corpus Methodology

- **Test262** (TC39) — 50,000+ ECMAScript conformance tests. Structure mirrors the spec: `language/` (syntax) vs `built-ins/` (stdlib) vs `annexB/` (legacy browser). Validates our layered corpus organization.
- **Tree-sitter test corpus** — "test all permutations of each language construct." Input + expected AST structure pairs.

### Novel Contribution

Grafema's combination is not found in literature:
- Semantic-level (not AST-level) graph representation
- Designed for AI agent consumption (not human security analysts)
- Targeting untyped legacy codebases (not TypeScript/Java)
- Graph + Datalog + declarative enrichers

Closest: GraphGen4Code (IBM/WALA) — code knowledge graphs for AI, but retrospective (1.3M files batch), not interactive.

---

## The Five Layers

Every language has multiple layers of "what's available." The analysis must be layered accordingly.

| Layer | What | Analyzer | Example (JS) | Example (PHP) |
|-------|------|----------|-------------|---------------|
| **1. Language syntax** | Grammar constructs | Base analyzer | `class`, `async`, `=>`, `const` | `class`, `match`, `fn() =>` |
| **2. Standard library** | Always-available types/functions | Base analyzer (builtins) | `Array.map`, `Object.keys`, `Math` | `array_map`, `strlen`, `DateTime` |
| **3. Runtime stdlib** | Environment-specific stdlib | Runtime plugin | Node: `fs`, `http`; Browser: `document`, `fetch` | CLI: `readline`; FPM: `$_SERVER` |
| **4. Runtime APIs** | Platform APIs | Runtime plugin | `Worker`, `IndexedDB`, `cluster` | Extensions: `pdo`, `gd`, `redis` |
| **5. Framework APIs** | Framework-specific patterns | Framework plugin | Express routes, React components, NestJS decorators | Laravel facades, Symfony DI |

**Severity of layer divergence by language:**

| Language | Layer 1-2 | Layer 3-4 | Layer 5 | Assessment |
|----------|-----------|-----------|---------|------------|
| JavaScript | Unified (ECMAScript) | **Radically divergent** (Node/Browser/Deno/Bun/CF Workers) | Massive ecosystem | Hardest |
| Python | Unified (CPython mostly) | Moderate (CPython/PyPy/MicroPython) | Large (Django/Flask/FastAPI) | Medium |
| PHP | Unified (Zend) | Moderate (extensions: pdo, gd, imagick) | Large (Laravel/Symfony) | Medium |
| Java | JDK-defined | Moderate (JDK vs Android SDK) | Large (Spring/Jakarta) | Medium-low |
| Ruby | MRI dominant | Low (JRuby niche) | Moderate (Rails) | Low |
| Go | One runtime | Trivial | Moderate | Trivial |
| Rust | One runtime | Trivial (std/no_std) | Growing | Trivial |

---

## Phase 1: Syntax Corpus

**Goal:** Enumerate ALL constructs the analyzer must handle. This becomes the test suite.

### 1.1 Initial Enumeration

For target language, create fixture files organized by construct category:
```
test/fixtures/syntax-corpus-{lang}/src/
  declarations.{ext}       # variable declarations, function declarations
  expressions.{ext}        # operators, calls, templates, constructors
  statements.{ext}         # control flow, loops, labels
  patterns.{ext}           # destructuring, default values, rest/spread
  classes.{ext}            # inheritance, static, private, decorators
  async-generators.{ext}   # promises, async/await, generators, iterators
  closures.{ext}           # scope, hoisting, IIFE, captured variables
  modules.{ext}            # import/export, re-exports, dynamic import
  types.{ext}              # type annotations (if typed language)
  ...
```

Each construct gets a `@construct PENDING <category>` marker:
```js
// @construct PENDING var-decl-init
let count = 0;
```

Source: language specification, grammar reference, ecosystem patterns.

### 1.2 Separate Concerns

Create separate files for constructs requiring plugins:
```
runtime-apis.{ext}        # Runtime-specific APIs → needs runtime plugin
jsdoc-types.{ext}         # JSDoc/PHPDoc types → needs doc-comment plugin
legacy-patterns.{ext}     # Legacy module systems, polyfills, compiled output
```

Each plugin-territory file gets a header explaining:
- What plugin would handle it
- Why it can't be handled by the base analyzer
- What graph edges the plugin would produce

### 1.3 Adversarial Review

Run N rounds of "what's missing?" review. Each round:
1. Read the entire corpus
2. Cross-reference with language spec / Test262 / real-world patterns
3. Document gaps in GAPS.md
4. Triage: language construct → existing file; runtime API → plugin file
5. Add constructs, update counts

Stop when rounds yield diminishing returns.

### 1.4 Deliverable

- `GRAPH-SPEC.md` — manifest with principles, task categories, process, statistics
- `GAPS.md` — adversarial review notes (history of what was found and integrated)
- Fixture files with `@construct PENDING` markers covering the language
- Statistics: N files, M constructs, K rounds of review

---

## Phase 2: Graph Annotation

**Goal:** For each `@construct PENDING`, define EXACTLY what nodes and edges it should produce.

### 2.1 Annotation Format

```js
// @construct PENDING var-decl-init
// SCOPE <module> -> DECLARES -> VARIABLE <count>
// VARIABLE <count> {declarationKind: 'let'} -> INITIALIZES -> NUMBER_LITERAL <0>
let count = 0;
```

Rules:
- One line per node or edge
- Node format: `<TYPE> <id> {metadata}`
- Edge format: `<SOURCE> -> <EDGE_TYPE> -> <TARGET>`
- Bottom-up discovery: vocabulary emerges from constructs, not the other way around

### 2.2 Approval

Human reviews each annotation: `PENDING → APPROVED`.
Collect approved annotations to build the edge/node type vocabulary.

### 2.3 Trait Definition

After all constructs are annotated, group edge types into overlapping sets (traits)
for query purposes. E.g., "data flow" trait = {INITIALIZES, REASSIGNS, FLOWS_INTO, RETURNS, ...}.

### 2.4 Deliverable

- All constructs annotated with expected graph representation
- Node type vocabulary (FUNCTION, CLASS, VARIABLE, PARAMETER, ...)
- Edge type vocabulary (CALLS, CONTAINS, IMPORTS, EXTENDS, ...)
- Trait definitions (data-flow, control-flow, type-system, ...)

---

## Phase 3: Implementation

**Goal:** Build the analyzer that turns source code into the specified graph.

### 3.1 Parser Integration

Choose parser for the language:
- **tree-sitter** — fast, incremental, available for most languages. Good default.
- **Babel** (JS/TS) — full AST, JSX support, plugin ecosystem
- **php-parser** (PHP) — nikic/php-parser, the standard
- **Language-specific** — use whatever the language community uses

### 3.2 Base Analyzer

Walks the AST, creates nodes and edges for Layer 1-2 constructs:
- Declaration nodes (FUNCTION, CLASS, VARIABLE, PARAMETER)
- Structural edges (CONTAINS, DECLARES)
- Call edges (CALLS, INSTANTIATES)
- Module edges (IMPORTS, EXPORTS)
- Type edges (EXTENDS, IMPLEMENTS) — from syntax, not JSDoc

### 3.3 Plugin Enrichers

Each plugin adds semantic edges for its layer:
- **Runtime plugin** — models execution environment (Node: EventEmitter → CALLS; Browser: addEventListener → CALLS)
- **Type plugin** — extracts types from doc comments (JSDoc, PHPDoc, docstrings)
- **Framework plugin** — models framework patterns (route handlers, DI, decorators)

**Key insight from CodeQL MaD:** Framework knowledge should be declarative data, not imperative code:
```yaml
framework: express
patterns:
  - type: route_handler
    pattern: "app.{get,post,put,delete}(path, handler)"
    creates: [ENDPOINT node, CALLS edge to handler]
```

### 3.4 Golden Tests

Corpus files from Phase 1 become test fixtures.
Annotations from Phase 2 become expected results.
Each `@construct APPROVED` = one test case.

### 3.5 Deliverable

- Working analyzer producing correct graph for all approved constructs
- Plugin enrichers for relevant layers
- Test suite passing for all golden file fixtures

---

## Phase 4: Validation

**Goal:** Verify the analyzer matches the spec across all constructs.

### 4.1 Snapshot Testing

Run analyzer on corpus fixtures, compare graph output to expected annotations.
`@construct APPROVED` that doesn't match = bug or spec update.

### 4.2 Real-World Validation

Run analyzer on real codebases. Compare graph quality to manual inspection.
Gaps between spec and reality → new tasks.

### 4.3 Dogfooding

Use the graph to answer real questions about the analyzed codebase.
If reading code gives better results than querying Grafema — that's a product gap.

---

## Process Invariant

```
Language Spec
  → Corpus (fixture files with @construct markers)
    → Annotations (expected nodes + edges per construct)
      → Implementation (analyzer code)
        → Golden tests (corpus + annotations = test suite)
```

Each phase validates against the previous one. Corpus checks against language spec.
Annotations check against graph tasks (GRAPH-SPEC.md). Implementation checks against annotations.

For a new language — same process, different corpus.

---

## References

### Foundational
- Cousot & Cousot, "Abstract Interpretation" (POPL 1977)
- Reps, "Program Analysis via Graph Reachability" (1997)
- Horwitz, Reps, Binkley, "Interprocedural Slicing Using Dependence Graphs" (PLDI 1988)
- Bravenboer & Smaragdakis, "Doop: Declarative Points-to Analysis" (OOPSLA 2009)

### Graph-Based Code Representations
- Yamaguchi et al., "Code Property Graphs" (IEEE S&P 2014) — https://ieeexplore.ieee.org/document/6956589/
- Joern CPG Specification — https://cpg.joern.io/

### Multi-Language Tools
- CodeQL Architecture — https://deepwiki.com/github/codeql
- CodeQL Models as Data — https://codeql.github.com/docs/codeql-language-guides/customizing-library-models-for-javascript/
- Semgrep Architecture — https://deepwiki.com/semgrep/semgrep
- LiSA Framework (Negrini, Ferrara et al., 2023)

### JavaScript-Specific
- TAJS (Jensen, Møller, Thiemann, SAS 2009) — https://github.com/cs-au-dk/TAJS
- Jensen, Madsen, Møller, "Modeling the HTML DOM and Browser API" (ESEC/FSE 2011)
- Madsen, Tip, Lhoták, "Static Analysis of Event-Driven Node.js" (OOPSLA 2015)
- Feldthaus et al., "Approximate Call Graphs for JavaScript" (ICSE 2013)
- Jelly JS/TS Analyzer — https://github.com/cs-au-dk/jelly
- SAFE Framework — https://github.com/kaist-plrg/safe

### Test Corpus Methodology
- Test262 ECMAScript Conformance Suite — https://github.com/tc39/test262
- Tree-sitter Test Writing — https://tree-sitter.github.io/tree-sitter/creating-parsers/5-writing-tests.html

### IR Surveys
- Zhang et al., "Unveiling the Power of IRs for Static Analysis" (arXiv 2024)
- "Challenges of Multilingual Program Specification and Analysis" (arXiv 2024)
