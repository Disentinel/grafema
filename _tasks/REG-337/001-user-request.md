# REG-337: Add column location to all physical nodes for precise cursor navigation

## Problem

VS Code extension can't distinguish between multiple nodes on the same line because many node types don't store `column` in metadata. Currently `column` is OPTIONAL and defaults to 0.

Example: `Invitations.tsx:91` has 3 nodes:

* FUNCTION formatDate → column: 21 ✓
* VARIABLE formatDate → column: undefined (defaults to 0) ✗
* SCOPE formatDate:body → column: undefined ✗

When user clicks at different positions on the same line, nodeLocator can't tell them apart.

## Solution

1. **Make** `column` REQUIRED for all physical code nodes (nodes that represent specific code locations)
2. **Add validation in NodeFactory** - throw error if column is undefined/missing for physical nodes
3. **Physical nodes** (must have column):
   * FUNCTION, VARIABLE_DECLARATION, CONSTANT, LITERAL
   * CALL_SITE, METHOD_CALL, CONSTRUCTOR_CALL
   * OBJECT_LITERAL, ARRAY_LITERAL, EXPRESSION
   * CLASS, INTERFACE, TYPE, ENUM, IMPORT, EXPORT
   * DECORATOR, EVENT_LISTENER, HTTP_REQUEST, DATABASE_QUERY
   * PARAMETER, BRANCH, CASE
4. **Abstract/semantic nodes** (no column needed):
   * SERVICE, ENTRYPOINT, MODULE
   * SCOPE (spans range, not point)
   * EXTERNAL_MODULE, net:request, net:stdio
   * ISSUE (optional column)

## Implementation

1. Update node contracts: move `column` from OPTIONAL to REQUIRED
2. Add validation in `NodeFactory.create*()` methods
3. Update analyzers to always pass column from AST
4. Run analysis on test projects to catch violations

## Acceptance Criteria

- [ ] All physical nodes have `column` in metadata
- [ ] NodeFactory throws on missing column for physical nodes
- [ ] VS Code extension can distinguish nodes on same line
