# I6 Research: Semantic ID v2 — Stable Identifiers

> Date: 2026-02-11
> Input: Current SemanticId.ts, IdGenerator.ts, ScopeTracker.ts, all visitors
> Status: **РЕШЕНИЕ ПРИНЯТО**

---

## 1. Problem Statement

### Current format (v1)

```
{file}->{scope_path}->{type}->{name}[#discriminator]
```

Example:
```
src/app.js->handler->if#0->CALL->console.log#0
```

### Cascading instability

Scope path contains positional discriminators (`if#0`, `for#1`). Adding an if-block above shifts `if#0` → `if#1`, which **cascades to ALL children** — including named entities inside that scope. This invalidates the claim that "named entities are stable."

```
Before:                                  After adding if-block above:
handler->if#0->FUNCTION->helper   →     handler->if#1->FUNCTION->helper
handler->if#0->CALL->fetch#0      →     handler->if#1->CALL->fetch#0
```

Named function `helper` changed ID despite no semantic change. All edges pointing to it become dangling.

---

## 2. Solution: Semantic ID v2 (TRIZ: separate identity from address)

### Core principle

**Identity = what the node IS. Address = where the node IS.**

Scope path is an address (where in the AST tree). It changes when surrounding structure changes. Remove it from ID entirely. Replace with `namedParent` — the nearest named ancestor (function, class, method). Named ancestors are stable by definition (their name IS their identity).

### New format

```
file->TYPE->name[in:namedParent]                    // базовый
file->TYPE->name[in:namedParent,h:xxxx]             // + content hash при коллизии
file->TYPE->name[in:namedParent,h:xxxx]#N           // + counter при полном дубликате
```

`namedParent` rules:
- Nearest ancestor with type FUNCTION/CLASS/METHOD that has a **non-anonymous** name
- If nearest named ancestor is `anonymous` → skip, take next one up
- Top-level (no named ancestor) → `global`

### Disambiguation strategy

Within a file, all nodes created in single AST pass. When base ID (`file->TYPE->name[in:parent]`) collides:
1. Add content hash `h:xxxx` (4 hex chars from hash of relevant AST subtree)
2. If STILL collides (identical content) → add counter `#N`

Counter `#N` is fundamentally different from old scheme:
- Old: counter in scope PATH → cascades to all children
- New: counter on LEAF node only → no cascade, affects only this node

---

## 3. Complete Node Type Table

### A. Always unique (no disambiguation needed)

| Type | Example ID | Why unique |
|------|-----------|------------|
| Named FUNCTION | `app.js->FUNCTION->processData[in:global]` | Function name unique in JS scope |
| CLASS | `app.js->CLASS->UserService[in:global]` | Class name unique in scope |
| METHOD | `app.js->FUNCTION->login[in:UserService]` | Method name unique in class |
| Getter/Setter | `app.js->FUNCTION->get:name[in:User]` | `get:`/`set:` prefix |
| Private method | `app.js->FUNCTION->#validate[in:User]` | `#name` unique in class |
| Constructor | `app.js->FUNCTION->constructor[in:User]` | One per class |
| INTERFACE | `app.ts->INTERFACE->IUser[in:global]` | Unique in scope |
| TYPE | `app.ts->TYPE->UserId[in:global]` | Unique in scope |
| ENUM | `app.ts->ENUM->Status[in:global]` | Unique in scope |
| IMPORT | `app.js->IMPORT->./db:connection[in:global]` | source+name unique per file |
| EXPORT | `app.js->EXPORT->processData[in:global]` | Export name unique per file |
| EXTERNAL_MODULE | `EXTERNAL_MODULE->lodash` | Global singleton, no file prefix |
| SCOPE body | `app.js->SCOPE->body[in:processData]` | One body per function |
| PARAMETER | `app.js->PARAMETER->userId#0[in:login]` | Index = position in signature (semantic) |

**~55% of all nodes. No collisions possible.**

PARAMETER note: `#0` is parameter position in function signature, not file position. Changes only when signature changes — which IS a semantic change (callers need update).

### B. Usually unique, collision possible

| Type | Base ID | When collision | Hash source |
|------|---------|---------------|-------------|
| VARIABLE | `->VARIABLE->x[in:process]` | Same name in different blocks (shadowing) | Initializer AST |
| CONSTANT | `->CONSTANT->MAX[in:process]` | Same | Initializer AST |
| Arrow→variable | `->FUNCTION->handler[in:global]` | `const handler = () => {}` in different blocks | Function body AST |

**~15% of nodes. Collision requires same name in same named scope, resolved by hash.**

### C. Frequently collide — need hash

