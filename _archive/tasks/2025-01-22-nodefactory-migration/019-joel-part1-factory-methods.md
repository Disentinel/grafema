# Joel's Technical Spec: REG-98 Part 1 - Factory Methods

## Overview

Add 8 missing factory methods to `NodeFactory.ts`. This aligns with the established pattern: each node type has a contract file in `packages/core/src/core/nodes/` with `create()`, `createWithContext()`, and `validate()` methods, and NodeFactory provides the unified API.

## Current State Analysis

### Existing Pattern in NodeFactory

```typescript
// NodeFactory delegates to node contracts
static createFunction(name, file, line, column, options = {}) {
  return FunctionNode.create(name, file, line, column, options);
}
```

Each factory method:
1. Takes required positional parameters + optional options object
2. Delegates to the node contract's `create()` method
3. Has matching validator entry in `validate()` method

### Existing Node Contracts

| Contract File | Has create() | Has createWithContext() | Has validate() |
|--------------|--------------|------------------------|----------------|
| ClassNode.ts | Yes | Yes | Yes |
| ExportNode.ts | Yes | Yes | Yes |
| FunctionNode.ts | Yes | Yes | Yes |
| ImportNode.ts | Yes | No | Yes |
| ModuleNode.ts | Yes | No | Yes |

### Info Types in types.ts

Already defined:
- `ClassDeclarationInfo` - for CLASS nodes
- `ExportInfo` - for EXPORT nodes
- `InterfaceDeclarationInfo` - for INTERFACE nodes
- `TypeAliasInfo` - for TYPE nodes
- `EnumDeclarationInfo` - for ENUM nodes
- `DecoratorInfo` - for DECORATOR nodes

Not defined (need to create):
- `ExternalModuleInfo` - for EXTERNAL_MODULE nodes
- `ExpressionInfo` - for EXPRESSION nodes (exists inline in VariableVisitor)

---

## Method Specifications

### 1. createClass()

**Status:** Contract EXISTS (`ClassNode.ts`), needs factory integration

**Method Signature:**
```typescript
static createClass(
  name: string,
  file: string,
  line: number,
  column: number,
  options: ClassOptions = {}
): ClassNodeRecord

interface ClassOptions {
  exported?: boolean;
  superClass?: string;
  methods?: string[];
}
```

**Required Fields:** name, file, line, column
**Optional Fields:** exported (default: false), superClass, methods (default: [])

**Example Usage:**
```typescript
const classNode = NodeFactory.createClass(
  'UserService',
  '/src/services/UserService.ts',
  10,
  0,
  { exported: true, superClass: 'BaseService', methods: ['create', 'update'] }
);
// ID: /src/services/UserService.ts:CLASS:UserService:10
```

**Implementation:**
- Add import: `ClassNode, type ClassNodeRecord` to NodeFactory imports
- Add `ClassOptions` interface
- Add factory method delegating to `ClassNode.create()`
- Add 'CLASS': ClassNode to validators map

---

### 2. createExport()

**Status:** Contract EXISTS (`ExportNode.ts`), needs factory integration

**Method Signature:**
```typescript
static createExport(
  name: string,
  file: string,
  line: number,
  column: number,
  options: ExportOptions = {}
): ExportNodeRecord

interface ExportOptions {
  exportKind?: 'value' | 'type';
  local?: string;
  default?: boolean;
}
```

**Required Fields:** name, file, line, column
**Optional Fields:** exportKind (default: 'value'), local (default: name), default (default: false)

**Example Usage:**
```typescript
// Named export
const namedExport = NodeFactory.createExport(
  'formatDate',
  '/src/utils.ts',
  15,
  0,
  { exportKind: 'value' }
);

// Default export
const defaultExport = NodeFactory.createExport(
  'default',
  '/src/App.tsx',
  100,
  0,
  { default: true, local: 'App' }
);
```

**Implementation:**
- Add import: `ExportNode, type ExportNodeRecord, type ExportKind` to NodeFactory imports
- Add `ExportOptions` interface
- Add factory method delegating to `ExportNode.create()`
- Add 'EXPORT': ExportNode to validators map

---

### 3. createExternalModule()

**Status:** Contract DOES NOT EXIST, needs creation

**Purpose:** Represents external npm packages or Node.js built-in modules that are imported but not analyzed.

