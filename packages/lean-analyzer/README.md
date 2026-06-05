# @grafema/lean-analyzer

Lean 4 code graph extractor for Grafema. Extracts declarations, type class hierarchy, proof dependencies, and tactic attribute membership from Lean 4 environments via `.olean` files.

## Requirements

- Lean 4 (via `elan`) — version matching the target project's `lean-toolchain`
- `lake` build system
- Pre-built `.olean` cache (`lake exe cache get` for Mathlib)

## Usage

```bash
# From within a Lean 4 project with built .olean files:
cd /path/to/lean-project
lake env lean --run /path/to/GrafemaExtract.lean [module] [output.jsonl]

# Example: extract full Mathlib
lake env lean --run GrafemaExtract.lean Mathlib mathlib-graph.jsonl

# Example: extract a subtree
lake env lean --run GrafemaExtract.lean Mathlib.Algebra algebra-graph.jsonl
```

## Output Format

JSONL with two record types:

**Nodes** (`"t":"n"`):
```json
{"t":"n","id":"Nat.add_comm","type":"THEOREM","name":"add_comm","file":"Mathlib/Algebra/Group/Defs.lean","module":"Mathlib.Algebra.Group.Defs","origin":"mathlib","uparams":[],"simp":true,"line":42,"col":8,"endLine":42,"endCol":16}
```

**Edges** (`"t":"e"`):
```json
{"t":"e","src":"Nat.add_comm","tgt":"Nat.rec","type":"PROOF_USES"}
```

## Node Types

| Type | Description |
|------|-------------|
| MODULE | Lean module (file) |
| THEOREM | Proven proposition |
| DEFINITION | Computable definition |
| CLASS | Type class |
| INSTANCE | Type class instance |
| INDUCTIVE | Inductive type |
| CONSTRUCTOR | Constructor of inductive |
| RECURSOR | Recursor/eliminator |
| AXIOM | Postulated axiom |
| OPAQUE | Opaque constant |
| QUOTIENT | Quotient type primitive |
| RULE_SET | Aesop tactic rule set |

## Edge Types

| Type | Description |
|------|-------------|
| CONTAINS | Module → declaration |
| IMPORTS | Module → module |
| TYPE_USES | Declaration references in type signature |
| PROOF_USES | Theorem proof references (not in type) |
| VALUE_USES | Definition body references (not in type) |
| EXTENDS | Class hierarchy (child → parent) |
| INSTANCE_OF | Instance → type class |
| HAS_CONSTRUCTOR | Inductive ↔ constructor |
| MEMBER_OF | Declaration → Aesop rule set |

## Attributes

| Field | Attribute | Description |
|-------|-----------|-------------|
| `"simp":true` | `@[simp]` | Simplification lemma |
| `"ext":true` | `@[ext]` | Extensionality lemma |
| `"norm_num":true` | `@[norm_num]` | Numeric normalization evaluator |

## Loading into RFDB

```bash
# Start RFDB server
rfdb-server ./graph.rfdb --socket /tmp/rfdb.sock

# Load (two-pass: nodes first, then edges)
node load-into-rfdb.mjs /tmp/rfdb.sock mathlib-graph.jsonl
```

## Performance (Mathlib, 2.2M LOC)

| Stage | Time | Output |
|-------|------|--------|
| Lean extraction | 8:45 | 1.5 GB JSONL |
| RFDB load | 3:26 | 1.2 GB on disk |
| **Total** | **~12 min** | 497K nodes, 13.7M edges |

## Tests

```bash
# Generate test fixture
cd /path/to/mathlib4
lake env lean --run GrafemaExtract.lean Mathlib.Data.Nat.Basic test-verify.jsonl

# Run tests (53 tests, 9 categories)
node test-extractor.mjs test-verify.jsonl
```

## Known Limitations

1. **Mathlib-specific imports**: `import Aesop` and `import Mathlib.Tactic.NormNum.Core` are required for Aesop rule set and norm_num extraction. For non-Mathlib projects, remove these imports.
2. **Tactic attribution**: Proof terms contain results of tactic execution but not which tactic was used. All lemma references are captured via PROOF_USES.
3. **ID collisions**: ~200 cases where module names coincide with declaration names (Lean4 characteristic).
4. **Source positions**: 74-82% coverage. Auto-generated declarations (recursors, match lemmas) lack positions.
