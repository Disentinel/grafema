# REG-514: IntelliJ-style Call Hierarchy + CodeLens

## Goal

IntelliJ-style call hierarchy + CodeLens showing caller/callee counts above functions.

## Scope

### CALLERS Panel (TreeView)

- Incoming calls (who calls this function) — follow incoming CALLS edges
- Outgoing calls (what does this function call) — follow outgoing CALLS edges
- Expandable: click a caller → shows ITS callers (recursive depth)
- Depth control: Quick Pick to set max depth (1-5)
- Filters: hide test files, hide node_modules
- Description shows file:line, tooltip shows code context

### CodeLens

- Register `vscode.languages.registerCodeLensProvider`
- Above each FUNCTION node in graph:

  ```
  3 callers · 2 callees · blast: 5 files
  ```

- Each segment is a clickable command:
  - "3 callers" → opens CALLERS panel focused on this function
  - "2 callees" → same, flipped to outgoing
  - "blast: 5 files" → opens BLAST RADIUS panel (or placeholder if Phase 4 not done)
- Performance: batch-query all functions in visible range, cache results
- Setting to enable/disable CodeLens

## Dependencies

- CALLS edges already exist in graph
- Need efficient "count edges by type" query or client-side counting

## Acceptance Criteria

- [ ] CALLERS panel shows incoming/outgoing call hierarchy
- [ ] Recursive expansion works (caller's callers)
- [ ] Depth control and test/node_modules filter
- [ ] CodeLens shows counts above functions
- [ ] CodeLens segments clickable → open relevant panel
- [ ] Performance acceptable (no visible delay on scroll)
