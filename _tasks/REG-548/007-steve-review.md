## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

---

### Vision Alignment

The project vision is: "AI should query the graph, not read code." That only works if the graph data is accurate. EXPRESSION nodes with column values of 200–600 (byte offsets) instead of 10 (true column) are corrupted data. An agent trying to navigate to code using those positions gets the wrong answer — every time. Fixing this is not housekeeping. It is a prerequisite for the vision to function at all.

This fix is a direct enabler of the vision: accurate position data in the graph = agents can trust the graph = agents do not need to fall back to reading source files.

### Architecture

The implementation is exactly right. There is already a shared, documented utility — `getColumn(node)` in `packages/core/src/plugins/analysis/ast/utils/location.ts` — that is the designated "single source of truth for location extraction across all analyzers." The fix applies that helper at all 10 sites in `trackVariableAssignment` and the destructuring branch. No new abstraction was invented; the existing one was used correctly.

The `getColumn` implementation is minimal and safe: `node?.loc?.start?.column ?? 0`. It handles null/undefined nodes without throwing. The fallback to 0 is honest — 0 means "unknown location," not "byte offset of something else."

### Tests

The test design is smart. The fixture uses padding lines to push byte offsets well above 200 while keeping the real expressions at column 10. That gap makes the distinction between the bug and the fix unambiguous — there is no grey zone. All 7 expression types from the fix are covered. The ID-consistency test (8th test) is a good catch: it verifies that the column embedded in the node ID matches `node.column`, which prevents silent mismatches between the identifier and the stored field.

The test setup is idiomatic and matches the existing test patterns in this codebase.

### Would shipping this embarrass us?

No. The opposite is true. Shipping EXPRESSION nodes with byte offsets as column values would be the embarrassment. Any agent or developer querying the graph and getting position 347 for code that sits at column 10 would immediately lose confidence in the entire graph. This fix restores that confidence.

The change is narrow, correct, complete, and well-tested. Ship it.
