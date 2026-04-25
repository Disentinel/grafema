# REG-552: Index class property declarations (fields with modifiers)

**Linear:** https://linear.app/grafemadev/issue/REG-552/index-class-property-declarations-fields-with-modifiers
**Priority:** Urgent
**Labels:** v0.2, Feature

## Goal

Create graph nodes for class property declarations. Currently `private graph: GraphBackend`, `private config: OrchestratorOptions`, etc. produce no nodes — invisible in the graph.

## Expected

Each class field declaration should produce a node (e.g. `CLASS_PROPERTY` or `VARIABLE` with modifier metadata) with:

* `name`: field name (`graph`, `config`, etc.)
* `file`, `line`, `column`: position of the field name
* `metadata.modifier`: `"private"` | `"public"` | `"protected"` | `"readonly"`
* `metadata.type`: TypeScript type annotation if present

## Acceptance Criteria

- [ ] `private graph: GraphBackend` → node visible in graph
- [ ] Field modifier (`private`/`public`/`protected`) stored in metadata
- [ ] Node appears in "Nodes in File" panel at correct position
- [ ] Unit test: class with 3 fields, all 3 indexed with correct modifiers
