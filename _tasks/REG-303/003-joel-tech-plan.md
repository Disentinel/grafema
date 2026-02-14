# REG-303: AST -- Track Type Parameter Constraints

## Joel Spolsky -- Detailed Technical Specification

---

## 1. Summary

Add `TYPE_PARAMETER` node type and `HAS_TYPE_PARAMETER` edge type to represent generic type parameters (`<T extends Serializable = string>`) on functions, classes, interfaces, and type aliases. Follows the existing visitor -> collection -> GraphBuilder pattern exactly.

---

## 2. Implementation Steps (Ordered)

### Step 1: Add type constants (`packages/types/src/nodes.ts`, `packages/types/src/edges.ts`)

### Step 2: Add `TYPE_PARAMETER` to `NodeKind.ts` (`packages/core`)

### Step 3: Add `TypeParameterInfo` interface to `types.ts` and `typeParameters` to `ASTCollections`

### Step 4: Create `TypeParameterNode.ts` contract (new file)

### Step 5: Export from `nodes/index.ts`

### Step 6: Add `createTypeParameter()` to `NodeFactory.ts`

### Step 7: Add `TypeParameterNode` to `NodeFactory.validate()`

### Step 8: Add type param extraction helper to `TypeScriptVisitor.ts`

### Step 9: Extract type params in `TypeScriptVisitor` (interfaces + type aliases)

### Step 10: Extract type params in `FunctionVisitor` (function declarations + arrow functions)

### Step 11: Extract type params in `ClassVisitor` (class declarations + class methods)

### Step 12: Add `bufferTypeParameterNodes()` to `GraphBuilder.ts` and call it from `build()`

### Step 13: Update plugin metadata in `JSASTAnalyzer.ts`

### Step 14: Export `TypeParameterNode` from `@grafema/core` index

### Step 15: Write tests

---

## 3. Exact Code Changes Per File

### 3.1 `packages/types/src/nodes.ts` (line 47)

Add `TYPE_PARAMETER` to `NODE_TYPE` const, after `EXPRESSION`:

```typescript
// Current (line 15-16):
  EXPRESSION: 'EXPRESSION',

// After EXPRESSION, before the closing }, add:
  TYPE_PARAMETER: 'TYPE_PARAMETER',
```

Also add `TypeParameterNodeRecord` interface after `PluginNodeRecord` (around line 309):

```typescript
// Type parameter node (generic type param: <T extends Constraint = Default>)
export interface TypeParameterNodeRecord extends BaseNodeRecord {
  type: 'TYPE_PARAMETER';
  column: number;
  constraint?: string;    // String repr of constraint: "Serializable", "A & B"
  defaultType?: string;   // String repr of default: "string", "unknown"
  variance?: 'in' | 'out' | 'in out';
}
```

Add `TypeParameterNodeRecord` to the `NodeRecord` union type (around line 334).

### 3.2 `packages/types/src/edges.ts` (line 103)

Add `HAS_TYPE_PARAMETER` to `EDGE_TYPE` const. Insert in the **Inheritance** section after `INSTANCE_OF` (line 43):

```typescript
  // Inheritance
  EXTENDS: 'EXTENDS',
  IMPLEMENTS: 'IMPLEMENTS',
  INSTANCE_OF: 'INSTANCE_OF',
  HAS_TYPE_PARAMETER: 'HAS_TYPE_PARAMETER',
```

### 3.3 `packages/core/src/core/nodes/NodeKind.ts` (line 27)

Add `TYPE_PARAMETER` to the `NODE_TYPE` const. After `EXPRESSION` (line 27):

```typescript
  EXPRESSION: 'EXPRESSION',  // Generic expression node for data flow tracking
  TYPE_PARAMETER: 'TYPE_PARAMETER',
```

### 3.4 `packages/core/src/plugins/analysis/ast/types.ts`

**A. Add `TypeParameterInfo` interface** (after `EnumMemberInfo`, around line 404):

