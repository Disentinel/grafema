# REG-554: Index this.property = value assignments as PROPERTY_ASSIGNMENT nodes

**Source:** Linear REG-554
**Date:** 2026-02-22
**Priority:** Urgent
**Labels:** v0.2, Feature

## Goal

Model `this.x = value` assignments as graph nodes. Currently `this.graph = options.graph!` creates only a `PROPERTY_ACCESS "graph"` with no assignment semantics — the data flow is lost.

## Design

New node type `PROPERTY_ASSIGNMENT` (or reuse VARIABLE with `isField: true`):

* `name`: property name (`graph`)
* `file`, `line`, `column`
* Edges: `ASSIGNED_FROM → <rhs node>`, `CONTAINED_IN → CLASS`

## Impact

Without this, tracing data flow into class fields is impossible — `this.x` assignments are a dead end.

## Acceptance Criteria

- [ ] `this.graph = options.graph!` → PROPERTY_ASSIGNMENT node + `ASSIGNED_FROM` edge to rhs
- [ ] PROPERTY_ASSIGNMENT linked to owning CLASS node
- [ ] Unit test: constructor with 3 field assignments, all traced correctly
