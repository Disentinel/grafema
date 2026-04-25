# RFD-4: Semantic ID v2 -- Don Melton Analysis & Plan

## 1. Prior Art

Brief web search confirms our approach is well-grounded:

- **Semantic Anchoring (Roo-Code DAST)** -- content-addressable hashing of intrinsic node properties, immune to line-number shifts. Closely mirrors our `[h:xxxx]` graduated disambiguation.
- **Lossless Semantic Trees (Moderne/OpenRewrite)** -- full-fidelity code model that preserves identity across refactors. Their LST uses type-attributed IDs, but for untyped codebases (our target), structural+name-based IDs are the right analog.
- **RefactoringMiner (2024 TOSEM paper)** -- shows that AST diff tools break when they match by position; semantic matching based on declaration names and structure is far more resilient.

Our design (named parent + content hash + counter) is the right architecture for untyped, refactoring-resilient code identification.

## 2. Current v1 Architecture

### 2.1 ID Format (v1)

```
{file}->{scopePath...}->{TYPE}->{name}[#discriminator]
```

**Examples of actual v1 IDs:**
```
src/app.js->global->FUNCTION->processData
src/app.js->UserService->FUNCTION->login
src/app.js->fetchData->if#0->try#0->VARIABLE->response
src/app.js->global->CALL->console.log#0
config.js->global->CONSTANT->API_URL
```

### 2.2 Core Components

| File | Role |
|------|------|
| `packages/core/src/core/SemanticId.ts` | `computeSemanticId()`, `parseSemanticId()`, `computeDiscriminator()` |
| `packages/core/src/core/ScopeTracker.ts` | Maintains scope stack during AST traversal, provides `getContext()` |
| `packages/core/src/plugins/analysis/ast/IdGenerator.ts` | Centralized ID generation wrapping legacy + semantic paths |

### 2.3 How IDs Flow Through the System

```
                     AST Traversal (single pass)
                              |
         Visitors (Function, Call, Variable, Class, TS, PropAccess)
              |                    |                    |
        ScopeTracker          IdGenerator         computeSemanticId()
        (push/pop scope)    (generate/generateSimple)    |
              |                    |                    |
              +-----> collections (FunctionInfo[], CallSiteInfo[], etc.)
                              |
                         GraphBuilder
                              |
                   parseSemanticId() for scope-based variable resolution
                              |
                          RFDB (stores ID as opaque string)
                              |
                   CLI (query.ts, trace.ts) -- parseSemanticId() for scope matching
                   MCP (handlers.ts) -- uses ID as lookup key
```

### 2.4 The Pain: Why v1 Breaks

**The fundamental problem:** anonymous scopes (if, for, try, catch, else) are encoded in the scope path.

```javascript
function fetchData() {
  const url = getUrl();       // ID: file->fetchData->VARIABLE->url
  if (shouldCache) {          // <-- this block enters scope "if#0"
    const response = fetch(); // ID: file->fetchData->if#0->VARIABLE->response
  }
}
```

Now add an `if` before it:

```javascript
function fetchData() {
  if (debug) { log(); }       // <-- NEW: this becomes if#0
  const url = getUrl();       // ID: file->fetchData->VARIABLE->url (stable!)
  if (shouldCache) {          // <-- this is now if#1 (WAS if#0!)
    const response = fetch(); // ID: file->fetchData->if#1->VARIABLE->response  BROKEN!
  }
}
```

**Everything inside `if#0` cascades** when a new block is inserted before it. This defeats the entire purpose of "stable" IDs.

### 2.5 Scope Path Usage Inventory (Blast Radius)

| Consumer | How it uses scopePath | Impact of v2 |
|----------|----------------------|---------------|
| `GraphBuilder.resolveVariableInScope()` | Parses ID, walks `scopePath` to find variable in enclosing scopes | **HIGH** -- needs `namedParent` equivalent |
| `GraphBuilder.resolveParameterInScope()` | Same pattern as variable resolution | **HIGH** |
| `GraphBuilder.scopePathsMatch()` | Exact array comparison of two scope paths | **HIGH** -- concept changes entirely |
| `GraphBuilder` (mutations) | Uses `mutationScopePath` stored alongside mutations | **MEDIUM** -- stored separately from ID |
| `CLI query.ts matchesScope()` | Checks if scope name appears in `parsed.scopePath` | **HIGH** -- needs new parsing |
| `CLI query.ts extractScopeContext()` | Formats scope path for human display | **MEDIUM** -- changes format |
| `CLI trace.ts` | Filters by scope name in `parsed.scopePath` | **HIGH** -- needs new parsing |
| `FunctionNode.createWithContext()` | Computes `parentScopeId` from `context.scopePath` | **HIGH** -- parent lookup changes |
| `MCP handlers.ts` | Uses ID as opaque lookup key via `db.getNode(semanticId)` | **LOW** -- ID is just a string key |
| `RFDB` | Stores ID as opaque string | **NONE** -- format irrelevant |

