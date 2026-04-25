# REG-573: GraphBuilder: Object literal properties not connected to OBJECT_LITERAL node

## Problem

`OBJECT_LITERAL` nodes exist in the graph but have **zero outgoing edges** to their key-value properties. `PROPERTY_ASSIGNMENT` nodes for object literal syntax (`{ key: value }`) are not created at all — only for mutations (`this.prop = value`). Without this, it's impossible to determine the schema of any object from the graph.

## Acceptance Criteria

* All `{ key: value }` object literal forms create `PROPERTY_ASSIGNMENT` nodes linked from `OBJECT_LITERAL` via `HAS_PROPERTY`
* Each `PROPERTY_ASSIGNMENT` has `PROPERTY_KEY` (to key name literal) and `PROPERTY_VALUE` (to value expression) edges
* Mutation-form `this.prop = value` `PROPERTY_ASSIGNMENT` nodes get `ASSIGNS_TO` + `ASSIGNED_FROM` edges
* Schema of any object can be reconstructed by graph traversal
* No regressions in existing tests; new tests for both object literal and mutation forms
