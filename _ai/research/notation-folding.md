# Notation Folding — Formal Theory of Structural Compression

**Status:** Research / Draft
**Date:** 2026-03-11
**Depends on:** `visual-language.md` (archetypes, LOD, summarization)
**Problem origin:** `server.ts` at LOD 2 produces 130+ lines — nearly as long as the source. 36 identical `o- imports from handleXxx` blocks provide zero insight.

## I. The Problem

The existing notation pipeline has three mechanisms for managing information volume:

| Mechanism | Controls | When it fires |
|-----------|----------|---------------|
| **LOD** | Vertical depth (how many containment levels) | Always — user picks 0/1/2 |
| **Budget** | Horizontal count (how many items per group) | When `lines.length > budget` |
| **Perspective** | Archetype filter (which relation types visible) | When user specifies perspective |

**What's missing:** None of these handle **structural repetition among siblings**. When a MODULE contains 36 IMPORT children that all have the shape `{ o- imports from X }`, each child is unique (different name, different target), so:

- **LOD** can't help — they're all at the same depth level, and reducing LOD hides ALL children, including interesting ones.
- **Budget** can't help — budget operates on *lines within a block*, not on *sibling blocks*. Each import block has 1 line, so no budget triggers.
- **Perspective** can't help — imports use the `depends` archetype, and filtering out `depends` removes ALL dependency information, not just the repetitive part.

**Result:** Verbose output where the signal-to-noise ratio approaches zero. The notation restates the source code instead of compressing it.

## II. Core Insight: Surprisal-Driven Compression

A sequence of sibling blocks `[B₁, B₂, ..., Bₙ]` is compressible when blocks share structural shape. The principle: **items predictable from the group pattern carry near-zero information; only deviations (anomalies) carry signal.**

For 36 import blocks with identical structure:
- Unfolded: 36 × 2 lines = 72 lines
- Folded: "36 imports from handlers/index.js" ≈ 1 line
- Compression ratio: 72:1

The information content of the repetitive part is near-zero (each block is predictable from the pattern). The useful information is entirely in: (a) the pattern itself, (b) the count, (c) any **anomalies** that deviate from the pattern.

## III. Formal Definitions

### 3.1 Block Signature

**Definition.** The *signature* of a notation block `B = (id, type, name, lines, children)` is:

```
σ(B) = (type, L, |children|)
```

where `L = {(op, verb) | line ∈ B.lines}` is the multiset of (operator, verb) pairs, ignoring targets.

Two blocks `B₁, B₂` are **signature-equivalent** (`B₁ ≡_σ B₂`) iff `σ(B₁) = σ(B₂)`.

**Intuition:** Signature-equivalent blocks "do the same thing structurally" — they have the same node type, the same pattern of edges (same operators and verbs), and the same number of nested children. They differ only in names and specific targets.

### 3.2 Sibling Group

**Definition.** A *sibling group* `G` is a maximal subset of children of a single parent block where all members share the same signature:

```
G = {Bᵢ | Bᵢ ∈ parent.children, σ(Bᵢ) = σ_G}
```

### 3.3 Homogeneity Ratio

**Definition.** The *homogeneity ratio* of a parent block P is:

```
h(P) = max(|G|) / |P.children|
```

where the max is over all sibling groups G in P.

- `h(P) = 1.0` → all children are structurally identical (pure repetition)
- `h(P) = 1/n` → all children are structurally unique (no repetition)

### 3.4 Anomaly

**Definition.** Given a sibling group G with signature σ_G, an *anomaly* is any sibling of G's parent that does NOT belong to G:

```
anomalies(P, G) = {B ∈ P.children | σ(B) ≠ σ_G}
```

Anomalies are **never folded**. They carry high surprisal (information content) precisely because they deviate from the dominant pattern.

## IV. Folding Rules

### Rule 1: Group Fold (Homogeneous Siblings)

**Precondition:** Sibling group G with |G| > threshold T (default: T = 3).

**Transform:**

```
BEFORE (|G| = 36):
  handleQueryGraph { o- imports from handleQueryGraph }
  handleFindCalls { o- imports from handleFindCalls }
  handleFindNodes { o- imports from handleFindNodes }
  ... (33 more)

AFTER:
  o- imports 36 handlers from ./handlers/index.js
```

**Formal rule:** Replace sibling group G = {B₁, ..., Bₙ} with a *fold node* F:

```
F = (
  count: n,
  signature: σ_G,
  verb_summary: derived from shared (op, verb) pairs,
  source_summary: common source if all targets resolve to same module,
  exemplar: B₁ (first member, always shown expanded)
)
```

**Exemplar principle:** A fold ALWAYS includes one fully-expanded member as a concrete example. The reader sees the pattern by example, not by description. Without an exemplar, the fold is opaque — the reader must mentally reconstruct what "36 imports" looks like. With an exemplar, the pattern is self-evident.

```
BEFORE (36 identical blocks):
  handleQueryGraph { o- imports from handleQueryGraph }
  handleFindCalls { o- imports from handleFindCalls }
  ... (34 more)

AFTER (fold with exemplar):
  handleQueryGraph { o- imports from handleQueryGraph }   ← exemplar
  ...+35 more handlers from ./handlers/index.js           ← fold summary
```

The exemplar is the **first** member of the group (preserving original order). For Rules 8-11 (chain folds), the exemplar is the full chain shown once, with the fold summary indicating repetitions.

