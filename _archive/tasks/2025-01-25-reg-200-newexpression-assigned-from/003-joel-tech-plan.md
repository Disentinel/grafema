# Joel Spolsky: REG-200 Technical Specification

## Overview

This specification details the implementation of CONSTRUCTOR_CALL nodes and ASSIGNED_FROM edges for `new` expressions in Grafema. The fix ensures that variables initialized with constructor calls (both user-defined classes and built-in constructors like Date, Map, Set) have proper data flow edges.

**Key Changes:**
1. New `ConstructorCallNode` contract in `packages/core/src/core/nodes/`
2. New `BuiltinConstructorNode` contract for language built-ins
3. Updated `VariableAssignmentInfo` type with CONSTRUCTOR_CALL sourceType
4. Updated `JSASTAnalyzer.trackVariableAssignment()` to emit CONSTRUCTOR_CALL
5. Updated `GraphBuilder.bufferAssignmentEdges()` to create nodes and edges
6. Updated `NodeFactory` with factory methods
7. Tests in `test/unit/DataFlowTracking.test.js`

## Type Definitions

### packages/core/src/core/nodes/ConstructorCallNode.ts (NEW FILE)

```typescript
/**
 * ConstructorCallNode - contract for CONSTRUCTOR_CALL node
 *
 * Represents a `new ClassName()` expression.
 * Used for data flow tracking - ASSIGNED_FROM edges point to this node.
 *
 * ID format: {file}:CONSTRUCTOR_CALL:{className}:{line}:{column}
 * Example: src/app.js:CONSTRUCTOR_CALL:Date:10:15
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ConstructorCallNodeRecord extends BaseNodeRecord {
  type: 'CONSTRUCTOR_CALL';
  className: string;       // The constructor name (Date, Map, MyClass, etc.)
  column: number;
  isBuiltin?: boolean;     // true for Date, Map, Set, etc.
  parentScopeId?: string;
}

interface ConstructorCallNodeOptions {
  parentScopeId?: string;
  isBuiltin?: boolean;
  counter?: number;
}

export class ConstructorCallNode {
  static readonly TYPE = 'CONSTRUCTOR_CALL' as const;

  static readonly REQUIRED = ['name', 'className', 'file', 'line'] as const;
  static readonly OPTIONAL = ['column', 'parentScopeId', 'isBuiltin'] as const;

  /**
   * Built-in JavaScript constructors that don't have CLASS nodes
   */
  static readonly BUILTIN_CONSTRUCTORS = new Set([
    // Core types
    'Date', 'RegExp', 'Error', 'Function',
    // Collections
    'Array', 'Object', 'Map', 'Set', 'WeakMap', 'WeakSet',
    // Typed arrays
    'ArrayBuffer', 'DataView', 'SharedArrayBuffer',
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
    'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
    'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
    // Wrappers
    'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
    // Errors
    'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
    'URIError', 'EvalError', 'AggregateError',
    // Async
    'Promise', 'Proxy', 'Reflect',
    // URL/Web
    'URL', 'URLSearchParams', 'Headers', 'Request', 'Response',
    'FormData', 'Blob', 'File', 'FileReader',
    // Streams
    'ReadableStream', 'WritableStream', 'TransformStream',
    // Intl
    'Intl.Collator', 'Intl.DateTimeFormat', 'Intl.NumberFormat',
    'Intl.PluralRules', 'Intl.RelativeTimeFormat'
  ]);

  static isBuiltinConstructor(className: string): boolean {
    return this.BUILTIN_CONSTRUCTORS.has(className);
  }

  static create(
    className: string,
    file: string,
    line: number,
    column: number,
    options: ConstructorCallNodeOptions = {}
  ): ConstructorCallNodeRecord {
    if (!className) throw new Error('ConstructorCallNode.create: className is required');
    if (!file) throw new Error('ConstructorCallNode.create: file is required');
    if (line === undefined) throw new Error('ConstructorCallNode.create: line is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:CONSTRUCTOR_CALL:${className}:${line}:${column || 0}${counter}`;
    const isBuiltin = options.isBuiltin ?? this.isBuiltinConstructor(className);

    return {
      id,
      type: this.TYPE,
      name: `new ${className}()`,
      className,
      file,
      line,
      column: column || 0,
      parentScopeId: options.parentScopeId,
      isBuiltin
    };
  }

  static generateId(className: string, file: string, line: number, column: number): string {
    return `${file}:CONSTRUCTOR_CALL:${className}:${line}:${column || 0}`;
  }

  static validate(node: ConstructorCallNodeRecord): string[] {
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

export type { ConstructorCallNodeRecord };
```

### packages/core/src/core/nodes/BuiltinConstructorNode.ts (NEW FILE)

```typescript
/**
 * BuiltinConstructorNode - contract for BUILTIN_JS node
 *
 * Singleton nodes representing JavaScript built-in constructors.
 * One node per constructor type (Date, Map, Set, etc.).
 *
 * ID format: BUILTIN_JS:{constructorName}
 * Example: BUILTIN_JS:Date, BUILTIN_JS:Map
 *
 * User decision: Language-namespaced format for multi-language support.
 * Future: BUILTIN_TS:ReadonlyArray, BUILTIN_PHP:DateTime
 */

import type { BaseNodeRecord } from '@grafema/types';

interface BuiltinConstructorNodeRecord extends BaseNodeRecord {
  type: 'BUILTIN_JS';
  language: 'js';  // For future multi-language support
}

export class BuiltinConstructorNode {
  static readonly TYPE = 'BUILTIN_JS' as const;

  static readonly REQUIRED = ['name'] as const;
  static readonly OPTIONAL = [] as const;

  /**
   * Create BUILTIN_JS node (singleton)
   *
   * @param constructorName - Built-in constructor name (Date, Map, etc.)
   * @returns BuiltinConstructorNodeRecord
   */
  static create(constructorName: string): BuiltinConstructorNodeRecord {
    if (!constructorName) throw new Error('BuiltinConstructorNode.create: constructorName is required');

    return {
      id: `BUILTIN_JS:${constructorName}`,
      type: this.TYPE,
      name: constructorName,
      file: '',  // Built-ins have no file
      line: 0,
      language: 'js'
    };
  }

  static validate(node: BuiltinConstructorNodeRecord): string[] {
    const errors: string[] = [];

    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }

    if (!node.name) {
      errors.push('Missing required field: name');
    }

    return errors;
  }
}

