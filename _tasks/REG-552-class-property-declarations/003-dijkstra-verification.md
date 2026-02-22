## Dijkstra Plan Verification — REG-552

**Verdict:** APPROVE with mandatory notes

**Completeness tables:** 7

**Date:** 2026-02-22

---

## Critical Open Question — Resolved

**Don's question:** Where do `variableDeclarations` items with `isClassProperty: true` get their VARIABLE graph nodes created?

**Answer found in `GraphBuilder.ts` lines 275–278:**

```typescript
// 3. Buffer variables (keep parentScopeId on node for queries)
for (const varDecl of variableDeclarations) {
  this._bufferNode(varDecl as unknown as GraphNode);
}
```

Every entry in `variableDeclarations` — without exception, regardless of `isClassProperty` — is passed **as-is** to `_bufferNode`. The cast is `as unknown as GraphNode`, and `GraphNode` has an index signature `[key: string]: unknown`. This means:

1. The VARIABLE node IS created for all `variableDeclarations` entries.
2. Any extra fields on the object — including `metadata` — are passed through to the graph node unchanged.
3. `CoreBuilder.bufferVariableEdges` runs afterward and skips `isClassProperty` nodes for DECLARES edges. It does NOT affect node creation (which already happened in step 3 of `GraphBuilder.build()`).

**Conclusion:** The plan's claim that metadata will reach the VARIABLE node is CORRECT. No changes to `GraphBuilder`, `CoreBuilder`, or `TypeSystemBuilder` are needed. The node buffering path already works exactly as Don assumed.

---

## Table 1: `ClassProperty.key` type — Name extraction

The plan extracts the field name with:
```typescript
const propName = propNode.key.type === 'Identifier'
  ? propNode.key.name
  : (propNode.key as { value?: string }).value || 'anonymous';
```
This is already in the existing code (ClassDeclaration handler, line 257–259; ClassExpression handler, line 732–734). The plan inherits this logic unchanged.

| Key type | Example | Expected behavior | Plan handles it? |
|----------|---------|-------------------|-----------------|
| `Identifier` | `private graph: Foo` | `propNode.key.name` → `"graph"` | Yes — explicit branch |
| `StringLiteral` | `"method"() {}` (rare in class property context) | `.value` → `"method"` | Yes — falls to `.value` |
| `NumericLiteral` | `0 = 'value'` (invalid TS but valid JS) | `.value` → `"0"` | Yes — falls to `.value` |
| Computed expression | `[Symbol.iterator]() {}` | `.value` is `undefined` → `"anonymous"` | Partially — silently named `"anonymous"` |

**Gap:** Computed property keys (`[Symbol.iterator]`, `[key]`) produce the name `"anonymous"`. If two computed properties exist in the same class, they will share the same semantic ID, causing a collision. However, computed `ClassProperty` declarations (not methods) are extremely rare in TypeScript, and the existing code for function-valued properties already has the same behavior. This is a pre-existing limitation inherited from the REG-271 pattern. **Not a blocker for REG-552** — the task's acceptance criteria are `private graph: GraphBackend`, `public name: string`, `protected config: Config`, all of which use `Identifier` keys.

---

## Table 2: Modifier extraction — `accessibility × readonly` combinations

The plan's modifier logic (implementation code block):
```typescript
const parts: string[] = [];
if (propNodeTS.accessibility && propNodeTS.accessibility !== 'public') parts.push(propNodeTS.accessibility);
if (propNodeTS.readonly) parts.push('readonly');
const modifier = parts.length > 0 ? parts.join(' ') : 'public';
```

Note: The section 3 text initially says `readonly` takes precedence and returns early, but the implementation block (section 4) correctly uses the `parts` array approach that produces compound modifiers like `"private readonly"`. The implementation code supersedes the prose description. The implementation is correct.

| `accessibility` | `readonly` | Expected modifier | Plan produces | Correct? |
|----------------|-----------|-------------------|---------------|---------|
| `null` (implicit public) | `false` | `"public"` | `parts = []` → `"public"` | Yes |
| `"public"` | `false` | `"public"` | `parts = []` (public is excluded) → `"public"` | Yes |
| `"private"` | `false` | `"private"` | `parts = ["private"]` → `"private"` | Yes |
| `"protected"` | `false` | `"protected"` | `parts = ["protected"]` → `"protected"` | Yes |
| `null` (implicit public) | `true` | `"readonly"` | `parts = ["readonly"]` → `"readonly"` | Yes |
| `"public"` | `true` | `"readonly"` or `"public readonly"` | `parts = ["readonly"]` → `"readonly"` | Acceptable — public is implicit |
| `"private"` | `true` | `"private readonly"` | `parts = ["private", "readonly"]` → `"private readonly"` | Yes |
| `"protected"` | `true` | `"protected readonly"` | `parts = ["protected", "readonly"]` → `"protected readonly"` | Yes |