**What the fold preserves:**
- The count (36)
- The structural pattern — shown concretely via exemplar, not described abstractly
- The common source (./handlers/index.js)

**What the fold compresses:**
- The 35 remaining members identical to the exemplar — recoverable by expanding the fold

### Rule 2: Anomaly Preservation

**Invariant:** If parent P has a dominant sibling group G with |G| ≥ ceiling(|P.children| × 0.5), all non-G children are anomalies and MUST be shown individually.

```
server.ts {
  handleQueryGraph { o- imports from handleQueryGraph }   ← exemplar
  ...+35 more handlers from ./handlers/index.js           ← fold summary

  o- imports Server, StdioServerTransport from @mcp/sdk   ← anomaly (different source)
  o- imports 4 schemas from @mcp/sdk/types                ← anomaly (different source)

  asArgs<T>() { > returns ?? }        ← anomaly (FUNCTION, not IMPORT)
  main() { > awaits server.connect }  ← anomaly
  <arrow>() { > dispatches ... }      ← anomaly
}
```

**Formal rule:** Given dominant group G:
1. Render F (fold node) for G
2. Render each B ∈ anomalies(P, G) individually
3. Order: fold first, then anomalies in original order

### Rule 3: Source Aggregation (within a fold)

When all targets in a fold resolve to the same source MODULE, collapse further:

```
BEFORE (fold of 36 imports):
  fold: 36 imports, each "o- imports from <name>"

AFTER (with source aggregation):
  o- imports 36 handlers from ./handlers/index.js
```

When targets come from K different sources:

```
  o- imports 20 handlers from ./handlers/index.js, 10 types from ./types.js, 6 utils from ./utils.js
```

**Formal rule:** Group fold members by `target_module(Bᵢ)`, render one sub-line per unique source.

### Rule 4: Deduplication

**Precondition:** Two or more sibling blocks share the same semantic ID.

**Transform:** Keep the block with the richest subgraph (most lines + children). Discard duplicates.

**Formal rule:**

```
dedup(siblings) = {
  for each unique id ∈ siblings.map(b => b.nodeId):
    keep argmax(b, |b.lines| + |b.children|) where b.nodeId == id
}
```

This addresses the `server.ts` problem where `asArgs` and `main` appear twice, and multiple unnamed `function` blocks appear.

### Rule 5: Structural-Only Suppression

**Precondition:** A child block at LOD 2 has lines containing ONLY containment-class edges (all operators are empty) or has no lines and no children.

**Transform:** Inline the child as a name in the parent's containment list rather than expanding as a block.

```
BEFORE:
  CallToolRequestSchema  (server.ts:1137)
  ListToolsRequestSchema  (server.ts:1162)
  ListPromptsRequestSchema  (server.ts:1188)
  GetPromptRequestSchema  (server.ts:1216)
  ToolResult  (server.ts:2419)
  ReportIssueArgs  (server.ts:2433)
  ...

AFTER:
  [imports: CallToolRequestSchema, ListToolsRequestSchema, ...]
  [types: ToolResult, ReportIssueArgs, GetDocumentationArgs, ...]
```

**Formal rule:** A block B is *structurally trivial* if:

```
trivial(B) = (B.lines = ∅) ∧ (B.children = ∅)
           ∨ (∀ line ∈ B.lines: line.operator = '')
```

Trivial blocks are not expanded; they are listed as names in a summary line grouped by node type.

## V. Folding Algorithm

```
fold(parent: NotationBlock) → NotationBlock:
  1. DEDUP: Remove duplicate semantic IDs (Rule 4)
  2. PARTITION: Group children by signature → sibling groups
  3. For each sibling group G where |G| > threshold:
     a. FOLD: Replace G with fold node F (Rule 1)
     b. AGGREGATE: If all F targets share source, aggregate (Rule 3)
  4. SEPARATE: Collect anomalies (Rule 2)
  5. SUPPRESS: Inline structurally trivial children (Rule 5)
  6. ORDER: Folds first, then anomalies, then trivial summary
  7. RECURSE: Apply fold() to each remaining expanded child
```

**Complexity:** O(n log n) per parent — dominated by signature computation and grouping. No graph queries needed; operates on already-built NotationBlocks.

## VI. Interaction with Existing Mechanisms

### LOD × Folding

Folding is built into the LOD progression:

```
LOD 0: names only → no children, nothing to fold
LOD 1: edges only → no children, nothing to fold
LOD 2: nested children + fold → children expanded, then compressed
LOD 3: nested children, no fold → children expanded, exact bijective output
```

LOD 2 and LOD 3 both expand children. The difference: LOD 2 applies fold rules as a post-pass, LOD 3 does not. Implementation-wise, LOD 3 is what the current LOD 2 produces (before this work).

### Budget × Folding

Budget and folding are orthogonal:
- **Budget** limits lines *within a single block* (horizontal compression)
- **Folding** compresses *sibling blocks* that share structure (vertical compression)

After folding, if the remaining blocks still exceed a count budget, standard summarization can apply on top.

### Perspectives × Folding

Perspectives filter archetypes before folding sees the data. A perspective that filters out `depends` would remove import lines from all blocks, potentially making previously-heterogeneous siblings signature-equivalent. This is correct behavior — from the perspective's viewpoint, they ARE equivalent.

