# RFD-4: Semantic ID v2 -- Joel Spolsky Technical Specification

## 0. Don's Open Question: Resolution

**Don asks:** Should `mutationScopePath` / `valueScopePath` be (a) kept as full paths or (b) simplified to named-parent-only?

**Answer: (a) Keep full paths.** Confirmed after code review.

The scope resolution in GraphBuilder (`resolveVariableInScope`, `resolveParameterInScope`) does scope-chain walking: it tries `scopePath[0..n]`, then `scopePath[0..n-1]`, etc. This models JavaScript lexical scoping correctly. It needs the full anonymous scope path (including `if#0`, `try#1`) because a variable declared inside `if#0` should NOT be visible outside it.

If we simplified to named-parent-only, we'd lose the ability to distinguish between:
```javascript
function fetchData() {
  if (a) { const x = 1; }  // x visible only in if#0
  if (b) { use(x); }       // x NOT visible here
}
```

Both `x` and `use(x)` have the same `namedParent` = `fetchData`. Without the full scope path, resolution would incorrectly resolve `x` across block boundaries.

**The ID format and the resolution scope path solve DIFFERENT problems. Don't conflate them.**

---

## 1. Phase 1: Core ID Functions

### Files Changed
- `packages/core/src/core/SemanticId.ts`

### New Types

```typescript
/**
 * Parsed v2 semantic ID components.
 *
 * v2 format: file->TYPE->name[in:namedParent,h:xxxx]#N
 */
export interface ParsedSemanticIdV2 {
  file: string;
  type: string;
  name: string;
  namedParent?: string;   // from [in:...], undefined for top-level
  contentHash?: string;   // from [h:xxxx], 4-hex chars
  counter?: number;       // from #N suffix
}

/**
 * Content hint data for computing content hash.
 * Each node type supplies different hints.
 */
export interface ContentHashHints {
  /** Number of arguments (CALL) or parameters (FUNCTION) */
  arity?: number;
  /** First literal argument value (CALL) */
  firstLiteralArg?: string;
  /** First parameter name (FUNCTION) */
  firstParamName?: string;
  /** RHS expression type (VARIABLE/CONSTANT) */
  rhsType?: string;
  /** First significant token of RHS (VARIABLE/CONSTANT) */
  rhsToken?: string;
  /** Object expression chain (PROPERTY_ACCESS) */
  objectChain?: string;
}
```

### New Functions

#### `computeSemanticIdV2()`

```typescript
/**
 * Compute v2 semantic ID.
 *
 * Format: file->TYPE->name                           (top-level, no collision)
 * Format: file->TYPE->name[in:parent]                (nested, no collision)
 * Format: file->TYPE->name[in:parent,h:xxxx]         (collision, hash disambiguates)
 * Format: file->TYPE->name[in:parent,h:xxxx]#N       (hash collision, counter)
 *
 * @param type - Node type (FUNCTION, CALL, VARIABLE, etc.)
 * @param name - Node name
 * @param file - Source file path
 * @param namedParent - Nearest named ancestor (undefined for top-level)
 * @param contentHash - 4-hex content hash (set by CollisionResolver)
 * @param counter - Counter for hash collisions (set by CollisionResolver)
 */
export function computeSemanticIdV2(
  type: string,
  name: string,
  file: string,
  namedParent?: string,
  contentHash?: string,
  counter?: number
): string {
  // Build bracket content
  const brackets: string[] = [];
  if (namedParent) brackets.push(`in:${namedParent}`);
  if (contentHash) brackets.push(`h:${contentHash}`);

  let id = `${file}->${type}->${name}`;
  if (brackets.length > 0) {
    id += `[${brackets.join(',')}]`;
  }
  if (counter !== undefined && counter > 0) {
    id += `#${counter}`;
  }
  return id;
}
```

**Complexity:** O(1) -- string concatenation only.

**Edge cases:**
- `namedParent` undefined + no hash + no counter = simplest form: `file->TYPE->name`
- `namedParent` present + no hash = `file->TYPE->name[in:parent]`
- Counter = 0 is omitted (first item doesn't need counter, only #1, #2, etc.)
- `name` may contain dots (e.g., `console.log`) -- this is fine, the `->` delimiter is unambiguous

#### `parseSemanticIdV2()`

```typescript
/**
 * Parse v2 semantic ID back to components.
 *
 * Handles both v2 format: file->TYPE->name[in:parent,h:xxxx]#N
 * and special formats: net:stdio->__stdio__, EXTERNAL_MODULE->lodash
 *
 * @returns Parsed components or null if invalid
 */