```typescript
// === TYPE PARAMETER INFO ===
export interface TypeParameterInfo {
  name: string;              // "T", "K", "V"
  constraintType?: string;   // "Serializable" (string repr via typeNodeToString)
  defaultType?: string;      // "string" (string repr via typeNodeToString)
  variance?: 'in' | 'out' | 'in out';
  parentId: string;          // ID of owning function/class/interface/type
  parentType: 'FUNCTION' | 'CLASS' | 'INTERFACE' | 'TYPE';
  file: string;
  line: number;
  column: number;
}
```

**B. Add `typeParameters` to `ASTCollections` interface** (after `decorators`, around line 1123):

```typescript
  decorators?: DecoratorInfo[];
  // Type parameter tracking for generics (REG-303)
  typeParameters?: TypeParameterInfo[];
```

### 3.5 `packages/core/src/core/nodes/TypeParameterNode.ts` (NEW FILE)

Follow exact pattern of `TypeNode.ts`:

```typescript
/**
 * TypeParameterNode - contract for TYPE_PARAMETER node
 *
 * Represents a generic type parameter on a function, class, interface, or type alias.
 *
 * ID format: {parentId}:TYPE_PARAMETER:{name}
 * Example: /src/types.ts:INTERFACE:Container:5:TYPE_PARAMETER:T
 *
 * Type parameter names are unique within their declaration scope
 * (TypeScript does not allow `<T, T>`), so {parentId}:{name} is sufficient.
 */

import type { BaseNodeRecord } from '@grafema/types';

interface TypeParameterNodeRecord extends BaseNodeRecord {
  type: 'TYPE_PARAMETER';
  column: number;
  constraint?: string;
  defaultType?: string;
  variance?: 'in' | 'out' | 'in out';
}

interface TypeParameterNodeOptions {
  constraint?: string;
  defaultType?: string;
  variance?: 'in' | 'out' | 'in out';
}

export class TypeParameterNode {
  static readonly TYPE = 'TYPE_PARAMETER' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['constraint', 'defaultType', 'variance'] as const;

  /**
   * Create TYPE_PARAMETER node
   *
   * @param name - Type parameter name (e.g., "T", "K")
   * @param parentId - ID of the owning declaration (function, class, interface, type)
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional constraint, defaultType, variance
   * @returns TypeParameterNodeRecord
   */
  static create(
    name: string,
    parentId: string,
    file: string,
    line: number,
    column: number,
    options: TypeParameterNodeOptions = {}
  ): TypeParameterNodeRecord {
    if (!name) throw new Error('TypeParameterNode.create: name is required');
    if (!parentId) throw new Error('TypeParameterNode.create: parentId is required');
    if (!file) throw new Error('TypeParameterNode.create: file is required');
    if (!line) throw new Error('TypeParameterNode.create: line is required');
    if (column === undefined) throw new Error('TypeParameterNode.create: column is required');

    return {
      id: `${parentId}:TYPE_PARAMETER:${name}`,
      type: this.TYPE,
      name,
      file,
      line,
      column,
      ...(options.constraint !== undefined && { constraint: options.constraint }),
      ...(options.defaultType !== undefined && { defaultType: options.defaultType }),
      ...(options.variance !== undefined && { variance: options.variance }),
    };
  }

  static validate(node: TypeParameterNodeRecord): string[] {
    const errors: string[] = [];

    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }

    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined || nodeRecord[field] === null) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    return errors;
  }
}

export type { TypeParameterNodeRecord, TypeParameterNodeOptions };
```

### 3.6 `packages/core/src/core/nodes/index.ts` (line 36)

After the TypeNode export:

```typescript
export { TypeNode, type TypeNodeRecord } from './TypeNode.js';
export { TypeParameterNode, type TypeParameterNodeRecord, type TypeParameterNodeOptions } from './TypeParameterNode.js';
```

### 3.7 `packages/core/src/core/NodeFactory.ts`

**A. Add import** (line 41, after TypeNode import):

```typescript
  TypeNode,
  TypeParameterNode,
  EnumNode,
```

