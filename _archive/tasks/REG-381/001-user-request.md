# REG-381: Datalog queries return no results for existing node types

## Goal

Ensure Datalog `node(X, "TYPE")` queries return existing nodes.

## Acceptance Criteria

* After successful analysis with `http:route` nodes present, query `violation(X) :- node(X, "http:route").` returns results.
* `grafema query` behavior matches `grafema ls --type <type>` for the same type.

## Context

On ToolJet after analysis, `grafema ls --type http:route` shows 322 nodes, but Datalog query `violation(X) :- node(X, "http:route").` returns no results. Similar for `FUNCTION`. This makes docs/examples unreliable.