## VII. Invariants

### Inv-F1: Lossless Unfold

> Folding is reversible. For every fold node F, the original sibling group G is recoverable from F.count + F.signature + the graph.

The fold is a **view transform**, not a data transform. The underlying SubgraphData is unchanged.

### Inv-F1b: Exemplar Presence

> Every fold includes at least one fully-expanded exemplar member. A fold with zero exemplars is forbidden.

The exemplar makes the fold self-documenting: the reader sees what the pattern looks like without needing to mentally reconstruct it from the count and signature. This is the "show, don't tell" invariant.

### Inv-F2: Anomaly Visibility

> No anomaly is ever hidden by folding. If σ(B) ≠ σ_G for the dominant group, B is rendered individually.

This is the information-theoretic guarantee: high-surprisal elements are always visible.

### Inv-F3: LOD Monotonicity Preservation

> Folding at LOD N never contradicts information shown at LOD N-1.

Since folding only applies at LOD ≥ 2 and LOD 1 doesn't show children, there's nothing to contradict. The fold node's summary line is strictly additive — it adds the count and source information that LOD 1 didn't show.

### Inv-F4: Count Conservation

> The sum of counts across all folds + individually-rendered children = the original children count.

```
|fold₁| + |fold₂| + ... + |anomalies| + |trivials| = |parent.children|
```

### Inv-F5: Idempotence

> Applying fold() twice produces the same result as applying it once.

```
fold(fold(P)) = fold(P)
```

Since fold nodes have no children with shared signatures, re-folding is a no-op.

## VIII. Grammar Compatibility Analysis

### Current DSL Grammar

```
notation  = block*
block     = name [location] '{' body '}' | name [location]
body      = line* block*
line      = [modifier] [operator] verb targets
targets   = target (',' target)*
modifier  = '[]' | '??' | '[] ??'
operator  = 'o-' | '>' | '<' | '=>' | '>x' | '~>>' | '?|' | '|='
```

**Core invariant:** bijection `block ↔ graph node`, `line ↔ edge group`. Each block is exactly one node. Each line is one or more edges of the same archetype+verb. This bijection is what makes the DSL a **formal representation** rather than pretty-printing.

### Compatibility Verdict

| Rule | Output form | Breaks grammar? | Breaks bijection? |
|------|------------|----------------|-------------------|
| 1. Group Fold | `...+35 more handlers` | YES — no operator/verb | YES — 1 line = 35 nodes |
| 2. Anomaly Preservation | (unchanged blocks) | no | no |
| 3. Source Aggregation | `from ./handlers/` | YES — new keyword | no (fold modifier) |
| 4. Dedup | (removes blocks) | no | no |
| 5. Structural Suppression | `[types: X, Y, Z]` | YES — new line form | YES — 1 line = N nodes |
| 6. Target Dedup | (filters targets) | no | no |
| 7. Repeated Leaf | `function ×10` | YES — ×N suffix | YES — 1 block = 10 nodes |
| 8. Derivation Chain | `< reads node.gnFile` | YES — dot navigation | YES — 1 line = 3 nodes |
| 9. Chain Linearization | `f ∘ g ∘ h(src)` | YES — ∘ operator | YES — 1 line = N nodes |
| 10. Repetitive Call | `mkGlobal ×16` | YES — ×N suffix | YES — 1 line = N nodes |
| 11. Case Dispatch | `pattern → handler` | YES — → arrow | YES — 1 line = quadruplet |

**8 of 11 rules break grammar. 7 of 11 break bijection.** This is not patchable — it's a structural tension between folding and the DSL's formal properties.

### The Tension

The DSL was designed as a **bijective projection**: graph structure → notation, with no information loss and exact 1:1 correspondence. This is what makes `describe` output machine-readable and formally verifiable (Invariant 6 in visual-language.md: "topology equivalence").

Folding wants to be a **lossy compression**: many nodes → one summary. These goals conflict. Three resolution paths:

### Path A: Two-Layer Architecture (notation + rendering)

Separate the DSL into two layers:
- **Notation layer** (formal): preserves bijection, outputs `block ↔ node` representation. This is what exists today.
- **Rendering layer** (pragmatic): folds notation into human-readable output. Operates on NotationBlocks, not on the graph directly.

```
graph → extractSubgraph() → renderNotation() → NotationBlock[] → fold() → string
                              ↑ formal DSL                        ↑ display transform
```

Folding is NOT part of the DSL grammar — it's a display transform applied after notation is built. The folded output is not parseable back into DSL. This is analogous to how `git log --oneline` is not a valid git format — it's a view.

**Pros:** Preserves DSL formalism. Folding is additive, not destructive. Can be toggled off.
**Cons:** Two representations to maintain. "DSL" stops meaning "what you see" — users might expect to parse folded output.

### Path B: Extend DSL Grammar with Quantifiers

Add a single new construct — the **quantifier** — to the DSL grammar:

```
block     = name [location] [quantifier] '{' body '}' | name [location] [quantifier]
quantifier = '×' number ['(' label ')']
```

A quantified block represents N structurally identical siblings:
```
handleQueryGraph ×36 { o- imports from handleQueryGraph }
```

This means: "there are 36 blocks like this one; I'm showing one." The grammar stays regular. The bijection becomes `block ↔ node SET` (a block can represent one or many nodes that share structure).

