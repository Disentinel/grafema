# Joel Spolsky - Revised Semantic ID Specification

## 1. ID Format

### Separator: `->`

Changed from `::` to `->` for clarity and visual hierarchy.

```
{file}->{scope_path}->{type}->{name}[#discriminator]
```

Examples:
```
src/app.js->global->FUNCTION->processData
src/app.js->UserService->METHOD->login
src/app.js->handler->if#1->CALL->console.log#2
```

### Why `->`?

- Visually indicates scope traversal (like navigation)
- Unambiguous - never appears in JS identifiers
- Easy to split: `id.split('->')`
- Readable in logs and debugging

---

## 2. ID Categories

| Category | Node Types | Strategy |
|----------|------------|----------|
| Pure Semantic | MODULE, IMPORT, EXPORT, EXTERNAL_MODULE | name-based, unique by definition |
| Scope-based | FUNCTION, CLASS, VARIABLE, INTERFACE, TYPE, ENUM | `scope->name` |
| Counter-based | CALL, SCOPE, LITERAL, EXPRESSION, DECORATOR | `scope->name#N` |
| Singletons | net:stdio, net:request | fixed string |

---

## 3. Detailed ID Formats

### Pure Semantic

```
MODULE:        {file}->global->MODULE->module
IMPORT:        {file}->global->IMPORT->{source}:{localName}
EXPORT:        {file}->global->EXPORT->{exportedName}
EXTERNAL:      EXTERNAL_MODULE->{moduleName}
```

### Scope-based

```
FUNCTION:      {file}->{scopePath}->FUNCTION->{name}
CLASS:         {file}->{scopePath}->CLASS->{name}
METHOD:        {file}->{className}->METHOD->{name}
VARIABLE:      {file}->{scopePath}->VARIABLE->{name}
INTERFACE:     {file}->{scopePath}->INTERFACE->{name}
TYPE:          {file}->{scopePath}->TYPE->{name}
ENUM:          {file}->{scopePath}->ENUM->{name}
```

### Counter-based

```
CALL:          {file}->{scopePath}->CALL->{calleeName}#N
SCOPE:         {file}->{scopePath}->SCOPE->{scopeType}#N
LITERAL:       {file}->{scopePath}->LITERAL->{valueType}#N
EXPRESSION:    {file}->{scopePath}->EXPRESSION->{exprType}#N
DECORATOR:     {file}->{scopePath}->DECORATOR->{name}#N
```

### Singletons

```
net:stdio:     net:stdio->__stdio__
net:request:   net:request->__network__
```

---

## 4. ScopeTracker Design

```typescript
// /packages/core/src/core/ScopeTracker.ts

export interface ScopeContext {
  file: string;
  scopePath: string[];      // ['MyClass', 'myMethod', 'if#1']
}

export interface Location {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export class ScopeTracker {
  private file: string;
  private scopeStack: ScopeEntry[] = [];
  private counters: Map<string, number> = new Map();

  constructor(file: string) {
    this.file = file;
  }

  // === Scope Management ===

  enterScope(name: string, type: string): void {
    this.scopeStack.push({ name, type });
  }

  enterCountedScope(type: string): { name: string; discriminator: number } {
    const key = this.counterKey(type);
    const n = this.counters.get(key) || 0;
    this.counters.set(key, n + 1);

    const name = `${type}#${n}`;
    this.scopeStack.push({ name, type, counter: n });
    return { name, discriminator: n };
  }

  exitScope(): void {
    this.scopeStack.pop();
  }

  // === ID Generation ===

  getContext(): ScopeContext {
    return {
      file: this.file,
      scopePath: this.scopeStack.map(s => s.name)
    };
  }

  getScopePath(): string {
    if (this.scopeStack.length === 0) return 'global';
    return this.scopeStack.map(s => s.name).join('->');
  }

  // === Counter Management ===

  /**
   * Get next counter for item type within current scope.
   * Used for CALL, LITERAL, etc. that need #N discriminators.
   */
  getItemCounter(itemType: string): number {
    const key = this.counterKey(itemType);
    const n = this.counters.get(key) || 0;
    this.counters.set(key, n + 1);
    return n;
  }

  /**
   * Get current count without incrementing.
   * Used to check for collisions.
   */
  peekItemCounter(itemType: string): number {
    return this.counters.get(this.counterKey(itemType)) || 0;
  }

  // === Sibling Tracking ===

  /**
   * Track siblings by name within current scope.
   * Used for anonymous functions: anonymous[0], anonymous[1]
   */
  getSiblingIndex(name: string): number {
    const key = `${this.getScopePath()}:sibling:${name}`;
    const n = this.counters.get(key) || 0;
    this.counters.set(key, n + 1);
    return n;
  }

  // === Private ===

  private counterKey(itemType: string): string {
    return `${this.getScopePath()}:${itemType}`;
  }
}

