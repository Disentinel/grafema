# REG-128: Clean up dead interfaceId computation in TypeScriptVisitor

## Linear Issue
https://linear.app/reginaflow/issue/REG-128/clean-up-dead-interfaceid-computation-in-typescriptvisitor

## Context
After REG-103 (InterfaceNode migration), the `interfaceId` variable computed at TypeScriptVisitor.ts:129 is now dead code. The actual node ID comes from `InterfaceNode.create()` in GraphBuilder, so the visitor-computed ID is never used.

## Task
Remove the `interfaceId` computation entirely and `id` from InterfaceDeclarationInfo.

## Technical Debt
This is minor (wasteful string computation) but creates confusion about where IDs come from.

## Files
- `packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts` - line 129
- `packages/core/src/plugins/analysis/ast/types.ts` - InterfaceDeclarationInfo type
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - bufferImplementsEdges uses iface.id