export type { BuiltinConstructorNodeRecord };
```

### packages/core/src/plugins/analysis/ast/types.ts (UPDATE)

Add new interface and update existing:

```typescript
// === CONSTRUCTOR CALL INFO === (NEW)
/**
 * Information about a NewExpression assignment.
 * Collected by JSASTAnalyzer, processed by GraphBuilder.
 */
export interface ConstructorCallInfo {
  id: string;
  type: 'CONSTRUCTOR_CALL';
  className: string;
  file: string;
  line: number;
  column: number;
  parentScopeId?: string;
  isBuiltin: boolean;
}

// Update VariableAssignmentInfo sourceType union:
export interface VariableAssignmentInfo {
  variableId: string;
  sourceId?: string | null;
  // Add 'CONSTRUCTOR_CALL' to the sourceType union
  sourceType: 'LITERAL' | 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'FUNCTION'
            | 'EXPRESSION' | 'CLASS' | 'CONSTRUCTOR_CALL' | 'DERIVES_FROM_VARIABLE';
  // ... rest of existing fields ...
  // NEW fields for CONSTRUCTOR_CALL:
  constructorCallId?: string;
  isBuiltinConstructor?: boolean;
}

// Update ASTCollections:
export interface ASTCollections {
  // ... existing fields ...
  constructorCalls?: ConstructorCallInfo[];  // NEW
}
```

## Implementation Steps

### Step 1: Create ConstructorCallNode.ts

Create file: `packages/core/src/core/nodes/ConstructorCallNode.ts`

Content: As specified in Type Definitions section above.

### Step 2: Create BuiltinConstructorNode.ts

Create file: `packages/core/src/core/nodes/BuiltinConstructorNode.ts`

Content: As specified in Type Definitions section above.

### Step 3: Update nodes/index.ts

Add exports to `packages/core/src/core/nodes/index.ts`:

```typescript
export { ConstructorCallNode, type ConstructorCallNodeRecord } from './ConstructorCallNode.js';
export { BuiltinConstructorNode, type BuiltinConstructorNodeRecord } from './BuiltinConstructorNode.js';
```

### Step 4: Update NodeFactory.ts

Add factory methods for createConstructorCall(), generateConstructorCallId(), isBuiltinConstructor(), createBuiltinConstructor().

### Step 5: Update JSASTAnalyzer.trackVariableAssignment()

Update NewExpression handling (lines 668-680) to emit CONSTRUCTOR_CALL sourceType with location info.

### Step 6: Update GraphBuilder.bufferAssignmentEdges()

Add handling for CONSTRUCTOR_CALL sourceType - create node and ASSIGNED_FROM edge.

### Step 7: Update types.ts

Add ConstructorCallInfo interface and update VariableAssignmentInfo.

### Step 8: Update packages/types/src/nodes.ts

Add CONSTRUCTOR_CALL and BUILTIN_JS to NODE_TYPE constant.

## ID Format Specifications

### CONSTRUCTOR_CALL Node ID

**Format:** `{file}:CONSTRUCTOR_CALL:{className}:{line}:{column}[:{counter}]`

**Examples:**
- `src/app.js:CONSTRUCTOR_CALL:Date:10:15`
- `src/app.js:CONSTRUCTOR_CALL:Map:25:8`
- `src/app.js:CONSTRUCTOR_CALL:Database:42:10`

### BUILTIN_JS Node ID

**Format:** `BUILTIN_JS:{constructorName}`

**Examples:**
- `BUILTIN_JS:Date`
- `BUILTIN_JS:Map`
- `BUILTIN_JS:Set`

## Edge Relationships

```
VARIABLE
    |
    | ASSIGNED_FROM
    v