## 3. New v2 Format

```
file->TYPE->name[in:namedParent]                    // base
file->TYPE->name[in:namedParent,h:xxxx]             // + content hash on collision
file->TYPE->name[in:namedParent,h:xxxx]#N           // + counter for identical duplicates
```

### 3.1 Key Semantic Changes

1. **Scope path removed.** No `->scope1->scope2->` chain between file and type.
2. **`namedParent`** = nearest named ancestor (function, class, method). Anonymous scopes (if, for, try, etc.) are invisible.
3. **Graduated disambiguation:** base ID first, then content hash on collision, then counter for truly identical nodes.
4. **Two-pass:** single AST traversal collects base IDs + content hints, then `CollisionResolver` does O(n) fixup.

### 3.2 Examples: v1 -> v2

| Code element | v1 ID | v2 ID |
|-------------|-------|-------|
| Top-level function `processData` | `src/app.js->global->FUNCTION->processData` | `src/app.js->FUNCTION->processData` |
| Class method `login` in `UserService` | `src/app.js->UserService->FUNCTION->login` | `src/app.js->FUNCTION->login[in:UserService]` |
| Variable `response` inside `if` inside `fetchData` | `src/app.js->fetchData->if#0->VARIABLE->response` | `src/app.js->VARIABLE->response[in:fetchData]` |
| First `console.log` call in `processData` | `src/app.js->processData->CALL->console.log#0` | `src/app.js->CALL->console.log[in:processData]` |
| Second `console.log` in same function (different args) | `src/app.js->processData->CALL->console.log#1` | `src/app.js->CALL->console.log[in:processData,h:a1b2]` |
| Third identical `console.log` (same hash) | N/A | `src/app.js->CALL->console.log[in:processData,h:a1b2]#1` |
| Top-level constant | `config.js->global->CONSTANT->API_URL` | `config.js->CONSTANT->API_URL` |
| Nested class method `render` in `Widget` in `Dashboard` | `src/ui.js->Dashboard->Widget->FUNCTION->render` | `src/ui.js->FUNCTION->render[in:Widget]` |

### 3.3 `namedParent` Rules

- **Named scopes:** function, class, method (named arrow functions count)
- **Anonymous scopes:** if, for, for-of, for-in, try, catch, else, finally, switch, while -- **skipped**
- **Top-level (global):** `namedParent` is omitted entirely (no `[in:global]`)
- **Depth:** always the **nearest** named ancestor, not the full chain

### 3.4 Content Hash (FNV-1a)

Used only when base ID collides. What to hash depends on node type:

| Node type | Hash input |
|-----------|-----------|
| CALL / METHOD_CALL | Argument count + first literal arg (if any) |
| VARIABLE / CONSTANT | RHS expression type + first significant token |
| FUNCTION (anonymous) | Param count + first param name |
| PROPERTY_ACCESS | Object expression structure |

FNV-1a produces 32-bit hash, truncated to 4-hex chars (`h:a1b2`). No new dependencies required.

## 4. Architecture Plan

### Phase 1: Core ID Generation (Foundation)

**Files changed:** `SemanticId.ts`

1. Add `computeSemanticIdV2(type, name, file, namedParent?, contentHash?, counter?)` -- pure function
2. Add `parseSemanticIdV2(id)` -- returns `{ file, type, name, namedParent?, contentHash?, counter? }`
3. Add `computeContentHash(nodeType, hints)` -- FNV-1a implementation
4. Keep v1 functions intact (no removal yet)

**Why separate functions:** v1 and v2 coexist during migration. No flag-flipping, no runtime branching in hot paths.

### Phase 2: ScopeTracker Enhancement

**Files changed:** `ScopeTracker.ts`

1. Add `getNamedParent(): string | undefined` -- walks stack from top, skips counted scopes (`#` in name), returns first named scope
2. This is trivial given the existing `getEnclosingScope()` pattern

### Phase 3: CollisionResolver (New)