**B. Add `TypeParameterOptions` interface** (after `TypeOptions`, around line 202):

```typescript
interface TypeParameterOptions {
  constraint?: string;
  defaultType?: string;
  variance?: 'in' | 'out' | 'in out';
}
```

**C. Add `createTypeParameter()` factory method** (after `createType`, around line 530):

```typescript
  /**
   * Create TYPE_PARAMETER node
   *
   * Represents a generic type parameter (<T extends Constraint = Default>).
   *
   * @param name - Type parameter name ("T", "K", "V")
   * @param parentId - ID of the owning declaration (function/class/interface/type)
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional constraint, defaultType, variance
   */
  static createTypeParameter(
    name: string,
    parentId: string,
    file: string,
    line: number,
    column: number,
    options: TypeParameterOptions = {}
  ) {
    return brandNode(TypeParameterNode.create(name, parentId, file, line, column, options));
  }
```

**D. Add to `validate()` map** (around line 726, after `'TYPE': TypeNode`):

```typescript
      'TYPE': TypeNode,
      'TYPE_PARAMETER': TypeParameterNode,
      'ENUM': EnumNode,
```

### 3.8 `packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts`

**A. Add import** for `TypeParameterInfo` (line 27):

```typescript
import type {
  InterfaceDeclarationInfo,
  InterfacePropertyInfo,
  TypeAliasInfo,
  EnumDeclarationInfo,
  EnumMemberInfo,
  TypeParameterInfo
} from '../types.js';
```

**B. Add helper function `extractTypeParameters()`** (after `typeNodeToString`, around line 99):

```typescript
/**
 * Extracts type parameter info from a TSTypeParameterDeclaration node.
 *
 * Handles:
 * - Simple: <T>
 * - Constrained: <T extends Serializable>
 * - Defaulted: <T = string>
 * - Variance: <in T>, <out T>, <in out T>
 * - Intersection constraints: <T extends A & B>
 *
 * @param typeParameters - Babel TSTypeParameterDeclaration node (or undefined)
 * @param parentId - ID of the owning declaration
 * @param parentType - 'FUNCTION' | 'CLASS' | 'INTERFACE' | 'TYPE'
 * @param file - File path
 * @param line - Line of the declaration
 * @param column - Column of the declaration
 * @returns Array of TypeParameterInfo (empty if no type params)
 */
export function extractTypeParameters(
  typeParameters: unknown,
  parentId: string,
  parentType: 'FUNCTION' | 'CLASS' | 'INTERFACE' | 'TYPE',
  file: string,
  line: number,
  column: number
): TypeParameterInfo[] {
  if (!typeParameters || typeof typeParameters !== 'object') return [];

  const tpDecl = typeParameters as { type?: string; params?: unknown[] };
  if (tpDecl.type !== 'TSTypeParameterDeclaration' || !Array.isArray(tpDecl.params)) return [];

  const result: TypeParameterInfo[] = [];

  for (const param of tpDecl.params) {
    const tsParam = param as {
      type?: string;
      name?: string;
      constraint?: unknown;
      default?: unknown;
      in?: boolean;
      out?: boolean;
      loc?: { start?: { line?: number; column?: number } };
    };

    if (tsParam.type !== 'TSTypeParameter') continue;

    const paramName = tsParam.name;
    if (!paramName) continue;

    // Extract constraint via typeNodeToString
    const constraintType = tsParam.constraint ? typeNodeToString(tsParam.constraint) : undefined;

    // Extract default via typeNodeToString
    const defaultType = tsParam.default ? typeNodeToString(tsParam.default) : undefined;

    // Extract variance
    let variance: 'in' | 'out' | 'in out' | undefined;
    if (tsParam.in && tsParam.out) {
      variance = 'in out';
    } else if (tsParam.in) {
      variance = 'in';
    } else if (tsParam.out) {
      variance = 'out';
    }

    // Use param's own location if available, otherwise fall back to declaration location
    const paramLine = tsParam.loc?.start?.line ?? line;
    const paramColumn = tsParam.loc?.start?.column ?? column;

    result.push({
      name: paramName,
      constraintType: constraintType !== 'unknown' ? constraintType : undefined,
      defaultType: defaultType !== 'unknown' ? defaultType : undefined,
      variance,
      parentId,
      parentType,
      file,
      line: paramLine,
      column: paramColumn,
    });
  }

  return result;
}
```

