# REG-515: VSCode Phase 3: ISSUES panel with badge

**Source:** Linear REG-515
**Date:** 2026-02-19
**Priority:** Medium

## Goal

Surface graph-level issues (guarantee violations, connectivity gaps, analysis warnings) in a dedicated panel with badge count.

## Scope

### ISSUES Panel (TreeView with badge)

* Badge on tab shows total issue count
* Three groups:

**Guarantee violations:**
* Query ISSUE nodes from graph
* Show: violation message, file:line, which guarantee
* Click → jump to code location
* Icon: `$(warning)` yellow

**Connectivity gaps:**
* From value trace analysis: where traces break
* Missing edges, unresolved imports, unknown callees
* "Missing edge: X → Y" with source location
* Icon: `$(debug-disconnect)`

**Analysis warnings:**
* Files that failed to parse
* Skipped files (unsupported syntax)
* Plugin errors
* Icon: `$(info)` blue

### Integration

* Refresh on graph reconnect / reanalysis
* DiagnosticCollection: push guarantee violations as VS Code diagnostics (squiggly underlines in editor)
* Problems panel integration (standard VS Code "Problems" tab)

## Dependencies

* ISSUE nodes from guarantee engine
* Connectivity gap detection (from Phase 1 value tracing)

## Acceptance Criteria

- [ ] ISSUES panel shows grouped issues
- [ ] Badge count on tab
- [ ] Click issue → jump to code
- [ ] Guarantee violations also appear in Problems panel
- [ ] Refreshes on reanalysis
