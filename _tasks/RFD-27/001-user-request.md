# RFD-27: parse_query() should error on unconsumed input

## Goal

`parse_query()` in the Datalog parser should return an error when input is not fully consumed, instead of silently ignoring trailing content.

## Context

Discovered in REG-381. When `violation(X) :- node(X, "http:route").` is sent to `datalogQuery`, `parse_query()` parses only `violation(X)` and silently ignores `:- node(X, "http:route").`. This caused a confusing "0 results" response instead of a parse error.

## Acceptance Criteria

* `parse_query("node(X, \"http:route\")")` → succeeds (valid query)
* `parse_query("violation(X) :- node(X, \"http:route\").")` → returns parse error like "unexpected input after query at position N"
* Existing valid queries are unaffected

## Location

`packages/rfdb-server/src/datalog/parser.rs` — `parse_query()` method (line ~246)
