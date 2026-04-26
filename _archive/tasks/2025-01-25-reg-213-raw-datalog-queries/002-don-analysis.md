# Don Melton Analysis: REG-213 Raw Datalog Queries

## Investigation Summary

The `--raw` flag **IS implemented and functional**. The problem is that users are using incorrect syntax.

## The Actual Problem

```bash
grafema query --raw "type(N, T)"
# → No results
```

The query returns no results because **`type` is NOT a valid predicate**. Looking at `rust-engine/src/datalog/eval.rs:128-138`:

```rust
pub fn eval_atom(&self, atom: &Atom) -> Vec<Bindings> {
    match atom.predicate() {
        "node" => self.eval_node(atom),
        "edge" => self.eval_edge(atom),
        "incoming" => self.eval_incoming(atom),
        "path" => self.eval_path(atom),
        "attr" => self.eval_attr(atom),
        "neq" => self.eval_neq(atom),
        "starts_with" => self.eval_starts_with(atom),
        "not_starts_with" => self.eval_not_starts_with(atom),
        _ => self.eval_derived(atom),
    }
}
```

## Available Predicates

| Predicate | Signature | Purpose |
|-----------|-----------|---------|
| `node` | `node(Id, Type)` | Find nodes by type or get type of node |
| `edge` | `edge(Src, Dst, Type)` | Find edges |
| `incoming` | `incoming(Dst, Src, Type)` | Find incoming edges |
| `path` | `path(Src, Dst)` | Check reachability |
| `attr` | `attr(NodeId, AttrName, Value)` | Access node attributes |
| `neq` | `neq(A, B)` | Check inequality |
| `starts_with` | `starts_with(Str, Prefix)` | String prefix check |
| `not_starts_with` | `not_starts_with(Str, Prefix)` | Negated prefix check |

## What Should Work

```bash
# Correct syntax - use 'node' not 'type'
grafema query --raw 'node(X, "FUNCTION")'

# Find nodes by name
grafema query --raw 'node(X, "FUNCTION"), attr(X, "name", "myFunc")'

# Find edges
grafema query --raw 'edge(X, Y, "CALLS")'
```

## Root Cause

1. **Missing documentation**: CLI `--help` doesn't show available predicates or examples
2. **Intuitive predicate missing**: Users expect `type(N, T)` but must use `node(N, T)`
3. **No error feedback**: Unknown predicates silently return empty results

## Fix Required

### Option 1: Documentation Only (minimal)
- Update `--help` to show available predicates and examples
- Add error message for unknown predicates

### Option 2: Add `type` Predicate (better UX)
- Add `type(Id, Type)` as alias for `node(Id, Type)` in eval.rs
- This matches user intuition

### Option 3: Both (recommended)
- Add `type/2` predicate as alias
- Add comprehensive `--help` documentation
- Add error messages for unknown predicates

## Recommendation

**Option 3** - Both fixes. This aligns with project vision: the graph should be the superior way to understand code. Users shouldn't need to guess the syntax.

## Implementation Scope

1. **Rust changes**: Add `type` predicate alias in `eval.rs` (1 line)
2. **CLI changes**: Update help text in `query.ts`
3. **Error handling**: Improve feedback for unknown predicates