**Contract File:** `packages/core/src/core/nodes/ExternalModuleNode.ts`

**Node Record:**
```typescript
interface ExternalModuleNodeRecord extends BaseNodeRecord {
  type: 'EXTERNAL_MODULE';
  // Minimal - external modules don't have file/line
}
```

**Method Signature:**
```typescript
static createExternalModule(source: string): ExternalModuleNodeRecord
```

**Required Fields:** source (module name like 'lodash', '@tanstack/react-query')
**Optional Fields:** None

**ID Format:** `EXTERNAL_MODULE:{source}`

**Example Usage:**
```typescript
const lodash = NodeFactory.createExternalModule('lodash');
// ID: EXTERNAL_MODULE:lodash

const reactQuery = NodeFactory.createExternalModule('@tanstack/react-query');
// ID: EXTERNAL_MODULE:@tanstack/react-query
```

**Current GraphBuilder Pattern (to migrate):**
```typescript
// packages/core/src/plugins/analysis/ast/GraphBuilder.ts:508-519
const externalModuleId = `EXTERNAL_MODULE:${source}`;
this._bufferNode({
  id: externalModuleId,
  type: 'EXTERNAL_MODULE',
  name: source,
  file: module.file,  // Note: using importing file, not ideal
  line: line
});
```

**Contract Implementation:**
```typescript
export class ExternalModuleNode {
  static readonly TYPE = 'EXTERNAL_MODULE' as const;
  static readonly REQUIRED = ['name'] as const;
  static readonly OPTIONAL = [] as const;

  static create(source: string): ExternalModuleNodeRecord {
    if (!source) throw new Error('ExternalModuleNode.create: source is required');

    return {
      id: `EXTERNAL_MODULE:${source}`,
      type: this.TYPE,
      name: source,
      file: '',  // External modules have no file
      line: 0
    };
  }

  static validate(node: ExternalModuleNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    if (!node.name) errors.push('Missing required field: name');
    return errors;
  }
}
```

---

### 4. createInterface()

**Status:** Contract DOES NOT EXIST, needs creation

**Purpose:** Represents TypeScript interface declarations.

**Contract File:** `packages/core/src/core/nodes/InterfaceNode.ts`

**Node Record:**
```typescript
interface InterfaceNodeRecord extends BaseNodeRecord {
  type: 'INTERFACE';
  column: number;
  extends?: string[];  // Parent interface names
  properties: InterfacePropertyRecord[];
}

interface InterfacePropertyRecord {
  name: string;
  type?: string;
  optional?: boolean;
  readonly?: boolean;
}
```

**Method Signature:**
```typescript
static createInterface(
  name: string,
  file: string,
  line: number,
  column: number,
  options: InterfaceOptions = {}
): InterfaceNodeRecord

interface InterfaceOptions {
  extends?: string[];
  properties?: InterfacePropertyRecord[];
}
```

**Required Fields:** name, file, line, column
**Optional Fields:** extends (default: []), properties (default: [])

**ID Format:** `{file}:INTERFACE:{name}:{line}`

**Example Usage:**
```typescript
const userInterface = NodeFactory.createInterface(
  'IUser',
  '/src/types.ts',
  5,
  0,
  {
    extends: ['IEntity'],
    properties: [
      { name: 'id', type: 'string', readonly: true },
      { name: 'name', type: 'string' },
      { name: 'email', type: 'string', optional: true }
    ]
  }
);
```

**Current GraphBuilder Pattern (to migrate):**
```typescript
// packages/core/src/plugins/analysis/ast/GraphBuilder.ts:1062-1073
this._bufferNode({
  id: iface.id,
  type: 'INTERFACE',
  name: iface.name,
  file: module.file,
  line: iface.line,
  column: iface.column || 0,
  properties: iface.properties || []
});
```

---

### 5. createType()

**Status:** Contract DOES NOT EXIST, needs creation

**Purpose:** Represents TypeScript type alias declarations.

**Contract File:** `packages/core/src/core/nodes/TypeNode.ts`

**Node Record:**
```typescript
interface TypeNodeRecord extends BaseNodeRecord {
  type: 'TYPE';
  column: number;
  aliasOf?: string;  // String representation of the type
}
```

