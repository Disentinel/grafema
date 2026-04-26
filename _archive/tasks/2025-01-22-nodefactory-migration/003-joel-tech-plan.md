# Joel Spolsky's Technical Plan: NodeFactory Migration (REG-98)

## Overview

Detailed implementation specifications for all 11 factory methods. Each specification is complete enough for Kent (tests) and Rob (implementation) to work independently.

## ID Format Standardization

**CRITICAL**: All new factory methods use **colon-separated** format:
```
${file}:${TYPE}:${name}:${line}
```

Exception for singletons:
```
${namespace}:${TYPE}:${singleton_name}
```

---

## Phase 1: Factory Methods for Existing Contracts

### 1.1 createClass()

**File**: `/packages/core/src/core/NodeFactory.ts`

```typescript
interface ClassOptions {
  exported?: boolean;
  superClass?: string;
  methods?: string[];
  implements?: string[];
}

static createClass(name: string, file: string, line: number, column: number, options: ClassOptions = {})
```

**ID**: `${file}:CLASS:${name}:${line}`

**GraphBuilder target**: lines 386-419

### 1.2 createExport()

**File**: `/packages/core/src/core/NodeFactory.ts`

```typescript
interface ExportOptions {
  exportKind?: 'value' | 'type';
  local?: string;
  default?: boolean;
  source?: string;
}

static createExport(name: string, file: string, line: number, column: number, options: ExportOptions = {})
```

**ID**: `${file}:EXPORT:${name}:${line}`

**GraphBuilder targets**: lines 527-607 (default, named, re-export all)

---

## Phase 2: Simple New Contracts

### 2.1 ExternalModuleNode.ts (NEW)

**File**: `/packages/core/src/core/nodes/ExternalModuleNode.ts`

```typescript
static create(moduleName: string, referencingFile: string, line: number, options = {})
```

**ID** (SINGLETON): `EXTERNAL_MODULE:${moduleName}`

**Examples**: `EXTERNAL_MODULE:react`, `EXTERNAL_MODULE:@tanstack/react-query`

### 2.2 TypeNode.ts (NEW)

**File**: `/packages/core/src/core/nodes/TypeNode.ts`

```typescript
static create(name: string, file: string, line: number, column: number, options = {})
```

**ID**: `${file}:TYPE:${name}:${line}`

**Options**: `{ aliasOf?: string }`

### 2.3 EnumNode.ts (NEW)

**File**: `/packages/core/src/core/nodes/EnumNode.ts`

```typescript
static create(name: string, file: string, line: number, column: number, options = {})
```

**ID**: `${file}:ENUM:${name}:${line}`

**Options**: `{ isConst?: boolean, members: EnumMember[] }`

---

## Phase 3: Contracts with External Variants

### 3.1 InterfaceNode.ts (NEW)

**File**: `/packages/core/src/core/nodes/InterfaceNode.ts`

```typescript
static create(name: string, file: string, line: number, column: number, options = {})
static createExternal(name: string, referencingFile: string, referencingLine: number)
```

**ID Regular**: `${file}:INTERFACE:${name}:${line}`
**ID External**: `${referencingFile}:INTERFACE:${name}:external`

**Options**: `{ extends?: string[], properties: InterfaceProperty[], isExternal?: boolean }`

### 3.2 createExternalClass()

**Modify**: `/packages/core/src/core/nodes/ClassNode.ts`

```typescript
static createExternal(name: string, referencingFile: string, line: number)
```

Returns ClassNodeRecord with `isInstantiationRef: true`

---

## Phase 4: Target-Dependent Contract

### 4.1 DecoratorNode.ts (NEW)

**File**: `/packages/core/src/core/nodes/DecoratorNode.ts`

```typescript
static create(name: string, file: string, line: number, column: number,
              targetId: string, targetType: DecoratorTargetType, options = {})
```

**ID**: `${file}:DECORATOR:${name}:${line}:${column}`

**targetType**: `'CLASS' | 'METHOD' | 'PROPERTY' | 'PARAMETER'`

---

## Phase 5: Singletons

### 5.1 Fix ExternalStdioNode

**File**: `/packages/core/src/core/nodes/ExternalStdioNode.ts`

Change SINGLETON_ID from `EXTERNAL_STDIO:__stdio__` to `net:stdio#__stdio__`

### 5.2 NetRequestNode.ts (NEW)

**File**: `/packages/core/src/core/nodes/NetRequestNode.ts`

```typescript
static create(): NetRequestNodeRecord
```

**ID** (SINGLETON): `net:request#__network__`

---

## Files Summary

### Files to Create (6)
- `ExternalModuleNode.ts`
- `InterfaceNode.ts`
- `TypeNode.ts`
- `EnumNode.ts`
- `DecoratorNode.ts`
- `NetRequestNode.ts`

### Files to Modify (4)
- `nodes/index.ts` - Export new classes
- `nodes/ClassNode.ts` - Add `createExternal()`, add `implements` field
- `nodes/ExternalStdioNode.ts` - Fix SINGLETON_ID
- `NodeFactory.ts` - Add 11 factory methods

### Test Files to Create (10)
- `NodeFactoryClass.test.js`
- `NodeFactoryExport.test.js`
- `NodeFactoryExternalModule.test.js`
- `NodeFactoryType.test.js`
- `NodeFactoryEnum.test.js`
- `NodeFactoryInterface.test.js`
- `NodeFactoryExternalClass.test.js`
- `NodeFactoryDecorator.test.js`
- `NodeFactoryNetStdio.test.js`
- `NodeFactoryNetRequest.test.js`

---

## Implementation Order

1. **Phase 1**: `createClass()`, `createExport()` (existing contracts)
2. **Phase 2**: `ExternalModuleNode`, `TypeNode`, `EnumNode` (simple new)
3. **Phase 3**: `InterfaceNode`, `createExternalClass()` (with external variants)
4. **Phase 4**: `DecoratorNode` (target-dependent)
5. **Phase 5**: Fix `ExternalStdioNode`, `NetRequestNode` (singletons)

---

## ID Format Migration Note

**BREAKING CHANGE**: Some existing IDs use `#` separator; new ones use `:`.

Current GraphBuilder uses:
- `INTERFACE#${name}#${file}#${line}`
- `TYPE#${name}#${file}#${line}`
- `ENUM#${name}#${file}#${line}`

New format:
- `${file}:INTERFACE:${name}:${line}`
- `${file}:TYPE:${name}:${line}`
- `${file}:ENUM:${name}:${line}`

**Decision needed**: Migration strategy for existing data before Part 2.
