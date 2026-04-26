# Joel Spolsky's Technical Implementation Plan - REG-128

## Overview

This plan details the implementation of Don's cleanup strategy for removing dead `interfaceId`, `typeId`, and `enumId` computations from TypeScriptVisitor. The implementation is straightforward but requires careful attention to maintain IMPLEMENTS edge functionality.

## File Changes Summary

| File | Action | Risk |
|------|--------|------|
| TypeScriptVisitor.ts | Remove 3 lines (ID computations), remove ID from 3 push() calls | Low |
| types.ts | Mark 3 `id` fields as deprecated, make optional | Low |
| GraphBuilder.ts | Fix `bufferImplementsEdges()` to compute ID using factory | Medium |

---

## 1. TypeScriptVisitor.ts Changes

**Location:** `/packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts`

### 1.1 Remove `interfaceId` computation (line 129)

**Current code (lines 128-129):**
```typescript
const interfaceName = node.id.name;
const interfaceId = `${module.file}:INTERFACE:${interfaceName}:${node.loc!.start.line}`;  // DELETE THIS LINE
```

### 1.2 Update InterfaceDeclarationInfo push (lines 175-185)

**Remove `id: interfaceId,` from the push call (line 176)**

### 1.3 Remove `typeId` computation (line 193)

**Current code (lines 192-193):**
```typescript
const typeName = node.id.name;
const typeId = `TYPE#${typeName}#${module.file}#${node.loc!.start.line}`;  // DELETE THIS LINE
```

### 1.4 Update TypeAliasInfo push (lines 204-213)

**Remove `id: typeId,` from the push call (line 205)**

### 1.5 Remove `enumId` computation (line 221)

**Current code (lines 220-221):**
```typescript
const enumName = node.id.name;
const enumId = `ENUM#${enumName}#${module.file}#${node.loc!.start.line}`;  // DELETE THIS LINE
```

### 1.6 Update EnumDeclarationInfo push (lines 253-263)

**Remove `id: enumId,` from the push call (line 254)**

---

## 2. types.ts Changes

**Location:** `/packages/core/src/plugins/analysis/ast/types.ts`

### 2.1 Update InterfaceDeclarationInfo (lines 149-159)

Add `@deprecated` JSDoc and make `id` optional (`id?: string;`)

### 2.2 Update TypeAliasInfo (lines 169-178)

Same pattern: add `@deprecated` JSDoc and make `id` optional

### 2.3 Update EnumDeclarationInfo (lines 181-191)

Same pattern: add `@deprecated` JSDoc and make `id` optional

---

## 3. GraphBuilder.ts Changes

**Location:** `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### 3.1 Fix bufferImplementsEdges() (lines 1208-1239)

**Problem:** Line 1218 uses `iface.id` which comes from the visitor. After we remove the `id` field from the visitor output, this will break.

**Solution:** Compute the interface ID using the same formula as `InterfaceNode.create()`:
```
id: `${file}:INTERFACE:${name}:${line}`
```

**After:**
```typescript
const iface = interfaces.find(i => i.name === ifaceName);
if (iface) {
  // Compute interface ID using same formula as InterfaceNode.create()
  const interfaceId = `${iface.file}:INTERFACE:${iface.name}:${iface.line}`;
  this._bufferEdge({
    type: 'IMPLEMENTS',
    src: classDecl.id,
    dst: interfaceId
  });
}
```

---

## 4. Test Strategy

### 4.1 Existing Test Coverage

- **`test/unit/InterfaceNodeMigration.test.js`** - Tests for REG-103 migration

### 4.2 New Test Needed: IMPLEMENTS Edge Test

There are **NO existing tests** for IMPLEMENTS edges (CLASS -> INTERFACE). We need to add one.

---

## 5. Implementation Order

1. **Write IMPLEMENTS edge test** (TDD approach)
2. **Update GraphBuilder.ts** (most critical change)
3. **Update types.ts** (deprecation + optional)
4. **Update TypeScriptVisitor.ts** (remove dead code)
5. **Run full test suite**

---

## 6. Acceptance Criteria

- [ ] `interfaceId`, `typeId`, `enumId` computations removed from TypeScriptVisitor
- [ ] `id` field marked as deprecated and optional in Info types
- [ ] `bufferImplementsEdges()` computes ID using factory formula
- [ ] All existing tests pass
- [ ] IMPLEMENTS edges work correctly (verified by new test)
