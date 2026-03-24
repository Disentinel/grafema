# Grafema as Scaffold for ToCS Benchmark

## What is this

Results of running [Grafema](https://github.com/Disentinel/grafema) static analysis on [ToCS](https://arxiv.org/abs/2603.00601) generated codebases. Grafema extracts a code dependency graph deterministically — no LLM involved.

## Results: codebase_42 (medium, 27 modules, 70 GT edges)

### Static analysis only (no project-specific plugins)

| Edge Type | GT | Found | TP | Precision | Recall | F1 |
|-----------|-----|-------|-----|-----------|--------|------|
| IMPORTS | 47 | 38 | 38 | **1.000** | 0.809 | 0.894 |
| CALLS_API | 12 | 30 | 10 | 0.333 | **0.833** | 0.476 |
| REGISTRY_WIRES | 6 | 0 | 0 | — | 0.000 | — |
| DATA_FLOWS_TO | 5 | 0 | 0 | — | 0.000 | — |
| **OVERALL** | **70** | **68** | **48** | **0.706** | **0.686** | **0.696** |

### With project-level plugin (pipeline config resolver)

A batch-mode Grafema plugin (~60 lines JS) reads `pipeline_config.json` and resolves dynamic dependencies:

| Edge Type | GT | Found | TP | Precision | Recall | F1 |
|-----------|-----|-------|-----|-----------|--------|------|
| IMPORTS | 47 | 38 | 38 | **1.000** | 0.809 | 0.894 |
| CALLS_API | 12 | 30 | 10 | 0.333 | **0.833** | 0.476 |
| REGISTRY_WIRES | 6 | 6 | 6 | **1.000** | **1.000** | **1.000** |
| DATA_FLOWS_TO | 5 | 5 | 5 | **1.000** | **1.000** | **1.000** |
| **OVERALL** | **70** | **79** | **59** | **0.747** | **0.843** | **0.792** |

### Comparison with ToCS baselines

| System | Dep F1 | Precision | Recall |
|--------|--------|-----------|--------|
| **Grafema + plugin** | **0.792** | 0.747 | **0.843** |
| Oracle | 1.000 | 1.000 | 1.000 |
| Config-Aware | 0.577 | 0.736 | 0.475 |
| Random | 0.538 | 1.000 | 0.368 |
| BFS-Import | 0.293 | 1.000 | 0.173 |

### Adjusted results (excluding GT-code mismatches)

11 ground truth edges have no corresponding import/call in the generated code (see Findings below). Excluding these:

**Adjusted recall: 59/59 = 100%** — every edge that exists in code is found.

## What Grafema provides that baselines don't

1. **100% precision on syntactic imports** — zero false positives. Every IMPORTS_FROM edge points to the right declaration.

2. **Symbol-level resolution** — not just "file A depends on file B", but "file A line 5 imports `StageBase` from file B line 9". This is richer than ToCS GT which only has file-to-file edges.

3. **Virtual dispatch** — `stage.process()` where `stage: StageBase` resolves to all 6 subclass implementations via EXTENDS edges + type annotations. Rule-based baselines can't do this.

4. **Plugin extensibility** — project-specific patterns (importlib + config, DI containers, event dispatch) handled by batch-mode plugins that write directly to the graph. The pipeline config plugin is 60 lines and resolves REGISTRY_WIRES + DATA_FLOWS_TO with 100% precision.

## What Grafema can't do (LLM territory)

- **Naming-based intent**: `StageTokenizeAdapter` is meant to wrap `mod_a` (the tokenizer). The code only uses `StageBase` via DI — the mapping adapter→specific-stage lives in naming/docstrings, not code.

- **Ungenerated code paths**: GT includes edges for code the generator didn't emit (runner→middleware imports, adapter→model imports). Static analysis correctly reports these as absent.

## Findings: GT-code mismatches in the generator

13 GT edges in codebase_42 have no corresponding code:

| Source | Target | Type | Issue |
|--------|--------|------|-------|
| adapters/mod_g.py | models.py | IMPORTS | No import statement |
| adapters/mod_g.py | stages/mod_a.py | IMPORTS | No import statement |
| adapters/mod_h.py | models.py | IMPORTS | No import statement |
| adapters/mod_h.py | stages/mod_f.py | IMPORTS | No import statement |
| legacy/old_pipeline.py | models.py | IMPORTS | File has zero imports |
| utils/formatters.py | models.py | IMPORTS | No import statement |
| utils/helpers.py | config.py | IMPORTS | No import statement |
| runner.py | middleware/mod_i.py | IMPORTS | No import of middleware |
| runner.py | middleware/mod_j.py | IMPORTS | No import of middleware |
| runner.py | middleware/mod_i.py | CALLS_API | No call to middleware |
| runner.py | middleware/mod_j.py | CALLS_API | No call to middleware |

**Root cause**: `grammar.py` adds edges to the blueprint (lines 827–830, 882, 893, 919, 957–958), but `export.py` code generation templates (`_gen_adapter`, `_gen_runner`, etc.) don't emit the corresponding imports.

Additionally, `pipeline_config.json` is not loaded anywhere in the generated code. `PipelineConfig.stage_order` has `default_factory=list` (empty), and `cli.py` constructs the config without stage_order.

Pattern is systematic across all medium/large codebases (same codegen templates).

## How to reproduce

```bash
# Clone & install Grafema
git clone https://github.com/Disentinel/grafema
cd grafema && pnpm install && pnpm build

# Build Haskell analyzers (requires GHC 9.8+)
cd packages/python-analyzer && cabal build
cd packages/python-resolve && cabal build
# Copy binaries to ~/.grafema/bin/

# Analyze a ToCS codebase
cd /path/to/tocs/data/codebase_42
cat > grafema.config.yaml << 'YAML'
root: "."
include:
  - "text_processor/**/*.py"
exclude:
  - "**/__pycache__/**"
plugins:
  - name: tocs-pipeline-config
    command: "node tocs-pipeline-plugin.mjs"
    mode: batch
YAML

grafema analyze --clear
grafema overview --json
```

## For "scaffold-augmented evaluation"

The ideal experiment setup from ToCS Contributing section:

1. **Baseline**: LLM agent explores codebase under partial observability (existing ToCS harness)
2. **Scaffold**: LLM agent receives Grafema graph as context before/during exploration
3. **Metric**: Does the scaffold improve Action AUC, Dep F1, or constraint discovery?

Grafema provides the 67% of edges (IMPORTS) with perfect precision, plus partial CALLS_API. The LLM agent's job becomes: use the scaffold to bootstrap understanding, then focus exploration budget on the 15-30% of edges that require semantic reasoning (DI patterns, config interpretation, architectural intent from naming).