**C. Destructure `typeParameters` from collections** (inside `getHandlers()`, line 117):

```typescript
    const {
      interfaces,
      typeAliases,
      enums,
      typeParameters
    } = this.collections;
```

Note: `VisitorCollections` has `[key: string]: unknown` so accessing `typeParameters` is type-safe.

**D. Add type param extraction to `TSInterfaceDeclaration` handler** (after `properties` extraction, before the push to `interfaces`, around line 174):

The parentId for interfaces is generated by InterfaceNode.create() in GraphBuilder, which uses format `{file}:INTERFACE:{name}:{line}`. We must use the same ID format here for consistency:

```typescript
        // Extract type parameters (REG-303)
        if (typeParameters && node.typeParameters) {
          const interfaceId = `${module.file}:INTERFACE:${interfaceName}:${getLine(node)}`;
          const typeParamInfos = extractTypeParameters(
            node.typeParameters,
            interfaceId,
            'INTERFACE',
            module.file,
            getLine(node),
            getColumn(node)
          );
          for (const tp of typeParamInfos) {
            (typeParameters as TypeParameterInfo[]).push(tp);
          }
        }
```

Insert this right before the `(interfaces as InterfaceDeclarationInfo[]).push({` line (line 174).

**E. Add type param extraction to `TSTypeAliasDeclaration` handler** (after `aliasOf` extraction, before the push, around line 201):

```typescript
        // Extract type parameters (REG-303)
        if (typeParameters && node.typeParameters) {
          const typeId = `${module.file}:TYPE:${typeName}:${getLine(node)}`;
          const typeParamInfos = extractTypeParameters(
            node.typeParameters,
            typeId,
            'TYPE',
            module.file,
            getLine(node),
            getColumn(node)
          );
          for (const tp of typeParamInfos) {
            (typeParameters as TypeParameterInfo[]).push(tp);
          }
        }
```

Insert right before the `(typeAliases as TypeAliasInfo[]).push({` line (line 201).

### 3.9 `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`

**A. Add import** (line 30):

```typescript
import type { ParameterInfo, PromiseExecutorContext, TypeParameterInfo } from '../types.js';
```

Also add `extractTypeParameters` import (after `typeNodeToString` import, line 25):

```typescript
import { typeNodeToString, extractTypeParameters } from './TypeScriptVisitor.js';
```

**B. Add type param extraction to `FunctionDeclaration` handler** (after `start: node.start ?? undefined` push, before `scopeTracker.enterScope`, around line 245):

```typescript
        // Extract type parameters (REG-303)
        const typeParametersCollection = collections.typeParameters;
        if (typeParametersCollection && (node as any).typeParameters) {
          const typeParamInfos = extractTypeParameters(
            (node as any).typeParameters,
            functionId,
            'FUNCTION',
            module.file,
            line,
            getColumn(node)
          );
          for (const tp of typeParamInfos) {
            (typeParametersCollection as TypeParameterInfo[]).push(tp);
          }
        }
```

Insert between the `(functions as FunctionInfo[]).push({...})` block and the `scopeTracker.enterScope(...)` call.

**C. Add type param extraction to `ArrowFunctionExpression` handler** (after the push to `functions`, before `scopeTracker.enterScope`, around line 320):

```typescript
        // Extract type parameters (REG-303)
        const arrowTypeParamsCollection = collections.typeParameters;
        if (arrowTypeParamsCollection && (node as any).typeParameters) {
          const typeParamInfos = extractTypeParameters(
            (node as any).typeParameters,
            functionId,
            'FUNCTION',
            module.file,
            line,
            column
          );
          for (const tp of typeParamInfos) {
            (arrowTypeParamsCollection as TypeParameterInfo[]).push(tp);
          }
        }
```

