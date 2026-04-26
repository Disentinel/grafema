# REG-531: Chained method calls resolve to PROPERTY_ACCESS instead of CALL

## Source
Linear issue REG-531

## Problem
`this.discoveryManager.buildIndexingUnits()` resolves to `PROPERTY_ACCESS "discoveryManager"` instead of the CALL node. Direct `this.method()` calls work fine.

## Repro
- File: `packages/core/src/Orchestrator.ts` lines 217, 334, 337, 493
- Hover over chained method call

## Expected
Should resolve to the CALL node for the method being invoked.

## Root Cause (from issue)
For chained calls `obj.prop.method()`, the cursor position falls on the property access portion, and `findNodeAtCursor` returns the PROPERTY_ACCESS node instead of the enclosing CALL node.

## Acceptance Criteria
- Chained method calls like `obj.prop.method()` resolve to CALL node
- Direct method calls like `this.method()` continue to work correctly
- Tests cover both chained and direct call patterns