For chains (Rules 8-9), extend `targets`:
```
targets   = target (',' target)* | chain
chain     = target ('.' target)+
```

This allows `< reads node.gnFile` and `> calls a.b.c` as valid target forms — a chain is a path through the graph, not a single node.

**Pros:** Folding is part of the formal language. Output is parseable. Single representation.
**Cons:** Breaks the strict block↔node bijection (now block↔node set). Chains add complexity. The ×N quantifier is a new concept that doesn't map to any archetype.

### Path C: Folding as LOD 3

Treat folding not as a grammar extension but as a new LOD level:

```
LOD 0: names only
LOD 1: names + edges
LOD 2: names + edges + nested children (current max)
LOD 3: LOD 2 + structural folding
```

At LOD 3, the renderer recognizes repetitive patterns and applies folding rules. The output uses the existing grammar where possible, with a single extension: the `...+N more` summary line (which already exists in budget enforcement).

The key insight: `...+N more` is already in the grammar (renderer.ts line 208-213). It's the budget summary. Folding is just budget-at-the-block-level.

```
# LOD 2 (no fold):
handleQueryGraph { o- imports from handleQueryGraph }
handleFindCalls { o- imports from handleFindCalls }
... (36 blocks)

# LOD 3 (with fold):
handleQueryGraph { o- imports from handleQueryGraph }   ← exemplar
...+35 more (same structure)                            ← reuses existing budget syntax
```

For chains (Rules 8-9), LOD 3 doesn't linearize — it keeps the block-per-node structure but applies dedup (Rule 4) and leaf suppression (Rule 5) more aggressively. Chain linearization is deferred to a future "LOD 4" or a separate `--chain` flag.

**Pros:** Minimal grammar change (reuses `...+N more`). LOD is already the primary compression axis. Natural progression.
**Cons:** Chains (Rules 8-11) don't fit cleanly. LOD 3 is a partial solution.

### Decision: Path A — Fold as View Layer

Fold is a **display transform**, not part of the DSL grammar. The DSL stays bijective (`block ↔ node`). Folding is opt-in progressive disclosure, activated by `--fold` flag.

```
graph → extractSubgraph() → renderNotation() → NotationBlock[] → fold() → string
                              ↑ formal DSL                        ↑ view transform
```

**Rationale:**

1. **DSL stays machine-readable.** Without `--fold`, output is a precise graph projection. With `--fold`, it's a human/LLM-optimized summary. Two uses, one pipeline.

2. **LLM can unfold.** An LLM reading `...+35 more (same structure)` after seeing an exemplar can mentally reconstruct the full set. If it needs details, it calls `describe` again without `--fold`, or queries specific nodes. The fold is a hint ("don't waste tokens on these"), not a data format.

3. **No grammar pollution.** The 9-operator archetype system stays clean. No `×N`, no `∘`, no `→`. Folded output is plaintext annotation, not DSL.

4. **Progressive disclosure is the LOD axis, not a flag:**
   ```
   LOD 0  names only
   LOD 1  names + edges
   LOD 2  names + edges + nested children (folded)
   LOD 3  names + edges + nested children (unfolded, exact)
   ```

**Interface — fold as LOD level, not flag:**

```
LOD 0: names only
LOD 1: names + edges
LOD 2: names + edges + nested children (folded)    ← default
LOD 3: names + edges + nested children (unfolded)   ← exact bijective DSL
```

```bash
grafema describe server.ts              # LOD 1 (default depth)
grafema describe server.ts -d 2         # nested + folded (compressed view)
grafema describe server.ts -d 3         # nested + unfolded (exact DSL, every node)
describe(target="server.ts", depth=2)   # MCP: folded
describe(target="server.ts", depth=3)   # MCP: unfolded
```

No extra flags. Fold is just what LOD 2 does. If you want every node expanded, ask for more detail: `-d 3`.

**Monotonicity holds:** LOD 1 ⊂ LOD 2(folded) ⊂ LOD 3(unfolded). Each level strictly adds information. LOD 2 adds children (compressed). LOD 3 expands the compressions. No information visible at level N disappears at level N+1.

**LLM workflow:** MCP `describe` defaults to depth=1. For overview of a module, depth=2 gives the folded summary — exemplars + counts. If the LLM needs a specific fold expanded, it queries that node directly at depth=1, or requests depth=3 on the parent.

**Fold output is NOT parseable back into NotationBlocks.** That's fine — LOD 3 provides the exact bijective representation. LOD 2 is the compressed view optimized for context windows.

## IX. Expected Compression on Real Codebases

| File pattern | Children | Dominant group | After folding |
|-------------|----------|---------------|---------------|
| MCP server (dispatch) | ~80 | 36 handler imports | 1 fold + ~10 anomalies |
| Barrel re-export | 50+ | 50 `export { X } from Y` | 1-3 folds by source |
| React component library index | 30+ | 30 component exports | 1 fold |
| Express router | 20+ | 15 `router.get/post` | 2 folds (by HTTP method) |
| Test file | 30+ | 25 `it('...')` blocks | 1 fold |
| GraphQL resolvers | 40+ | 35 resolver functions | 1-2 folds by type |
| Config/constants | 100+ | 100 plain values | 1 fold |
| Mixed util module | 15 | 5 functions + 5 classes + 5 types | 3 folds |

