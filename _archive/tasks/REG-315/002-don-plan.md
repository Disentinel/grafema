# REG-315: Don Melton's Analysis - attr_edge() Predicate

## Problem Statement

We need to query **edge metadata** in Datalog. Currently, `attr(NodeId, AttrName, Value)` only works for node attributes. REG-314 Phase 2 stores cardinality information on ITERATES_OVER edges, and we need to query this data to write guarantee rules.

Example use case:
```datalog
% Find loops iterating over large collections
large_iteration(Loop, Var, File, Line) :-
    node(Loop, "LOOP"),
    edge(Loop, Var, "ITERATES_OVER"),
    attr_edge(Loop, Var, "ITERATES_OVER", "cardinality.scale", Scale),
    (Scale = "nodes" ; Scale = "unbounded"),
    attr(Loop, "file", File),
    attr(Loop, "line", Line).
```

## Existing Pattern Analysis

### How `eval_attr()` Works (lines 433-511 in eval.rs)

The current `attr(NodeId, AttrName, Value)` predicate:

1. **Requires bound node ID** - returns empty if ID is not constant
2. **Gets node from engine** - `self.engine.get_node(node_id)`
3. **Handles built-in attributes**: `name`, `file`, `type`
4. **For other attributes**: parses metadata JSON and uses `get_metadata_value()` helper
5. **Returns bindings** based on value_term:
   - Variable: binds the value
   - Constant: checks equality
   - Wildcard: succeeds if attr exists

### The `get_metadata_value()` Helper (utils.rs)

This is the REG-313 implementation that we can reuse:

```rust
pub(crate) fn get_metadata_value(metadata: &Value, attr_name: &str) -> Option<String>
```

**Resolution strategy:**
1. Exact key match first (backward compatibility for keys with dots)
2. If not found AND key contains '.', try nested path resolution

**Supported value types:**
- String, Number, Bool -> returns `Some(String)`
- Object, Array, Null -> returns `None`

This is exactly what we need for edge metadata.

### Edge Storage (EdgeRecord in storage/mod.rs)

```rust
pub struct EdgeRecord {
    pub src: u128,
    pub dst: u128,
    pub edge_type: Option<String>,
    pub version: String,
    pub metadata: Option<String>,  // JSON string, same as node metadata
    pub deleted: bool,
}
```

The `metadata` field is identical in structure to node metadata - a JSON string.

### Edge Retrieval

There's no `get_edge(src, dst, type)` method. Available methods:

1. `get_outgoing_edges(src, edge_types)` - returns `Vec<EdgeRecord>`
2. `get_incoming_edges(dst, edge_types)` - returns `Vec<EdgeRecord>`
3. `get_all_edges()` - returns all edges

**Best approach**: Use `get_outgoing_edges(src, Some(&[edge_type]))` and filter by dst.

## Implementation Strategy

### Signature

```rust
fn eval_attr_edge(&self, atom: &Atom) -> Vec<Bindings>
```

**Arguments**: `attr_edge(Src, Dst, EdgeType, AttrName, Value)`

1. `Src` - Source node ID (must be constant/bound)
2. `Dst` - Destination node ID (must be constant/bound)
3. `EdgeType` - Edge type string (must be constant)
4. `AttrName` - Attribute name (must be constant, supports nested paths)
5. `Value` - Attribute value (variable, constant, or wildcard)

### Algorithm

1. Extract and validate arguments (need 5 args)
2. Parse src_id (must be constant u128)
3. Parse dst_id (must be constant u128)
4. Parse edge_type (must be constant string)
5. Get edges: `self.engine.get_outgoing_edges(src_id, Some(&[edge_type]))`
6. Filter to find edge with matching dst
7. If found, parse metadata JSON
8. Use `get_metadata_value()` to extract attribute
9. Match against value_term (same logic as eval_attr)

### Code Structure (mirrors eval_attr)

