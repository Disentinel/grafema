# User Request: REG-517

**Source:** Linear issue REG-517
**Title:** VSCode Phase 5: EXPLORER enhancements (search, filters, bookmarks)

## Goal

Enhance existing graph explorer with search, edge type filtering, and bookmarks.

## Scope

* **Search**: Text input to find nodes by name (use queryNodesStream)
* **Edge type filter**: Quick Pick with checkboxes — show/hide CALLS, IMPORTS, ASSIGNED_FROM, etc.
* **Bookmarks**: Pin frequently visited nodes for quick access (persisted in workspace state)
* **Improved labels**: Show more context in description (module path, exported status)

## Dependencies

* queryNodesStream already available in RFDB client

## Acceptance Criteria

- [ ] Can search nodes by name
- [ ] Can filter displayed edges by type
- [ ] Can bookmark/pin nodes
- [ ] Bookmarks persist across sessions

## MLA Configuration

Mini-MLA: Don → Dijkstra → Uncle Bob → Kent ∥ Rob → 4-Review → Vadim
