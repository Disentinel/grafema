# REG-268: Track dynamic imports: import() expressions with isDynamic flag

## Problem

Dynamic `import()` expressions are not tracked in the graph. Only static `import x from 'y'` statements are handled.

```javascript
// Currently tracked
import foo from './foo';

// NOT tracked - invisible in graph
const mod = await import('./dynamic.js');
const config = await import(`./config/${env}.js`);
```

## Why It Matters

* **Lazy loading** - Modern apps use dynamic imports for code splitting
* **Conditional modules** - Runtime-determined module loading is common
* **Plugin systems** - Many architectures use dynamic imports for extensibility
* **Can't see full dependency graph** - Major blind spot for understanding code flow

## Proposed Solution

Track as `IMPORT` node with `isDynamic: true` flag:

```typescript
interface ImportNode {
  // existing fields...
  isDynamic: boolean;       // true for import() expressions
  isResolvable: boolean;    // false if path is a variable/expression
  dynamicPath?: string;     // original dynamic path expression if template literal
}
```

### Resolution Strategy

| Path Type | Example | Resolvable? |
| -- | -- | -- |
| Literal | `import('./foo.js')` | Yes |
| Template (partial) | `import(`./config/${name}.js`)` | Partial (base path known) |
| Variable | `import(modulePath)` | No (flag as dynamic-only) |

## Implementation

1. Handle `ImportExpression` AST node in ImportExportVisitor
2. Create IMPORT node with `isDynamic: true`
3. Create IMPORTS_FROM edge when path is resolvable
4. Add `dynamicPath` metadata for template literals

## Acceptance Criteria

- [ ] `import()` expressions create IMPORT nodes
- [ ] `isDynamic: true` flag set on all dynamic imports
- [ ] Literal paths resolve to IMPORTS_FROM edges
- [ ] Template literal paths captured in metadata
- [ ] Variable paths flagged as unresolvable
- [ ] Tests cover all dynamic import patterns
