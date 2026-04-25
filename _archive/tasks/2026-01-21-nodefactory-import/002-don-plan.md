# Don Melton - Analysis & Plan

## Current State Analysis

### ImportNode Contract (packages/core/src/core/nodes/ImportNode.ts)
- **Static method**: `ImportNode.create(name, file, line, column, source, options)`
- **Required fields**: name, file, line, source
- **Optional fields**: column, importKind, imported, local
- **Import kinds**: 'value' | 'type' | 'typeof'
- **ID format**: `${file}:IMPORT:${name}:${line}`
- **Validation**: Validates required fields, type consistency

### NodeFactory Current State (packages/core/src/core/NodeFactory.ts)
- **Pattern**: Delegates to node class static `.create()` methods
- **Already 15+ node types supported**: SERVICE, ENTRYPOINT, MODULE, FUNCTION, SCOPE, CALL_SITE, METHOD_CALL, VARIABLE_DECLARATION, CONSTANT, LITERAL, OBJECT_LITERAL, ARRAY_LITERAL, EXTERNAL_STDIO, EVENT_LISTENER, HTTP_REQUEST, DATABASE_QUERY
- **Validation support**: Central `validate()` method that dispatches to node validators
- **Options pattern**: Each factory method has a corresponding Options interface
- **Missing**: ImportNode.create() is NOT imported or exposed via NodeFactory

### GraphBuilder's Inline IMPORT Creation (packages/core/src/plugins/analysis/ast/GraphBuilder.ts)
**Location**: `bufferImportNodes()` method (lines 501-550)
**Current inline node creation**:
```typescript
const importId = `${module.file}:IMPORT:${source}:${spec.local}:${line}`;
this._bufferNode({
  id: importId,
  type: 'IMPORT',
  source: source,
  importType: importType,  // ⚠️ MISMATCH: should be 'importKind'
  imported: spec.imported,
  local: spec.local,
  file: module.file,
  line: line
});
```

## Architectural Concerns

### CRITICAL MISMATCH #1: Field Naming Inconsistency
**Problem**: GraphBuilder uses `importType` but ImportNode contract uses `importKind`
- GraphBuilder line 515: `importType: importType`
- ImportNode line 13: `importKind: ImportKind`
- This violates the single-responsibility principle — two different representations of the same concept

**Impact**:
- Callers of GraphBuilder directly get wrong field name
- If validation runs on GraphBuilder output, it will fail
- Future refactoring becomes error-prone

### CRITICAL MISMATCH #2: ID Generation Pattern
**Problem**: GraphBuilder generates ID using `source` in the key, but ImportNode uses `name`
- GraphBuilder: `${module.file}:IMPORT:${source}:${spec.local}:${line}`
- ImportNode: `${file}:IMPORT:${name}:${line}`
- These patterns don't match! GraphBuilder includes source (module path), ImportNode includes name

**Impact**:
- Two different ID formats for the same concept breaks graph consistency
- Queries for imports will get different IDs depending on how they're created
- Migration would create "duplicate" nodes with different IDs

### CRITICAL MISMATCH #3: Missing Column Information
**Problem**: GraphBuilder never captures `column` (line 501-550 doesn't pass it)
- ImportNode contract requires column with default fallback (line 49: `column: column || 0`)
- GraphBuilder can't determine column from ImportInfo (not in its data structure)

**Impact**:
- All IMPORT nodes created via GraphBuilder will have column: 0
- Loss of precise location information
- TypeScript/JSX imports often benefit from column precision

### MISSING: Handling of `importType` vs `importKind`
GraphBuilder correctly calculates `importType` but ImportNode expects `importKind`:
```typescript
// GraphBuilder
const importType = spec.imported === 'default' ? 'default' :
                  spec.imported === '*' ? 'namespace' : 'named';

// ImportNode.create expects options.importKind, defaults to 'value'
// This doesn't match the 'default', 'namespace', 'named' values!
```

**This is wrong at the architectural level.** ImportNode and GraphBuilder have different semantic meanings for import kinds.

## High-Level Plan

### Phase 1: Understand the Architectural Problem (MUST DO FIRST)
1. **Clarify intent**: Are `importType` (GraphBuilder's 'default'/'namespace'/'named') and `importKind` (ImportNode's 'value'/'type'/'typeof') meant to represent the same thing?
   - If YES → one must change to match the other
   - If NO → we have two separate concerns that shouldn't be conflated
2. **Review ImportInfo data structure**: Check what fields are available in the collected AST data
3. **Verify column availability**: Determine if column information can be extracted during analysis phase

### Phase 2: Define the Contract (with user discussion)
Based on Phase 1, establish:
- Single field name for import kind (recommend: `importKind`)
- Value semantics: clarify difference between 'type'/'typeof' vs 'default'/'namespace'/'named'
- Column handling: clarify requirements for import location precision
- Create issue if column requires new AST analysis capability

### Phase 3: Create ImportOptions Interface
```typescript
interface ImportOptions {
  importKind?: ImportKind;        // 'value' | 'type' | 'typeof'
  imported?: string;              // what was imported
  local?: string;                 // local binding name
  // column is passed as parameter, not in options
}
```

### Phase 4: Add NodeFactory.createImport() Method
```typescript
static createImport(
  name: string,           // local binding
  file: string,
  line: number,
  column: number,
  source: string,
  options: ImportOptions = {}
): ImportNodeRecord {
  return ImportNode.create(name, file, line, column, source, options);
}
```

### Phase 5: Update NodeFactory.validate()
Add IMPORT to the validators map:
```typescript
'IMPORT': ImportNode,
```

### Phase 6: Migrate GraphBuilder
Replace inline creation with:
```typescript
for (const spec of specifiers) {
  const importNode = NodeFactory.createImport(
    spec.local,
    module.file,
    line,
    column ?? 0,  // Use captured column or default
    source,
    {
      importKind: 'value',  // or determine from context
      imported: spec.imported,
      local: spec.local
    }
  );
  this._bufferNode(importNode);
}
```

### Phase 7: Tests
- Unit tests for `NodeFactory.createImport()` with all ImportKind values
- Tests for optional fields handling
- Integration test: verify GraphBuilder → NodeFactory flow
- Validation tests: confirm ImportNode.validate() accepts factory output

## Risks

1. **ID Format Break**: Changing how IMPORT nodes are created will generate different IDs
   - If existing data relies on GraphBuilder's ID format, migration is complex
   - Mitigation: Verify no external code depends on specific ID format

2. **Semantic Confusion**: `importKind` and `importType` might represent different concepts
   - If mixed in same node, validation will fail
   - Mitigation: Resolve architectural mismatch in Phase 1 discussion

3. **Missing Column Data**: ImportInfo might not include column
   - If AST analysis doesn't capture it, defaults to 0
   - Mitigation: Check before implementation; if missing, create separate issue

4. **Scope Creep**: Fixing field names across all import usages could require updates:
   - Test files (if they check import node structure)
   - Query patterns (if they reference old field names)
   - Backend storage (if it has hardcoded expectations)
   - Mitigation: Search codebase for "importType" usage before starting

## Recommendation

**STOP implementation until architectural mismatch is resolved:**
- The difference between GraphBuilder's `importType` ('default'/'named'/'namespace') and ImportNode's `importKind` ('value'/'type'/'typeof') is fundamental
- These might represent genuinely different information about imports
- Don't patch this with a workaround—get clarity first
- This conversation should happen with user before moving to technical planning phase
