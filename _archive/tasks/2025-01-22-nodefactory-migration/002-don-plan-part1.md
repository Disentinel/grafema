# Don Melton's Plan: NodeFactory Migration (Part 1 - REG-98)

## Executive Summary

Analyzed existing patterns in `NodeFactory.ts`, node contracts in `./nodes/`, and inline creations in `GraphBuilder.ts`. The task is well-defined with clear existing patterns.

## Existing Patterns

### NodeFactory Pattern
```typescript
static createXxx(required1, required2, ..., options: XxxOptions = {}) {
  return XxxNode.create(required1, required2, ..., options);
}
```

### Node Contract Pattern
Each class has:
- `XxxNodeRecord extends BaseNodeRecord` interface
- `XxxNodeOptions` interface
- Static: `TYPE`, `REQUIRED`, `OPTIONAL`
- Static `create()` and `validate()` methods

### ID Formats
- **Semantic ID**: `${file}:IMPORT:${source}:${name}` (stable)
- **Position-based**: `${file}:FUNCTION:${name}:${line}:${column}`
- **Singleton**: `EXTERNAL_STDIO:__stdio__`

## Critical Issue: ID Format Inconsistency

**Problem**: Two formats in use:
1. **Colon-separated** (NodeFactory): `${file}:CLASS:${name}:${line}`
2. **Hash-separated** (GraphBuilder): `INTERFACE#${name}#${file}#${line}`

**Decision**: Standardize on **colon-separated** format to match NodeFactory pattern.

## Existing Contract Status

| Type | Contract Exists | Factory Exists |
|------|-----------------|----------------|
| `ClassNode` | YES | NO |
| `ExportNode` | YES | NO |
| `ExternalStdioNode` | YES | YES (ID mismatch) |
| `EXTERNAL_MODULE` | NO | NO |
| `INTERFACE` | NO | NO |
| `TYPE` | NO | NO |
| `ENUM` | NO | NO |
| `DECORATOR` | NO | NO |
| `net:request` | NO | NO |

## Factory Method Signatures

### 1. createExternalModule() - NEW contract
```typescript
static create(moduleName: string, referencingFile: string, line: number, options = {})
// ID: `EXTERNAL_MODULE:${moduleName}` (singleton per module)
```

### 2. createClass() - factory for existing ClassNode
```typescript
static createClass(name, file, line, column, options = {})
```

### 3. createExternalClass() - NEW
```typescript
static createExternalClass(className, file, line, options = {})
// ID with isExternal: true flag
```

### 4. createExport() - factory for existing ExportNode
```typescript
static createExport(name, file, line, column, options = {})
```

### 5. createInterface() - NEW contract
```typescript
static create(name, file, line, column, options = {})
// ID: `${file}:INTERFACE:${name}:${line}`
// Options: { extends?: string[], properties?, isExternal? }
```

### 6. createExternalInterface()
```typescript
static createExternalInterface(name, file, line, options = {})
// ID: `${file}:INTERFACE:${name}:external`, isExternal: true
```

### 7. createType() - NEW contract
```typescript
static create(name, file, line, column, options = {})
// ID: `${file}:TYPE:${name}:${line}`
// Options: { aliasOf?: string }
```

### 8. createEnum() - NEW contract
```typescript
static create(name, file, line, column, options = {})
// ID: `${file}:ENUM:${name}:${line}`
// Options: { isConst?, members }
```

### 9. createDecorator() - NEW contract
```typescript
static create(name, file, line, column, targetId, targetType, options = {})
// ID: `${file}:DECORATOR:${name}:${line}:${column}`
```

### 10. createNetStdio() - SINGLETON, fix existing
```typescript
static create()
// ID: `net:stdio#__stdio__` - match production data
```

### 11. createNetRequest() - NEW singleton
```typescript
static create()
// ID: `net:request#__network__`
```

## Implementation Order

**Phase 1: Factory methods for existing contracts**
1. `createClass()`
2. `createExport()`

**Phase 2: Simple new contracts**
3. `createExternalModule()`
4. `createType()`
5. `createEnum()`

**Phase 3: Contracts with external variants**
6. `createInterface()`
7. `createExternalInterface()`
8. `createExternalClass()`

**Phase 4: Target-dependent**
9. `createDecorator()`

**Phase 5: Singletons**
10. `createNetStdio()`
11. `createNetRequest()`

## Files to Create

1. `ExternalModuleNode.ts`
2. `InterfaceNode.ts`
3. `TypeNode.ts`
4. `EnumNode.ts`
5. `DecoratorNode.ts`
6. `NetRequestNode.ts`

## Files to Modify

1. `NodeFactory.ts` - Add 11 factory methods
2. `nodes/index.ts` - Export new classes
3. Possibly `NodeKind.ts` - Add new types

## Architectural Concerns

1. **ID Migration**: Changing `#` to `:` may break existing data
2. **Singleton guarantee**: `net:stdio` and `net:request` must return same ID always
3. **Type safety**: After migration, `_bufferNode()` should accept typed `NodeRecord`
