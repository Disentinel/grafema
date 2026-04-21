---
name: rfdb-datalog-hash-join-shared-var
description: |
  Fix silent incorrect results in RFDB Datalog queries that share a variable
  between two edge atoms on opposite ends (e.g. self-join patterns like
  `edge(M, C, "T1"), edge(C, M, "T2")`). Use when: (1) a Datalog rule
  returns rows that look structurally wrong (e.g. a self-loop rule reports
  hits but pinning M to each reported id refutes the edge existence),
  (2) Cypher `MATCH (m)-[:R1]->(c)-[:R2]->(m)` returns the same bogus
  rows (engine-level bug, not Datalog-specific), (3) results change when
  you bind one variable explicitly vs. leave it free. Root cause: hash-
  join fast path in `eval_edge_hash_join` / `eval_incoming_hash_join`
  unconditionally rebinds the non-key Term::Var without checking
  whether the variable is already bound in the current row.
author: Claude Code
version: 1.0.0
date: 2026-04-20
---

# RFDB Datalog hash-join shared-var bug

## Problem

RFDB's Datalog engine has a fast path that kicks in once `current`
bindings exceed `HASH_JOIN_THRESHOLD`: it pulls all edges of a given
type and builds `HashMap<src, Vec<dst>>` (or the inverse for
`incoming`) for O(1) lookups per binding.

The bug: when the other end of the edge is a `Term::Var` whose name
is **already bound** in the current row (i.e. a shared variable
across two atoms), the fast path rebinds it unconditionally. Any
value that satisfies the second edge pattern in isolation gets
emitted as a "match," even when it contradicts the first atom's
bindings.

### Repro

```
edge(M, C, "CONTAINS"), edge(C, M, "SENDS_MESSAGE")
```

When you want: `M contains C` AND `C sends back to M` (self-loop).

What you get with the bug: `M contains C` AND `C sends to *any* M'`,
bleeding ~N false positives.

Constraining M to a concrete id returns 0 rows; free M returns many.
That delta is the symptom.

## Trigger conditions

1. Two `edge/3` or `incoming/3` atoms share a variable, each on
   opposite sides of the edge direction.
2. Current bindings for the *first* atom exceed `HASH_JOIN_THRESHOLD`
   (default 256). Below that, nested-loop runs via `unify` which
   handles bound vars correctly.
3. Edge types are constants (hash-join requires const type).

## Fix

In `packages/rfdb-server/src/datalog/eval.rs`, both
`eval_edge_hash_join` and `eval_incoming_hash_join` must check the
non-key `Term::Var` against `bindings.get(var)` before accepting a
row:

```rust
if let Term::Var(var) = dst_term {
    if let Some(existing) = bindings.get(var).and_then(|v| v.as_id()) {
        if existing != dst_id { continue; }
    }
}
```

(Mirror in `eval_incoming_hash_join` with `src_term` / `src_id`.)

Put the check **before** `bindings.clone()` so mismatched rows are
skipped without allocation.

## Verification

Regression tests in `packages/rfdb-server/src/datalog/tests.rs`:
- `test_hash_join_shared_var_across_two_edges` — edge/3 self-join.
- `test_incoming_hash_join_shared_var` — incoming/3 self-join.

Both build a graph with `n = HASH_JOIN_THRESHOLD + 10` triples where
exactly one pair forms a true round-trip. Without the fix, the
rule returns n rows; with the fix, 1.

## How we found it

Adding `MESSAGE_TYPE → CONTAINS → CALL` edges to the BEAM graph and
writing a Datalog guarantee for handler self-loops surfaced 13 hits
on Ichi. Drilling into each "hit" M by binding it to a literal id
showed zero incoming CONTAINS-that-sends-back edges. Reducing to the
minimal repro `edge(A, B, "CONTAINS"), edge(B, A, "CONTAINS")` on a
tree-shaped graph produced 15 spurious symmetric pairs — a tree has
zero symmetric CONTAINS by construction. Cypher showed the same
rows, ruling out the Datalog reorder/parser layer and pointing at
the shared join engine.

## Notes

- Nested-loop path (via `unify`) is correct — the bug is isolated to
  the hash-join fast path.
- `eval_negation_hash_join` (for `\+ edge(X, _, "T")`) does not have
  the same bug because it only projects one variable by design; the
  other side is always `_` / `Wildcard`.
- If you ever add a third variant of hash-join (e.g. for path/2
  transitive closure), port the same check.
