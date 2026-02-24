# @grafema/lang-spec

Language specification generator for Grafema. Automates the full pipeline from a language descriptor to annotated corpus, validated vocabulary, compiled test suite, and generated analyzer plugins.

## Why

Grafema needs to know **what graph** to build for each language construct. This package generates that specification automatically:

1. A corpus of code examples covering the language grammar
2. Annotated with expected graph nodes and edges
3. Validated vocabulary (approved types, no duplicates, no noise)
4. Edge requirement profiles (what context each edge type needs)
5. Compiled test suite (691+ test cases with phased edge expectations)
6. Generated plugin scaffolds (rule table + ANALYSIS/ENRICHMENT plugins)

## Pipeline

```
                    LLM stages                  Deterministic stages
                    ──────────                  ────────────────────

 ┌─────────────┐   ┌──────────────┐   ┌──────────────┐
 │ 00 generate  │──▸│ 01 review    │──▸│ 02 parse     │
 │   corpus     │   │   corpus     │   │   corpus     │
 └─────────────┘   └──────────────┘   └──────────────┘
                                              │
                                              ▾
 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 │ 03 annotate  │──▸│ 04 triage    │──▸│ 05 vocabulary │
 │   Pass 1     │   │ GREEN/YEL/RED│   │   extract     │
 └──────────────┘   └──────────────┘   └──────────────┘
                                              │
                           ┌──────────────────┘
                           ▾          (human review of vocabulary)
 ┌──────────────┐   ┌──────────────┐
 │ 06 reannotate│──▸│ 07 writeback │
 │   Pass 2     │   │   to source  │
 └──────────────┘   └──────────────┘
                           │
        ┌──────────────────┘
        ▾
 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 │ 08 classify  │──▸│ 09 compile   │──▸│ 10 generate  │
 │   edges      │   │   tests      │   │   plugin     │
 └──────────────┘   └──────────────┘   └──────────────┘
```

## Quick Start

```bash
# Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...
# Or use the .env file in this package

# Generate corpus for JavaScript
npx tsx src/cli.ts generate --lang javascript --out ./corpus-js

# Parse @construct blocks
npx tsx src/cli.ts parse --corpus ./corpus-js

# Annotate constructs (LLM, ~$12 for JS)
npx tsx src/cli.ts annotate --corpus ./corpus-js --concurrency 10

# Auto-classify GREEN/YELLOW/RED
npx tsx src/cli.ts triage --corpus ./corpus-js

# Extract vocabulary
npx tsx src/cli.ts vocabulary --corpus ./corpus-js

# Re-annotate YELLOW/RED with vocabulary constraint
npx tsx src/cli.ts reannotate --corpus ./corpus-js --concurrency 10

# Write annotations back to source files
npx tsx src/cli.ts writeback --corpus ./corpus-js

# Classify edge types by requirement profile (LLM, ~$0.50)
npx tsx src/cli.ts classify-edges --corpus ./corpus-js

# Compile test suite (deterministic)
npx tsx src/cli.ts compile-tests --corpus ./corpus-js

# Generate plugin scaffolds (LLM for disambiguation)
npx tsx src/cli.ts generate-plugin --corpus ./corpus-js
```

## Commands

| Command | Type | Input | Output | Cost |
|---------|------|-------|--------|------|
| `generate` | LLM | language descriptor | corpus files with @construct markers | ~$3 |
| `parse` | deterministic | corpus files | `00-parsed.ndjson` | — |
| `annotate` | LLM | parsed constructs | `01-annotated.ndjson` | ~$15 |
| `triage` | deterministic | annotations | `02-triaged.ndjson` | — |
| `vocabulary` | deterministic | triaged annotations | `03-vocabulary.json` | — |
| `reannotate` | LLM | YELLOW/RED + vocabulary | `04-reannotated.ndjson` | ~$8 |
| `writeback` | deterministic | merged annotations | annotated source files | — |
| `classify-edges` | LLM | vocabulary + annotations | `05-edge-requirements.json` | ~$0.50 |
| `compile-tests` | deterministic | annotations + edge reqs | `06-test-suite.json` | — |
| `generate-plugin` | hybrid | vocab + reqs + tests | `07-plugins/` directory | ~$1 |

## Pipeline Output

