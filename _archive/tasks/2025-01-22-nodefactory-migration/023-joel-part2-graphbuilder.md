# Joel Spolsky - Part 2: GraphBuilder Migration Technical Spec

## Overview

This document provides a detailed migration plan for `GraphBuilder.ts` to use `NodeFactory` instead of inline object creation. The goal is to centralize node creation through the factory, ensuring consistent ID formats and field validation.

## Current State Analysis

**File:** `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

GraphBuilder currently creates nodes in two ways:
1. **Passthrough buffering** - receives pre-formed node data from visitors, strips parent IDs, passes to `_bufferNode()`
2. **Inline creation** - creates node objects directly in `_bufferNode({...})` calls

Only **inline creations** need migration. Passthrough buffering (where visitors already created the nodes) should stay as-is.

## Migration Categories

### Category A: Use Existing Factory Methods (8 changes)

These nodes have factory methods already available.

### Category B: Need New Factory Methods (2 new factories)

- `ExternalNetworkNode` - for `net:request` singleton
- Legacy `net:stdio` needs update (uses different ID format than `ExternalStdioNode`)

### Category C: Field Mapping Issues (5 changes)

Some nodes need field mapping because GraphBuilder uses different field names than the factory.

---

## Detailed Changes

### 1. bufferStdioNodes (lines 366-373)

**Location:** Method `bufferStdioNodes`, line 367-373

**Current code:**
```typescript
this._bufferNode({
  id: stdioId,
  type: 'net:stdio',
  name: '__stdio__',
  description: 'Standard input/output stream'
});
```

**Problem:** Uses legacy `net:stdio` type and `net:stdio#__stdio__` ID format. The `ExternalStdioNode` uses `EXTERNAL_STDIO` type and `EXTERNAL_STDIO:__stdio__` ID.

**Decision Required:** This is a **breaking change** if we switch to `ExternalStdioNode`. Tests and queries relying on `net:stdio` will break.

**Options:**
1. **Keep as-is** - Leave legacy format, document tech debt
2. **Migrate with alias** - Create edge alias in queries
3. **Full migration** - Update all usages (out of scope for this task)

**Recommendation:** Keep as-is for Part 2. Create Linear issue for full stdio migration.

---

### 2. bufferClassDeclarationNodes (lines 391-400)

**Location:** Method `bufferClassDeclarationNodes`, line 392-400

**Current code:**
```typescript
this._bufferNode({
  id,
  type,
  name,
  file,
  line,
  column,
  superClass
});
```

**Issue:** This receives `id` and `type` from `ClassDeclarationInfo` which already has the ID computed by the visitor.

**Analysis:** The visitor (`ClassDeclarationVisitor` or similar) already creates the ID. GraphBuilder just passes through with destructuring.

**Decision:** **No change needed** - this is passthrough, not inline creation. The visitor should use factory (separate task).

---

### 3. bufferClassNodes - External class (lines 439-447)

**Location:** Method `bufferClassNodes`, lines 439-447

**Current code:**
```typescript
classId = `${module.file}:CLASS:${className}:${line}`;
this._bufferNode({
  id: classId,
  type: 'CLASS',
  name: className,
  file: module.file,
  line,
  isInstantiationRef: true
});
```

**Migration:**
```typescript
const classNode = NodeFactory.createClass(
  className,
  module.file,
  line,
  0, // column not available
  { exported: false }
);
// Override to mark as instantiation reference
const instantiationRef = {
  ...classNode,
  isInstantiationRef: true
};
classId = instantiationRef.id;
this._bufferNode(instantiationRef as GraphNode);
```

**Note:** `isInstantiationRef` is not a standard ClassNode field. Need to add to options or handle separately.

**Better approach:** Add `isInstantiationRef` to `ClassNodeOptions`:
```typescript
// In ClassNode.ts, add to interface:
interface ClassNodeOptions {
  exported?: boolean;
  superClass?: string;
  methods?: string[];
  isInstantiationRef?: boolean;  // NEW
}
```

Then migration becomes:
```typescript
const classNode = NodeFactory.createClass(
  className,
  module.file,
  line,
  0,
  { isInstantiationRef: true }
);
classId = classNode.id;
this._bufferNode(classNode as unknown as GraphNode);
```