export function parseSemanticIdV2(id: string): ParsedSemanticIdV2 | null {
  // Handle singletons (unchanged)
  if (id.startsWith('net:stdio') || id.startsWith('net:request')) {
    const [prefix, name] = id.split('->');
    return { file: '', type: 'SINGLETON', name };
  }
  if (id.startsWith('EXTERNAL_MODULE')) {
    const [, name] = id.split('->');
    return { file: '', type: 'EXTERNAL_MODULE', name };
  }

  // v2 format: file->TYPE->name[in:parent,h:xxxx]#N
  const parts = id.split('->');
  if (parts.length < 3) return null;

  const file = parts[0];
  const type = parts[1];
  let nameRaw = parts.slice(2).join('->');  // Rejoin in case name has ->

  // Parse counter suffix: #N (only at the very end, after brackets)
  let counter: number | undefined;
  const counterMatch = nameRaw.match(/^(.+)#(\d+)$/);
  if (counterMatch) {
    nameRaw = counterMatch[1];
    counter = parseInt(counterMatch[2], 10);
  }

  // Parse bracket content: [in:parent,h:xxxx]
  let namedParent: string | undefined;
  let contentHash: string | undefined;
  let name = nameRaw;

  const bracketMatch = nameRaw.match(/^(.+)\[(.+)\]$/);
  if (bracketMatch) {
    name = bracketMatch[1];
    const bracketContent = bracketMatch[2];

    for (const part of bracketContent.split(',')) {
      const [key, value] = part.split(':');
      if (key === 'in') namedParent = value;
      else if (key === 'h') contentHash = value;
    }
  }

  return { file, type, name, namedParent, contentHash, counter };
}
```

**Complexity:** O(n) where n = ID string length.

**Edge cases:**
- Names with dots: `console.log` -- the `->` split handles this because dots aren't delimiters
- Names with colons: `new:ClassName` -- bracket parsing uses position of `[` so inner colons in `name` are safe
- Names with brackets in name part: extremely unlikely, but `[` split takes the LAST bracket match (greedy `.+`)
- v1 IDs passed to v2 parser: will parse incorrectly (4+ parts with scopePath). **We do NOT handle v1 in the v2 parser.** Callers must know which version they're using.

**IMPORTANT: The `name` part may itself contain `->` in theory (e.g., if someone named a variable `a->b`). In practice this never happens in JavaScript/TypeScript. The parser splits on `->` and takes first part as file, second as type, remainder as name. This matches v1 behavior.**

Actually, wait. Let me reconsider. Names like `console.log` do NOT contain `->`. The only `->` in a v2 ID are: `file->TYPE->name[...]#N`. So there are exactly two `->` delimiters. Parts[0] = file, parts[1] = type, parts[2] = everything else.

#### `computeContentHash()`

```typescript
/**
 * FNV-1a hash function, returns 4-hex-char string.
 *
 * FNV-1a is simple, fast, and has good distribution for short strings.
 * 4 hex chars = 16 bits = 65536 buckets. Collision probability:
 * - 10 same-name items: ~0.07%
 * - 100 same-name items: ~7%
 * - 400 same-name items: ~70%
 *
 * In practice, you rarely have >10 identical calls in one function.
 * Counter (#N) handles the rare hash collisions.
 *
 * @param hints - Content data to hash
 * @returns 4-char hex string (e.g., "a1b2")
 */
export function computeContentHash(hints: ContentHashHints): string {
  // Build deterministic string from hints
  const parts: string[] = [];
  if (hints.arity !== undefined) parts.push(`a:${hints.arity}`);
  if (hints.firstLiteralArg !== undefined) parts.push(`l:${hints.firstLiteralArg}`);
  if (hints.firstParamName !== undefined) parts.push(`p:${hints.firstParamName}`);
  if (hints.rhsType !== undefined) parts.push(`r:${hints.rhsType}`);
  if (hints.rhsToken !== undefined) parts.push(`t:${hints.rhsToken}`);
  if (hints.objectChain !== undefined) parts.push(`o:${hints.objectChain}`);

  const input = parts.join('|');

  // FNV-1a 32-bit
  let hash = 0x811c9dc5;  // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);  // FNV prime
  }

  // Truncate to 16 bits, format as 4-hex
  const truncated = (hash >>> 0) & 0xFFFF;
  return truncated.toString(16).padStart(4, '0');
}
```

**Complexity:** O(k) where k = total length of hint strings. Typically <50 chars.

**Edge cases:**
- Empty hints (no fields set): hashes empty string. Still produces a valid 4-hex hash.
- `firstLiteralArg` with special characters: fine, FNV-1a handles any bytes.
- `Math.imul` handles 32-bit integer overflow correctly in JavaScript.

### Exports

Add to `packages/core/src/index.ts`:
```typescript
export {
  computeSemanticIdV2,
  parseSemanticIdV2,
  computeContentHash
} from './core/SemanticId.js';
export type { ParsedSemanticIdV2, ContentHashHints } from './core/SemanticId.js';
```

### Tests (file: `test/unit/SemanticIdV2.test.js`)

| Test name | What it verifies |
|-----------|-----------------|
| `computeSemanticIdV2 - top-level function` | `src/app.js->FUNCTION->processData` (no brackets) |
| `computeSemanticIdV2 - nested method` | `src/app.js->FUNCTION->login[in:UserService]` |
| `computeSemanticIdV2 - with content hash` | `src/app.js->CALL->console.log[in:processData,h:a1b2]` |
| `computeSemanticIdV2 - with hash and counter` | `...->CALL->console.log[in:processData,h:a1b2]#1` |
| `computeSemanticIdV2 - counter 0 omitted` | No `#0` suffix |
| `computeSemanticIdV2 - top-level constant (no parent)` | `config.js->CONSTANT->API_URL` |
| `parseSemanticIdV2 - round-trip all variants` | parse(compute(...)) preserves all fields |
| `parseSemanticIdV2 - singleton format` | `net:stdio->__stdio__` returns singleton |
| `parseSemanticIdV2 - external module` | `EXTERNAL_MODULE->lodash` returns correctly |
| `parseSemanticIdV2 - v2 with all fields` | All 5 fields extracted |
| `parseSemanticIdV2 - v2 minimal` | Only file, type, name |
| `parseSemanticIdV2 - name with dots` | `console.log` preserved in name |
| `parseSemanticIdV2 - invalid (too few parts)` | Returns null |
| `computeContentHash - deterministic` | Same hints = same hash |
| `computeContentHash - different inputs differ` | Different hints = different hash |
| `computeContentHash - format is 4 hex chars` | Matches /^[0-9a-f]{4}$/ |

---

## 2. Phase 2: ScopeTracker Enhancement

### Files Changed
- `packages/core/src/core/ScopeTracker.ts`

### New Method

```typescript
/**
 * Get the nearest named ancestor scope.
 *
 * Walks the scope stack from innermost to outermost, skipping
 * counted scopes (if#0, try#1, for#0, etc.) and returns the
 * first named scope.
 *
 * Returns undefined when at top-level (global scope).
 *
 * @returns Name of nearest named ancestor, or undefined
 */
getNamedParent(): string | undefined {
  for (let i = this.scopeStack.length - 1; i >= 0; i--) {
    const entry = this.scopeStack[i];
    // Counted scopes have '#' in their name (if#0, try#1, for#0, etc.)
    // Named scopes don't (function names, class names)
    if (!entry.name.includes('#')) {
      return entry.name;
    }
  }
  return undefined;
}
```

**Complexity:** O(d) where d = scope depth. Typically d < 10.

**Edge cases:**
- Empty stack (top-level) -> returns `undefined`
- Stack with only counted scopes (e.g., deeply nested anonymous blocks) -> returns `undefined`
- Function inside `if` inside function: `[fetchData, if#0, processItem]` -> returns `processItem` (innermost named)
- Class methods: `[UserService, login]` -> returns `login`

### Why not use `getEnclosingScope()`?

`getEnclosingScope(scopeType)` filters by TYPE (e.g., 'CLASS', 'FUNCTION'). We need to skip by NAME pattern (has `#` = counted = anonymous). Different semantics. A new method is cleaner than overloading.

### Tests (added to existing `test/unit/ScopeTracker.test.js` or new file)

| Test name | What it verifies |
|-----------|-----------------|
| `getNamedParent - empty stack` | Returns undefined |
| `getNamedParent - only counted scopes` | `[if#0, try#1]` -> undefined |
| `getNamedParent - named function at top` | `[fetchData]` -> `fetchData` |
| `getNamedParent - named inside counted` | `[fetchData, if#0]` -> `fetchData` |
| `getNamedParent - nested named scopes` | `[UserService, login, if#0]` -> `login` (innermost named) |

---

## 3. Phase 3: CollisionResolver

### New File
`packages/core/src/plugins/analysis/ast/CollisionResolver.ts`

### Design

The CollisionResolver is called AFTER all visitors have completed for a file, BEFORE the data is passed to GraphBuilder. It performs a single O(n) pass over all collected nodes to assign final IDs.

**Key insight:** During AST traversal, visitors produce "pending" nodes with base IDs (no hash, no counter). The CollisionResolver groups by base ID and applies graduated disambiguation:
1. **Unique base ID** -> use as-is
2. **Collision on base ID, unique content hash** -> add `[...,h:xxxx]`
3. **Collision on base ID AND content hash** -> add counter `#N`

### Types

```typescript
/**
 * A node awaiting final ID assignment.
 *
 * Created by visitors during AST traversal. Contains the
 * base ID (without hash/counter) and content hints for
 * hash computation if disambiguation is needed.
 */
export interface PendingNode {
  /** Base ID: file->TYPE->name or file->TYPE->name[in:parent] */
  baseId: string;

  /** Content hints for hash computation (node-type-specific) */
  contentHints: ContentHashHints;

  /**
   * Index into the source collection array.
   * Used to update the final ID on the original object.
   */
  collectionRef: { id: string };

  /** Original insertion order (for deterministic counter assignment) */
  insertionOrder: number;
}
```

### Class

```typescript
import { computeContentHash } from '../../../core/SemanticId.js';

/**
 * CollisionResolver - Graduated disambiguation for v2 semantic IDs.
 *
 * Pipeline position: After all visitors complete, before GraphBuilder.
 *
 * Algorithm:
 * 1. Group PendingNodes by baseId
 * 2. For groups with size=1: no change needed
 * 3. For groups with size>1: compute content hashes
 *    a. If all hashes unique within group: append [h:xxxx]
 *    b. If hash collision: append [h:xxxx]#N (counter)
 *
 * Complexity: O(n) where n = total nodes in file.
 */
export class CollisionResolver {
  /**
   * Resolve collisions and assign final IDs.
   *
   * Mutates each PendingNode's collectionRef.id in place.
   *
   * @param nodes - All pending nodes for one file
   */
  resolve(nodes: PendingNode[]): void {
    // Step 1: Group by baseId
    const groups = new Map<string, PendingNode[]>();
    for (const node of nodes) {
      let group = groups.get(node.baseId);
      if (!group) {
        group = [];
        groups.set(node.baseId, group);
      }
      group.push(node);
    }

    // Step 2: Process each group
    for (const [baseId, group] of groups) {
      if (group.length === 1) {
        // Unique -- base ID is final
        group[0].collectionRef.id = baseId;
        continue;
      }

      // Sort by insertion order for deterministic counter assignment
      group.sort((a, b) => a.insertionOrder - b.insertionOrder);

      // Compute hashes for all nodes in group
      const hashes = group.map(n => computeContentHash(n.contentHints));

      // Sub-group by hash
      const hashGroups = new Map<string, { node: PendingNode; index: number }[]>();
      for (let i = 0; i < group.length; i++) {
        const hash = hashes[i];
        let hg = hashGroups.get(hash);
        if (!hg) {
          hg = [];
          hashGroups.set(hash, hg);
        }
        hg.push({ node: group[i], index: i });
      }

      // Assign final IDs
      for (const [hash, entries] of hashGroups) {
        if (entries.length === 1) {
          // Unique hash within collision group -- hash suffices
          const node = entries[0].node;
          node.collectionRef.id = this.appendHash(baseId, hash);
        } else {
          // Hash collision -- need counter
          for (let c = 0; c < entries.length; c++) {
            const node = entries[c].node;
            // First item gets counter=0 (omitted in ID), second gets #1, etc.
            node.collectionRef.id = this.appendHashAndCounter(baseId, hash, c);
          }
        }
      }
    }
  }

  /**
   * Append content hash to base ID.
   *
   * "file->TYPE->name" -> "file->TYPE->name[h:xxxx]"
   * "file->TYPE->name[in:parent]" -> "file->TYPE->name[in:parent,h:xxxx]"
   */
  private appendHash(baseId: string, hash: string): string {
    const bracketIdx = baseId.indexOf('[');
    if (bracketIdx === -1) {
      // No existing brackets
      return `${baseId}[h:${hash}]`;
    }
    // Insert hash before closing bracket
    return `${baseId.slice(0, -1)},h:${hash}]`;
  }

  /**
   * Append content hash and counter to base ID.
   *
   * Counter 0 is omitted (first occurrence doesn't need disambiguation).
   */
  private appendHashAndCounter(baseId: string, hash: string, counter: number): string {
    const withHash = this.appendHash(baseId, hash);
    if (counter === 0) return withHash;
    return `${withHash}#${counter}`;
  }
}
```

### Algorithm Detail

```
Input: [
  { baseId: "app.js->CALL->console.log[in:processData]", hints: {arity:1, firstLiteralArg:"hello"} },
  { baseId: "app.js->CALL->console.log[in:processData]", hints: {arity:2, firstLiteralArg:"world"} },
  { baseId: "app.js->CALL->console.log[in:processData]", hints: {arity:1, firstLiteralArg:"hello"} },
  { baseId: "app.js->FUNCTION->processData", hints: {} }
]

