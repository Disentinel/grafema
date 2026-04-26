# Don Melton - Analysis & Plan: REG-104

## Executive Summary

**BLOCKER FOUND**: TypeNode.ts already exists and is properly implemented. The actual task is NOT to create TypeNode.ts (already done), but to **migrate TYPE creation from inline objects in GraphBuilder.bufferTypeAliasNodes() to use NodeFactory.createType() factory method**, matching the pattern established by REG-103 (InterfaceNode migration).

The factory method `NodeFactory.createType()` already exists and delegates correctly to `TypeNode.create()`. The migration requires updating ONE location: `GraphBuilder.bufferTypeAliasNodes()` method (line 1131-1142).

---

## Codebase Analysis

### 1. Existing Node Factory Patterns

The pattern for node factory migration is well-established:

#### Pattern Components:
1. **Node Class Contract** (e.g., InterfaceNode.ts):
   - Static method: `create(name, file, line, column, options)` 
   - Static method: `validate(node)`
   - Static readonly: `TYPE`, `REQUIRED`, `OPTIONAL` constants
   - Returns specific node record type (e.g., InterfaceNodeRecord)
   
2. **Factory Wrapper** (NodeFactory.ts):
   - Static method: `createX(name, file, line, column, options)`
   - Delegates to: `SpecificNode.create(...)`
   - Returns typed record for that node type

3. **Usage Pattern**:
   - OLD: `{ id: ..., type: 'INTERFACE', name: ..., file: ..., line: ..., column: ..., ... }`
   - NEW: `InterfaceNode.create(name, file, line, column, options)`

4. **Two-Pass Processing** (for nodes with relations):
   - First pass: Create all nodes, store in Map
   - Second pass: Create edges between them using stored node IDs
   - Handles external references (unresolved in same file)

#### Recent Migrations:
- **REG-103** (InterfaceNode): Complete - includes two-pass for EXTENDS edges
- **REG-101** (ExportNode): Complete
- **REG-100** (ImportNode): Complete - with auto-detection logic
- **REG-99** (ClassNode): Complete

### 2. TYPE Creation Locations Found

**Total: 2 locations with inline TYPE creation**

| File | Line | Context | Status |
|------|------|---------|--------|
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | 1131-1142 | `bufferTypeAliasNodes()` method - creates TYPE nodes | **NEEDS MIGRATION** |
| `packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts` | 204-213 | Collects TypeAliasInfo[] - decorative only, no migration needed | N/A |

**Code at GraphBuilder.ts:1131-1142:**
```typescript
private bufferTypeAliasNodes(module: ModuleNode, typeAliases: TypeAliasInfo[]): void {
  for (const typeAlias of typeAliases) {
    // Buffer TYPE node
    this._bufferNode({
      id: typeAlias.id,
      type: 'TYPE',
      name: typeAlias.name,
      file: typeAlias.file,
      line: typeAlias.line,
      column: typeAlias.column,
      aliasOf: typeAlias.aliasOf
    });
    
    // MODULE -> CONTAINS -> TYPE
    this._bufferEdge({
      type: 'CONTAINS',
      src: module.id,
      dst: typeAlias.id
    });
  }
}
```

**Why TypeScriptVisitor is not affected:**
- TypeScriptVisitor only collects TypeAliasInfo[] metadata (lines 200-213)
- It does NOT create graph nodes - just populates the info objects
- GraphBuilder is responsible for actual node creation
- No migration needed in visitor

### 3. TYPE Node Structure

**TypeNodeRecord (from TypeNode.ts:12-16):**
```typescript
interface TypeNodeRecord extends BaseNodeRecord {
  type: 'TYPE';
  column: number;
  aliasOf?: string;  // String representation of aliased type
}
```

**Required fields** (from TypeNode.REQUIRED):
- `name` - Type alias name
- `file` - File path
- `line` - Line number

**Optional fields** (from TypeNode.OPTIONAL):
- `column` - Column position (defaults to 0)
- `aliasOf` - What type this aliases

**ID format:** `{file}:TYPE:{name}:{line}`
Example: `/src/types.ts:TYPE:UserId:10`

**Note:** TypeNode does NOT use semantic IDs yet (unlike ClassNode and ExportNode which have `createWithContext()` methods). This is acceptable - the base implementation is sufficient.

### 4. NodeFactory.ts - Current State

**Status:** TypeNode is ALREADY integrated

**Location:** Lines 416-424
```typescript
static createType(
  name: string,
  file: string,
  line: number,
  column: number,
  options: TypeOptions = {}
) {
  return TypeNode.create(name, file, line, column, options);
}
```

**TypeOptions interface** (lines 183-185):
```typescript
interface TypeOptions {
  aliasOf?: string;
}
```