CONSTRUCTOR_CALL (new Date())
    |
    | INVOKES
    v
BUILTIN_JS:Date  (singleton)
```

For user-defined classes:
```
VARIABLE
    |
    | ASSIGNED_FROM
    v
CONSTRUCTOR_CALL (new MyClass())
    |
    | INVOKES (optional, created in enrichment if CLASS exists)
    v
CLASS:MyClass
```

## Test Scenarios

1. Built-in Constructor Assignment (Date) - `const date = new Date()`
2. Built-in Constructor Assignment (Map) - `const cache = new Map()`
3. User-defined Class Constructor - `class Database {}; const db = new Database()`
4. Multiple Constructors Same File - distinct nodes, shared singletons
5. Data Flow Trace Query - trace where variable value comes from
6. Nested NewExpression - `new Wrapper(new Inner())`

## Files to Modify Summary

| File | Action |
|------|--------|
| `packages/core/src/core/nodes/ConstructorCallNode.ts` | CREATE |
| `packages/core/src/core/nodes/BuiltinConstructorNode.ts` | CREATE |
| `packages/core/src/core/nodes/index.ts` | MODIFY |
| `packages/core/src/core/NodeFactory.ts` | MODIFY |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | MODIFY |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | MODIFY |
| `packages/core/src/plugins/analysis/ast/types.ts` | MODIFY |
| `packages/types/src/nodes.ts` | MODIFY |
| `test/unit/DataFlowTracking.test.js` | MODIFY |