**Key prediction:** Files with high h(P) (> 0.5) benefit most. Files with low h(P) (all children unique) see no change — folding is a no-op, which is correct.

## IX. Empirical Survey — 20 Files Across 3 Languages

Survey of `grafema describe <file> -d 2 --locations` across TypeScript, Haskell, and Rust files. Goal: find repetitive patterns NOT covered by Rules 1-5.

### Pattern A: Duplicate Node Pairs (Rule 4 not applied)

**Frequency:** Every TypeScript file. CRITICAL.
**Impact:** ~50% of all TS output is pure duplication.

Every function/class appears twice with identical semantic ID, location, and edges. Values within annotations are also doubled:

```
parseFile  (parser.ts:1651) {
  > returns parseFileContent, parseFileContent    ← doubled
  < receives filePath, corpusDir, filePath, corpusDir  ← doubled
}
parseFile  (parser.ts:1651) {       ← entire block duplicated
  > returns parseFileContent, parseFileContent
  < receives filePath, corpusDir, filePath, corpusDir
}
```

**Diagnosis:** This is a Rule 4 implementation gap — dedup is defined but not applied in the renderer. The intra-line doubling (`returns X, X`) is a separate sub-issue (target list dedup).

### Pattern B: Intra-Annotation Value Duplication

**Frequency:** Every TypeScript file. HIGH.
**Impact:** ~20% of annotation text is redundant.

```
> has method constructor, update, setStats, display, ..., constructor, update, setStats, display, ...
> returns 'derived', 'synced', 'declared', 'derived', 'synced', 'declared'
```

Same values repeated 2-4x within a single line. Likely caused by multiple resolution passes producing duplicate edges.

**Proposed Rule 6: Target Dedup** — deduplicate the targets list within each NotationLine before serialization. `targets = [...new Set(targets)]`.

### Pattern C: Bare Keyword/Attribute Leaf Nodes

**Frequency:** Every TS file (`function`, `class` keywords) + every Rust file (`doc`, `cfg`, `inline` attributes). MEDIUM.

```
function  (parser.ts)         ← 10 identical leaves in one file
function  (parser.ts)
function  (parser.ts)
...

doc  (manifest.rs:58)         ← 17 identical-name leaves in one file
doc  (manifest.rs:74)
doc  (manifest.rs:140)
...
```

These are AST artifacts — keyword nodes and attribute nodes with no semantic edges.

**Proposed Rule 7: Repeated Leaf Fold** — when N leaf siblings share the same name, collapse: `function ×10` or `doc ×17, cfg ×3`. Subsumes Rule 5 for the repeated case.

### Pattern D: Accessor Chain Expansion (Haskell-specific)

**Frequency:** Every Haskell file. HIGH — hundreds of lines per file.

Field accessors (`gnFile`, `gnName`, `gnId`) each expand to a 3-line triplet:

```
gnFile  (ImportResolution.hs:91)
gnFile  (ImportResolution.hs:91)
node  (ImportResolution.hs:91) {
  > derived from gnFile
}
```

The first is a reference, second is the accessor itself, third is the source with a `derived from` edge. This triplet repeats for every field access in every function.

**Proposed Rule 8: Derivation Chain Collapse** — a sequence `[ref, ref, source { derived from ref }]` collapses to `< reads node.gnFile`. This is a specific case of recognizing that accessor + derivation together express one concept: "reading a field."

### Pattern E: Function Composition Chains (Haskell-specific)

**Frequency:** 3-5 per Haskell analyzer file, 8-10 lines each. HIGH.

`pack . occNameString . rdrNameOcc . unLoc` is a standard idiom:

```
pack  (Expressions.hs:111)
pack  (Expressions.hs:111)
occNameString  (Expressions.hs:111) { > derived from pack }
occNameString  (Expressions.hs:111)
rdrNameOcc  (Expressions.hs:111) { > derived from occNameString }
rdrNameOcc  (Expressions.hs:111)
unLoc  (Expressions.hs:111) { > derived from rdrNameOcc }
unLoc  (Expressions.hs:111)
name  (Expressions.hs:111) { > derived from unLoc; < reads name }
```

9 lines → conceptually `pack . occNameString . rdrNameOcc . unLoc(name)`.

**Proposed Rule 9: Derivation Chain Linearization** — when a sequence of sibling nodes forms a chain where each has `> derived from <predecessor>`, linearize into: `pack . occNameString . rdrNameOcc . unLoc(name)`. This is Rule 8 generalized to chains of length > 2.

**Formal:** Given siblings `[N₁, N₂, ..., Nₖ]` where `∀i: Nᵢ₊₁.lines contains "derived from Nᵢ"`, replace with single line: `N₁ ∘ N₂ ∘ ... ∘ Nₖ(source)`.

### Pattern F: Repetitive Call Lists (Data Definition Files)

**Frequency:** Data-definition files. HIGH — RuntimeGlobals.hs: 840 lines → ~10 lines.

`globalsDb` list contains ~100 `mkGlobal "name" Category "kind"` calls:

```
mkGlobal  (RuntimeGlobals.hs:44)
mkGlobal  (RuntimeGlobals.hs:44) { < reads mkGlobal }
NodeJs  (RuntimeGlobals.hs:44) { > derived from mkGlobal; < reads NodeJs }
mkGlobal  (RuntimeGlobals.hs:45)
mkGlobal  (RuntimeGlobals.hs:45) { < reads mkGlobal }
Browser  (RuntimeGlobals.hs:45) { > derived from mkGlobal; < reads Browser }
... ×100
```