**Validation registry:** TYPE is already in the validators map (line 493)

**Exports:** TypeNode is already imported (line 37) and exported from nodes/index.ts (line 31)

**Conclusion:** NodeFactory is READY - no factory changes needed.

### 5. Verification of Issue Locations

✓ **GraphBuilder.ts:1132** - CONFIRMED: inline TYPE creation in `bufferTypeAliasNodes()`
✓ **TypeScriptVisitor.ts** - Confirmed present but only decorative, not creating nodes
✓ **NodeFactory.createType()** - Already exists and properly configured
✓ **TypeNode.ts** - Already exists with complete implementation
✓ **nodes/index.ts** - Already exports TypeNode and TypeNodeRecord

---

## High-Level Plan

### Phase 1: Code Migration
1. **Update GraphBuilder.bufferTypeAliasNodes():**
   - Replace inline TYPE object creation with `NodeFactory.createType()` call
   - Keep the single-pass structure (no second pass needed - TYPE nodes have no relations within same file like INTERFACE's EXTENDS edges)
   - Import TypeNode for type annotations if needed

### Phase 2: Testing
1. **Unit tests for TypeNode migration:**
   - Test basic TYPE node creation via factory
   - Test edge creation (MODULE -> CONTAINS -> TYPE)
   - Test all optional fields (column, aliasOf)
   - Test validation of TYPE nodes
   - Verify ID generation format matches expectations

### Phase 3: Integration
1. **Ensure backward compatibility:**
   - TYPE nodes still have correct ID format
   - All edges still created correctly
   - GraphBuilder integration works end-to-end

---

## Alignment with Project Vision

**Perfectly aligned:**
- ✓ Centralizes node creation in factory pattern
- ✓ Removes duplicate TYPE node creation logic
- ✓ Enforces single point of validation
- ✓ Makes code more testable and maintainable
- ✓ Follows established pattern from prior migrations (REG-99, REG-100, REG-101, REG-103)
- ✓ Continues the gradual NodeFactory migration work

**Incremental improvement to architecture:**
- Nodes are transitioning from inline creation → factory methods → node classes with contracts
- This is moving toward the right direction: "graph as first-class citizen"

---

## Risks / Concerns

### None Critical
- **Risk: ID format stability** - Mitigated by existing TypeNode.create() which already implements the ID format. No risk of format change.
- **Risk: Field mapping** - Mitigated by matching TypeAliasInfo structure to TypeNodeRecord fields exactly (column defaults to 0, aliasOf is optional)
- **Risk: Backward compatibility** - ID format UNCHANGED, so no graph corruption risk

### Opportunities
- **Future enhancement:** TypeNode could benefit from `createWithContext()` method for semantic IDs (like ClassNode, ExportNode), but this is OUT OF SCOPE for this task

---

## Implementation Details

### Single Location to Modify:
**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Method:** `bufferTypeAliasNodes()` (lines 1131-1142)

### Migration Strategy:
- NO two-pass needed (unlike INTERFACE with EXTENDS edges)
- Simple 1:1 replacement of inline object with `NodeFactory.createType()` call
- Keep the structure:
  1. Create node via factory
  2. Buffer node
  3. Create MODULE -> CONTAINS -> TYPE edge

### Code Before:
```typescript
this._bufferNode({
  id: typeAlias.id,
  type: 'TYPE',
  name: typeAlias.name,
  file: typeAlias.file,
  line: typeAlias.line,
  column: typeAlias.column,
  aliasOf: typeAlias.aliasOf
});
```

### Code After:
```typescript
const typeNode = NodeFactory.createType(
  typeAlias.name,
  typeAlias.file,
  typeAlias.line,
  typeAlias.column || 0,
  { aliasOf: typeAlias.aliasOf }
);
this._bufferNode(typeNode as unknown as GraphNode);
```

---

## Blockers / Dependencies

**None.** Everything needed already exists:
- ✓ TypeNode.ts is complete
- ✓ NodeFactory.createType() is complete  
- ✓ TypeOptions interface is defined
- ✓ TypeNode validation is registered
- ✓ nodes/index.ts exports are in place

**Ready to implement immediately.**

---

## Success Criteria

1. ✓ GraphBuilder.bufferTypeAliasNodes() uses NodeFactory.createType()
2. ✓ All TYPE node tests pass (create, validate, edges)
3. ✓ ID format remains: `{file}:TYPE:{name}:{line}`
4. ✓ No regression: existing TYPE functionality unchanged
5. ✓ Code follows established pattern from REG-103 (InterfaceNode)

---

## Next Steps

→ Proceed to Joel for technical spec refinement