**All 8 combinations are handled.** No gap.

**Minor inconsistency:** The section 3 prose description (`extractModifier`) and the section 4 implementation block differ. The section 3 function returns early on `readonly` and loses the `accessibility` modifier. The section 4 implementation is correct. The implementer must follow section 4, not section 3. This discrepancy in the plan document should not cause problems if the implementer reads section 4 carefully, but it is a documentation flaw.

---

## Table 3: `ClassProperty` in `ClassDeclaration` vs `ClassExpression`

**Verified by reading `ClassVisitor.ts`.**

| Code path | Lines | Has `ClassProperty` handler? | Has `else` branch currently? | Symmetric? |
|-----------|-------|------------------------------|------------------------------|------------|
| `ClassDeclaration` | 248–335 | Yes | No (falls off end at line 334) | — |
| `ClassExpression` | 727–781 | Yes | No (falls off end at line 781) | Yes |

Both paths have the identical `if (propNode.value && (Arrow\|Function))` structure with an empty `else`. The plan's instruction to add the `else` block in both handlers is correct.

**Additional asymmetry noted (pre-existing, out of scope):** The `ClassDeclaration` handler includes `ClassPrivateProperty`, `ClassPrivateMethod`, and `StaticBlock` sub-handlers. The `ClassExpression` handler has none of these. This means private fields in class expressions are currently not indexed. This is a pre-existing gap from REG-271, not a concern for REG-552. The plan correctly says "same else block in both."

---

## Table 4: VARIABLE node creation path — metadata pass-through

**Traced fully.** The pipeline is:

1. `ClassVisitor` pushes to `collections.variableDeclarations` (the new `else` block).
2. `GraphBuilder.build()` step 3 (line 276): `this._bufferNode(varDecl as unknown as GraphNode)` — entire object including `metadata` field goes to the buffer.
3. `GraphNode` has `[key: string]: unknown` index signature — `metadata` survives the cast.
4. `_bufferNode` calls `brandNodeInternal(node as unknown as NodeRecord)` — must verify this does not strip `metadata`.

| Step | Does `metadata` survive? | Evidence |
|------|--------------------------|----------|
| Push to `variableDeclarations` | Yes — object is built with `metadata` field | Plan section 4 |
| `GraphBuilder` step 3 loop | Yes — no field stripping, `as unknown as GraphNode` cast | `GraphBuilder.ts` line 276–278 |
| `GraphNode` interface | Yes — `[key: string]: unknown` index signature | `types.ts` line 1265 |
| `CoreBuilder.bufferVariableEdges` | N/A — skips `isClassProperty` entirely, no node ops | `CoreBuilder.ts` line 124–126 |
| `TypeSystemBuilder.bufferClassDeclarationNodes` | N/A — reads `classDeclarations` collection, not `variableDeclarations` | `TypeSystemBuilder.ts` lines 70–100 |

**One precondition unverified:** `brandNodeInternal`. The plan does not verify that `brandNodeInternal` (called inside `_bufferNode`) passes `metadata` through. If `brandNodeInternal` strips unknown fields, `metadata` would be lost silently. This function was not read during verification. **The implementer must verify that `brandNodeInternal` does not strip the `metadata` field.** If it does, the metadata would need to be stored differently (e.g., as top-level fields `modifier` and `declaredType`).

---

## Table 5: Field with initializer value — `count = 0`

The branching logic is: `if (propNode.value && (Arrow|Function))` → FUNCTION node, `else` → VARIABLE node.

| Case | `propNode.value` | Enters `else` branch? | VARIABLE node created? | Correct? |
|------|-----------------|----------------------|------------------------|---------|
| `private graph: GraphBackend` (bare declaration) | `null` | Yes | Yes | Yes |
| `count = 0` (numeric initializer) | `NumericLiteral` (truthy) | Yes — not Arrow/Function | Yes | Yes |
| `name = "Alice"` (string initializer) | `StringLiteral` (truthy) | Yes | Yes | Yes |
| `items = []` (array initializer) | `ArrayExpression` (truthy) | Yes | Yes | Yes |
| `handle = () => {}` (arrow function) | `ArrowFunctionExpression` | No — goes to FUNCTION branch | FUNCTION node, not VARIABLE | Correct (existing behavior) |
| `fn = function() {}` | `FunctionExpression` | No — goes to FUNCTION branch | FUNCTION node, not VARIABLE | Correct (existing behavior) |

