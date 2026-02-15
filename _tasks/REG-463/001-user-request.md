# REG-463: Review & split MethodCallResolver.ts (927 lines)

## Goal

Uncle Bob review of MethodCallResolver.ts (927 lines, 1.9x over limit). Split if clear boundaries exist.

## Scope

* File-level review: identify responsibilities
* Method-level review: identify candidates for extraction
* Decision: split or defer (if risk > benefit)

## Acceptance Criteria

* File < 500 lines, OR documented reason to defer
* All tests pass