**New file:** `packages/core/src/plugins/analysis/ast/CollisionResolver.ts`

```typescript
interface PendingNode {
  baseId: string;          // file->TYPE->name[in:parent]
  contentHashInput: unknown; // node-type-specific data for hashing
  finalId?: string;        // set by resolver
}

class CollisionResolver {
  resolve(nodes: PendingNode[]): void;
  // Groups by baseId, applies graduated disambiguation
}
```

**Pipeline position:** After all visitors complete for a file, before GraphBuilder.

### Phase 4: IdGenerator v2

**Files changed:** `IdGenerator.ts`

1. Add v2 generation methods that produce `PendingNode` objects (base ID + hash hints)
2. v2 methods use `ScopeTracker.getNamedParent()` instead of full scope path
3. Keep v1 methods for backward compat during transition

### Phase 5: Visitor Updates (6 visitors)

**Files changed:** All 6 visitors + `JSASTAnalyzer.ts`

Each visitor switches from `idGenerator.generate()` to `idGenerator.generateV2()`:

| Visitor | Key changes |
|---------|------------|
| **FunctionVisitor** | Anonymous naming stays, but scope path not in ID. Arrow->variable name inference unchanged. Content hash: param count. |
| **CallExpressionVisitor** | CALL/METHOD_CALL use `namedParent`. Content hash: arg count + first literal. `detectArrayMutation` and `detectObjectAssign` semantic IDs update. |
| **VariableVisitor** | VARIABLE/CONSTANT use `namedParent`. Content hash: RHS type. |
| **ClassVisitor** | Methods get `[in:ClassName]`. Private fields, static blocks, decorators -- all use namedParent. |
| **PropertyAccessVisitor** | PROPERTY_ACCESS uses `namedParent`. Content hash: object chain. |
| **TypeScriptVisitor** | INTERFACE, TYPE, ENUM -- typically top-level, namedParent often absent. Simple update. |

### Phase 6: GraphBuilder Scope Resolution Refactor

**Files changed:** `GraphBuilder.ts`

This is the **highest-risk** phase. GraphBuilder currently uses `parseSemanticId()` to extract `scopePath` and do scope-chain variable resolution. With v2:

1. `resolveVariableInScope()` can no longer walk scope path from the ID. Instead, it must use the `mutationScopePath` / reference scope path stored alongside the data.
2. `resolveParameterInScope()` same change.
3. `scopePathsMatch()` -- may need to compare `namedParent` instead.

**Key insight:** The scope path data already exists separately from the ID in many places (`mutationScopePath`, `valueScopePath`). The ID was being parsed redundantly. v2 forces cleaner separation: **ID for identity, scope path for resolution.**

**Migration strategy:**
- GraphBuilder resolution functions keep using the separately-stored scope paths
- Stop parsing IDs for scope information
- `parseSemanticIdV2()` returns `namedParent` (single string) instead of `scopePath` (array)

### Phase 7: CLI & MCP Updates

**Files changed:** `packages/cli/src/commands/query.ts`, `packages/cli/src/commands/trace.ts`

1. `matchesScope()` -- update to use `namedParent` from parsed v2 ID
2. `extractScopeContext()` -- simpler with v2 (just `namedParent`)
3. MCP tools -- no change needed (ID is opaque lookup key)

### Phase 8: Migration Tests

1. **Stability test (THE KEY TEST):** Parse a file, add an `if` block, re-parse -- all sibling IDs must be identical.
2. **Collision test:** Two `console.log` calls in same function -- different IDs via hash disambiguation.
3. **v1-to-v2 mapping:** For each test fixture, verify expected v2 IDs.
4. **No-duplicate regression:** Full analysis of test fixtures -- no duplicate IDs within any file.
5. **Round-trip:** `parseSemanticIdV2(computeSemanticIdV2(...))` preserves all fields.

## 5. Risks & Mitigations

### Risk 1: GraphBuilder scope resolution breaks (HIGH)

**Problem:** `resolveVariableInScope()` currently parses the semantic ID to get the full scope path. v2 IDs only have `namedParent`.

**Mitigation:** Scope paths are already stored separately (e.g., `mutationScopePath`, `valueScopePath`). The ID-based parsing was always a convenience shortcut. Phase 6 migrates to using the authoritative scope data instead of reconstructing it from IDs.

### Risk 2: CLI scope filtering changes behavior (MEDIUM)