### 3.10 `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

**A. Add imports** (line 29):

```typescript
import type { DecoratorInfo, ParameterInfo, VariableDeclarationInfo, TypeParameterInfo } from '../types.js';
```

And add `extractTypeParameters` (after existing imports, no `typeNodeToString` is imported yet in ClassVisitor -- add it):

```typescript
import { extractTypeParameters } from './TypeScriptVisitor.js';
```

**B. Add type param extraction to `ClassDeclaration` handler** (after implements extraction and before `(classDeclarations as ClassInfo[]).push(...)`, around line 208):

The parentId for classes is generated by `ClassNode.createWithContext()` which returns `classRecord.id`. So:

```typescript
        // Extract type parameters (REG-303)
        if (collections.typeParameters && (classNode as any).typeParameters) {
          const typeParamInfos = extractTypeParameters(
            (classNode as any).typeParameters,
            classRecord.id,
            'CLASS',
            module.file,
            classLine,
            classColumn
          );
          for (const tp of typeParamInfos) {
            (collections.typeParameters as TypeParameterInfo[]).push(tp);
          }
        }
```

Insert between the `implementsNames` extraction block and the `(classDeclarations as ClassInfo[]).push({...})` block.

**C. Add type param extraction to `ClassMethod` handler** (after `funcData` push, before decorator extraction, around line 356):

ClassMethod type parameters are on the method node itself. The parentId is the `functionId` (semantic ID):

```typescript
            // Extract type parameters for methods (REG-303)
            if (collections.typeParameters && (methodNode as any).typeParameters) {
              const typeParamInfos = extractTypeParameters(
                (methodNode as any).typeParameters,
                functionId,
                'FUNCTION',
                module.file,
                methodLine,
                methodColumn
              );
              for (const tp of typeParamInfos) {
                (collections.typeParameters as TypeParameterInfo[]).push(tp);
              }
            }
```

### 3.11 `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**A. Add import for TypeParameterInfo** (in the import block from `./types.js`, around line 38):

```typescript
  TypeParameterInfo,
```

Add import for `TypeParameterNode`:

```typescript
import { TypeParameterNode } from '../../../core/nodes/TypeParameterNode.js';
```

**B. Add destructuring in `build()`** (after `decorators = []`, line 164):

```typescript
      decorators = [],
      // Type parameter tracking for generics (REG-303)
      typeParameters = [],
```

**C. Add call to `bufferTypeParameterNodes()`** (after `bufferDecoratorNodes` call, around line 382):

```typescript
    // 24.5. Buffer TYPE_PARAMETER nodes and HAS_TYPE_PARAMETER edges (REG-303)
    this.bufferTypeParameterNodes(typeParameters);
```

**D. Add `bufferTypeParameterNodes()` private method** (after `bufferDecoratorNodes`, around line 2100):

