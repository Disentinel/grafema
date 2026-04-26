# Don Melton - Part 3 Plan: Visitor Migration Analysis

## Summary

After analyzing all 6 visitor files, the situation is clear:

**CRITICAL FINDING: Most visitors DO NOT need migration.**

The visitors primarily collect data into collections arrays that GraphBuilder then consumes to create actual nodes. This is the RIGHT architecture - visitors extract AST data, GraphBuilder (already migrated in Part 2) creates nodes.

## Detailed Analysis by Visitor

### 1. CallExpressionVisitor.ts (1082 lines)

**What it pushes:**
- `callSites` (lines 897-907) - call site info objects
- `methodCalls` (lines 970-983) - method call info objects
- `eventListeners` (lines 948-958) - event listener info objects
- `literals` (lines 216-226, 269-280, 523-534, 678-689) - literal info objects
- `callArguments` (line 403) - argument info for PASSES_ARGUMENT edges
- `objectLiterals` (lines 318-326, 546-552, 700-707) - object literal info
- `arrayLiterals` (lines 369-377, 577-583, 728-734) - array literal info
- `objectProperties` (lines 488, 615-628) - property info for HAS_PROPERTY edges
- `arrayElements` (lines 670, 766) - element info for HAS_ELEMENT edges
- `arrayMutations` (lines 831-838) - mutation tracking info
- `variableAssignments` (lines 291-298) - for DERIVES_FROM edges
- `methodCallbacks` (lines 1009-1014) - callback tracking info

**Migration status: PASSTHROUGH**
All pushes are to collections that GraphBuilder consumes. The actual node creation happens in GraphBuilder (already migrated). No changes needed here.

### 2. ImportExportVisitor.ts (262 lines)

**What it pushes:**
- `imports` (lines 128-133) - import info objects with source, specifiers, line
- `exports` (lines 146-150, 172-177, 192-195, 206-210, 220-224, 231-236, 246-249) - export info objects

**Migration status: PASSTHROUGH**
These are data collection arrays. GraphBuilder's `processImportsExports()` (already migrated) creates the actual Import/Export nodes.

### 3. FunctionVisitor.ts (432 lines)

**What it pushes:**
- `functions` (lines 299-313, 383-398) - function info objects with id, stableId, name, etc.
- `parameters` (lines 232-273) - parameter info objects
- `scopes` (lines 327-336, 412-420) - scope info for function bodies

**Migration status: PASSTHROUGH**
These are data objects collected into arrays. GraphBuilder's `processFunctions()` (already migrated in Part 2) consumes these to create FunctionNode, ScopeNode, etc.

### 4. VariableVisitor.ts (269 lines)

**What it pushes:**
- `variableDeclarations` (lines 173, 190-197) - variable/constant info objects
- `classInstantiations` (lines 180-186) - for INSTANCE_OF edges
- `literals` (lines 219-229) - expression nodes for destructuring
- `variableAssignments` (lines 232-236, 240-246) - for data flow edges

**Migration status: PASSTHROUGH**
All pushes are to collections. GraphBuilder's `processVariableDeclarations()` (already migrated) handles node creation.

### 5. TypeScriptVisitor.ts (268 lines)

**What it pushes:**
- `interfaces` (lines 175-185) - interface declaration info
- `typeAliases` (lines 204-213) - type alias info
- `enums` (lines 253-263) - enum declaration info

**Migration status: PASSTHROUGH**
GraphBuilder's TypeScript processing (already migrated) consumes these.

### 6. ClassVisitor.ts (409 lines)

**What it pushes:**
- `classDeclarations` (lines 194-205) - class info with methods list
- `decorators` (lines 218, 248-249, 364-366) - decorator info
- `functions` (lines 272-286, 342-357) - method function info
- `scopes` (lines 298-308, 380-390) - method body scope info

**Migration status: PASSTHROUGH**
GraphBuilder's `processClasses()` (already migrated) creates the actual nodes.

## Conclusion

**No visitors need migration for REG-98.**

The architecture is correct:
1. **Visitors** = AST traversal, data extraction into plain objects
2. **Collections** = intermediate storage (arrays of info objects)
3. **GraphBuilder** = actual node creation using NodeFactory (ALREADY MIGRATED in Part 2)

The original estimate of "18 push() calls in CallExpressionVisitor" was counting data collection, not node creation. These are fundamentally different:

- `.push({ id: ..., type: 'CALL', ... })` into a collection = DATA EXTRACTION (stays as-is)
- `NodeFactory.createCallSite(...)` = NODE CREATION (done in GraphBuilder)

## Recommendation

**REG-98 Part 3 is already complete.** The work was done in Part 2 when GraphBuilder was migrated.

What remains for REG-98:
1. Final verification that all tests pass
2. Documentation of the NodeFactory architecture
3. Review for any edge cases missed

## Next Steps

1. Run full test suite to verify no regressions
2. Consider if any cleanup is needed in visitors (interface types, removing duplicate type definitions)
3. Update REG-98 status to reflect completion

---

*Note: The original scope document listed visitors with "X push() calls" but those were counting collection pushes, not direct node creation. The actual node creation was always in GraphBuilder, which is now fully migrated.*