840 lines for what is "a list of ~30 mkGlobal calls grouped by category."

**Proposed Rule 10: Repetitive Call Fold** — when the same function is called N times as siblings with structurally identical shape, fold by distinguishing argument. Show one exemplar expanded, then summary:

```
mkGlobal "process" NodeJs "global"                        ← exemplar
...+15 more mkGlobal (NodeJs), +8 (Browser), +8 (EcmaScript)  ← fold
```

This is Rule 1 (Group Fold) generalized: the signature matches but we also extract the one varying dimension (the category argument) as a sub-grouping key.

### Pattern G: Case Dispatch Expansion

**Frequency:** Walker/dispatch files. HIGH — Walker.hs: 2139 lines → ~100 lines.

`walkNode` has ~80 `case` branches, each structurally identical:

```
VariableDeclarationNode  (Walker.hs:52)
ruleVariableDeclaration  (Walker.hs:52) { > derived from case }
ruleVariableDeclaration  (Walker.hs:52)
node  (Walker.hs:52) { > derived from ruleVariableDeclaration; < reads node }

FunctionDeclarationNode  (Walker.hs:53)
ruleFunctionDeclaration  (Walker.hs:53) { > derived from case }
...
```

~6 lines per branch × 80 branches = 480 lines of dispatch boilerplate.

**Proposed Rule 11: Case Dispatch Fold** — when a parent has N children that form `[pattern, handler { derived from case }, handler, arg { derived from handler }]` quadruplets with identical structure, show one branch expanded (exemplar) + dispatch summary:

```
VariableDeclarationNode → ruleVariableDeclaration {       ← exemplar (full branch)
  > derived from case
  < reads node
}
...+79 more branches: FunctionDeclarationNode → ruleFunctionDeclaration, ...
```

### Impact Summary

| Pattern | Where | Lines saved | Priority |
|---------|-------|-------------|----------|
| A: Duplicate nodes | All TS | ~50% of TS output | **P0** (bug) |
| B: Intra-annotation dedup | All TS | ~20% of line length | **P0** (bug) |
| C: Keyword leaf fold | TS + Rust | 10-20 lines/file | P2 |
| D: Accessor chain collapse | All Haskell | ~30% of Haskell output | **P1** |
| E: Composition chain | Haskell analyzers | ~50 lines/file | **P1** |
| F: Repetitive call fold | Data-def Haskell | 840 → ~10 lines | **P1** |
| G: Case dispatch fold | Walker/dispatch | 2139 → ~100 lines | **P1** |

**Critical finding:** Patterns A and B are bugs (data duplication), not folding rules. They should be fixed at the source — either in `extractSubgraph()` (dedup edges/nodes) or in `buildLines()` (dedup targets). Rules 6-11 are genuine folding rules that compress structurally repetitive notation.

## X. Revised Rule Table

| # | Rule | Level | Trigger |
|---|------|-------|---------|
| 1 | Group Fold | Sibling blocks | N siblings with σ(Bᵢ) = σ(Bⱼ), N > T |
| 2 | Anomaly Preservation | Sibling blocks | σ(B) ≠ dominant σ |
| 3 | Source Aggregation | Within a fold | All targets share source MODULE |
| 4 | Dedup | Sibling blocks | Same semantic ID |
| 5 | Structural Suppression | Leaf blocks | No edges, no children |
| 6 | Target Dedup | Within a line | Duplicate names in targets list |
| 7 | Repeated Leaf Fold | Leaf siblings | N leaves with same name → `name ×N` |
| 8 | Derivation Chain Collapse | Adjacent siblings | `[ref, ref, src { derived from ref }]` → `< reads src.ref` |
| 9 | Chain Linearization | Adjacent siblings | N-length `derived from` chain → `f ∘ g ∘ h(src)` |
| 10 | Repetitive Call Fold | Sibling calls | Same function called N times, group by varying arg |
| 11 | Case Dispatch Fold | Case children | N branches with `[pattern, handler { derived from case }]` |

Rules 1-5: structural (language-agnostic). Rules 6-7: cleanup (bugs/artifacts). Rules 8-11: semantic (require understanding derivation/call patterns).

## XI. Relation to Existing Theory

### Abstract Interpretation (Cousot & Cousot)

Folding is an abstraction in the Cousot sense: it maps a concrete domain (list of blocks) to an abstract domain (fold nodes + anomalies) via a Galois connection.

- **Abstraction α:** block list → fold summary + anomalies
- **Concretization γ:** fold summary → original block list (by querying graph)
- **Soundness:** γ(α(blocks)) ⊇ blocks (unfold recovers all information)

### Cognitive Dimensions (Green & Petre)

| Dimension | Effect of folding |
|-----------|-------------------|
| **Diffuseness** | Reduced — 36 blocks → 1 line |
| **Hard mental operations** | Reduced — no need to scan for differences in identical blocks |
| **Hidden dependencies** | Preserved — anomalies (the different ones) are always visible |
| **Progressive evaluation** | Preserved — fold can be expanded on demand |
| **Role-expressiveness** | Improved — "36 handlers" communicates the ROLE better than listing names |

### Shimojima's Free Rides