**Method Signature:**
```typescript
static createType(
  name: string,
  file: string,
  line: number,
  column: number,
  options: TypeOptions = {}
): TypeNodeRecord

interface TypeOptions {
  aliasOf?: string;
}
```

**Required Fields:** name, file, line, column
**Optional Fields:** aliasOf

**ID Format:** `{file}:TYPE:{name}:{line}`

**Example Usage:**
```typescript
const userIdType = NodeFactory.createType(
  'UserId',
  '/src/types.ts',
  10,
  0,
  { aliasOf: 'string | number' }
);
```

**Note:** TypeAliasInfo exists in types.ts, no GraphBuilder implementation yet (future work).

---

### 6. createEnum()

**Status:** Contract DOES NOT EXIST, needs creation

**Purpose:** Represents TypeScript enum declarations.

**Contract File:** `packages/core/src/core/nodes/EnumNode.ts`

**Node Record:**
```typescript
interface EnumNodeRecord extends BaseNodeRecord {
  type: 'ENUM';
  column: number;
  isConst?: boolean;  // const enum
  members: EnumMemberRecord[];
}

interface EnumMemberRecord {
  name: string;
  value?: string | number;
}
```

**Method Signature:**
```typescript
static createEnum(
  name: string,
  file: string,
  line: number,
  column: number,
  options: EnumOptions = {}
): EnumNodeRecord

interface EnumOptions {
  isConst?: boolean;
  members?: EnumMemberRecord[];
}
```

**Required Fields:** name, file, line, column
**Optional Fields:** isConst (default: false), members (default: [])

**ID Format:** `{file}:ENUM:{name}:{line}`

**Example Usage:**
```typescript
const statusEnum = NodeFactory.createEnum(
  'Status',
  '/src/types.ts',
  20,
  0,
  {
    isConst: true,
    members: [
      { name: 'Active', value: 'active' },
      { name: 'Inactive', value: 'inactive' }
    ]
  }
);
```

**Current GraphBuilder Pattern (to migrate):**
```typescript
// packages/core/src/plugins/analysis/ast/GraphBuilder.ts:1144-1156
this._bufferNode({
  id: enumDecl.id,
  type: 'ENUM',
  name: enumDecl.name,
  file: module.file,
  line: enumDecl.line,
  column: enumDecl.column || 0,
  isConst: enumDecl.isConst || false,
  members: enumDecl.members || []
});
```

---

### 7. createDecorator()

**Status:** Contract DOES NOT EXIST, needs creation

**Purpose:** Represents TypeScript/JavaScript decorators applied to classes, methods, properties, or parameters.

**Contract File:** `packages/core/src/core/nodes/DecoratorNode.ts`

**Node Record:**
```typescript
interface DecoratorNodeRecord extends BaseNodeRecord {
  type: 'DECORATOR';
  column: number;
  arguments?: unknown[];  // Decorator arguments
  targetId: string;       // ID of decorated element
  targetType: 'CLASS' | 'METHOD' | 'PROPERTY' | 'PARAMETER';
}
```

**Method Signature:**
```typescript
static createDecorator(
  name: string,
  file: string,
  line: number,
  column: number,
  targetId: string,
  targetType: 'CLASS' | 'METHOD' | 'PROPERTY' | 'PARAMETER',
  options: DecoratorOptions = {}
): DecoratorNodeRecord

interface DecoratorOptions {
  arguments?: unknown[];
}
```

**Required Fields:** name, file, line, column, targetId, targetType
**Optional Fields:** arguments (default: [])

**ID Format:** `{file}:DECORATOR:{name}:{line}:{column}`

**Example Usage:**
```typescript
const injectable = NodeFactory.createDecorator(
  'Injectable',
  '/src/services/UserService.ts',
  5,
  0,
  'CLASS:UserService:6',
  'CLASS',
  { arguments: [{ providedIn: 'root' }] }
);
```

**Current GraphBuilder Pattern (to migrate):**
```typescript
// packages/core/src/plugins/analysis/ast/GraphBuilder.ts:1170-1182
this._bufferNode({
  id: decorator.id,
  type: 'DECORATOR',
  name: decorator.name,
  file: module.file,
  line: decorator.line,
  column: decorator.column || 0,
  arguments: decorator.arguments || [],
  targetId: decorator.targetId,
  targetType: decorator.targetType
});
```