Step 1 - Group by baseId:
  "app.js->FUNCTION->processData": [node3]           -- size 1, no change
  "app.js->CALL->console.log[in:processData]": [node0, node1, node2]  -- size 3, collision

Step 2 - Process collision group:
  Sorted by insertionOrder: [node0, node1, node2]
  Hashes: ["a1b2", "c3d4", "a1b2"]

  Sub-group by hash:
    "a1b2": [node0, node2]   -- hash collision!
    "c3d4": [node1]          -- unique hash

  Assign:
    node1 -> "...console.log[in:processData,h:c3d4]"           (unique hash)
    node0 -> "...console.log[in:processData,h:a1b2]"           (counter=0, omitted)
    node2 -> "...console.log[in:processData,h:a1b2]#1"         (counter=1)

Step 3 - "app.js->FUNCTION->processData" unchanged (unique)
```

**Complexity:**
- Grouping: O(n)
- Sorting within group: O(k log k) where k = group size (typically very small, <10)
- Hash computation: O(n)
- Total: O(n) amortized (the sort is dominated by n for practical group sizes)

**Edge cases:**
- Empty input: no-op
- All unique base IDs: each group has size 1, no hashing needed
- All identical base IDs AND all identical content: counter distinguishes them (0 omitted, then #1, #2, ...)
- Base ID with no brackets + hash: becomes `name[h:xxxx]`
- Base ID with brackets + hash: becomes `name[in:parent,h:xxxx]`

### Tests (file: `test/unit/CollisionResolver.test.js`)

| Test name | What it verifies |
|-----------|-----------------|
| `resolve - no collisions` | All nodes keep base ID |
| `resolve - two same-name calls, different args` | Hash disambiguates, no counter |
| `resolve - three same-name calls, two identical` | Hash + counter for identical pair |
| `resolve - all identical content` | All get same hash, counters 0,1,2 |
| `resolve - base ID with brackets` | `[in:parent]` + `[h:xxxx]` merged correctly |
| `resolve - base ID without brackets` | `[h:xxxx]` added correctly |
| `resolve - insertion order preserved` | Counter assigned by original order, not alphabetical |
| `resolve - empty input` | No error, no output |
| `resolve - single node` | No change to ID |
| `resolve - mixed colliding and unique` | Only colliding groups get hashes |

---

## 4. Phase 4: IdGenerator v2

### Files Changed
- `packages/core/src/plugins/analysis/ast/IdGenerator.ts`

### New Methods

The key insight: v2 IdGenerator methods do NOT call `computeSemanticIdV2` directly. Instead, they produce **base IDs** and register **PendingNodes** with the CollisionResolver. The CollisionResolver assigns final IDs after all visitors complete.

However, there's a subtlety: some IDs are needed immediately during traversal (e.g., `functionId` is used to push into the `functions` array, and that same ID is referenced by SCOPE nodes, PARAMETER nodes, etc.). We need to handle this.

**Design decision:** The IdGenerator produces the base ID immediately and writes it to the collection object. The CollisionResolver later mutates `collectionRef.id` in place. All cross-references (SCOPE.parentFunctionId, PARAMETER.functionId) point to the SAME object reference, so the mutation propagates automatically.

Wait -- that won't work. Cross-references store the ID value as a string, not a reference to the object. When CollisionResolver changes `func.id`, the `scope.parentFunctionId` still has the old base ID.

**Revised design:** Two options:
1. **Deferred reference resolution:** Store references as pointers to the source object, resolve after CollisionResolver runs.
2. **ID rewriting map:** CollisionResolver returns `Map<baseId, finalId>`, and we rewrite all stored references.

Option 2 is simpler and less invasive. The CollisionResolver produces a `Map<string, string>` mapping base IDs to final IDs. A single post-processing pass rewrites all ID fields in all collections.

**But wait.** Let's think about which node types actually collide:
- FUNCTION (named): Unique by name within parent. Collision only with multiple anonymous functions in same parent -- these already get unique names via variable assignment inference or anonymous counter.
- CLASS: Unique by name. No collisions expected.
- VARIABLE/CONSTANT: Unique by name within scope. JavaScript doesn't allow redeclaring `const` in same scope. No collisions.
- CALL: **Primary collision source.** Multiple `console.log(...)` in same function.
- METHOD_CALL: Same as CALL.
- PROPERTY_ACCESS: Can collide (`obj.prop` accessed multiple times).
- SCOPE: Unique by construction (tied to parent function).
- INTERFACE/TYPE/ENUM: Unique by name (TypeScript enforces this).

So collisions are practically limited to CALL, METHOD_CALL, and PROPERTY_ACCESS. Functions/variables/classes are named uniquely by the language.

**Further simplification:** For CALL/METHOD_CALL, the v1 system already uses `discriminator` (counter) within the scope. We can keep this approach for v2: CALL nodes get hash-based disambiguation. But the CollisionResolver should handle it generically.

**IMPORTANT realization:** Most node types DON'T need CollisionResolver because they're unique by name. The CollisionResolver is primarily for:
- CALL / METHOD_CALL (multiple calls to same function)
- PROPERTY_ACCESS (multiple accesses to same property chain)

For these types, we don't need cross-references to be stable during traversal -- CALLs aren't referenced by other node IDs. They're only referenced by edges (CALLS, ARGUMENT), and edges use the final node ID.

**Actually, let's look at what happens with CALL IDs during traversal:**

In `CallExpressionVisitor`, the `callId` is pushed into `callSites[]` collection AND used to create `callArguments[]` entries (`parentCallId`). So if CollisionResolver changes the CALL ID, argument edges would break.

**Simplest correct approach:** The `PendingNode.collectionRef` pattern works. The `callId` string is stored in `callSites[i].id`. The `callArguments[j].parentCallId` also stores the same string value. CollisionResolver changes `callSites[i].id`, but `callArguments[j].parentCallId` still has the old value.

We need the rewriting map approach. After CollisionResolver runs, we walk all collections that reference CALL IDs and rewrite them.

**BUT this is getting complex. Let me step back.**

The v1 system uses `scopeTracker.getItemCounter('CALL:console.log')` which produces a scope-local counter. This is already a form of collision resolution -- it's just positional (not content-based). In v2, we want content-based disambiguation.

**Simplest approach that works:**

IdGenerator v2 still produces final IDs immediately during traversal, but uses a file-level registry to detect and resolve collisions on-the-fly:

```typescript
/**
 * V2 ID registry - tracks base IDs and resolves collisions during traversal.
 *
 * Alternative to post-hoc CollisionResolver. Advantages:
 * - IDs are final immediately (no rewriting needed)
 * - Cross-references are always valid
 *
 * Disadvantage:
 * - First node gets base ID, second node retroactively needs to update first.
 *
 * We solve this by always computing the hash eagerly. If the base ID is unique,
 * the hash is computed but not used. If a collision occurs, the hash is appended.
 * This means the FIRST node in a collision group doesn't get a hash (it was
 * assigned before the collision was detected).
 *
 * Actually, this is a problem. We need to know ALL nodes before assigning IDs.
 * The post-hoc approach is correct.
 */