Folding creates a new class of free rides: **pattern visibility**. When 36/40 children fold into one line, the 4 remaining anomalies become immediately visible. Without folding, finding the 4 "different" children among 40 requires scanning all 40 — O(n) cognitive effort. With folding, they're spatially separated — O(1).

## XII. Open Questions

1. **Threshold T:** Default T=3 means groups of ≤ 3 aren't folded. Is this the right number? Should it depend on total sibling count? (e.g., fold at T=3 if siblings > 10, but T=5 if siblings > 20?)

2. **Nested folding:** If a fold's exemplar blocks themselves have foldable children, should we fold recursively? Current design says yes (step 7 recurses), but deep folding may over-compress.

3. **Fold label generation:** How to generate the summary verb? "36 handlers from index.js" requires knowing that the targets are "handlers" — this is either inferred from the source module name or from the node types. Needs heuristics.

4. **Type-aware grouping:** Should the signature include the child's `name` pattern? E.g., `handle*` functions might fold separately from `*Args` types even if they have the same structural signature. This would improve fold labels but reduce compression.

5. **Interactive expansion:** In TUI/GUI, a fold should be expandable. In CLI text output, expansion isn't possible. Should CLI show first-K exemplars within the fold? E.g.:
   ```
   o- imports 36 handlers (handleQueryGraph, handleFindCalls, handleFindNodes, ...+33 more)
   ```

6. **Rules 8-11 language-specificity:** Derivation chains and composition chains are Haskell-specific idioms expressed through generic graph edges. Are there equivalent patterns in other languages that would trigger the same rules? (e.g., Python decorator chains, Rust trait impl blocks, TS method chains)

7. **Rule ordering:** Rules 8-11 operate on adjacent siblings (sequential patterns), while Rules 1-5 operate on unordered groups. Should sequential rules run first (collapsing chains into single nodes), making the remaining siblings more amenable to group folding?

---

## XIII. Node Rendering Roles

**Discovery date:** 2026-03-11
**Origin:** Reading folded `server.ts` output revealed that `projectPath { < assigned from getProjectPath }` doesn't read as an assignment. The block-per-node model fails for certain node types.

### The Problem

The renderer treats every node as a block: `name { lines... }`. But cognitively, different nodes answer different questions:

- `main { > calls start }` → "what does main DO?" ✓ (action → block is right)
- `projectPath { < assigned from getProjectPath }` → "what IS projectPath?" ✗ (value → block is wrong)
- `ListToolsRequestSchema` (REFERENCE) → implementation detail, shouldn't be shown at all

### Seven Roles

Determined by **graph shape** (outgoing edge types), NOT just AST node type. The same AST type can play different roles depending on its edges.

| Role | Cognitive question | Determined by | Notation format |
|------|-------------------|---------------|-----------------|
| **Actor** | What does it DO? | Has behavior edges (>, =>, >x, ~>>) | Block `name { lines }` |
| **Container** | What's INSIDE? | MODULE, CLASS, NAMESPACE types | Block `name { children }` |
| **Binding** | From WHERE? | IMPORT, EXPORT types | Line or fold group |
| **Datum** | What VALUE? | VARIABLE/CONSTANT with only passive edges (<) | Inline `name = source` |
| **Shape** | What FORM? | INTERFACE, TYPE_ALIAS, ENUM | Block or name-only |
| **Control** | Which PATH? | LOOP, BRANCH, CASE | Modifier on children |
| **Internal** | (suppress) | REFERENCE, LITERAL, EXPRESSION leaf | Not shown |

### Role depends on observation point

A function plays different roles at different locations in the graph:

| Point in graph | Role | Notation |
|---------------|------|----------|
| Definition `const handler = λ` | Datum | `handler = λ` |
| Passing `register(schema, handler)` | Argument (flow) | `> passes handler to register` |
| Invocation `handler(req)` | Actor | `handler { < receives req, > calls ... }` |

### Implementation (completed)

Added to `fold.ts` as `classifyRole()` + `applyRoleTransforms()`:
- **Datum** → inline `name = source` format (foldMeta.kind = 'datum-inline')
- **Internal** → suppressed (removed from output)
- Runs after semantic rules (chains, dispatch) but before structural rules (group fold)

### Sort order: input → process → output

Reordered archetypes for cognitive flow:

```
flow_in (1) → depends (2) → flow_out (3) → write (4) → publishes (5) → exception (6) → gates (7) → governs (8) → returns (9)
```

RETURNS/YIELDS/RESPONDS_WITH get sortOrder 9 (output comes last).

## XIV. Name-Preserved Folding

**Problem:** Current group fold (Rule 1) outputs exemplar + `...+N more`. This discards names (high-entropy, unique, identifying) to save space on structure (low-entropy, shared, repetitive). Information theory says: compress low-entropy, keep high-entropy.

### Current (lossy)

```
handler0 {
  o- imports target0
}
...+4 more functions
```

### Proposed (name-preserving)

```
handler0, handler1, handler2, handler3, handler4 {
  o- imports <target>
}
```

One block instead of two. All names visible, structure shown once. With budget:

```
handler0, handler1, handler2 +2 more {
  o- imports <target>
}
```

### Target variance

When fold members share structure but targets differ, show `<varies>` or omit:
- All same target → show it: `o- imports from index.js`
- All different targets → show `<varies>`: `o- imports <varies>`
- Mixed → show common, `<varies>` for rest