```rust
fn eval_attr_edge(&self, atom: &Atom) -> Vec<Bindings> {
    let args = atom.args();
    if args.len() < 5 {
        return vec![];
    }

    let src_term = &args[0];
    let dst_term = &args[1];
    let type_term = &args[2];
    let attr_term = &args[3];
    let value_term = &args[4];

    // 1. Need bound src ID
    let src_id = match src_term {
        Term::Const(s) => s.parse::<u128>().ok()?,
        _ => return vec![],
    };

    // 2. Need bound dst ID
    let dst_id = match dst_term {
        Term::Const(s) => s.parse::<u128>().ok()?,
        _ => return vec![],
    };

    // 3. Need constant edge type
    let edge_type = match type_term {
        Term::Const(s) => s.as_str(),
        _ => return vec![],
    };

    // 4. Need constant attr name
    let attr_name = match attr_term {
        Term::Const(s) => s.as_str(),
        _ => return vec![],
    };

    // 5. Find the edge
    let edges = self.engine.get_outgoing_edges(src_id, Some(&[edge_type]));
    let edge = edges.into_iter().find(|e| e.dst == dst_id)?;

    // 6. Parse metadata
    let metadata_str = edge.metadata.as_ref()?;
    let metadata: serde_json::Value = serde_json::from_str(metadata_str).ok()?;

    // 7. Get attribute value
    let attr_value = crate::datalog::utils::get_metadata_value(&metadata, attr_name)?;

    // 8. Match against value_term (same as eval_attr)
    match value_term {
        Term::Var(var) => {
            let mut b = Bindings::new();
            b.set(var, Value::Str(attr_value));
            vec![b]
        }
        Term::Const(expected) => {
            if &attr_value == expected {
                vec![Bindings::new()]
            } else {
                vec![]
            }
        }
        Term::Wildcard => vec![Bindings::new()],
    }
}
```

## Changes Required

### 1. Add predicate registration (eval.rs line ~184)

In `eval_atom()` match statement:

```rust
"attr_edge" => self.eval_attr_edge(atom),
```

### 2. Implement `eval_attr_edge()` function

New function after `eval_attr()` (around line 512).

### 3. Add tests (tests.rs)

Test cases:
- `test_eval_attr_edge_basic` - extract metadata from edge
- `test_eval_attr_edge_nested_path` - test "cardinality.scale" style paths
- `test_eval_attr_edge_constant_match` - matching against constant value
- `test_eval_attr_edge_no_metadata` - edge without metadata returns empty
- `test_eval_attr_edge_missing_attr` - missing attribute returns empty
- `test_eval_attr_edge_in_rule` - use in a datalog rule context

## Edge Cases

1. **Edge doesn't exist** - return empty
2. **Edge has no metadata** - return empty
3. **Attribute doesn't exist** - return empty
4. **Nested path doesn't resolve** - return empty (handled by get_metadata_value)
5. **Value is object/array/null** - return empty (handled by get_metadata_value)
6. **Multiple edges with same (src, dst, type)** - technically possible, we take first match

## Alignment with Vision

This is a straightforward extension that:
- Follows existing patterns (mirrors eval_attr exactly)
- Reuses proven helper (get_metadata_value from REG-313)
- Enables cardinality-based guarantees (REG-314 Phase 3)
- Keeps Datalog as the primary query interface for graph analysis

## Risk Assessment

**Low risk** - This is a clean addition:
- No changes to existing predicates
- Reuses existing, tested helper
- Follows established patterns
- Independent of other systems

## Estimated Effort

- Implementation: ~30 minutes
- Tests: ~30 minutes
- Total: ~1 hour

## Dependencies

- REG-313 (nested paths in attr) - Done, provides get_metadata_value()
- REG-314 Phase 2 (CardinalityEnricher) - Done, provides edge metadata to query

## Recommendation

**Proceed with implementation.** This is a well-defined, low-risk task that follows established patterns and is necessary for REG-314 Phase 3.