```typescript
  /**
   * Buffer TYPE_PARAMETER nodes, HAS_TYPE_PARAMETER edges, and EXTENDS edges for constraints.
   *
   * For each type parameter:
   * 1. Creates TYPE_PARAMETER node with constraint/default/variance metadata
   * 2. Creates HAS_TYPE_PARAMETER edge: parent -> TYPE_PARAMETER
   * 3. If constraint is a known type name, creates EXTENDS edge:
   *    TYPE_PARAMETER -> constraint target (dangling edge, resolved during enrichment)
   */
  private bufferTypeParameterNodes(typeParameters: TypeParameterInfo[]): void {
    for (const tp of typeParameters) {
      // Create TYPE_PARAMETER node
      const tpNode = TypeParameterNode.create(
        tp.name,
        tp.parentId,
        tp.file,
        tp.line,
        tp.column,
        {
          constraint: tp.constraintType,
          defaultType: tp.defaultType,
          variance: tp.variance,
        }
      );
      this._bufferNode(tpNode as unknown as GraphNode);

      // HAS_TYPE_PARAMETER edge: parent -> TYPE_PARAMETER
      this._bufferEdge({
        type: 'HAS_TYPE_PARAMETER',
        src: tp.parentId,
        dst: tpNode.id
      });

      // EXTENDS edge for constraint (if constraint looks like a type reference, not a primitive)
      // Primitives (string, number, boolean, etc.) don't need EXTENDS edges
      if (tp.constraintType && !isPrimitiveType(tp.constraintType)) {
        // For intersection types ("A & B"), create EXTENDS edge for each part
        const constraintParts = tp.constraintType.includes(' & ')
          ? tp.constraintType.split(' & ').map(s => s.trim())
          : [tp.constraintType];

        for (const part of constraintParts) {
          // Skip primitives and complex types
          if (isPrimitiveType(part) || part === 'unknown') continue;
          // Skip union types, array types, etc.
          if (part.includes(' | ') || part.includes('[]') || part.includes('[')) continue;

          // Create a dangling EXTENDS edge -- will be resolved during enrichment
          // The dst is a TYPE_PARAMETER -> constraint name mapping
          // We use the constraint name as-is; cross-file resolution happens during enrichment
          this._bufferEdge({
            type: 'EXTENDS',
            src: tpNode.id,
            dst: part,  // Dangling reference to constraint type name
            metadata: { constraintRef: true }
          });
        }
      }
    }
  }
```

**E. Add `isPrimitiveType()` helper** (right before or after `bufferTypeParameterNodes`, as a module-level function or private method):

```typescript
/**
 * Check if a type string represents a TypeScript primitive (no EXTENDS edge needed)
 */
function isPrimitiveType(typeName: string): boolean {
  const PRIMITIVES = new Set([
    'string', 'number', 'boolean', 'void', 'null', 'undefined',
    'never', 'any', 'unknown', 'object', 'symbol', 'bigint', 'function'
  ]);
  return PRIMITIVES.has(typeName);
}
```

### 3.12 `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**A. Add `TypeParameterInfo` to import** (wherever the other types are imported from `./ast/types.js`):

```typescript
  TypeParameterInfo,
```

**B. Add `typeParameters` to `Collections` interface** (after `decorators`, line 154):

```typescript
  decorators: DecoratorInfo[];
  // Type parameter tracking for generics (REG-303)
  typeParameters: TypeParameterInfo[];
```

**C. Add initialization in `analyzeModule()`** (after `const decorators`, around line 1460):

```typescript
      const decorators: DecoratorInfo[] = [];
      // Type parameter tracking for generics (REG-303)
      const typeParameters: TypeParameterInfo[] = [];
```

**D. Add to `allCollections`** (after `decorators` in the allCollections object, around line 1547):

```typescript
        interfaces, typeAliases, enums, decorators,
        // Type parameter tracking for generics (REG-303)
        typeParameters,
```

**E. Update plugin metadata** (in `get metadata()`, around line 270):

Add `'TYPE_PARAMETER'` to nodes:

```typescript
          // TypeScript-specific nodes
          'INTERFACE', 'TYPE', 'ENUM', 'DECORATOR', 'TYPE_PARAMETER'
```

Add `'HAS_TYPE_PARAMETER'` to edges:

```typescript
          // TypeScript-specific edges
          'IMPLEMENTS', 'EXTENDS', 'DECORATED_BY', 'HAS_TYPE_PARAMETER',
```

### 3.13 `packages/core/src/index.ts`

Add export after `TypeNode` (around line 196):

```typescript
export { TypeNode } from './core/nodes/TypeNode.js';
export { TypeParameterNode, type TypeParameterNodeRecord, type TypeParameterNodeOptions } from './core/nodes/TypeParameterNode.js';
```

---

## 4. Test Plan

### Test file: `test/unit/TypeParameterTracking.test.js`

Follow the pattern from `InterfaceNodeMigration.test.js`:
- Use `createTestDatabase()` + `createTestOrchestrator()` for integration tests
- Use direct node creation for unit tests