All intermediate outputs live in `{corpus}/.pipeline/`:

```
.pipeline/
  00-parsed.ndjson              # Parsed @construct blocks
  01-annotated.ndjson           # Pass 1 annotations (unconstrained)
  02-triaged.ndjson             # GREEN/YELLOW/RED classification
  03-vocabulary.json            # Vocabulary analysis (human-editable)
  04-reannotated.ndjson         # Pass 2 annotations (vocabulary-constrained)
  05-edge-requirements.json     # Edge type requirement profiles
  06-test-suite.json            # Compiled test cases with phased edges
  07-plugins/                   # Generated plugin scaffolds
    rule-table.json
    {lang}-analyzer.ts
    {lang}-post-file-enricher.ts
    {lang}-post-project-enricher.ts
    tests/{lang}-analyzer.test.ts
    tests/{lang}-enrichers.test.ts
```

## Edge Classification Model

Stage 08 classifies each edge type into one of three phases based on what context is needed:

| Phase | When | Context Available |
|-------|------|-------------------|
| **walk** | During AST traversal | Current AST node, parent, scope stack |
| **post-file** | After file is fully walked | All nodes in current file |
| **post-project** | After all files are walked | Entire project graph |

Phase is derived deterministically from needs:
- `crossFile` or `typeInfo` → **post-project**
- `siblingNodes` → **post-file**
- Otherwise → **walk**

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--corpus <path>` | Path to corpus directory | required |
| `--lang <name>` | Language name (for generate) | — |
| `--out <path>` | Output directory (for generate) | — |
| `--concurrency <n>` | Max concurrent LLM calls | 10 |
| `--resume` | Resume interrupted LLM operation | false |
| `--review-passes <n>` | Adversarial review passes | 3 |

## Adding a New Language

1. Create `data/languages/{lang}.json` with language descriptor
2. Run the full pipeline from `generate` through `generate-plugin`
3. Review `03-vocabulary.json` after the vocabulary stage
4. Generated plugins in `07-plugins/` are ready to adapt into Grafema plugins

## Lessons Learned (JS corpus, 2026-02-24)

### Cost Reality
Estimated ~$18.50 total, actual ~$30+. The main driver: annotate (691 records × Sonnet) and reannotate (706 records × Sonnet) are ~$15 and ~$8 respectively, not the $12/$5 originally projected. Each call sends ~3K input tokens (code + system prompt + vocabulary constraint) and receives ~1K output.

### Reannotate is Largely Unnecessary
Stage 06 (reannotate) sends YELLOW/RED records back to the LLM with a "use only approved types" constraint. But the vocabulary review produces a **deterministic merge map** (e.g., `DESTRUCTURES_FROM → READS_FROM`). A local string substitution achieves the same result at $0 and instantly. LLM re-pass only adds value when the graph **structure** (not just type names) needs to change.

**Recommendation:** After vocabulary review, apply merge map locally. Only use LLM reannotation for records where the annotation structure is fundamentally wrong (true RED), not just vocabulary mismatches.

### Triage Timing
Triage (stage 04) classifies records as RED based on the **initial** approved vocabulary. If you then promote 17 node types and 26 edge types during vocabulary review, most RED records become GREEN/YELLOW. Run triage **after** vocabulary edits to get accurate counts, or skip it entirely if using merge-map approach.

### Vocabulary Review is the Critical Gate
The human review of `03-vocabulary.json` (step 4) is where all the real decisions happen. Invest time here. Key patterns found:
- LLM generates 5-7 synonyms for the same concept (destructuring cluster had 11)
- Direction confusion is common (ASSIGNS_TO vs ASSIGNED_FROM)
- Node/edge confusion (TYPE_ANNOTATION appeared as both)
- TypeScript type system needs its own category (17 new types)

### API Key Gotcha
`source .env` in Bash tool doesn't export to `npx tsx` subprocess. Use `env $(cat .env) npx tsx ...` instead.

## Architecture

- **TypeScript** — same ecosystem as Grafema orchestrator and plugins
- **Anthropic SDK** — LLM calls with retry, rate limit handling, resume
- **NDJSON** — streaming, resumable intermediate outputs
- **No external CLI framework** — `process.argv` parsed manually
- **Rule table format** — serializable, future Rust implementation can consume it
