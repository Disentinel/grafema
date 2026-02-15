# RFD-29: Make v2 edge write-buffer upsert semantics explicit

## Source

Linear issue RFD-29

## Request

Make upsert behavior explicit in the v2 write-buffer API and callsites:

- Introduce explicit edge upsert API in `write_buffer` (e.g. `upsert_edge`) or equivalent explicit contract
- Make callsites intentional and readable around insert-vs-update semantics
- Replace ambiguous `bool` return with semantic result (`Inserted` / `Updated`) where practical
- Keep/extend regression coverage for:
  - duplicate edge key metadata replacement
  - delete + re-add with same key in one flush window
- Update inline docs/comments to reflect canonical semantics

## Acceptance Criteria

- Upsert intent is explicit in API or returned operation type
- Existing and added tests pass, including computed-property scenarios that rely on same-key metadata refresh
- No regressions in edge key dedup behavior
