---
name: grafema-orchestrator-derived-edges
description: |
  Pattern for adding derived edge types in the Grafema Rust orchestrator (main.rs).
  Use when: (1) need to create new graph edges derived from existing edges (e.g., MODULE-level
  DEPENDS_ON from IMPORTS_FROM), (2) Datalog joins on large edge sets time out,
  (3) adding enrichment steps that combine data from multiple resolver outputs,
  (4) need to understand how resolver outputs flow through the orchestrator pipeline.
author: Claude Code
version: 1.0.0
date: 2026-03-11
---

# Adding Derived Edges in Grafema Orchestrator

## Problem

You need to add a new edge type that is derived from existing edges created by resolvers.
For example, MODULE->MODULE DEPENDS_ON edges derived from IMPORTS_FROM edges that connect
IMPORT_BINDINGs to their target nodes (CLASS, FUNCTION, MODULE).

## Context / Trigger Conditions

- Need to create graph edges that aggregate or transform existing edges
- Datalog joins involving large edge sets (CONTAINS, IMPORTS_FROM) time out
- New edge type requires data from multiple resolver outputs (JS, Haskell, Rust, etc.)

## Why NOT Datalog

A Datalog query like:
```
violation(SrcMod, DstMod) :-
  edge(Src, Dst, "IMPORTS_FROM"),
  edge(SrcMod, Src, "CONTAINS"),
  node(SrcMod, "MODULE"),
  edge(DstMod, Dst, "CONTAINS"),
  node(DstMod, "MODULE").
```
Times out on real codebases (~1,964 IMPORTS_FROM edges × CONTAINS joins). The RFDB
Datalog engine is not optimized for multi-way joins at this scale.

## Solution

Derive edges **in-memory in the orchestrator** after all resolvers complete.

### Step 1: Declare a collector before resolution blocks

```rust
// Before step 8 in main.rs
let mut all_imports_from_edges: Vec<(String, String)> = Vec::new();
```

### Step 2: Build index from analysis results

`FileAnalysis` has `file` and `module_id` fields — use them directly:

```rust
let file_to_module: HashMap<String, String> = results
    .iter()
    .filter_map(|r| r.analysis.as_ref())
    .map(|a| (a.file.clone(), a.module_id.clone()))
    .collect();
```

### Step 3: Collect edges from each resolver output

After each import-related resolver commits to RFDB, collect its IMPORTS_FROM edges:

```rust
for edge in &import_output.edges {
    if edge.edge_type == "IMPORTS_FROM" {
        all_imports_from_edges.push((edge.src.clone(), edge.dst.clone()));
    }
}
```

Do this for ALL language resolvers: JS, Haskell, Rust, Java, Kotlin, Python, JVM cross.

### Step 4: Extract file from semantic ID

Semantic IDs follow the pattern `path/to/file.ts->TYPE->name[scope]`.
File path is always the first segment before `->`:

```rust
let src_file = src_id.split("->").next().unwrap_or("");
```

### Step 5: Derive and deduplicate

```rust
let mut depends_on_pairs: HashSet<(String, String)> = HashSet::new();
for (src_id, dst_id) in &all_imports_from_edges {
    let src_file = src_id.split("->").next().unwrap_or("");
    let dst_file = dst_id.split("->").next().unwrap_or("");
    if let (Some(src_mod), Some(dst_mod)) =
        (file_to_module.get(src_file), file_to_module.get(dst_file))
    {
        if src_mod != dst_mod {
            depends_on_pairs.insert((src_mod.clone(), dst_mod.clone()));
        }
    }
}
```

### Step 6: Commit to RFDB

```rust
let wire_edges: Vec<rfdb::WireEdge> = depends_on_pairs.iter().map(|(src, dst)| {
    rfdb::WireEdge {
        src: src.clone(),
        dst: dst.clone(),
        edge_type: "DEPENDS_ON".to_string(),
        metadata: Some(format!(
            r#"{{"_source":"module-dependencies","_generation":{generation}}}"#
        )),
    }
}).collect();

rfdb.commit_batch(&[], &[], &wire_edges, false).await?;
```

## Key Constraints

1. **Resolvers receive nodes, not edges** — a Haskell/JS resolver cannot query existing
   edges. Derived edges MUST be computed in the orchestrator (Rust) or via batch-mode plugin.

2. **Resolution outputs are scoped** — each resolver's output exists only within its
   `match` arm. Collect edges immediately after each commit, before the pool shuts down.

3. **Metadata stamping** — use `_source` and `_generation` fields. The orchestrator's
   `gc::stamp_edge_metadata()` handles this for resolver outputs, but for manually
   constructed WireEdges, stamp metadata in the JSON string directly.

4. **Placement** — add derived edge computation AFTER all resolvers (including user plugins)
   but BEFORE the summary println. This ensures all source data is available.

## Verification

```bash
cargo build --release  # Must compile clean
cargo test             # All tests pass
```

After re-analysis:
```
query_graph('violation(X) :- edge(X, _, "DEPENDS_ON").')
# Should return MODULE nodes
```

## Notes

- For ~2,000 IMPORTS_FROM edges and ~350 modules, derivation is instant (< 1ms)
- The `file_to_module` map comes from `FileAnalysis.module_id`, not from RFDB queries
- Self-edges (src_mod == dst_mod) are filtered out
- HashSet deduplication handles multiple imports between the same module pair