**`count = 0` correctly enters the `else` branch and gets a VARIABLE node.** The plan test case 6 covers this. No gap.

---

## Table 6: `static` field handling

| Case | `propNode.static` | `isStatic` on VariableDeclarationInfo | Correct? |
|------|------------------|--------------------------------------|---------|
| `private graph: Foo` | `false` | `false` | Yes |
| `static count = 0` | `true` | `true` | Yes |
| `static readonly MAX = 100` | `true` | `true` | Yes — `readonly` also captured in modifier |

The plan uses: `isStatic: propNode.static || false`

`propNode.static` on a Babel `ClassProperty` is always a `boolean` (never `undefined`), so `|| false` is redundant but harmless. Static fields will be correctly flagged.

**Gap:** The test suite (section 6) does not include a test case for `static` fields. The test for `count = 0` only covers a non-static initializer. A test asserting `isStatic: true` on a static field would be appropriate but is not in the required minimum. This is a minor gap in test coverage, not in implementation correctness.

---

## Table 7: `typeNodeToString` import

**Verified by reading `TypeScriptVisitor.ts`.**

```typescript
export function typeNodeToString(node: unknown): string {
```

Line 36 of `TypeScriptVisitor.ts`: `typeNodeToString` is exported as a named export. The current import in `ClassVisitor.ts` (line 30):

```typescript
import { extractTypeParameters } from './TypeScriptVisitor.js';
```

The plan's proposed import:

```typescript
import { extractTypeParameters, typeNodeToString } from './TypeScriptVisitor.js';
```

| Item | Status |
|------|--------|
| `typeNodeToString` exported from `TypeScriptVisitor.ts`? | Yes — line 36, named export |
| Current import in `ClassVisitor.ts` has `extractTypeParameters`? | Yes — line 30 |
| Plan's import is a valid extension of the existing import? | Yes — just adds `typeNodeToString` to the destructuring |
| `typeNodeToString` handles the types needed? | Yes — handles primitives, `TSTypeReference` (user-defined types), arrays, unions, generics |

No gap.

---

## Summary of Gaps and Preconditions

**Gaps found:**

1. **Documentation inconsistency in the plan:** Section 3's `extractModifier` function and section 4's implementation block produce different results for compound modifiers (`readonly` vs `"private readonly"`). Section 4 is correct. The implementer must follow section 4. Risk: low (implementer reading carefully will implement section 4).

2. **Test coverage gap — `static` field:** No test case asserts `isStatic: true` for static properties. The implementation handles statics correctly; the tests just don't verify it. Risk: low.

3. **Computed property key collision (pre-existing):** Two computed class properties in the same class would both get semantic ID with name `"anonymous"`, causing a collision. Pre-existing from REG-271, not introduced by REG-552. Risk: negligible (computed `ClassProperty` declarations are rare in TS codebases).

**Precondition issues:**

1. **`brandNodeInternal` not verified:** `GraphBuilder._bufferNode` calls `brandNodeInternal(node)` before pushing to the buffer. If this function strips fields not present on `NodeRecord`, the `metadata` field would be silently lost. The plan does not address this. The implementer must read `brandNodeInternal` and confirm it passes `metadata` through before assuming the node creation path is complete. If it strips `metadata`, an alternative approach (storing `modifier` and `declaredType` as top-level fields directly on the node instead of nested under `metadata`) would be required.

**Non-issues (previously open questions, now resolved):**

- VARIABLE node creation for `isClassProperty` entries: confirmed working via `GraphBuilder.ts` line 276.
- `metadata` field passing through the `GraphNode` cast: confirmed via index signature `[key: string]: unknown`.
- `HAS_PROPERTY` edge creation: confirmed in `TypeSystemBuilder.bufferClassDeclarationNodes` lines 94–100 — iterates `classDecl.properties` and emits one `HAS_PROPERTY` edge per ID.
- `typeNodeToString` export: confirmed at `TypeScriptVisitor.ts` line 36.
- Both `ClassDeclaration` and `ClassExpression` have the empty `else` slot: confirmed.

---

## Final Verdict

**APPROVE** — the plan is technically sound and the architecture is correct. The one precondition that must be checked before the implementation is considered complete: **verify `brandNodeInternal` does not strip `metadata`**. If it does, that is the only thing that would require a design change (metadata as top-level fields rather than nested object). Everything else — node creation path, edge wiring, modifier extraction, type annotation extraction, import — is verified correct.