---

### 4. bufferImportNodes - EXTERNAL_MODULE (lines 508-519)

**Location:** Method `bufferImportNodes`, lines 508-519

**Current code:**
```typescript
this._bufferNode({
  id: externalModuleId,
  type: 'EXTERNAL_MODULE',
  name: source,
  file: module.file,
  line: line
});
```

**Issue:** Current code includes `file` and `line`, but `ExternalModuleNode.create()` sets `file: ''` and `line: 0`.

**Analysis:** External modules are singletons. Adding file/line creates inconsistency - same module imported from different files would have different `file` values but same ID.

**Migration:**
```typescript
const externalModule = NodeFactory.createExternalModule(source);
this._bufferNode(externalModule as unknown as GraphNode);
```

**Note:** This removes file/line context. If needed for debugging, create Linear issue for `ExternalModuleNode` enhancement.

---

### 5. bufferExportNodes - default export (lines 537-546)

**Location:** Method `bufferExportNodes`, lines 537-546

**Current code:**
```typescript
const exportId = `${module.file}:EXPORT:default:${line}`;
this._bufferNode({
  id: exportId,
  type: 'EXPORT',
  exportType: 'default',
  name: 'default',
  file: module.file,
  line: line
});
```

**Issue:** Uses `exportType: 'default'` but `ExportNode` uses `default: boolean` and `exportKind`.

**Migration:**
```typescript
const exportNode = NodeFactory.createExport(
  'default',
  module.file,
  line,
  0, // column not available
  { default: true }
);
this._bufferNode(exportNode as unknown as GraphNode);
```

---

### 6. bufferExportNodes - named export with specifiers (lines 556-567)

**Location:** Method `bufferExportNodes`, lines 556-567

**Current code:**
```typescript
this._bufferNode({
  id: exportId,
  type: 'EXPORT',
  exportType: 'named',
  name: spec.exported,
  local: spec.local,
  file: module.file,
  line: line,
  source: source
});
```

**Issue:** Includes `source` for re-exports (`export { foo } from './bar'`). `ExportNode` doesn't have `source` field.

**Decision Required:**
- Option A: Add `source` to `ExportNodeOptions`
- Option B: Keep inline for re-exports, use factory for regular named exports

**Recommendation:** Add `source` to `ExportNode` for completeness.

**Migration (after adding source to ExportNode):**
```typescript
const exportNode = NodeFactory.createExport(
  spec.exported,
  module.file,
  line,
  0,
  {
    local: spec.local,
    source: source  // NEW field
  }
);
this._bufferNode(exportNode as unknown as GraphNode);
```

---

### 7. bufferExportNodes - named export with name (lines 575-585)

**Location:** Method `bufferExportNodes`, lines 575-585

**Current code:**
```typescript
this._bufferNode({
  id: exportId,
  type: 'EXPORT',
  exportType: 'named',
  name: name,
  file: module.file,
  line: line
});
```

**Migration:**
```typescript
const exportNode = NodeFactory.createExport(
  name,
  module.file,
  line,
  0,
  { default: false }
);
this._bufferNode(exportNode as unknown as GraphNode);
```

---

### 8. bufferExportNodes - export all (lines 594-604)

**Location:** Method `bufferExportNodes`, lines 594-604

**Current code:**
```typescript
this._bufferNode({
  id: exportId,
  type: 'EXPORT',
  exportType: 'all',
  name: '*',
  file: module.file,
  line: line,
  source: source
});
```

**Issue:** `exportType: 'all'` is not in ExportNode. Needs `source` field.

**Decision:** Add `exportType` field to `ExportNode` to preserve semantics, or use a different approach.

**Alternative:** Keep `name: '*'` and `source` as indicators of "export all".

**Migration (after adding exportType to ExportNode):**
```typescript
const exportNode = NodeFactory.createExport(
  '*',
  module.file,
  line,
  0,
  {
    source: source,
    exportType: 'all'  // NEW field
  }
);
this._bufferNode(exportNode as unknown as GraphNode);
```

---