```

OK, the post-hoc CollisionResolver is the right approach. Let me handle the cross-reference problem cleanly.

**Cross-reference analysis:**

| Collection | ID field | Referenced by |
|-----------|----------|--------------|
| `functions[].id` | Primary ID | `scopes[].parentFunctionId`, `parameters[].functionId` (implicit via call), edge targets |
| `callSites[].id` | Primary ID | `callArguments[].parentCallId`, edge sources/targets |
| `methodCalls[].id` | Primary ID | `callArguments[].parentCallId`, edge sources/targets |
| `variableDeclarations[].id` | Primary ID | Edge targets (resolved by name+scope, not by stored ID) |
| `propertyAccesses[].id` | Primary ID | Edge targets |

Functions, variables, classes: **don't collide** (unique by name in language semantics). So their IDs never change. Only CALL, METHOD_CALL, PROPERTY_ACCESS can collide.

For CALL/METHOD_CALL: `callArguments[].parentCallId` stores the CALL ID. We need to rewrite this. That's the ONLY cross-reference.

For PROPERTY_ACCESS: no cross-references (only used as edge endpoints, resolved at GraphBuilder time by iterating the collection).

**So the rewriting scope is limited:** After CollisionResolver runs, we need ONE rewriting pass over `callArguments` using the `oldId -> newId` map from CollisionResolver.

### Revised Design

```typescript
// In IdGenerator.ts:

export interface PendingNode {
  baseId: string;
  contentHints: ContentHashHints;
  collectionRef: { id: string };  // Direct reference to the collection object's id field
  insertionOrder: number;
}

export class IdGenerator {
  // ... existing v1 methods unchanged ...

  /** Pending nodes for v2 collision resolution */
  private _pendingNodes: PendingNode[] = [];
  private _insertionCounter = 0;

  /**
   * Generate v2 base ID for CALL/METHOD_CALL nodes.
   *
   * Registers a PendingNode for later collision resolution.
   * Returns the base ID (may be changed by CollisionResolver).
   *
   * @param type - 'CALL' or 'METHOD_CALL'
   * @param name - Callee name (e.g., 'console.log')
   * @param file - Source file path
   * @param contentHints - Node-specific content for hash computation
   * @param collectionRef - The object whose .id will be updated
   */
  generateV2(
    type: string,
    name: string,
    file: string,
    contentHints: ContentHashHints,
    collectionRef: { id: string }
  ): string {
    const namedParent = this.scopeTracker?.getNamedParent();
    const baseId = computeSemanticIdV2(type, name, file, namedParent);

    this._pendingNodes.push({
      baseId,
      contentHints,
      collectionRef,
      insertionOrder: this._insertionCounter++
    });

    // Return base ID (will be overwritten by CollisionResolver if collision)
    collectionRef.id = baseId;
    return baseId;
  }

  /**
   * Generate v2 ID for nodes that are unique by construction
   * (FUNCTION, CLASS, VARIABLE, CONSTANT, INTERFACE, TYPE, ENUM, SCOPE).
   *
   * These don't need collision resolution -- language semantics guarantee uniqueness.
   * Directly returns the final ID.
   */
  generateV2Simple(
    type: string,
    name: string,
    file: string
  ): string {
    const namedParent = this.scopeTracker?.getNamedParent();
    return computeSemanticIdV2(type, name, file, namedParent);
  }

  /**
   * Get all pending nodes for collision resolution.
   * Called after all visitors complete for a file.
   */
  getPendingNodes(): PendingNode[] {
    return this._pendingNodes;
  }

  /**
   * Reset pending nodes (called at start of each file).
   */
  resetPending(): void {
    this._pendingNodes = [];
    this._insertionCounter = 0;
  }
}
```

### Tests (added to a new file or existing test)

| Test name | What it verifies |
|-----------|-----------------|
| `generateV2Simple - top-level function` | Returns `file->FUNCTION->name` |
| `generateV2Simple - nested function` | Returns `file->FUNCTION->name[in:parent]` |
| `generateV2 - registers pending node` | `getPendingNodes()` returns the registration |
| `generateV2 - base ID as interim` | `collectionRef.id` set to base ID |
| `generateV2 - insertion order increments` | Correct ordering across calls |
| `resetPending - clears state` | Empty after reset |

---

## 5. Phase 5: Visitor Updates

### Approach

Each visitor changes from v1 (`computeSemanticId` / `idGenerator.generate/generateSimple`) to v2 (`idGenerator.generateV2Simple` / `idGenerator.generateV2`).

**Critical distinction:**
- Nodes unique by name (FUNCTION, CLASS, VARIABLE, CONSTANT, INTERFACE, TYPE, ENUM, SCOPE) -> `generateV2Simple()`
- Nodes that can collide (CALL, METHOD_CALL, PROPERTY_ACCESS) -> `generateV2()` with content hints

### 5.1 FunctionVisitor

**File:** `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`

**Changes:**

1. `FunctionDeclaration` handler (line ~223):
```typescript
// BEFORE:
const functionId = idGenerator.generateSimple('FUNCTION', node.id.name, module.file, line);

// AFTER:
const functionId = idGenerator.generateV2Simple('FUNCTION', node.id.name, module.file);
```

2. `ArrowFunctionExpression` handler (line ~297):
```typescript
// BEFORE:
const functionId = idGenerator.generate('FUNCTION', functionName, module.file, line, column, functionCounterRef);

// AFTER:
const functionId = idGenerator.generateV2Simple('FUNCTION', functionName, module.file);
```
Note: Arrow functions assigned to variables get the variable name (`functionName`), making them unique. Anonymous arrows get `anonymous[N]` names from `generateAnonymousName()` which uses `scopeTracker.getSiblingIndex('anonymous')` -- this is already scope-unique.

3. Scope generation (lines ~254, ~329):
```typescript
// BEFORE:
const functionBodyScopeId = idGenerator.generateScope('body', `${name}:body`, module.file, line);