**Problem:** `matchesScope("try", ...)` currently works because `try#0` is in the scope path. With v2, anonymous scopes are invisible in the ID.

**Mitigation:** CLI scope filtering by anonymous scope names (if, try, for) was always fragile (order-dependent). With v2, users filter by named scopes (function, class) -- which is what they actually want. Document this as an intentional behavior change.

### Risk 3: Content hash collisions (LOW)

**Problem:** FNV-1a 4-hex truncation (16 bits) has ~1% collision probability at ~400 same-name items in same scope.

**Mitigation:** Counter (`#N`) handles hash collisions. In practice, you don't have 400 `console.log` calls in one function. The graduated approach (base -> hash -> counter) covers 99.99% of real code.

### Risk 4: Existing test suite (MEDIUM)

**Problem:** 13 test files test semantic ID behavior. All will need updating.

**Mitigation:** Phase 8 is specifically for this. Tests are updated alongside implementation, not after. The v1 tests remain as reference for the mapping validation.

### Risk 5: `FunctionNode.createWithContext()` parent computation (MEDIUM)

**Problem:** Currently computes `parentScopeId` by manipulating `context.scopePath`. With v2, parent is simply `namedParent`.

**Mitigation:** This actually becomes simpler. `parentScopeId = computeSemanticIdV2('FUNCTION', namedParent, file)`. No scope path slicing needed.

## 6. Phase Dependencies & Ordering

```
Phase 1 (Core) ─────────────┐
Phase 2 (ScopeTracker) ─────┤
                             ├──> Phase 4 (IdGenerator v2)
Phase 3 (CollisionResolver) ─┘           |
                                         v
                                Phase 5 (Visitors) ──> Phase 6 (GraphBuilder)
                                                              |
                                                              v
                                                       Phase 7 (CLI/MCP)
                                                              |
                                                              v
                                                       Phase 8 (Migration Tests)
```

Phases 1, 2, 3 are independent and can be done in parallel.
Phase 4 depends on 1+2+3.
Phase 5 depends on 4.
Phase 6 depends on 5 (needs new IDs flowing through).
Phase 7 depends on 6.
Phase 8 runs throughout but final validation at end.

## 7. Estimated Scope

| Phase | Files | LOC (approx) | Tests |
|-------|-------|-------------|-------|
| 1. Core | 1 | ~80 | ~15 |
| 2. ScopeTracker | 1 | ~15 | ~5 |
| 3. CollisionResolver | 1 (new) | ~100 | ~10 |
| 4. IdGenerator v2 | 1 | ~60 | ~5 |
| 5. Visitors (6) | 7 | ~200 | ~15 |
| 6. GraphBuilder | 1 | ~80 | ~10 |
| 7. CLI/MCP | 2 | ~40 | ~5 |
| 8. Migration tests | - | - | ~10 |
| **Total** | **~14** | **~575** | **~75** |

This aligns with the user's estimate of ~600 LOC / ~30 tests (we're slightly higher on tests because I want to be thorough on collision edge cases).

## 8. What I Would NOT Do

1. **Do not remove v1 functions.** Keep them until all consumers are migrated and tested. Dead code removal is a separate cleanup task.
2. **Do not change RFDB.** IDs are opaque strings to the database. Zero RFDB changes.
3. **Do not change `ScopeTracker.enterScope/exitScope` semantics.** The scope stack is still needed for parent lookup and scope-based resolution. Only the ID generation changes.
4. **Do not refactor GraphBuilder's scope resolution in this task.** If it works with stored scope paths, that's sufficient. A deeper refactor (eliminating redundant scope data) is future work.
5. **Do not change singleton or external module ID formats.** `net:stdio->__stdio__` and `EXTERNAL_MODULE->lodash` are fine as-is.

## 9. Open Question for Joel

The `mutationScopePath` / `valueScopePath` fields stored alongside data in collections -- these are full scope paths including anonymous scopes. They're used by GraphBuilder for resolution and are **independent of the ID format**. Should we:

(a) Keep them as-is (full paths with anonymous scopes) -- resolution continues to work identically
(b) Also simplify them to named-parent-only -- cleaner but requires rethinking resolution

**My recommendation:** (a) Keep full paths. The ID format is about identity and stability. The resolution scope paths are about semantic correctness. They solve different problems. Don't conflate them.

---

*"The scope path in the ID was always a lie -- it pretended to be an identifier but was actually a location. v2 makes the ID what it should have been: a name, a type, and where it lives."*