### Status

Not yet implemented. Current fold still uses exemplar + summary format.

## XV. Lambda Semantic Roles

**Discovery date:** 2026-03-11
**Origin:** `<arrow>` blocks in folded output carry zero semantic information. Anonymous functions need classification by what they DO, not what they ARE.

### Classification by signature

Lambda semantics are determined by parameter count + edge content (what it does inside). Works for untyped code — no type annotations needed.

| Signature | Role | Graph signal | Examples |
|-----------|------|-------------|----------|
| `() → void` | **Thunk** | 0 params, has side effects | `setTimeout(λ)`, `defer(λ)` |
| `() → T` | **Factory** | 0 params, has RETURNS edge | `lazy(λ)`, `useState(λ)` |
| `(T) → void` | **Consumer** | 1 param, no RETURNS | `forEach(λ)`, `subscribe(λ)` |
| `(T) → T` | **Transform** | 1 param, has RETURNS | `map(λ)`, `pipe(λ)` |
| `(T) → bool` | **Predicate** | 1 param, returns boolean-ish | `filter(λ)`, `find(λ)` |
| `(T, T) → num` | **Comparator** | 2 params, returns number | `sort(λ)` |
| `(A, T) → A` | **Reducer** | 2 params, returns 1st type | `reduce(λ)`, `fold(λ)` |
| `(T, next) → void` | **Middleware** | 2 params, one named next/done | `app.use(λ)` |
| `(event) → void` | **Handler** | 1 param, registered as callback | `on(λ)`, `setRequestHandler(λ)` |
| `(err) → void` | **ErrorHandler** | 1 param named err/error | `catch(λ)`, `onError(λ)` |

### Category theory correspondence

| Lambda role | Morphism type |
|-------------|--------------|
| Factory `() → T` | Terminal morphism (supplier) |
| Consumer `T → void` | Initial morphism |
| Transform `T → T` | Endomorphism |
| Predicate `T → Bool` | Characteristic function |
| Reducer `(A, T) → A` | Catamorphism |

### Notation format

```
> passes λ handler to setRequestHandler(CallToolRequestSchema)
> passes λ transform to map
> passes λ predicate to filter
```

Format: `λ <role>` mandatory, `(<params>)` optional (via `--signatures` flag).

### Universality: 20-language survey

Callback registration exists in all languages with first-class functions (~18/20):

| Syntax pattern | Languages |
|---------------|-----------|
| `f(callback)` | JS, Python, Go, Rust, Ruby, Lua, PHP, Perl, R, Dart, Julia |
| `f(lambda)` / `f { block }` | Kotlin, Swift, Scala, Ruby |
| Closures as SAM/trait/interface | Java, C#, Rust |
| Function pointers | C, C++ |
| Everything is a function | Haskell, OCaml, F#, Erlang, Elixir |

### Status

Not yet implemented. Requires: (1) parameter count from RECEIVES_ARGUMENT edges, (2) return detection from RETURNS edges, (3) classification heuristic in fold/renderer.

## XVI. Callback Flow Analysis (0-CFA)

**Problem:** Detecting callback registration from graph structure. Knowing that a PASSES_ARGUMENT target is a FUNCTION tells us it's a callback, but tracing WHERE it's eventually invoked requires flow analysis.

### Simple case: direct callback

```
Sink:   CALL where callee is a PARAMETER (function calls its own argument)
Source: PASSES_ARGUMENT where value is a FUNCTION node
Path:   PASSES_ARGUMENT → PARAMETER → CALL
```

### Field-sensitive case: object of callbacks

```js
app.register({ onRequest: λ, onError: λ })
// inside register(): config.onRequest(req)
```

Taint path: `PASSES_ARGUMENT → PARAMETER → PROPERTY_ACCESS → CALL`

### Taint path types

| Pattern | Path through graph |
|---------|-------------------|
| Direct `f(λ)` → `param()` | `PASSES_ARG → PARAM → CALL` |
| Member `f({a: λ})` → `param.a()` | `PASSES_ARG → PARAM → HAS_PROPERTY → CALL` |
| Destructured `f({a: λ})` → `const {a} = param; a()` | `PASSES_ARG → PARAM → DESTRUCTURED_FROM → CALL` |
| Re-assigned `f(λ)` → `const x = param; x()` | `PASSES_ARG → PARAM → ASSIGNED_FROM → CALL` |
| Dynamic `f(λ)` → `param[key]()` | Unresolvable statically |

### Prior art

This is **0-CFA** (Control Flow Analysis, Shivers 1988):

| Analysis | Precision | Cost |
|----------|-----------|------|
| Andersen (points-to) | Field-insensitive | O(n³) |
| Steensgaard (type-based) | Fast, imprecise | O(n·α(n)) |
| k-CFA (Shivers) | Context-sensitive | O(n^(k+3)) |

### Practical approach for Grafema

Three levels by cost:
1. **Assignment** — `const x = λ` → name `x`. Cheap, covers ~60% of cases
2. **Containment** — parent CALL → context. Always available, O(1)
3. **Data flow trace** — follow ASSIGNED_FROM chain. Expensive, needed for currying/indirection

Implementation: enrichment plugin that finds CALL nodes with FUNCTION arguments, marks PASSES_ARGUMENT with `isCallback: true` metadata. Full taint for later.

### Status

Research only. Not yet implemented.