// AFTER:
const functionBodyScopeId = idGenerator.generateV2Simple('SCOPE', 'body', module.file);
```

**Content hints for FUNCTION (if anonymous collision needed):**
```typescript
{ arity: node.params.length, firstParamName: firstParam?.name }
```

In practice, named functions don't collide. Anonymous functions get unique counter-based names. So `generateV2Simple` suffices.

### 5.2 CallExpressionVisitor

**File:** `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

This is the **primary consumer** of collision resolution. Multiple calls to `console.log`, `app.get`, etc.

**Changes at each ID generation site:**

1. Simple CALL (line ~1198):
```typescript
// BEFORE:
const callId = idGenerator.generate(
  'CALL', callee.name, module.file,
  line, column,
  callSiteCounterRef,
  { useDiscriminator: true, discriminatorKey: `CALL:${callee.name}` }
);

// AFTER:
const callInfo: CallSiteInfo = { /* ... all fields ... */ } as CallSiteInfo;
const callId = idGenerator.generateV2(
  'CALL', callee.name, module.file,
  {
    arity: node.arguments.length,
    firstLiteralArg: extractFirstLiteralArg(node)
  },
  callInfo
);
callInfo.id = callId;  // Already set by generateV2, but explicit for clarity
```

Actually, the pattern is cleaner if we create the object first, then call generateV2 which sets `.id`:

```typescript
const callInfo: CallSiteInfo = {
  id: '',  // Will be set by generateV2
  type: 'CALL',
  name: callee.name,
  file: module.file,
  line, column,
  // ... other fields
};
idGenerator.generateV2(
  'CALL', callee.name, module.file,
  { arity: node.arguments.length, firstLiteralArg: extractFirstLiteralArg(node) },
  callInfo
);
(callSites as CallSiteInfo[]).push(callInfo);
```

2. Method CALL (line ~1288, ~1399): Same pattern with `fullName` instead of `callee.name`.

3. Constructor CALL (line ~1455, ~1489): `new:ClassName` pattern -- same approach.

**New helper function needed:**
```typescript
/**
 * Extract first literal argument from a call expression for content hashing.
 * Returns the string representation of the first literal arg, or undefined.
 */
function extractFirstLiteralArg(node: CallExpression): string | undefined {
  if (node.arguments.length === 0) return undefined;
  const first = node.arguments[0];
  if (first.type === 'StringLiteral') return first.value;
  if (first.type === 'NumericLiteral') return String(first.value);
  if (first.type === 'BooleanLiteral') return String(first.value);
  if (first.type === 'NullLiteral') return 'null';
  if (first.type === 'TemplateLiteral' && first.quasis.length === 1) {
    return first.quasis[0].value.raw;
  }
  return undefined;
}
```

### 5.3 VariableVisitor

**File:** `packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`

**Changes (line ~259):**
```typescript
// BEFORE:
const varId = idGenerator.generate(
  nodeType, varInfo.name, module.file,
  varInfo.loc.start.line, varInfo.loc.start.column,
  varDeclCounterRef as CounterRef
);

// AFTER:
const varId = idGenerator.generateV2Simple(nodeType, varInfo.name, module.file);
```

