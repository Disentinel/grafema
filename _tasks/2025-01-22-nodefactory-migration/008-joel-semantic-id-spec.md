# Joel Spolsky's Technical Specification: Semantic ID System

## 1. Architecture Overview

### Separation of ID and Location
```
NODE = {
  id: string           // SEMANTIC - stable across reformatting
  location?: Location  // EPHEMERAL - stored separately, may change
}
```

### Semantic ID Format
```
{file}::{scope_path}::{type}::{name}[#discriminator]
```

Components:
- `file` - Relative file path
- `scope_path` - Dot-separated: `MyClass.myMethod.if#1`
- `type` - Node type (FUNCTION, CLASS, CALL, etc.)
- `name` - Entity name
- `discriminator` - Optional: `#N` or `[context]`

### ID Categories

| Category | Node Types | Strategy |
|----------|------------|----------|
| Pure Semantic | MODULE, IMPORT, EXPORT, EXTERNAL_MODULE | Name-based |
| Scope-based | FUNCTION, CLASS, VARIABLE, INTERFACE, TYPE, ENUM | scope::name |
| Counter-based | CALL, LITERAL, SCOPE, EXPRESSION, DECORATOR | scope::name#N |

## 2. Files to Create

### /packages/core/src/core/SemanticId.ts
```typescript
export interface Location {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface ScopeContext {
  file: string;
  scopePath: string[];
}

export interface SemanticIdOptions {
  discriminator?: number;
  context?: string;
}

export function computeSemanticId(
  type: string,
  name: string,
  context: ScopeContext,
  options?: SemanticIdOptions
): string;

export function parseSemanticId(id: string): {...};
export function computeDiscriminator(...): number;
```

### /packages/core/src/core/ScopeTracker.ts
```typescript
export class ScopeTracker {
  constructor(file: string);
  enterScope(name: string, type: string): void;
  enterCountedScope(type: string): { name: string; discriminator: number };
  exitScope(): void;
  getContext(): ScopeContext;
  getItemCounter(itemType: string): number;
}
```

## 3. Node Type ID Formats

### Pure Semantic
- MODULE: `{file}::global::MODULE::module`
- IMPORT: `{file}::global::IMPORT::{source}:{localName}`
- EXPORT: `{file}::global::EXPORT::{exportedName}`
- EXTERNAL_MODULE: `EXTERNAL_MODULE::{moduleName}`

### Scope-based
- FUNCTION: `{file}::{scopePath}::FUNCTION::{name}`
- CLASS: `{file}::{scopePath}::CLASS::{name}`
- METHOD: `{file}::{className}::METHOD::{name}`
- VARIABLE: `{file}::{scopePath}::VARIABLE::{name}`
- INTERFACE/TYPE/ENUM: `{file}::{scopePath}::TYPE::{name}`

### Counter-based
- CALL: `{file}::{scopePath}::CALL::{calleeName}#N`
- SCOPE: `{file}::{parentScope}::SCOPE::{scopeType}#N`
- LITERAL: `{file}::{scopePath}::LITERAL::{valueType}#N`
- EXPRESSION: `{file}::{scopePath}::EXPRESSION::{exprType}#N`
- DECORATOR: `{file}::{targetScope}::DECORATOR::{name}#N`

### Singletons
- net:stdio: `net:stdio::__stdio__`
- net:request: `net:request::__network__`

## 4. NodeFactory Changes

**Current:**
```typescript
static createFunction(name: string, file: string, line: number, column: number, options = {})
```

**New:**
```typescript
static createFunction(name: string, context: ScopeContext, location: Location, options = {})
```

## 5. Migration Strategy

1. Create SemanticId.ts and ScopeTracker.ts
2. Update node contracts to accept ScopeContext + Location
3. Update NodeFactory methods
4. Update analyzers with scope tracking
5. Clear database (`grafema db:clear`)

## 6. ID Comparison

| Current (Position) | New (Semantic) |
|--------------------|----------------|
| `src/app.js:FUNCTION:foo:42:5` | `src/app.js::global::FUNCTION::foo` |
| `src/app.js:CALL_SITE:log:45:10` | `src/app.js::foo::CALL::console.log#0` |

Benefits: Stable across reformatting, clear scope hierarchy, reliable incremental analysis.