### 9. bufferHttpRequests - net:request singleton (lines 648-654)

**Location:** Method `bufferHttpRequests`, lines 648-654

**Current code:**
```typescript
this._bufferNode({
  id: networkId,
  type: 'net:request',
  name: '__network__'
});
```

**Problem:** No factory exists for `net:request` singleton.

**Solution:** Create `ExternalNetworkNode` similar to `ExternalStdioNode`.

**New file: `/packages/core/src/core/nodes/ExternalNetworkNode.ts`**
```typescript
/**
 * ExternalNetworkNode - contract for EXTERNAL_NETWORK node (singleton)
 */
import type { BaseNodeRecord } from '@grafema/types';

interface ExternalNetworkNodeRecord extends BaseNodeRecord {
  type: 'EXTERNAL_NETWORK';
}

export class ExternalNetworkNode {
  static readonly TYPE = 'EXTERNAL_NETWORK' as const;
  static readonly SINGLETON_ID = 'EXTERNAL_NETWORK:__network__';

  static create(): ExternalNetworkNodeRecord {
    return {
      id: this.SINGLETON_ID,
      type: this.TYPE,
      name: '__network__',
      file: '__builtin__',
      line: 0
    };
  }
}
```

**Breaking Change:** Same issue as stdio - changes type from `net:request` to `EXTERNAL_NETWORK`.

**Recommendation:** Keep as-is for Part 2. Document for future migration.

---

### 10. bufferInterfaceNodes (lines 1063-1072)

**Location:** Method `bufferInterfaceNodes`, lines 1063-1072

**Current code:**
```typescript
this._bufferNode({
  id: iface.id,
  type: 'INTERFACE',
  name: iface.name,
  file: iface.file,
  line: iface.line,
  column: iface.column,
  properties: iface.properties,
  extends: iface.extends
});
```

**Analysis:** The `iface` object comes from `InterfaceDeclarationInfo` which already has the ID. This is passthrough.

**Decision:** **No change** - visitor should use factory (separate scope).

---

### 11. bufferInterfaceNodes - external interface (lines 1094-1102)

**Location:** Method `bufferInterfaceNodes`, lines 1094-1102

**Current code:**
```typescript
const externalId = `INTERFACE#${parentName}#${iface.file}#external`;
this._bufferNode({
  id: externalId,
  type: 'INTERFACE',
  name: parentName,
  file: iface.file,
  line: iface.line,
  isExternal: true
});
```

**Issue:** Uses `#` separator, different from factory's `:` separator. Also `isExternal` not in `InterfaceNode`.

**Decision Required:**
- Add `isExternal` to `InterfaceNodeOptions`
- ID format mismatch is a breaking change

**Migration (after adding isExternal):**
```typescript
const externalInterface = NodeFactory.createInterface(
  parentName,
  iface.file,
  iface.line,
  0,
  { isExternal: true }
);
this._bufferNode(externalInterface as unknown as GraphNode);
```

**Note:** ID will change from `INTERFACE#Name#file#external` to `file:INTERFACE:Name:line`. This is a **breaking change**.

---

### 12. bufferTypeAliasNodes (lines 1120-1128)

**Location:** Method `bufferTypeAliasNodes`, lines 1120-1128

**Current code:**
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

**Analysis:** Passthrough from visitor. ID already exists.

**Decision:** **No change** - visitor scope.

---

### 13. bufferEnumNodes (lines 1144-1154)

**Location:** Method `bufferEnumNodes`, lines 1144-1154

**Current code:**
```typescript
this._bufferNode({
  id: enumDecl.id,
  type: 'ENUM',
  ...
});
```

**Analysis:** Passthrough from visitor.

**Decision:** **No change** - visitor scope.

---

### 14. bufferDecoratorNodes (lines 1171-1180)

**Location:** Method `bufferDecoratorNodes`, lines 1171-1180

**Current code:**
```typescript
this._bufferNode({
  id: decorator.id,
  type: 'DECORATOR',
  ...
});
```

**Analysis:** Passthrough from visitor.

**Decision:** **No change** - visitor scope.

---

### 15. bufferImplementsEdges - external interface (lines 1208-1216)

