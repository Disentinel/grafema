# User Request: REG-98 - Migrate all node creation to NodeFactory

## Source
Linear Issue: REG-98
URL: https://linear.app/reginaflow/issue/REG-98/refactor-migrate-all-node-creation-to-nodefactory

## Problem Statement

Nodes are created as inline object literals in multiple places instead of using `NodeFactory`. This causes:
- Inconsistent node attributes (some nodes missing required fields)
- UI displays incomplete information in explore view
- No compile-time validation of node structure
- NodeCreationValidator cannot catch violations

## Root Cause Analysis

NodeCreationValidator was designed to find inline literals in `graph.addNode()` calls, but the actual architecture uses:
1. Visitors collect data into arrays via `.push({...})`
2. GraphBuilder buffers nodes via `_bufferNode({...})`
3. `graph.addNodes()` receives a variable, not inline literals

The validator looks in the wrong place - it checks `addNodes()` arguments but inline objects are created in `push()` and `_bufferNode()`.

## Required Solution

Migrate ALL node creation to use `NodeFactory.createX()` methods:
1. Create missing factory methods for node types without them
2. Update all visitors to use factory methods
3. Update GraphBuilder to use factory methods
4. Add TypeScript type enforcement to prevent inline creation

## Scope

**Node types requiring refactoring:**
- CLASS
- IMPORT
- EXPORT
- EXTERNAL_MODULE
- INTERFACE
- TYPE
- ENUM
- DECORATOR
- EXPRESSION
- net:stdio (use ExternalStdioNode)
- net:request (use HttpRequestNode)
- OBJECT_LITERAL
- ARRAY_LITERAL

**Files to update:**
- `GraphBuilder.ts` - 18 inline node creations
- `CallExpressionVisitor.ts` - 18 push() calls
- `ImportExportVisitor.ts` - 11 push() calls
- `FunctionVisitor.ts` - 7 push() calls
- `VariableVisitor.ts` - 5 push() calls
- `TypeScriptVisitor.ts` - 5 push() calls
- `ClassVisitor.ts` - 4 push() calls

## Acceptance Criteria
- All node creation goes through NodeFactory
- TypeScript types prevent inline object creation
- All existing tests pass
- NodeCreationValidator can be removed or simplified

## Blocked By
- REG-115: Data Flow: Transitive reachability queries
- REG-113: Data Flow: Track array mutations (.push, .unshift, assignment)
