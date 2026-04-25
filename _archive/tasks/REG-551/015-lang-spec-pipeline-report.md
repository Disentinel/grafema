# Lang-Spec Pipeline Run Report — JS Corpus

**Date:** 2026-02-24
**Corpus:** `test/fixtures/syntax-corpus` (691 parsed constructs)

## Pipeline Execution

| Stage | Output | Records | Cost | Time |
|-------|--------|---------|------|------|
| 03 annotate | `01-annotated.ndjson` | 771 (691+50 parse errors+30 resume dupes) | ~$15 | ~12 min |
| 04 triage | `02-triaged.ndjson` | 771 (65 GREEN, 103 YELLOW, 603 RED) | $0 | instant |
| 05 vocabulary | `03-vocabulary.json` | 157 unique node types, 243 edge types raw | $0 | instant |
| — vocabulary review | — | 40 node types, 64 edge types approved | $0 | ~1 hr human |
| 06 reannotate | `04-reannotated.ndjson` | 700 (613 LLM + 87 merge-map) | ~$8 | ~12 min |
| 07 writeback | 26 modified files | 688 annotations | $0 | instant |
| 08 classify-edges | `05-edge-requirements.json` | 64 edges (39 walk, 7 post-file, 18 post-project) | ~$0.50 | ~30 sec |
| 09 compile-tests | `06-test-suite.json` | 644 test cases, 7500 edge assertions | $0 | instant |
| 10 generate-plugin | `07-plugins/` | 420 rules, 3 plugins | ~$1 | ~30 sec |

**Total cost:** ~$24.50 (estimated $18.50)
**Total LLM time:** ~25 min
**Coverage:** 765/771 (99.2%)

## Vocabulary Decisions

### Promoted Node Types (+17)
`PROPERTY`, `GETTER`, `SETTER`, `TYPE_ALIAS`, `TYPE_PARAMETER`, `TYPE_REFERENCE`, `LITERAL_TYPE`, `CONDITIONAL_TYPE`, `INFER_TYPE`, `INTERFACE`, `ENUM`, `ENUM_MEMBER`, `NAMESPACE`, `STATIC_BLOCK`, `META_PROPERTY`, `LABEL`, `DECORATOR`

### Promoted Edge Types (+26)
`HAS_TYPE`, `HAS_TYPE_PARAMETER`, `RETURNS_TYPE`, `UNION_MEMBER`, `CONSTRAINED_BY`, `INTERSECTS_WITH`, `INFERS`, `DEFAULTS_TO`, `RESOLVES_TO`, `CHAINS_FROM`, `ALIASES`, `AWAITS`, `SHADOWS`, `DELETES`, `OVERRIDES`, `BINDS_THIS_TO`, `CALLS_ON`, `ACCESSES_PRIVATE`, `INVOKES`, `EXTENDS_SCOPE_WITH`, `HAS_OVERLOAD`, `IMPLEMENTS_OVERLOAD`, `MERGES_WITH`, `DECORATED_BY`, `SPREADS_FROM`, `LISTENS_TO`

### Key Merge Map (synonyms → canonical)
- Destructuring cluster (11 synonyms) → `READS_FROM` / `DECLARES` / `WRITES_TO`
- Type annotation cluster (4 synonyms) → `HAS_TYPE`
- Direction-confused edges → canonical direction (subject → object)

## Generated Plugin Analysis

### UnknownAnalyzer (walk phase)
- **420 rules**, 8 AST node types: FunctionDeclaration (267), VariableDeclaration (80), ClassDeclaration (54), ExportNamedDeclaration (6), ImportDeclaration (4), IfStatement (4), AssignmentExpression (3), ExportDefaultDeclaration (2)
- Emits 35 node types, 61 edge types
- All edges in walk phase (2530 total)
- **Problem:** Rules use `$name`/`$self`/`$child` template refs — generic, not concrete. Many VariableDeclaration rules have empty `conditions: []` — can't disambiguate.

### UnknownPostFileEnricher (post-file phase)
- **Stub only** — `void context;`
- Should create: ASSIGNED_FROM, CAPTURES, EXPORTS, HAS_ALTERNATE, MODIFIES, THROWS, WRITES_TO
- No implementation logic generated

### UnknownPostProjectEnricher (post-project phase)
- **Stub only** — `void context;`
- Should create: ALIASES, CALLS, CALLS_ON, DERIVES_FROM, EXTENDS, FLOWS_INTO, DEPENDS_ON, HAS_OVERLOAD, HAS_TYPE, IMPLEMENTS, IMPORTS, IMPORTS_FROM, IMPLEMENTS_OVERLOAD, MERGES_WITH, INVOKES, OVERRIDES, RESOLVES_TO, READS_FROM
- No implementation logic generated

## Problems Found

1. **Reannotate was wasteful** — $8 for what a merge-map script does in 0.1 sec. 87/706 records were done via merge-map when credits ran out, proving the point.
2. **Triage ordering** — should run AFTER vocabulary edits, not before. 603 RED was misleading (most were just vocabulary mismatches).
3. **Plugin enrichers are empty stubs** — stage 10 only generates the analyzer (walk phase). Post-file and post-project enrichers need manual implementation.
4. **Rule quality** — many VariableDeclaration rules have no conditions (can't tell `const x = 1` from `const x = new Foo()`). The rule engine needs a disambiguation strategy.
5. **Language detection** — plugins named "Unknown*" because language wasn't specified. Cosmetic but signals missing config.

## Comparison with Current JSASTAnalyzer

The generated analyzer covers **more edge types** (61 vs ~25 in current JSAST) but with **less precision**:
- Current JSAST: hand-crafted AST traversal, understands scope chains, function boundaries, class hierarchies
- Generated: flat rule matching, no scope awareness, no cross-node context
- Generated enrichers: empty stubs vs current enrichers (ValueDomainAnalyzer, MutationBuilder, TypeSystemBuilder, etc.) which have real logic

**Verdict:** The generated plugins are useful as a **specification** (what nodes/edges to emit for each AST pattern) but not as a replacement for hand-written analysis. The rule table (`rule-table.json`) is the real value — it's a machine-readable test oracle for what the graph should look like.
