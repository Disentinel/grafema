# Implementation Report: REG-395 — PROPERTY_ACCESS Nodes

## Summary

Closed the property access gap in the graph. Instead of `grafema grep`, we made property reads first-class graph citizens.

## What was built

### Core: PROPERTY_ACCESS nodes
- New node type tracking property reads (e.g., `config.maxBodyLength`)
- One node per chain link: `a.b.c` → nodes for `b` and `c`
- Method calls stay as CALL nodes — no duplication
- Handles: optional chaining, computed properties, this.prop, bracket notation

### CLI Integration
- `grafema query maxBodyLength` now finds PROPERTY_ACCESS nodes (added to default search types)
- `grafema query "property maxBodyLength"` and `grafema query "prop maxBodyLength"` work as type aliases
- Results include objectName for context

### MCP Integration
- Updated node type documentation in handlers.ts and definitions.ts
- `find_nodes` tool now lists PROPERTY_ACCESS as available type

## Files changed

| File | Change |
|------|--------|
| `packages/types/src/nodes.ts` | Added PROPERTY_ACCESS to NODE_TYPE + PropertyAccessNodeRecord |
| `packages/core/src/plugins/analysis/ast/types.ts` | Added PropertyAccessInfo interface |
| `packages/core/src/plugins/analysis/ast/visitors/ASTVisitor.ts` | Added propertyAccesses collection |
| `packages/core/src/plugins/analysis/ast/visitors/PropertyAccessVisitor.ts` | **NEW**: core visitor |
| `packages/core/src/plugins/analysis/ast/visitors/index.ts` | Export |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Wired visitor (module + function level) |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | bufferPropertyAccessNodes |
| `packages/cli/src/commands/query.ts` | Added type aliases + default search type |
| `packages/mcp/src/handlers.ts` | Updated type documentation |
| `packages/mcp/src/definitions.ts` | Updated type documentation |
| `test/unit/plugins/analysis/ast/property-access.test.ts` | **NEW**: 29 tests |

## Test results

- property-access.test.ts: 29/29 pass
- CallExpressionVisitorSemanticIds: 24/24 pass
- ScopeContainsEdges: 16/16 pass
- Expression: 19/19 pass
- ReturnStatementEdges: 36/36 pass