### 4.1 Unit Tests (TypeParameterNode contract)

```
describe('TypeParameterNode.create()')
  it('should generate ID with format {parentId}:TYPE_PARAMETER:{name}')
  it('should set type to TYPE_PARAMETER')
  it('should include constraint when provided')
  it('should include defaultType when provided')
  it('should include variance when provided')
  it('should omit optional fields when not provided')
  it('should throw when name is missing')
  it('should throw when parentId is missing')
  it('should create unique IDs for different type params on same parent')
  it('should create same ID for same parameters (idempotent)')

describe('TypeParameterNode.validate()')
  it('should pass for valid TYPE_PARAMETER node')
  it('should fail for wrong type')
  it('should fail for missing required fields')

describe('NodeFactory.createTypeParameter()')
  it('should delegate to TypeParameterNode.create()')
  it('should pass NodeFactory.validate()')
```

### 4.2 extractTypeParameters() Unit Tests

```
describe('extractTypeParameters()')
  it('should return empty array for null/undefined')
  it('should return empty array for non-TSTypeParameterDeclaration')
  it('should extract single type parameter')
  it('should extract constraint via typeNodeToString')
  it('should extract defaultType via typeNodeToString')
  it('should extract variance annotations (in, out, in out)')
  it('should handle intersection constraints ("A & B")')
  it('should handle multiple type parameters')
```

### 4.3 Integration Tests (full pipeline analysis)

```
describe('Type parameter tracking - Functions')
  it('should create TYPE_PARAMETER node for function with single type param')
    // function identity<T>(x: T): T { return x; }
  it('should create TYPE_PARAMETER with constraint')
    // function serialize<T extends Serializable>(obj: T): string { ... }
  it('should create TYPE_PARAMETER with default')
    // function create<T = string>(): T { ... }
  it('should handle multiple type params')
    // function map<K, V>(key: K, value: V): Map<K, V> { ... }
  it('should create HAS_TYPE_PARAMETER edge from function to type param')
  it('should create EXTENDS edge for constraint type')

describe('Type parameter tracking - Arrow functions')
  it('should extract type params from arrow function')
    // const identity = <T>(x: T): T => x;

describe('Type parameter tracking - Classes')
  it('should create TYPE_PARAMETER for class declaration')
    // class Container<T> { value: T; }
  it('should create TYPE_PARAMETER with constraint on class')
    // class Repository<T extends Entity> { ... }
  it('should create TYPE_PARAMETER for class methods')
    // class Mapper { map<U>(fn: (t: T) => U): U { ... } }

describe('Type parameter tracking - Interfaces')
  it('should create TYPE_PARAMETER for interface')
    // interface Collection<T> { items: T[]; }
  it('should create TYPE_PARAMETER with constraint on interface')
    // interface Comparable<T extends Comparable<T>> { ... }

describe('Type parameter tracking - Type aliases')
  it('should create TYPE_PARAMETER for type alias')
    // type Pair<A, B> = [A, B];
  it('should create TYPE_PARAMETER with intersection constraint')
    // type Merged<T extends A & B> = T;

describe('Type parameter tracking - Edge cases')
  it('should handle variance annotation: in T')
    // interface Consumer<in T> { consume(value: T): void; }
  it('should handle variance annotation: out T')
    // interface Producer<out T> { produce(): T; }
  it('should not create EXTENDS edge for primitive constraints')
    // function parse<T extends string>(input: T): T
  it('should handle constraint with default combined')
    // function create<T extends object = Record<string, unknown>>(): T
```

---

## 5. Complexity Analysis

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `extractTypeParameters()` | O(k) per declaration | k = number of type params (typically 1-3) |
| `bufferTypeParameterNodes()` | O(n * k) | n = total declarations with type params, k = avg type params per declaration |
| `typeNodeToString()` for constraints | O(1) per constraint | Already exists, no recursion for simple types |
| Intersection constraint splitting | O(c) | c = parts in intersection (typically 2-3) |
| `isPrimitiveType()` | O(1) | Set lookup |