**Location:** Method `bufferImplementsEdges`, lines 1208-1216

**Current code:**
```typescript
const externalId = `INTERFACE#${ifaceName}#${classDecl.file}#external`;
this._bufferNode({
  id: externalId,
  type: 'INTERFACE',
  name: ifaceName,
  file: classDecl.file,
  line: classDecl.line,
  isExternal: true
});
```

**Same as #11** - duplicate pattern for external interface.

**Migration:** Same as #11.

---

### 16. bufferAssignmentEdges - EXPRESSION node (lines 832-857)

**Location:** Method `bufferAssignmentEdges`, lines 832-857

**Current code:**
```typescript
const expressionNode: GraphNode = {
  id: sourceId,
  type: 'EXPRESSION',
  expressionType,
  file: exprFile,
  line: exprLine
};
// ... conditional field additions
this._bufferNode(expressionNode);
```

**Issue:** Uses pre-computed `sourceId` from visitor. The expression node creation is complex with many conditional fields.

**Analysis:** This is a hybrid - ID comes from visitor, but node is built inline.

**Decision:** The visitor should create the full EXPRESSION node. For now, keep as-is since the ID is already computed upstream.

**Recommendation:** Mark for visitor migration task.

---

## Summary of Required Changes

### Immediate Migrations (Part 2)

| # | Method | Line | Action |
|---|--------|------|--------|
| 1 | bufferClassNodes | 439-447 | Use `NodeFactory.createClass` + add `isInstantiationRef` option |
| 2 | bufferImportNodes | 508-519 | Use `NodeFactory.createExternalModule` |
| 3 | bufferExportNodes | 537-546 | Use `NodeFactory.createExport` (default) |
| 4 | bufferExportNodes | 575-585 | Use `NodeFactory.createExport` (named) |

### Require Factory Enhancements First

| # | Method | Enhancement Needed |
|---|--------|-------------------|
| 5 | bufferExportNodes | Add `source` and `exportType` to ExportNode |
| 6 | bufferExportNodes | Same as above |
| 7 | bufferInterfaceNodes | Add `isExternal` to InterfaceNode |
| 8 | bufferImplementsEdges | Same as above |

### Deferred (Breaking Changes)

| # | Method | Reason |
|---|--------|--------|
| 9 | bufferStdioNodes | Type change `net:stdio` -> `EXTERNAL_STDIO` |
| 10 | bufferHttpRequests | Need new `ExternalNetworkNode`, type change |

### Visitor Scope (Not Part 2)

All passthrough patterns where ID comes from visitor:
- bufferClassDeclarationNodes
- bufferInterfaceNodes (main)
- bufferTypeAliasNodes
- bufferEnumNodes
- bufferDecoratorNodes
- bufferAssignmentEdges (EXPRESSION)

---

## Implementation Order

### Phase 2a: Factory Enhancements
1. Add `isInstantiationRef` to `ClassNode`
2. Add `source`, `exportType` to `ExportNode`
3. Add `isExternal` to `InterfaceNode`
4. Export new types from index.ts

### Phase 2b: GraphBuilder Migrations
1. Migrate `bufferClassNodes` external class
2. Migrate `bufferImportNodes` EXTERNAL_MODULE
3. Migrate `bufferExportNodes` all three cases
4. Migrate `bufferInterfaceNodes` external interface
5. Migrate `bufferImplementsEdges` external interface

### Phase 2c: Tests
1. Run existing test suite
2. Verify no ID format changes
3. Verify no missing fields

---

## Risk Assessment

**Low Risk:**
- EXTERNAL_MODULE migration (ID format unchanged)
- Named export migration (ID format unchanged)

**Medium Risk:**
- External interface migration (ID format changes from `#` to `:`)
- Class instantiation ref (new field)

**High Risk (Deferred):**
- stdio/network singleton type changes

---

## Open Questions for Review

1. Should external interfaces keep `#` separator or migrate to `:`?
2. Should we add `source` to ExportNode or create separate `ReExportNode`?
3. Is `isInstantiationRef` the right name for class reference nodes?

---

*Joel Spolsky*
*Part 2 Technical Spec*
*2025-01-22*