---

### 8. createExpression()

**Status:** Contract DOES NOT EXIST, needs creation

**Purpose:** Represents complex expressions for data flow tracking (MemberExpression, BinaryExpression, etc.).

**Contract File:** `packages/core/src/core/nodes/ExpressionNode.ts`

**Node Record:**
```typescript
interface ExpressionNodeRecord extends BaseNodeRecord {
  type: 'EXPRESSION';
  column: number;
  expressionType: string;  // 'MemberExpression', 'BinaryExpression', etc.
  // MemberExpression fields
  object?: string;
  property?: string;
  computed?: boolean;
  computedPropertyVar?: string;
  // Binary/Logical expression fields
  operator?: string;
  // Additional fields for tracking
  path?: string;
  baseName?: string;
  propertyPath?: string[];
  arrayIndex?: number;
}
```

**Method Signature:**
```typescript
static createExpression(
  expressionType: string,
  file: string,
  line: number,
  column: number,
  options: ExpressionOptions = {}
): ExpressionNodeRecord

interface ExpressionOptions {
  // MemberExpression
  object?: string;
  property?: string;
  computed?: boolean;
  computedPropertyVar?: string;
  // Binary/Logical
  operator?: string;
  // Tracking
  path?: string;
  baseName?: string;
  propertyPath?: string[];
  arrayIndex?: number;
}
```

**Required Fields:** expressionType, file, line, column
**Optional Fields:** All fields in ExpressionOptions

**ID Format:** `{file}:EXPRESSION:{expressionType}:{line}:{column}` or `EXPRESSION#{path}#{file}#{line}:{column}`

**Example Usage:**
```typescript
// MemberExpression: user.name
const memberExpr = NodeFactory.createExpression(
  'MemberExpression',
  '/src/app.ts',
  25,
  10,
  {
    object: 'user',
    property: 'name',
    path: 'user.name'
  }
);

// BinaryExpression: a + b
const binaryExpr = NodeFactory.createExpression(
  'BinaryExpression',
  '/src/calc.ts',
  30,
  5,
  { operator: '+' }
);
```

**Current GraphBuilder Pattern (to migrate):**
```typescript
// packages/core/src/plugins/analysis/ast/GraphBuilder.ts:832-856
const expressionNode: GraphNode = {
  id: sourceId,
  type: 'EXPRESSION',
  expressionType,
  file: exprFile,
  line: exprLine
};

if (expressionType === 'MemberExpression') {
  expressionNode.object = object;
  expressionNode.property = property;
  expressionNode.computed = computed;
  expressionNode.name = `${object}.${property}`;
}
```

---

## Implementation Order

1. **createClass()** - Contract exists, quick win
2. **createExport()** - Contract exists, quick win
3. **createExternalModule()** - Simple contract, singleton pattern
4. **createInterface()** - Mirrors class pattern
5. **createType()** - Simple contract
6. **createEnum()** - Mirrors interface pattern
7. **createDecorator()** - Has targetId/targetType
8. **createExpression()** - Most complex, multiple subtypes

## Files to Modify

1. `packages/core/src/core/NodeFactory.ts` - Add 8 factory methods + imports
2. `packages/core/src/core/nodes/index.ts` - Export new contracts

## Files to Create

1. `packages/core/src/core/nodes/ExternalModuleNode.ts`
2. `packages/core/src/core/nodes/InterfaceNode.ts`
3. `packages/core/src/core/nodes/TypeNode.ts`
4. `packages/core/src/core/nodes/EnumNode.ts`
5. `packages/core/src/core/nodes/DecoratorNode.ts`
6. `packages/core/src/core/nodes/ExpressionNode.ts`

## Testing Strategy

For each new factory method:
1. Unit test: validates creation with required fields only
2. Unit test: validates creation with all options
3. Unit test: validates required field errors
4. Unit test: validates node validation

Test file: `test/unit/NodeFactory.test.js` (extend existing or create new)

## Notes

- All new contracts should support both `create()` (legacy) and `createWithContext()` (semantic ID) patterns
- GraphBuilder migration (Part 2) will update existing inline node creation to use these factory methods
- ExternalModule is a singleton-like node (one per package name)
- Expression nodes have variable structure based on expressionType
