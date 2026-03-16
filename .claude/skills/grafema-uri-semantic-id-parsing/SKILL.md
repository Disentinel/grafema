---
name: grafema-uri-semantic-id-parsing
description: |
  Fix silent failures when parsing Grafema semantic IDs that are in URI format
  instead of legacy arrow format. Use when: (1) code splits semantic IDs by "->"
  but gets the whole string back because IDs are grafema:// URIs, (2) file path
  extraction from semantic IDs returns empty or wrong values, (3) derived edges
  (DEPENDS_ON, etc.) produce 0 results despite source edges existing, (4) any
  code that processes semantic IDs after the analysis pipeline's to_uri_format()
  has run. The grafema:// URI format uses # fragments with percent-encoded
  characters instead of -> separators.
author: Claude Code
version: 1.0.0
date: 2026-03-16
---

# Grafema URI Semantic ID Parsing

## Problem
Code that processes semantic IDs using `split("->")` silently fails when the
analysis pipeline has converted IDs to `grafema://` URI format. The URI format
uses `#` fragments with percent-encoded characters (`%3E` instead of `>`),
so `->` never appears and `split("->")` returns the entire string as element 0.

## Context / Trigger Conditions
- Derived edges (e.g., MODULE->MODULE DEPENDS_ON from IMPORTS_FROM) produce 0 results
- File path extraction from semantic IDs returns the whole URI string
- Any Rust code in the orchestrator that processes semantic IDs from RFDB after
  `to_uri_format()` has been called during analysis
- Lookups into `file_to_module` or similar file-keyed maps always miss

## The Two Formats

**Legacy compact format** (before `to_uri_format`):
```
src/components/App.tsx->IMPORT_BINDING->react
MODULE#src/components/App.tsx
```

**URI format** (after `to_uri_format`, stored in RFDB):
```
grafema://github.com/owner/repo/src/components/App.tsx#IMPORT_BINDING%3Ereact
grafema://github.com/owner/repo/src/components/App.tsx#MODULE
```

**Virtual nodes** (no file path):
```
grafema://github.com/owner/repo/_/EXTERNAL_MODULE%3Elodash
grafema://github.com/owner/repo/_/GLOBAL%3A%3Aconsole
```

## Solution

Always handle both formats when extracting file paths from semantic IDs:

```rust
// Pre-compute URI prefix (authority is known from resolve_authority())
let uri_prefix = format!("grafema://{authority}/");

let extract_file = |id: &str| -> &str {
    if let Some(rest) = id.strip_prefix(&uri_prefix) {
        // URI format: take path up to '#'
        rest.split('#').next().unwrap_or("")
    } else {
        // Legacy format: take path up to first '->'
        id.split("->").next().unwrap_or("")
    }
};
```

Key points:
- `authority` is always available via `resolve_authority(&cfg)` in main.rs
- Virtual nodes have `_/` as the file path component — these won't match real files (correct behavior)
- `node.file` fields stay as **relative paths** (not URI-formatted), so `file_to_module` maps use relative paths as keys
- Edge `src`/`dst` fields ARE URI-formatted (they reference node IDs which were converted)

## Verification

After fixing, check:
1. `all_imports_from_edges.len()` > 0 (edges are collected)
2. `depends_on_pairs.len()` > 0 (file paths extracted and matched)
3. Tracing output shows "Module dependency edges derived" with non-zero count

## Example: The DEPENDS_ON Bug

The `to_uri_format()` method in analyzer.rs converts node IDs but keeps `node.file` as-is:
```rust
pub fn to_uri_format(&mut self, authority: &str) {
    for node in &mut self.nodes {
        node.id = convert(&node.id);  // → grafema://authority/path#FRAGMENT
        // node.file stays as relative path
    }
    for edge in &mut self.edges {
        edge.src = convert(&edge.src);  // → URI format
        edge.dst = convert(&edge.dst);  // → URI format
    }
}
```

So IMPORTS_FROM edges in RFDB have URI-formatted src/dst, but MODULE nodes have
relative file paths. The derivation code must parse URIs to extract relative paths
for the `file_to_module` lookup.

## Notes
- This affects ALL code that processes semantic IDs from RFDB in the orchestrator
- The `compact_to_uri` function in analyzer.rs defines the exact URI structure
- Fragment encoding: `>` → `%3E`, `[` → `%5B`, `]` → `%5D`, `#` → `%23`
- If `authority` changes between runs, old and new URIs won't match