| Type | Base ID | Typical collision | Hash source | With hash |
|------|---------|-------------------|-------------|-----------|
| CALL | `->CALL->console.log[in:process]` | Multiple calls to same function | Arguments (stringified) | `->CALL->console.log[in:process,h:a3f2]` |
| METHOD_CALL | `->CALL->this.emit[in:handler]` | Multiple method calls | Arguments | `->CALL->this.emit[in:handler,h:b1c4]` |
| PROPERTY_ACCESS | `->PROPERTY_ACCESS->user.name[in:render]` | Multiple reads | Surrounding statement | `->PROPERTY_ACCESS->user.name[in:render,h:d7e2]` |
| ARRAY_MUTATION | `->ARRAY_MUTATION->items.push[in:collect]` | Multiple mutations | Arguments | with hash |
| OBJECT_MUTATION | `->OBJECT_MUTATION->Object.assign:cfg[in:init]` | Same | Arguments | with hash |
| Anonymous FUNCTION | `->FUNCTION->anonymous[in:handler]` | Multiple callbacks | Function body AST | `->FUNCTION->anonymous[in:handler,h:c3d1]` |
| Static block SCOPE | `->SCOPE->static_block[in:Foo]` | Multiple `static {}` | Block body AST | `->SCOPE->static_block[in:Foo,h:e5f3]` |
| EVENT_LISTENER | `->EVENT_LISTENER->data[in:setup]` | Multiple `.on('data')` | Handler reference | with hash |

**~30% of nodes. Hash resolves 99%+ of collisions. Counter `#N` for remaining 0.1% (identical content duplicates).**

---

## 4. Edge Cases

### 4.1 Nested functions with same name (sloppy mode)
```js
function outer() {
  function helper() { /* v1 */ }
  if (cond) { function helper() { /* v2 */ } }
}
```
Both: `file->FUNCTION->helper[in:outer]` — collision.
Hash of body differs → `[in:outer,h:a1b2]` vs `[in:outer,h:c3d4]` → unique.
Note: strict mode = SyntaxError, not a real concern.

### 4.2 Same variable name, same initializer in different blocks
```js
function process() {
  if (a) { const x = null; }
  if (b) { const x = null; }
}
```
Both: `file->VARIABLE->x[in:process,h:0000]` — collision even with hash.
Fallback: `...#0` and `...#1`.
Probability: extremely low. Same name + same init + different blocks.

### 4.3 for-loop variables
```js
function process() {
  for (const item of list1) { ... }
  for (const item of list2) { ... }
}
```
Both: `file->VARIABLE->item[in:process]` — collision.
Hash of initializer: `list1` vs `list2` → different hash → unique.

### 4.4 Identical callbacks
```js
function retry() {
  [1,2,3].forEach(() => { attempt(); });
  [4,5,6].forEach(() => { attempt(); });
}
```
Both: `file->FUNCTION->anonymous[in:retry,h:same]` — collision (same body).
Fallback: `...#0`, `...#1`. These are leaf nodes, no cascade.

### 4.5 Computed property methods
```js
class Foo {
  [Symbol.iterator]() {}
  [dynamicKey]() {}
}
```
Both: `file->FUNCTION-><computed>[in:Foo]` — collision.
Hash of body → usually different → unique.

### 4.6 IIFE
```js
(function() { setup(); })();
(function() { teardown(); })();
```
Both: `file->FUNCTION->anonymous[in:global]` — collision.
Hash of body → different → unique.

### 4.7 Arrow in ObjectExpression (current limitation)
```js
const handlers = {
  onClick: () => { handleClick(); },
  onHover: () => { handleHover(); }
};
```
FunctionVisitor only checks `parent.type === 'VariableDeclarator'`. Both arrows become `anonymous`.
**Improvement opportunity:** check ObjectProperty parent → use key name (`onClick`, `onHover`).
With hash of body → unique regardless.

### 4.8 Nested anonymous in anonymous
```js
function handler() {
  arr.map(() => {
    arr2.filter(() => { return true; });
  });
}
```
Inner arrow: namedParent rule — skip anonymous ancestors → namedParent = `handler`.
Both anonymous functions have `[in:handler]` — collision → hash of body → unique.

### 4.9 `namedParent` for deep nesting
```js
function outer() {
  const inner = () => {     // named (arrow→variable)
    if (true) {
      for (const x of y) {
        console.log(x);     // namedParent = inner
      }
    }
  };
}
```
Rule: skip if/for/try/while scopes, skip anonymous functions. Take nearest named FUNCTION/CLASS.