interface ScopeEntry {
  name: string;
  type: string;
  counter?: number;
}
```

---

## 5. SemanticId Module

```typescript
// /packages/core/src/core/SemanticId.ts

import type { ScopeContext, Location } from './ScopeTracker';

export interface SemanticIdOptions {
  discriminator?: number;
  context?: string;  // for special cases like [in:else-block]
}

/**
 * Compute semantic ID for any node type.
 */
export function computeSemanticId(
  type: string,
  name: string,
  context: ScopeContext,
  options?: SemanticIdOptions
): string {
  const { file, scopePath } = context;
  const scope = scopePath.length > 0 ? scopePath.join('->') : 'global';

  let id = `${file}->${scope}->${type}->${name}`;

  if (options?.discriminator !== undefined) {
    id += `#${options.discriminator}`;
  } else if (options?.context) {
    id += `[${options.context}]`;
  }

  return id;
}

/**
 * Parse semantic ID back to components.
 */
export function parseSemanticId(id: string): {
  file: string;
  scopePath: string[];
  type: string;
  name: string;
  discriminator?: number;
  context?: string;
} | null {
  // Handle singletons
  if (id.startsWith('net:stdio') || id.startsWith('net:request')) {
    const [prefix, name] = id.split('->');
    return { file: '', scopePath: [prefix], type: 'SINGLETON', name, discriminator: undefined };
  }

  if (id.startsWith('EXTERNAL_MODULE')) {
    const [, name] = id.split('->');
    return { file: '', scopePath: [], type: 'EXTERNAL_MODULE', name, discriminator: undefined };
  }

  const parts = id.split('->');
  if (parts.length < 4) return null;

  const file = parts[0];
  const type = parts[parts.length - 2];
  let name = parts[parts.length - 1];
  const scopePath = parts.slice(1, -2);

  // Parse discriminator or context
  let discriminator: number | undefined;
  let context: string | undefined;

  const hashMatch = name.match(/^(.+)#(\d+)$/);
  if (hashMatch) {
    name = hashMatch[1];
    discriminator = parseInt(hashMatch[2], 10);
  }

  const bracketMatch = name.match(/^(.+)\[(.+)\]$/);
  if (bracketMatch) {
    name = bracketMatch[1];
    context = bracketMatch[2];
  }

  return { file, scopePath, type, name, discriminator, context };
}
```

---

## 6. Edge Cases

### 6.1 Anonymous Functions

Use sibling counter within scope:

```javascript
// Source
[1, 2].map(() => {});
[3, 4].filter(() => {});
```

IDs:
```
file.js->global->FUNCTION->anonymous[0]
file.js->global->FUNCTION->anonymous[1]
```

Implementation:
```typescript
const name = node.id?.name || `anonymous[${tracker.getSiblingIndex('anonymous')}]`;
```

### 6.2 Nested Anonymous Functions

Each scope level tracks its own siblings:

```javascript
outer(() => {
  inner(() => {});
  inner(() => {});
});
```

IDs:
```
file.js->global->FUNCTION->anonymous[0]              // outer callback
file.js->anonymous[0]->FUNCTION->anonymous[0]        // first inner
file.js->anonymous[0]->FUNCTION->anonymous[1]        // second inner
```

### 6.3 Variable Shadowing

Same-named variables in different scopes get different IDs naturally:

```javascript
function outer() {
  const x = 1;
  if (true) {
    const x = 2;  // Different scope
  }
}
```

IDs:
```
file.js->outer->VARIABLE->x
file.js->outer->if#0->VARIABLE->x
```

### 6.4 Renamed Variables (Destructuring)

Use the local name, not the imported name:

```javascript
import { foo as bar } from 'module';
const { a: b } = obj;
```

IDs:
```
file.js->global->IMPORT->module:bar
file.js->global->VARIABLE->b
```

### 6.5 Multiple Calls to Same Function

Counter-based within scope:

```javascript
function test() {
  console.log('a');
  console.log('b');
  console.log('c');
}
```

IDs:
```
file.js->test->CALL->console.log#0
file.js->test->CALL->console.log#1
file.js->test->CALL->console.log#2
```

### 6.6 Control Flow Scopes

```javascript
function process(x) {
  if (x > 0) {
    log('positive');
  } else {
    log('non-positive');
  }
  if (x === 0) {
    log('zero');
  }
}
```

IDs:
```
file.js->process->if#0->CALL->log#0       // positive
file.js->process->else#0->CALL->log#0     // non-positive
file.js->process->if#1->CALL->log#0       // zero
```

---

## 7. Migration Strategy

### Atomic Cleanup Approach

1. **Clear all data before migration**
   - Run `grafema db:clear` before deploying new ID format
   - Re-analyze entire codebase with new IDs
   - No migration scripts, no dual-format support

2. **Why this approach?**
   - Grafema is in active development, not production
   - Old IDs are meaningless with new format
   - Clean slate prevents ID collision bugs
   - Simpler than migration logic

### Migration Steps

```bash
# 1. Stop any running analysis
# 2. Clear existing data
grafema db:clear

# 3. Deploy code with new Semantic ID system
# 4. Re-analyze
grafema analyze /path/to/project
```

---

## 8. Incremental Rollout Plan

### Phase 1: Core Infrastructure (This Sprint)

1. Create `/packages/core/src/core/SemanticId.ts`
2. Create `/packages/core/src/core/ScopeTracker.ts`
3. Write tests for both modules

### Phase 2: FUNCTION, CALL, SCOPE Nodes

1. Update `FunctionNode.ts` to use SemanticId
2. Update `CallSiteNode.ts` to use SemanticId
3. Update `ScopeNode.ts` to use SemanticId
4. Update `FunctionVisitor.ts` with ScopeTracker
5. Update `CallExpressionVisitor.ts` with ScopeTracker

### Phase 3: Remaining Node Types

1. Update CLASS, METHOD, VARIABLE nodes
2. Update IMPORT, EXPORT, EXTERNAL_MODULE nodes
3. Update INTERFACE, TYPE, ENUM nodes
4. Update LITERAL, EXPRESSION, DECORATOR nodes

### Phase 4: GraphBuilder Integration

1. Update GraphBuilder to pass ScopeContext
2. Remove line-based ID generation
3. Update all visitors

### Phase 5: Cleanup

1. Remove old ID generation code
2. Update documentation
3. Clear database and re-analyze test projects

---

## 9. Implementation Checklist

### Files to Create

- [ ] `/packages/core/src/core/SemanticId.ts`
- [ ] `/packages/core/src/core/ScopeTracker.ts`
- [ ] `/packages/core/test/unit/SemanticId.test.ts`
- [ ] `/packages/core/test/unit/ScopeTracker.test.ts`

### Files to Modify

- [ ] All node contracts in `/packages/core/src/core/nodes/`
- [ ] `/packages/core/src/core/NodeFactory.ts`
- [ ] All visitors in `/packages/core/src/plugins/analysis/ast/visitors/`
- [ ] `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### Tests to Add

- [ ] Semantic ID computation for all node types
- [ ] ScopeTracker scope enter/exit
- [ ] ScopeTracker counter management
- [ ] Anonymous function naming
- [ ] Variable shadowing handling
- [ ] ID parsing and validation

---

## 10. Example: Full Trace

Input file `src/handlers/user.js`:

```javascript
import { db } from './database';

export function getUser(id) {
  const user = db.findById(id);
  if (user) {
    console.log('Found user');
    return user;
  }
  console.log('User not found');
  return null;
}
```

Generated IDs:

```
src/handlers/user.js->global->MODULE->module
src/handlers/user.js->global->IMPORT->./database:db
src/handlers/user.js->global->EXPORT->getUser
src/handlers/user.js->global->FUNCTION->getUser
src/handlers/user.js->getUser->VARIABLE->user
src/handlers/user.js->getUser->CALL->db.findById#0
src/handlers/user.js->getUser->SCOPE->if#0
src/handlers/user.js->getUser->if#0->CALL->console.log#0
src/handlers/user.js->getUser->CALL->console.log#1
```

Note: The second `console.log` is in getUser scope (after if block), not in if#0 scope.

---

## 11. Open Questions (For Review)

1. **else blocks**: Should `else` be a separate scope type or part of the `if`?
   - Current proposal: `else#N` as separate scope

2. **try/catch/finally**: Three scopes or one?
   - Current proposal: `try#N`, `catch#N`, `finally#N`

3. **switch statements**: Scope per case or one scope?
   - Current proposal: `switch#N` with `case#M` children

4. **Object method shorthand**:
   ```javascript
   const obj = { method() {} }
   ```
   - Current proposal: `obj->METHOD->method` (treat as method of object literal)