Variables are unique by name within their scope (JavaScript semantics: `const x` can't be redeclared in same block).

### 5.4 ClassVisitor

**File:** `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

ClassVisitor calls `computeSemanticId()` directly (not through IdGenerator). Changes:

1. Method IDs (lines ~270, ~337, ~465, ~571):
```typescript
// BEFORE:
const functionId = computeSemanticId('FUNCTION', propName, scopeTracker.getContext());

// AFTER:
const functionId = computeSemanticIdV2('FUNCTION', propName, module.file, scopeTracker.getNamedParent());
```

2. Scope IDs (lines ~300, ~379, ~495, ~613):
```typescript
// BEFORE:
const propBodySemanticId = computeSemanticId('SCOPE', 'body', scopeTracker.getContext());

// AFTER:
const propBodySemanticId = computeSemanticIdV2('SCOPE', 'body', module.file, scopeTracker.getNamedParent());
```

3. Private field variable (line ~515):
```typescript
// BEFORE:
const variableId = computeSemanticId('VARIABLE', displayName, scopeTracker.getContext());

// AFTER:
const variableId = computeSemanticIdV2('VARIABLE', displayName, module.file, scopeTracker.getNamedParent());
```

4. Static block scope (line ~413):
```typescript
// BEFORE:
const staticBlockScopeId = computeSemanticId('SCOPE', `static_block#${discriminator}`, scopeTracker.getContext());

// AFTER:
const staticBlockScopeId = computeSemanticIdV2('SCOPE', `static_block#${discriminator}`, module.file, scopeTracker.getNamedParent());
```

**Import change:** Replace `import { computeSemanticId }` with `import { computeSemanticIdV2 }`.

### 5.5 PropertyAccessVisitor

**File:** `packages/core/src/plugins/analysis/ast/visitors/PropertyAccessVisitor.ts`

PROPERTY_ACCESS can collide (same property accessed multiple times).

**Changes (line ~129):**
```typescript
// BEFORE:
if (scopeTracker) {
  const discriminator = scopeTracker.getItemCounter(`PROPERTY_ACCESS:${fullName}`);
  id = computeSemanticId('PROPERTY_ACCESS', fullName, scopeTracker.getContext(), { discriminator });
} else {
  id = `PROPERTY_ACCESS#${fullName}#${module.file}#${info.line}:${info.column}:${propertyAccessCounterRef.value++}`;
}

// AFTER:
if (scopeTracker) {
  const propInfo: PropertyAccessInfo = { /* ... fields ... */ } as PropertyAccessInfo;
  const idGenerator = new IdGenerator(scopeTracker);
  idGenerator.generateV2(
    'PROPERTY_ACCESS', fullName, module.file,
    { objectChain: info.objectExpression },
    propInfo
  );
  id = propInfo.id;
} else {
  id = `PROPERTY_ACCESS#${fullName}#${module.file}#${info.line}:${info.column}:${propertyAccessCounterRef.value++}`;
}
```

Alternatively, PropertyAccessVisitor could use `computeSemanticIdV2` directly and register with a shared collision resolver, but using IdGenerator keeps the pattern consistent.

**Actually, there's a design issue:** PropertyAccessVisitor creates its own `IdGenerator` instance per call. The pending node registration needs to be on a shared IdGenerator instance (per file). This means the IdGenerator must be created at the file level (in JSASTAnalyzer) and passed to all visitors.

**Currently:** Each visitor creates `new IdGenerator(scopeTracker)` locally. For v2, we need a single IdGenerator per file to accumulate pending nodes.

**Change:** JSASTAnalyzer creates one `IdGenerator` per file and passes it to all visitors. This is a refactor but necessary for CollisionResolver to work.

### 5.6 TypeScriptVisitor

**File:** `packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts`

INTERFACE, TYPE, ENUM are unique by name (TypeScript enforces this).

**Changes (lines ~133, ~195, ~221):**
```typescript
// BEFORE:
interfaceSemanticId = computeSemanticId('INTERFACE', interfaceName, scopeTracker.getContext());

// AFTER:
interfaceSemanticId = computeSemanticIdV2('INTERFACE', interfaceName, module.file, scopeTracker?.getNamedParent());
```

Same pattern for TYPE and ENUM.

### 5.7 JSASTAnalyzer Orchestration Changes

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**New orchestration after AST traversal, before GraphBuilder:**

```typescript
// After all visitors complete for a file:

// 1. Run CollisionResolver on pending nodes
const resolver = new CollisionResolver();
const pending = idGenerator.getPendingNodes();
const idRewrites = resolver.resolve(pending);  // Returns Map<oldId, newId>

// 2. Rewrite cross-references in callArguments
if (idRewrites.size > 0) {
  for (const arg of callArguments) {
    const newId = idRewrites.get(arg.parentCallId);
    if (newId) arg.parentCallId = newId;
  }
}

// 3. Pass to GraphBuilder as before
```

Wait -- I defined `resolve()` as void (mutates in place). Let me reconsider. The CollisionResolver should return the rewrite map for cross-reference fixing.

**Revised CollisionResolver.resolve():**
```typescript
resolve(nodes: PendingNode[]): Map<string, string> {
  const rewrites = new Map<string, string>();
  // ... same algorithm ...
  // When assigning final ID different from base:
  if (finalId !== node.baseId) {
    rewrites.set(node.baseId, finalId);
  }
  node.collectionRef.id = finalId;
  return rewrites;
}
```

**Problem with rewrite map:** If two nodes have the SAME base ID, the map would map that base ID to... which final ID? They all have different final IDs!

The rewrite map approach doesn't work for base ID -> final ID because it's one-to-many. Instead, each PendingNode already has the final ID written to `collectionRef.id`. For cross-references, we need to map the ORIGINAL base ID (stored in `callArguments.parentCallId`) to the specific final ID.

But `callArguments[j].parentCallId` was set to the base ID during traversal. Multiple callArguments might reference the same base CALL ID, and we need to map each to the correct final ID.

**The correct approach:** During traversal, when creating callArgument entries, store a reference to the parent CALL's collection object, not the ID string. Then after CollisionResolver runs, the object's `.id` field has the correct final ID.

```typescript
// In CallExpressionVisitor, when creating callArguments:
callArguments.push({
  parentCallRef: callInfo,  // Reference to the CallSiteInfo object
  // ... other fields
});

// After CollisionResolver:
for (const arg of callArguments) {
  arg.parentCallId = arg.parentCallRef.id;  // Now has final ID
}
```

This is cleaner. The `callArguments` type gets a temporary `parentCallRef` field used only during the build pipeline.

**Actually, even simpler:** The callArguments are always created IMMEDIATELY after the CALL node, referencing `callInfo.id`. Since `callInfo` is the same object registered with CollisionResolver, after resolution `callInfo.id` already has the final value. We just need to defer reading `callInfo.id` until after resolution.

Current code pattern:
```typescript
const callId = idGenerator.generate(...);
callArguments.push({ parentCallId: callId, ... });
```

If we change to:
```typescript
const callInfo = { id: '', ... };
idGenerator.generateV2('CALL', name, file, hints, callInfo);
callSites.push(callInfo);
// DON'T read callInfo.id yet -- just store the reference
callArguments.push({ parentCallId: callInfo.id, ... }); // BUG: reads base ID
```

The problem is `callInfo.id` is read immediately. We need lazy evaluation.

**Simplest fix:** Store the call info object reference in callArguments, resolve later.

```typescript
// Temporary field on CallArgumentInfo
interface CallArgumentInfo {
  // ... existing fields ...
  _parentCallRef?: CallSiteInfo;  // Temporary: resolved after CollisionResolver
}

// During traversal:
callArguments.push({ parentCallId: '', _parentCallRef: callInfo, ... });

// After CollisionResolver:
for (const arg of callArguments) {
  if (arg._parentCallRef) {
    arg.parentCallId = arg._parentCallRef.id;
    delete arg._parentCallRef;
  }
}
```

This is minimal invasion. The `_parentCallRef` is a build-pipeline-only field, stripped before GraphBuilder sees it.

### Phase 5 Tests

Tests for Phase 5 are primarily integration tests verifying the correct IDs flow through. They overlap with Phase 8 (migration tests). Key tests:

| Test name | What it verifies |
|-----------|-----------------|
| `FunctionVisitor - named function gets v2 ID` | `file->FUNCTION->name` (no scope chain) |
| `FunctionVisitor - arrow in variable gets v2 ID` | `file->FUNCTION->varName` |
| `CallExpressionVisitor - unique call` | `file->CALL->fn[in:parent]` (no hash) |
| `CallExpressionVisitor - duplicate calls different args` | Hash disambiguation |
| `CallExpressionVisitor - duplicate calls same args` | Hash + counter |
| `VariableVisitor - const gets v2 ID` | `file->CONSTANT->name[in:parent]` |
| `ClassVisitor - method gets v2 ID` | `file->FUNCTION->method[in:ClassName]` |
| `PropertyAccessVisitor - duplicate accesses` | Hash disambiguation |
| `TypeScriptVisitor - interface gets v2 ID` | `file->INTERFACE->name` |

---

## 6. Phase 6: GraphBuilder Scope Resolution Refactor

### Files Changed
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### Current State

`resolveVariableInScope()` (line 2328) and `resolveParameterInScope()` (line 2378) call `parseSemanticId(v.id)` to extract `scopePath` and compare it against the lookup scope path.

### v2 Impact

With v2 IDs, `parseSemanticId(v.id)` returns `null` because v2 format doesn't have 4+ `->` parts. We need `parseSemanticIdV2` which returns `namedParent` (a single string) instead of `scopePath` (an array).

But the resolution algorithm needs the FULL scope path to do scope-chain walking:
```
current scope [fetchData, if#0, for#1] ->
  try [fetchData, if#0, for#1]
  try [fetchData, if#0]
  try [fetchData]
  try []  (global)
```

The v2 ID only has `namedParent: fetchData`. That's not enough for this algorithm.

### Solution: Use Stored Scope Paths Instead of Parsing IDs

**Key insight from Don's plan:** The scope path data already exists independently of the ID:
- `VariableDeclarationInfo` doesn't currently store scope path explicitly, but the v1 ID encodes it.
- `ParameterInfo.semanticId` encodes the scope path.

**We need to add explicit scope path storage.** This is the cleanest approach: stop parsing IDs for scope info and use a dedicated field.

**Changes to types:**

```typescript
// In types.ts:
export interface VariableDeclarationInfo {
  id: string;
  semanticId?: string;
  type: 'VARIABLE' | 'CONSTANT';
  name: string;
  file: string;
  line: number;
  column?: number;
  value?: unknown;
  parentScopeId?: string;
  scopePath?: string[];  // NEW: full scope path from ScopeTracker (for resolution)
  // ... existing fields ...
}

// ParameterInfo already has semanticId, but we add scopePath too:
export interface ParameterInfo {
  // ... existing fields ...
  scopePath?: string[];  // NEW: full scope path from ScopeTracker (for resolution)
}
```

**Changes to VariableVisitor** (also Phase 5): When creating variable declarations, store the scope path:

```typescript
const constantData: VariableDeclarationInfo = {
  id: varId,
  type: 'CONSTANT',
  name: varInfo.name,
  file: module.file,
  line: varInfo.loc.start.line,
  parentScopeId: module.id,
  scopePath: scopeTracker?.getContext().scopePath ?? []  // NEW
};
```

**Changes to `createParameterNodes`:** Store scope path on ParameterInfo.

### Revised `resolveVariableInScope()`

```typescript
private resolveVariableInScope(
  name: string,
  scopePath: string[],
  file: string,
  variables: VariableDeclarationInfo[]
): VariableDeclarationInfo | null {
  for (let i = scopePath.length; i >= 0; i--) {
    const searchScopePath = scopePath.slice(0, i);

    const matchingVar = variables.find(v => {
      if (v.name !== name || v.file !== file) return false;

      // v2 path: use explicit scopePath field
      if (v.scopePath) {
        if (searchScopePath.length === 0) {
          return v.scopePath.length === 0;  // Global scope
        }
        return this.scopePathsMatch(v.scopePath, searchScopePath);
      }

      // Fallback: try parsing v1 semantic ID (backward compat during transition)
      const parsed = parseSemanticId(v.id);
      if (parsed && (parsed.type === 'VARIABLE' || parsed.type === 'CONSTANT')) {
        if (searchScopePath.length === 0) {
          return parsed.scopePath.length === 1 && parsed.scopePath[0] === 'global';
        }
        return this.scopePathsMatch(parsed.scopePath, searchScopePath);
      }

      return searchScopePath.length === 0;
    });

    if (matchingVar) return matchingVar;
  }
  return null;
}
```

The key change: Check `v.scopePath` first (new v2 field), fall back to `parseSemanticId` for backward compat. Once all consumers are migrated, the fallback can be removed.

### Revised `resolveParameterInScope()`

Same pattern: check `p.scopePath` first, fall back to parsing `p.semanticId`.

```typescript
private resolveParameterInScope(
  name: string,
  scopePath: string[],
  file: string,
  parameters: ParameterInfo[]
): ParameterInfo | null {
  return parameters.find(p => {
    if (p.name !== name || p.file !== file) return false;

    // v2 path: use explicit scopePath field
    if (p.scopePath) {
      for (let i = scopePath.length; i >= 0; i--) {
        const searchScopePath = scopePath.slice(0, i);
        if (searchScopePath.length === 0) {
          if (p.scopePath.length === 0) return true;
        } else {
          if (this.scopePathsMatch(p.scopePath, searchScopePath)) return true;
        }
      }
      return false;
    }

    // Fallback: parse v1 semantic ID
    if (p.semanticId) {
      const parsed = parseSemanticId(p.semanticId);
      if (parsed && parsed.type === 'PARAMETER') {
        for (let i = scopePath.length; i >= 0; i--) {
          const searchScopePath = scopePath.slice(0, i);
          if (searchScopePath.length === 0) {
            if (parsed.scopePath.length === 1 && parsed.scopePath[0] === 'global') return true;
          } else {
            if (this.scopePathsMatch(parsed.scopePath, searchScopePath)) return true;
          }
        }
      }
    }
    return false;
  }) ?? null;
}
```

### Import Changes

```typescript
// BEFORE:
import { computeSemanticId, parseSemanticId } from '../../../core/SemanticId.js';

// AFTER:
import { parseSemanticId } from '../../../core/SemanticId.js';
// parseSemanticId kept for backward compat fallback
```

`computeSemanticId` import removed (no longer used in GraphBuilder).

### `scopePathsMatch()` -- Unchanged

The function remains identical. It still compares full scope path arrays. The only change is WHERE the scope path comes from (now from `scopePath` field instead of parsed ID).

### Edge cases

- **Variables with no `scopePath` field (v1-era data):** Fallback to parsing the v1 ID. This handles incremental migration.
- **Global scope:** `scopePath: []` means global. In v1, this was `['global']`. The comparison logic handles both.
- **Mixed v1/v2 in same file:** Shouldn't happen (all nodes for a file are generated together), but the fallback handles it.

### Tests

| Test name | What it verifies |
|-----------|-----------------|
| `resolveVariableInScope - v2 scopePath direct` | Resolution using `scopePath` field |
| `resolveVariableInScope - scope chain walking` | `[a, if#0]` -> try `[a, if#0]`, then `[a]`, then `[]` |
| `resolveVariableInScope - global scope v2` | `scopePath: []` matches global lookup |
| `resolveParameterInScope - v2 scopePath` | Same as variable |
| `resolveVariableInScope - v1 fallback` | No `scopePath` field -> parses v1 ID |
| `bufferArrayMutationEdges - v2 IDs` | End-to-end: mutation with v2 variable IDs |
| `bufferObjectMutationEdges - v2 IDs` | End-to-end: object mutation with v2 IDs |
| `bufferVariableReassignmentEdges - v2 IDs` | End-to-end: reassignment with v2 IDs |

---

## 7. Phase 7: CLI & MCP Updates

### Files Changed
- `packages/cli/src/commands/query.ts`
- `packages/cli/src/commands/trace.ts`

### 7.1 `matchesScope()` in query.ts

**Current behavior (line 372):** Parses v1 ID, checks if scope name appears in `parsed.scopePath`.

**v2 behavior:** Parse v2 ID, check `namedParent`.

```typescript
export function matchesScope(semanticId: string, file: string | null, scopes: string[]): boolean {
  // Try v2 first
  const parsedV2 = parseSemanticIdV2(semanticId);
  if (parsedV2) {
    // File scope check (same logic)
    if (file !== null) {
      if (parsedV2.file !== file &&
          !parsedV2.file.endsWith('/' + file) &&
          basename(parsedV2.file) !== file) {
        return false;
      }
    }

    // Scope check: v2 only has namedParent (one level)
    for (const scope of scopes) {
      // Check namedParent
      if (parsedV2.namedParent === scope) continue;
      // Allow partial match (e.g., "UserService" matches namedParent "UserService")
      if (parsedV2.namedParent?.startsWith(scope + '#')) continue;
      return false;
    }
    return true;
  }

  // Fallback: try v1 parser
  const parsed = parseSemanticId(semanticId);
  if (!parsed) return false;

  // ... existing v1 logic unchanged ...
}
```

**Behavioral change:** v2 IDs only have ONE scope level (`namedParent`). Queries like `"response in catch in fetchData"` with two scope levels will only match v1 IDs. For v2 IDs, `"response in fetchData"` works but `"response in catch"` won't (catch is anonymous, not in ID).

**This is intentional.** Don's plan states: "users filter by named scopes (function, class) -- which is what they actually want."

### 7.2 `extractScopeContext()` in query.ts

```typescript
export function extractScopeContext(semanticId: string): string | null {
  // Try v2 first
  const parsedV2 = parseSemanticIdV2(semanticId);
  if (parsedV2 && parsedV2.namedParent) {
    return `inside ${parsedV2.namedParent}`;
  }
  if (parsedV2) return null;  // Top-level, no parent

  // Fallback: v1 parser
  const parsed = parseSemanticId(semanticId);
  if (!parsed) return null;
  const meaningfulScopes = parsed.scopePath.filter(s => s !== 'global');
  if (meaningfulScopes.length === 0) return null;
  // ... existing formatting ...
}
```

### 7.3 `trace.ts` scope filtering

**Current (line ~230-236):**
```typescript
const parsed = parseSemanticId(node.id);
if (!parsed) continue;
if (!parsed.scopePath.some(s => s.toLowerCase() === lowerScopeName)) {
  continue;
}
```

**v2:**
```typescript
const parsedV2 = parseSemanticIdV2(node.id);
if (parsedV2) {
  if (parsedV2.namedParent?.toLowerCase() !== lowerScopeName) {
    continue;
  }
} else {
  // Fallback: v1
  const parsed = parseSemanticId(node.id);
  if (!parsed) continue;
  if (!parsed.scopePath.some(s => s.toLowerCase() === lowerScopeName)) {
    continue;
  }
}
```

### Tests

| Test name | What it verifies |
|-----------|-----------------|
| `matchesScope - v2 ID with namedParent` | `"login[in:UserService]"` matches scope `"UserService"` |
| `matchesScope - v2 ID no parent` | Top-level matches when no scopes requested |
| `matchesScope - v2 ID file filtering` | File check works with v2 format |
| `matchesScope - v1 fallback` | v1 IDs still work |
| `extractScopeContext - v2 with parent` | Returns `"inside functionName"` |
| `extractScopeContext - v2 top-level` | Returns null |

---

## 8. Phase 8: Migration & Stability Tests

### File: `test/unit/SemanticIdV2Migration.test.js`

### 8.1 THE KEY TEST: Stability Under Block Addition

```javascript
describe('Semantic ID v2 stability', () => {
  it('should produce identical IDs when an if-block is added', () => {
    const code_before = `
      function fetchData() {
        const url = getUrl();
        if (shouldCache) {
          const response = fetch();
        }
      }
    `;

    const code_after = `
      function fetchData() {
        if (debug) { log(); }       // NEW block added
        const url = getUrl();
        if (shouldCache) {
          const response = fetch();
        }
      }
    `;

    const ids_before = analyzeAndGetIds(code_before);
    const ids_after = analyzeAndGetIds(code_after);

    // All pre-existing nodes must have identical IDs
    assert.strictEqual(ids_before.get('fetchData'), ids_after.get('fetchData'));
    assert.strictEqual(ids_before.get('url'), ids_after.get('url'));
    assert.strictEqual(ids_before.get('response'), ids_after.get('response'));

    // New nodes should have their own IDs
    assert.ok(ids_after.has('log'));
  });
});
```

### 8.2 Collision Tests

```javascript
describe('Collision resolution', () => {
  it('should disambiguate two console.log calls with different args', () => {
    const code = `
      function processData() {
        console.log("start");
        console.log("end");
      }
    `;
    const ids = analyzeAndGetIds(code);
    // Both should exist with different IDs
    const callIds = ids.getAll('console.log');
    assert.strictEqual(callIds.length, 2);
    assert.notStrictEqual(callIds[0], callIds[1]);
    // Both should contain hash
    assert.ok(callIds[0].includes('['));
    assert.ok(callIds[1].includes('['));
  });

  it('should use counter for identical calls', () => {
    const code = `
      function retry() {
        doWork();
        doWork();
        doWork();
      }
    `;
    const ids = analyzeAndGetIds(code);
    const callIds = ids.getAll('doWork');
    assert.strictEqual(callIds.length, 3);
    // All different
    const uniqueIds = new Set(callIds);
    assert.strictEqual(uniqueIds.size, 3);
    // At least one should have counter
    assert.ok(callIds.some(id => id.includes('#')));
  });
});
```

### 8.3 v1-to-v2 Mapping Verification

```javascript
describe('v1 to v2 ID mapping', () => {
  const mappings = [
    {
      description: 'top-level function',
      v1: 'src/app.js->global->FUNCTION->processData',
      v2: 'src/app.js->FUNCTION->processData'
    },
    {
      description: 'class method',
      v1: 'src/app.js->UserService->FUNCTION->login',
      v2: 'src/app.js->FUNCTION->login[in:UserService]'
    },
    {
      description: 'variable inside if inside function',
      v1: 'src/app.js->fetchData->if#0->VARIABLE->response',
      v2: 'src/app.js->VARIABLE->response[in:fetchData]'
    },
    {
      description: 'top-level constant',
      v1: 'config.js->global->CONSTANT->API_URL',
      v2: 'config.js->CONSTANT->API_URL'
    },
    {
      description: 'nested class method',
      v1: 'src/ui.js->Dashboard->Widget->FUNCTION->render',
      v2: 'src/ui.js->FUNCTION->render[in:Widget]'
    }
  ];

  for (const { description, v2 } of mappings) {
    it(`should produce correct v2 ID for ${description}`, () => {
      // Use compute functions to verify format
      const parsed = parseSemanticIdV2(v2);
      assert.ok(parsed, `Failed to parse v2 ID: ${v2}`);
      // Verify round-trip
      const recomputed = computeSemanticIdV2(
        parsed.type, parsed.name, parsed.file,
        parsed.namedParent, parsed.contentHash, parsed.counter
      );
      assert.strictEqual(recomputed, v2);
    });
  }
});
```

### 8.4 No-Duplicate Regression

```javascript
describe('No duplicate IDs', () => {
  it('should produce unique IDs within a file', () => {
    const code = `
      class UserService {
        login() { console.log("in"); }
        logout() { console.log("out"); }
      }
      function helper() {
        console.log("help");
        console.log("help");
      }
    `;
    const allIds = analyzeAndGetAllIds(code);
    const seen = new Set();
    for (const id of allIds) {
      assert.ok(!seen.has(id), `Duplicate ID: ${id}`);
      seen.add(id);
    }
  });
});
```

### 8.5 Round-Trip Tests

```javascript
describe('parseSemanticIdV2 round-trip', () => {
  const cases = [
    'src/app.js->FUNCTION->processData',
    'src/app.js->FUNCTION->login[in:UserService]',
    'src/app.js->CALL->console.log[in:processData,h:a1b2]',
    'src/app.js->CALL->console.log[in:processData,h:a1b2]#1',
    'config.js->CONSTANT->API_URL',
  ];

  for (const id of cases) {
    it(`should round-trip: ${id}`, () => {
      const parsed = parseSemanticIdV2(id);
      assert.ok(parsed);
      const recomputed = computeSemanticIdV2(
        parsed.type, parsed.name, parsed.file,
        parsed.namedParent, parsed.contentHash, parsed.counter
      );
      assert.strictEqual(recomputed, id);
    });
  }
});
```

---

## 9. Commit Strategy

### Commit 1: Phase 1 + Phase 2 (Core + ScopeTracker)
**Files:** `SemanticId.ts`, `ScopeTracker.ts`, `index.ts`, `SemanticIdV2.test.js`
**Why atomic:** Pure additions, no existing behavior changes. New functions + tests.

### Commit 2: Phase 3 (CollisionResolver)
**Files:** `CollisionResolver.ts` (new), `CollisionResolver.test.js` (new)
**Why atomic:** New file, no existing code changes. Fully self-contained with tests.

### Commit 3: Phase 4 (IdGenerator v2)
**Files:** `IdGenerator.ts`
**Why atomic:** Adds new methods to existing class, doesn't change existing methods. Tests can verify new methods work.

### Commit 4: Phase 5 + Phase 6 (Visitors + GraphBuilder)
**Files:** All 6 visitors, `JSASTAnalyzer.ts`, `GraphBuilder.ts`, `types.ts`
**Why combined:** Visitors produce v2 IDs, GraphBuilder must consume them. These MUST be deployed together or nothing works. This is the "big bang" commit.
**Risk mitigation:** Extensive tests in Phase 8 cover this.

### Commit 5: Phase 7 (CLI/MCP)
**Files:** `query.ts`, `trace.ts`
**Why atomic:** Consumer-side changes. With backward compat fallback, can be committed independently.

### Commit 6: Phase 8 (Migration tests)
**Files:** `SemanticIdV2Migration.test.js`, updates to existing test files
**Why last:** Tests verify the complete pipeline. Some may be written alongside Phases 1-7, but the stability/regression tests need the full implementation.

**Alternative: Commits 4-6 could be squashed** if the intermediate states are too fragile. The key property is: after each commit, `pnpm build && node --test` passes.

---

## 10. Risk Summary

| Risk | Severity | Mitigation |
|------|----------|-----------|
| GraphBuilder resolution breaks | HIGH | `scopePath` field on VariableDeclarationInfo/ParameterInfo + v1 fallback |
| Cross-references broken by CollisionResolver | HIGH | `_parentCallRef` pattern defers ID reading |
| IdGenerator shared state across visitors | MEDIUM | JSASTAnalyzer creates single IdGenerator per file |
| Existing test suite breaks | MEDIUM | Update tests alongside implementation (not after) |
| CLI scope filtering loses anonymous scope support | LOW | Intentional design decision, documented |
| Content hash collisions | LOW | Counter handles it; <10 same-name items per scope in practice |

---

## 11. LOC Estimate (Revised)

| Phase | New/Changed | Test LOC | Files |
|-------|------------|----------|-------|
| 1. Core | ~90 | ~120 | 2 |
| 2. ScopeTracker | ~15 | ~30 | 1 |
| 3. CollisionResolver | ~120 | ~100 | 1 (new) |
| 4. IdGenerator v2 | ~70 | ~40 | 1 |
| 5. Visitors | ~180 | ~80 | 8 |
| 6. GraphBuilder | ~60 | ~60 | 2 |
| 7. CLI/MCP | ~50 | ~40 | 2 |
| 8. Migration tests | - | ~120 | 1 (new) |
| **Total** | **~585** | **~590** | **~18** |

Implementation LOC aligns with original estimate (~600). Test LOC is higher than original 30 tests estimate -- we have ~75 test cases across ~590 LOC of test code. This is appropriate for a change with this blast radius.