**Overall impact:** Negligible. Type parameters are extracted from AST nodes the visitors ALREADY traverse (no extra iteration over the AST). The number of type-parameterized declarations in a typical file is small (0-20). This is strictly O(k) per declaration where k is type params count, piggy-backing on existing traversal.

**Memory:** One `TypeParameterInfo` object per type parameter encountered. Typical file has 0-20 type params. Not a concern.

---

## 6. Decisions and Rationale

### Why `{parentId}:TYPE_PARAMETER:{name}` for ID format?

- Matches the hierarchical pattern: parent contains type param
- Type param names are unique within declaration scope (TS enforces this)
- No need for line/column disambiguation since name is unique within parent

### Why reuse `EXTENDS` for constraints?

- `EXTENDS` already semantically means "is constrained to" or "is a subtype of"
- Used for interface extends, which is the same relationship
- Avoids creating a new edge type for something that IS an extends relationship
- Edge metadata `{ constraintRef: true }` distinguishes from regular EXTENDS if needed

### Why dangling EXTENDS edges?

- Matches existing pattern for interface extends (see `bufferInterfaceNodes`)
- Cross-file resolution happens during enrichment phase
- Same file resolution could be added later as optimization

### Why string representation for constraint/default?

- Matches existing pattern (`TypeNode.aliasOf`, `FunctionNodeRecord.returnType`, etc.)
- `typeNodeToString()` already exists and handles all TSType variants
- Graph nodes store string metadata -- consistent with codebase
- Full AST representation of constraints is not needed for querying

### Why extract in visitors, not in GraphBuilder?

- Follows the established pattern: visitors extract -> GraphBuilder creates nodes
- Visitors already have access to the Babel AST; GraphBuilder only sees collections
- Keeps GraphBuilder focused on graph construction, not AST parsing

---

## 7. Files Changed Summary

| # | File | Change Type | Lines Changed (est.) |
|---|------|------------|---------------------|
| 1 | `packages/types/src/nodes.ts` | Add TYPE_PARAMETER const + record | +15 |
| 2 | `packages/types/src/edges.ts` | Add HAS_TYPE_PARAMETER const | +1 |
| 3 | `packages/core/src/core/nodes/NodeKind.ts` | Add TYPE_PARAMETER const | +1 |
| 4 | `packages/core/src/plugins/analysis/ast/types.ts` | Add TypeParameterInfo + collection field | +18 |
| 5 | `packages/core/src/core/nodes/TypeParameterNode.ts` | NEW: node contract | ~90 |
| 6 | `packages/core/src/core/nodes/index.ts` | Export TypeParameterNode | +1 |
| 7 | `packages/core/src/core/NodeFactory.ts` | Add createTypeParameter + validate entry | +25 |
| 8 | `packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts` | Add extractTypeParameters helper + calls | +80 |
| 9 | `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` | Add type param extraction | +25 |
| 10 | `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` | Add type param extraction | +30 |
| 11 | `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Add bufferTypeParameterNodes + isPrimitiveType | +60 |
| 12 | `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Add collection + metadata | +10 |
| 13 | `packages/core/src/index.ts` | Export TypeParameterNode | +1 |
| 14 | `test/unit/TypeParameterTracking.test.js` | NEW: tests | ~400 |
| | **Total** | | **~757 lines** |

---

## 8. Implementation Order for Kent and Rob

1. **Kent writes unit tests** for TypeParameterNode contract (Step 15, first group)
2. **Rob implements** Steps 1-7 (types, node contract, factory) -- make Kent's unit tests pass
3. **Kent writes unit tests** for `extractTypeParameters()` helper (Step 15, second group)
4. **Rob implements** Steps 8-11 (visitors + GraphBuilder)
5. **Kent writes integration tests** (Step 15, third group)
6. **Rob implements** Steps 12-14 (JSASTAnalyzer metadata, exports) -- make integration tests pass
7. **Run full test suite** to ensure no regressions

Each step is atomic: the codebase compiles and all existing tests pass after each step.