### 4.10 Default export anonymous
```js
export default function() { ... }
```
Name = `default`. ID: `file->FUNCTION->default[in:global]`. Unique (one default export per file).

---

## 5. Stability Summary

| Action | Changes ID? | Why |
|--------|------------|-----|
| Add lines above | **No** | No line numbers in ID |
| Rename parent function | **Yes** | `[in:oldName]` → `[in:newName]` for children |
| Add if/for/try block | **No** | Anonymous scopes not in ID |
| Add call to same function above | **Maybe `#N`** | Only if hash also matches (identical calls) |
| Move code between functions | **Yes** | `[in:]` changes — semantic change |
| Add new function | **No** | Doesn't affect existing IDs |
| File rename | **Yes** | File prefix changes — entire file re-analyzed |

**Key achievement:** scope path (`if#0->for#1->`) completely removed. Cascading instability eliminated.

---

## 6. Rename Analysis (unchanged from v1)

Renaming = different ID by design. C4 blast radius handles this:
1. Pre-commit query finds dependents of OLD file
2. CommitBatch tombstones old IDs, creates new ones
3. Dependents re-enriched → edges updated

No special rename detection needed for correctness. Post-MVP optimization: match deleted+added pairs by same nodeType + same contentHash → rename candidate.

---

## 7. Implementation Impact

### Changes to SemanticId.ts

```typescript
// v1 (current)
computeSemanticId(type, name, { file, scopePath }, { discriminator })
// → file->scope1->scope2->TYPE->name#N

// v2 (new)
computeSemanticIdV2(type, name, { file, namedParent }, { contentHash, discriminator })
// → file->TYPE->name[in:namedParent]
// → file->TYPE->name[in:namedParent,h:xxxx]
// → file->TYPE->name[in:namedParent,h:xxxx]#N
```

### Changes to ScopeTracker.ts

New method:
```typescript
getNamedParent(): string {
  // Walk scope stack from top, find nearest non-anonymous FUNCTION/CLASS
  for (let i = this.scopeStack.length - 1; i >= 0; i--) {
    const scope = this.scopeStack[i];
    if ((scope.type === 'FUNCTION' || scope.type === 'CLASS') &&
        scope.name !== 'anonymous' && !scope.name.startsWith('anonymous[')) {
      return scope.name;
    }
  }
  return 'global';
}
```

### Changes to IdGenerator.ts

`generate()` and `generateSimple()` switch to v2 format. `generateLegacy()` unchanged (migration path).

### Collision detection

Single-pass with Set during AST traversal:
```typescript
const usedIds = new Set<string>();

function finalizeId(baseId: string, contentHash: string): string {
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }
  const withHash = `${baseId.slice(0, -1)},h:${contentHash.slice(0,4)}]`;
  if (!usedIds.has(withHash)) {
    usedIds.add(withHash);
    return withHash;
  }
  // Counter fallback
  let n = 0;
  while (usedIds.has(`${withHash}#${n}`)) n++;
  const final = `${withHash}#${n}`;
  usedIds.add(final);
  return final;
}
```

**Important:** when base ID collides, the FIRST node that claimed it must be retroactively promoted to hash level too. This requires deferred finalization or two-pass approach for collision groups.

### Hash computation per node type

| Node type | Hash source |
|-----------|-------------|
| CALL, METHOD_CALL | Stringified arguments AST |
| FUNCTION (anonymous) | Function body AST hash |
| VARIABLE, CONSTANT | Initializer expression AST |
| SCOPE (static_block) | Block body AST hash |
| PROPERTY_ACCESS | Surrounding statement AST |
| ARRAY_MUTATION, OBJECT_MUTATION | Arguments AST |
| EVENT_LISTENER | Handler reference AST |

Hash = first 4 hex chars of xxHash64 of stringified AST subtree.

---

## 8. Migration

v1 → v2 is a **breaking change** for all semantic IDs. Entire graph must be re-analyzed.

This aligns with RFDB v2 migration — new segment format requires fresh analysis anyway. No incremental migration needed.

### Backward compatibility

During transition period, IdGenerator can produce both v1 and v2 IDs. `generateLegacy()` already exists for v1 format. Tests can compare both to verify mapping.

---

## 9. Decision

**Adopt Semantic ID v2 format.** Ship with RFDB v2 (new format requires re-analysis anyway).

Key properties:
- Scope path removed from ID → no cascading instability
- `[in:namedParent]` always present → uniform format
- Content hash for disambiguation → stable for 99.9% of nodes
- Counter `#N` only for identical-content leaf duplicates → no cascade
- `stability_tier` metadata no longer needed (all nodes are effectively Tier 1-2)
