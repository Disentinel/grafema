# REG-105: NodeFactory - Add EnumNode and Migrate ENUM Creation

**Tech Lead Analysis by Don Melton**
**Date:** 2025-01-22

---

## 1. Executive Summary

This task is a straightforward migration following an already established pattern. The `EnumNode` factory class **already exists** and is fully implemented. The only remaining work is migrating the `bufferEnumNodes()` method in `GraphBuilder.ts` to use `EnumNode.create()` instead of inline object literals.

**Verdict: This is the RIGHT approach.** It aligns perfectly with the established NodeFactory pattern used for `InterfaceNode`, `ExportNode`, `ImportNode`, and `ClassNode`.

---

## 2. Existing Node Factory Pattern Analysis

### Reference Implementation: `InterfaceNode.ts`

**Location:** `/packages/core/src/core/nodes/InterfaceNode.ts`

The InterfaceNode pattern is the canonical reference for TypeScript declaration nodes (along with EnumNode). Key characteristics:

```typescript
export class InterfaceNode {
  static readonly TYPE = 'INTERFACE' as const;
  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['column', 'extends', 'properties', 'isExternal'] as const;

  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: InterfaceNodeOptions = {}
  ): InterfaceNodeRecord {
    // Validation
    if (!name) throw new Error('InterfaceNode.create: name is required');
    if (!file) throw new Error('InterfaceNode.create: file is required');
    if (!line) throw new Error('InterfaceNode.create: line is required');

    // Node construction with consistent ID format
    return {
      id: `${file}:INTERFACE:${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column: column || 0,
      // ... type-specific fields
    };
  }

  static validate(node: InterfaceNodeRecord): string[] {
    // Validation logic
  }
}
```

**ID Format Pattern:** `{file}:{TYPE}:{name}:{line}`

### Current EnumNode Implementation

**Location:** `/packages/core/src/core/nodes/EnumNode.ts`

**Status: FULLY IMPLEMENTED** - follows the exact same pattern:

```typescript
export class EnumNode {
  static readonly TYPE = 'ENUM' as const;
  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['column', 'isConst', 'members'] as const;

  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: EnumNodeOptions = {}
  ): EnumNodeRecord {
    if (!name) throw new Error('EnumNode.create: name is required');
    if (!file) throw new Error('EnumNode.create: file is required');
    if (!line) throw new Error('EnumNode.create: line is required');

    return {
      id: `${file}:ENUM:${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column: column || 0,
      isConst: options.isConst || false,
      members: options.members || []
    };
  }

  static validate(node: EnumNodeRecord): string[] { ... }
}
```

**NodeFactory Integration:**
- `EnumNode` is already imported in `/packages/core/src/core/NodeFactory.ts`
- `NodeFactory.createEnum()` method already exists and delegates to `EnumNode.create()`
- `NodeFactory.validate()` already includes `'ENUM': EnumNode` in validators

---

## 3. Locations with Inline ENUM Creation

### 3.1 GraphBuilder.bufferEnumNodes() - **NEEDS MIGRATION**

**Location:** `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts:1155-1176`

```typescript
private bufferEnumNodes(module: ModuleNode, enums: EnumDeclarationInfo[]): void {
  for (const enumDecl of enums) {
    // INLINE OBJECT LITERAL - should use EnumNode.create()
    this._bufferNode({
      id: enumDecl.id,           // <-- ID comes from TypeScriptVisitor
      type: 'ENUM',
      name: enumDecl.name,
      file: enumDecl.file,
      line: enumDecl.line,
      column: enumDecl.column,
      isConst: enumDecl.isConst,
      members: enumDecl.members
    });

    this._bufferEdge({
      type: 'CONTAINS',
      src: module.id,
      dst: enumDecl.id
    });
  }
}
```

**Problem:** Uses inline object literal instead of `EnumNode.create()`.

### 3.2 TypeScriptVisitor - Creates EnumDeclarationInfo (LEGACY FORMAT)

**Location:** `/packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts:216-264`

```typescript
// Line 221 - LEGACY FORMAT with # separators
const enumId = `ENUM#${enumName}#${module.file}#${node.loc!.start.line}`;

(enums as EnumDeclarationInfo[]).push({
  id: enumId,                    // <-- Uses legacy # format!
  semanticId: enumSemanticId,
  type: 'ENUM',
  ...
});
```

**CRITICAL FINDING:** TypeScriptVisitor uses the **legacy `#` separator format**:
- Current: `ENUM#Status#/path/file.ts#20`
- Target (EnumNode.create): `/path/file.ts:ENUM:Status:20`

This ID format mismatch must be addressed. The migration has two options:

1. **Option A (Recommended):** Don't use the ID from `EnumDeclarationInfo`. Instead, use `EnumNode.create()` which generates its own ID. This is the same approach used in `bufferInterfaceNodes()`.

2. **Option B:** Update TypeScriptVisitor to generate IDs in the colon format. However, this changes the data collection layer which may have other implications.

---

## 4. High-Level Migration Plan

### Phase 1: Test First (Kent Beck)

Create `/test/unit/EnumNodeMigration.test.js` following the pattern from `InterfaceNodeMigration.test.js`:

1. **Unit tests for EnumNode.create()**
   - ID format verification (`{file}:ENUM:{name}:{line}`)
   - No `#` separator in IDs
   - Required field validation
   - `isConst` and `members` handling

2. **Integration tests for ENUM analysis**
   - Regular enum analysis
   - Const enum analysis
   - Enum with numeric values
   - Enum with string values
   - MODULE -> CONTAINS -> ENUM edge

3. **ID Format tests**
   - Analyzed ENUM nodes use colon format (not legacy `#` format)
   - ID follows pattern: `{file}:ENUM:{name}:{line}`
   - NodeFactory.createEnum() produces same result as EnumNode.create()

### Phase 2: Migrate GraphBuilder (Rob Pike)

Update `bufferEnumNodes()` to use `EnumNode.create()`:

```typescript
private bufferEnumNodes(module: ModuleNode, enums: EnumDeclarationInfo[]): void {
  for (const enumDecl of enums) {
    // Use EnumNode.create() to generate proper ID (colon format)
    // Do NOT use enumDecl.id which has legacy # format
    const enumNode = EnumNode.create(
      enumDecl.name,
      enumDecl.file,
      enumDecl.line,
      enumDecl.column || 0,
      {
        isConst: enumDecl.isConst,
        members: enumDecl.members
      }
    );

    this._bufferNode(enumNode as unknown as GraphNode);

    this._bufferEdge({
      type: 'CONTAINS',
      src: module.id,
      dst: enumNode.id  // Use factory-generated ID (colon format)
    });
  }
}
```

**Key insight:** The `enumDecl.id` from TypeScriptVisitor uses legacy `#` format. By using `EnumNode.create()`, we get the correct colon format ID. This is the same approach used in `bufferInterfaceNodes()`.

### Phase 3: TypeScriptVisitor ID Format (Optional Cleanup)

The TypeScriptVisitor currently generates IDs with legacy `#` format:
```typescript
const enumId = `ENUM#${enumName}#${module.file}#${node.loc!.start.line}`;
```

**Decision:** Leave TypeScriptVisitor as-is for now. The `EnumDeclarationInfo.id` field is not used when we use `EnumNode.create()` in GraphBuilder. A future cleanup task can remove the legacy ID generation from TypeScriptVisitor once all node types are migrated to factory pattern.

### Phase 4: Add Import Statement

Add `EnumNode` import to GraphBuilder.ts alongside other node imports:

```typescript
import { EnumNode, type EnumNodeRecord } from '../../../core/nodes/EnumNode.js';
```

---

## 5. Architectural Concerns

### 5.1 None - This is a Clean Migration

Unlike some other migrations, this one has **no architectural concerns**:

1. **EnumNode factory already exists** and follows the established pattern
2. **NodeFactory integration is complete** (`createEnum()` already works)
3. **Type definitions are consistent** (`EnumMemberRecord` matches `EnumMemberInfo`)
4. **ID format is already colon-based** in EnumNode.create()

### 5.2 Minor Consideration: semanticId Field

`EnumDeclarationInfo` has an optional `semanticId` field that `EnumNode.create()` does not currently handle. This is fine because:

1. Semantic IDs are a future enhancement (REG-123)
2. The current implementation uses line-based IDs which work correctly
3. Adding `createWithContext()` for semantic IDs is a separate task

### 5.3 Consistency with InterfaceNode Migration (REG-103)

This migration follows the **exact same pattern** as the InterfaceNode migration:

| Aspect | InterfaceNode (REG-103) | EnumNode (REG-105) |
|--------|------------------------|-------------------|
| Factory exists | Yes | Yes |
| NodeFactory integration | Yes | Yes |
| GraphBuilder method | `bufferInterfaceNodes()` | `bufferEnumNodes()` |
| Uses inline literals | No (migrated) | Yes (to migrate) |
| ID format | `{file}:INTERFACE:{name}:{line}` | `{file}:ENUM:{name}:{line}` |

---

## 6. Files to Modify

1. **Create:** `/test/unit/EnumNodeMigration.test.js` - TDD tests
2. **Modify:** `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
   - Add import for `EnumNode`
   - Update `bufferEnumNodes()` to use `EnumNode.create()`

Optional (verify only):
3. **Verify:** `/packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts`
   - Ensure ID format matches `EnumNode.create()` pattern

---

## 7. Verdict

**GO.** This migration:

- Follows the established NodeFactory pattern exactly
- Has no architectural risks
- EnumNode is already implemented correctly
- Only requires updating GraphBuilder to use the factory
- Maintains consistency with InterfaceNode, ExportNode, ImportNode, ClassNode migrations

The implementation should be quick and clean. Estimated effort: ~30 minutes including tests.

---

*"I don't care if it works, is it RIGHT?"* - In this case, yes. The pattern is right, the implementation is right, we just need to connect the pieces.

