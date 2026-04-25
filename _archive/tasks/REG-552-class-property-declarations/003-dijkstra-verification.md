## Dijkstra Plan Verification

**Verdict:** APPROVE with required fixes (two blocking defects, one structural issue)

---

## Completeness Tables

### Table 1: ClassProperty Key Types

The plan gates the else branch on `propNode.key.type !== 'Identifier'` and silently returns. The actual Babel `ClassProperty` key type union is:

```
key: Identifier | StringLiteral | NumericLiteral | BigIntLiteral | Expression
```

| Key type | Example | Plan handles? | Correct behavior |
|---|---|---|---|
| `Identifier` | `class C { name: string }` | YES | Create VARIABLE node |
| `StringLiteral` (computed=false) | `class C { 'name': string }` | NO (return) | Could create node; plan drops silently |
| `NumericLiteral` | `class C { 0: string }` | NO (return) | Edge case; acceptable to drop |
| `BigIntLiteral` | rare | NO (return) | Acceptable to drop |
| `Expression` (computed=true) | `class C { [Symbol.iterator]: T }` | NO (return) | Correct to drop |

**Gap:** `StringLiteral` keys with `computed: false` (e.g., `class C { 'myProp': string }`) are syntactically valid TypeScript. The plan silently drops them. This is an edge case and the plan correctly guards against computed keys — but the guard text says "if key is not Identifier", which incorrectly conflates non-Identifier keys with computed keys. The actual Babel flag for computed keys is `propNode.computed`, not `key.type`. The guard should be:

```typescript
if (propNode.computed) return;  // Skip computed keys: class { [Symbol.iterator]: T }
```

Using `propNode.key.type !== 'Identifier'` also silently drops string-keyed properties like `class C { 'my-prop': string }`, which have `computed: false` and a valid string name. This is a minor gap (string-keyed fields are rare in TypeScript), but the guard logic is wrong. The implementor should use `propNode.computed` as the guard and handle `StringLiteral` key names as a fallback.

---

### Table 2: ClassProperty Value Types (the primary classification)

The existing code already handles value-is-function. The plan adds the else branch for all other cases.

| Value type | Example | Plan handles? | Correct behavior |
|---|---|---|---|
| `ArrowFunctionExpression` | `handler = () => {}` | YES (existing if-branch → FUNCTION) | Correct |
| `FunctionExpression` | `handler = function() {}` | YES (existing if-branch → FUNCTION) | Correct |
| `null` / `undefined` (no initializer) | `private name: string` | YES (else branch → VARIABLE) | Correct |
| Primitive literal | `count = 0` | YES (else branch → VARIABLE) | Correct |
| String literal | `label = 'hello'` | YES (else branch → VARIABLE) | Correct |
| Object expression | `config = {}` | YES (else branch → VARIABLE) | Correct |
| Array expression | `items = []` | YES (else branch → VARIABLE) | Correct |
| New expression | `service = new Foo()` | YES (else branch → VARIABLE) | Correct |
| Call expression | `value = getValue()` | YES (else branch → VARIABLE) | Correct |
| Template literal | `msg = \`hello\`` | YES (else branch → VARIABLE) | Correct |
| Another class | `nested = class {}` | YES (else branch → VARIABLE) | Acceptable (not traversed as class) |

**No gaps in value type classification.** The binary split (function vs. everything-else) is correct.

---

### Table 3: TypeScript Modifiers

The plan proposes the following modifier derivation:

```typescript
const modifier = propNodeTyped.readonly ? 'readonly' : propNodeTyped.accessibility ?? 'public';
```

| Modifier combination | Example | Plan output | Correct? |
|---|---|---|---|
| No modifier | `name: string` | `'public'` (accessibility=undefined → 'public') | YES — explicit public is correct |
| `public` | `public name: string` | `'public'` | YES |
| `private` | `private name: string` | `'private'` | YES |
| `protected` | `protected name: string` | `'protected'` | YES |
| `readonly` (no access mod) | `readonly name: string` | `'readonly'` | YES (readonly takes precedence) |
| `public readonly` | `public readonly name: string` | `'readonly'` | **DEFECT — `public` is lost** |
| `private readonly` | `private readonly name: string` | `'readonly'` | **DEFECT — `private` is lost** |
| `protected readonly` | `protected readonly name: string` | `'readonly'` | **DEFECT — `protected` is lost** |
| `static` | `static name: string` | stored separately as `isStatic: true` | YES |
| `static private readonly` | `static private readonly name: string` | `isStatic: true`, modifier=`'readonly'` | `private` lost |
| `abstract` (on abstract class) | `abstract name: string` | DROPPED entirely (see Table 4) | DEFECT |
| `override` | `override name: string` | stored as `'public'` | information lost but acceptable |
| `declare` | `declare name: string` | stored as `'public'` | DEFECT — see Table 4 |

**Blocking defect:** The modifier field is modeled as a single string `'private' | 'public' | 'protected' | 'readonly'`. This cannot represent combinations like `private readonly`. A field with `private readonly` is both private AND readonly. The current encoding forces a choice, losing one modifier.

**Required fix:** Either:
1. Use separate boolean flags (`isPrivate`, `isPublic`, `isProtected`, `isReadonly`) stored in metadata — this matches how `isPrivate` and `isStatic` are already stored on the node, OR
2. Store `accessibility` and `readonly` as two distinct metadata fields (`metadata.accessibility` and `metadata.readonly`), which is cleaner and matches the Babel AST structure.

Option 2 is strongly preferred because it directly mirrors the Babel AST fields and does not lose information.

The proposed `modifier?: 'private' | 'public' | 'protected' | 'readonly'` type in `VariableDeclarationInfo` must be replaced with two fields: `accessibility?: 'public' | 'private' | 'protected'` and `isReadonly?: boolean`.

---

### Table 4: Special TypeScript ClassProperty Flags

The Babel `ClassProperty` interface (confirmed from `@babel/types` d.ts) has these fields not mentioned in the plan:

| Flag | Babel field | Example | Plan handles? |
|---|---|---|---|
| Abstract field | `abstract?: boolean \| null` | `abstract name: string` (in abstract class) | NO |
| Declare field | `declare?: boolean \| null` | `declare name: string` | NO |
| Definite assignment | `definite?: boolean \| null` | `name!: string` | NO (acceptable) |
| Optional field | `optional?: boolean \| null` | `name?: string` | NO (acceptable) |
| Override | `override?: boolean` | `override name: string` | NO (acceptable) |
| Variance (Flow only) | `variance?: Variance \| null` | Flow-specific | NO (acceptable) |

**`abstract` fields:** An abstract class field (`abstract name: string`) will be caught by the else branch and create a VARIABLE node. This is not necessarily wrong, but the node will have no indication it is abstract. This is an acceptable gap for v1 — abstract fields are uncommon. **Not blocking.**

**`declare` fields — blocking defect:** TypeScript `declare` fields are type-only declarations that emit NO JavaScript:

```typescript
class Foo {
  declare name: string;  // No JS output — purely for type system
}
```

The plan will create a VARIABLE node for `declare` fields exactly as it does for real fields. This is semantically wrong: `declare` fields have no runtime presence. Creating VARIABLE nodes for them may cause false positive results in queries (e.g., "what variables does this class have?").

**Required action:** The implementor must check `(propNode as any).declare === true` in the else branch and `return` early to skip `declare`-only fields, similar to how `propNode.computed` should be checked. This is a correctness issue, not just a gap.

---

### Table 5: ClassExpression vs. ClassDeclaration

The plan correctly identifies the duplication risk (Risk 2) and mandates the else branch be applied to both the `ClassDeclaration` handler (lines 249–334) and the `ClassExpression` handler (lines 728–781).

| Context | Plan covers? |
|---|---|
| `class Foo { ... }` (ClassDeclaration) | YES — Change 2 targets this |
| `const Foo = class { ... }` (ClassExpression, anonymous) | YES — both handlers mentioned |
| `const Foo = class Bar { ... }` (ClassExpression, named) | YES — same handler |
| Nested class inside method | YES — `propPath.parent !== classNode.body` guard handles this |
| Class expression as default export | YES — handled by ClassExpression handler |

**Note:** The `ClassExpression` handler does NOT have the decorator extraction that the `ClassDeclaration` handler has (compare lines 264–274 in `ClassDeclaration` vs. `ClassExpression` block). When adding the else branch to `ClassExpression`, decorator extraction should also be added there for consistency. The plan does not mention this, but it is a pre-existing omission, not introduced by REG-552.

---

### Table 6: Abstract Classes and Interfaces

| Input | Plan handles? | Correct? |
|---|---|---|
| Abstract class with concrete field | YES (treated as normal class) | YES — concrete fields should be indexed |
| Abstract class with `abstract` field | YES (creates VARIABLE) | ACCEPTABLE (see Table 4) |
| TypeScript `interface` | N/A — interfaces use `TSPropertySignature`, not `ClassProperty` | N/A |
| `declare class` (ambient module) | Creates VARIABLE nodes for declared fields | DEBATABLE — ambient classes are type-only |

---

### Table 7: Decorator Interaction

The plan analyzes the decorator risk (Risk 4) and concludes decorator handling "runs BEFORE the function/else check." Verifying against the actual code:

- `ClassDeclaration` handler (line 264–274): decorator extraction uses `propertyTargetId = \`PROPERTY#${className}.${propName}#...\``. This ID is **disconnected** from the new `fieldId` (semantic ID via `computeSemanticIdV2`).
- `ClassPrivateProperty` handler (lines 569–578): decorator extraction uses `variableId` as the target — the same ID created for the VARIABLE node.

**Structural inconsistency:** For `ClassPrivateProperty` (the reference pattern), the decorator `targetId` IS the VARIABLE node's semantic ID. For the new `ClassProperty` else branch, the decorator `targetId` will be the legacy `PROPERTY#...` format, NOT the field's VARIABLE node semantic ID.

The plan notes this in Risk 4 but marks it as "acceptable" without resolving it. This means: for TypeScript-modifier class fields with decorators, the DECORATOR node's `targetId` will point to a non-existent node (the `PROPERTY#...` ID is never stored anywhere). For `ClassPrivateProperty`, the link works correctly.

**This is a pre-existing inconsistency in decorator handling for ClassDeclaration.** REG-552 does not need to fix it, but it should be noted as a known issue. The plan should explicitly say "decorator-to-VARIABLE linking is out of scope for REG-552 and tracked separately."

---

### Table 8: `typeNodeToString` import verification

The plan states `typeNodeToString` is exported from `TypeScriptVisitor.ts`. Verified from source:

```
/packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts, line 36:
export function typeNodeToString(node: unknown): string {
```

**Confirmed: exported, no issue.**

---

### Table 9: Test Structure Verification

The plan proposes `test/unit/plugins/analysis/ast/class-property-declarations.test.ts` following the `property-access.test.ts` pattern.

Checking against the actual test file pattern:
- Uses `createTestDatabase` and `createTestOrchestrator` — matches.
- Uses `setupTest(backend, files)` helper — matches.
- Uses `backend.getAllNodes()` and filters — matches.
- Uses `assert.strictEqual`, `assert.ok` — matches.

**One gap:** The test file uses `n.isClassProperty` as a top-level node field to filter results:

```typescript
const varNodes = allNodes.filter(n => n.type === 'VARIABLE' && n.isClassProperty);
```

The plan's Change 3 (GraphBuilder variable buffering loop) extracts `modifier` and `tsType` into `metadata`, but does NOT extract `isClassProperty`. This means `isClassProperty` remains as a top-level node field — which is actually correct and intentional. The test filter is valid. **No gap here.**

**Missing test case:** There is no test for a class property with BOTH an accessibility modifier AND `readonly`:

```typescript
class Foo {
  private readonly db: Database;
}
```

This is the exact case that exposes the blocking defect in Table 3 (modifier encoding loses either `private` or `readonly`). A test for `private readonly` fields would catch the defect.

**Missing test case:** No test for `declare` fields:

```typescript
class Foo {
  declare name: string;
}
```

After the fix in Table 4, the test should verify that `declare` fields do NOT produce VARIABLE nodes.

---

## Gaps Found

1. **[BLOCKING] Modifier encoding loses `private readonly` / `protected readonly` combinations.** The `modifier?: 'private' | 'public' | 'protected' | 'readonly'` type can only store one value. `private readonly name: string` would store `'readonly'`, silently discarding `private`. Fix: store `accessibility` and `readonly` as two separate metadata fields.

2. **[BLOCKING] `declare` fields create spurious VARIABLE nodes.** TypeScript `declare name: string` emits no JavaScript and has no runtime presence. The else branch must check `(propNode as any).declare === true` and return early. Without this, `declare` fields appear as real class fields in the graph.

3. **[MINOR] Computed key guard uses wrong discriminant.** The plan uses `propNode.key.type !== 'Identifier'` to skip computed keys. The correct check is `propNode.computed === true`. Using key type incorrectly skips string-keyed non-computed properties (e.g., `'my-prop': string`). Fix: replace the guard with `if (propNode.computed) return;`, then handle both `Identifier` and `StringLiteral` key names.

4. **[MINOR] Missing test for `private readonly` combination.** Without this test, the blocking defect in gap #1 will not be caught by the test suite.

5. **[MINOR] Missing test for `declare` fields.** Without this test, the blocking defect in gap #2 will not be caught.

6. **[INFORMATIONAL] Decorator `targetId` for ClassDeclaration properties uses legacy format inconsistent with `ClassPrivateProperty`.** Not introduced by REG-552 but not resolved by it either. Should be called out explicitly in the plan as a known limitation.

---

## Precondition Issues

1. **Unverified assumption: `accessibility` is in Babel's `ClassProperty` type.** The plan casts with `as ClassProperty & { accessibility?: ... }`. This cast is UNNECESSARY — the Babel `@babel/types` d.ts already includes `accessibility?: "public" | "private" | "protected" | null` and `readonly?: boolean | null` directly on `ClassProperty`. The cast can be removed; `propNode.accessibility` and `propNode.readonly` can be accessed directly. This is a minor cleanup but the implementor should not add a redundant cast.

2. **Assumption verified: `typeNodeToString` is exported.** Confirmed at line 36 of `TypeScriptVisitor.ts`.

3. **Assumption verified: both ClassDeclaration and ClassExpression handlers must be updated.** Confirmed by reading both handlers (lines 249–334 and 728–781).

4. **Assumption verified: GraphBuilder variable buffering loop is at lines 275–278.** Confirmed — the loop is at lines 275–278 and passes `varDecl as unknown as GraphNode` directly with no stripping of fields.

5. **Unverified: snapshot tests affected.** The plan correctly identifies this (Risk 3) but does not enumerate which snapshot fixtures contain TypeScript class fields with modifiers. The implementor must run snapshots against the actual Grafema codebase fixtures to discover which tests will fail. The plan's mitigation (regenerate) is correct but incomplete — some regenerations may hide real regressions if the new node count is wrong.

---

## Summary of Required Changes to Plan

Before implementation, Change 1 (types.ts) must be revised:

**Current (flawed):**
```typescript
modifier?: 'private' | 'public' | 'protected' | 'readonly';
tsType?: string;
```

**Required:**
```typescript
accessibility?: 'public' | 'private' | 'protected';  // undefined = implicit public
isReadonly?: boolean;                                   // true for readonly modifier
tsType?: string;
```

And Change 2 (ClassVisitor else branch) must be revised:

1. Guard: `if (propNode.computed) return;` (not `if (propNode.key.type !== 'Identifier') return`)
2. Add: `if ((propNode as any).declare) return;` — skip declare-only fields
3. Remove the redundant cast `as ClassProperty & { accessibility?...; readonly?... }` — these fields exist on `ClassProperty` directly
4. Store `accessibility: propNode.accessibility ?? 'public'` and `isReadonly: propNode.readonly || false` separately

And Change 3 (GraphBuilder) must strip both `accessibility` and `isReadonly` (not `modifier`) and push them into metadata:

```typescript
const { accessibility: _accessibility, isReadonly: _isReadonly, tsType: _tsType, ...varData } = varDecl;
const node = varData as unknown as GraphNode;
if (_accessibility || _isReadonly || _tsType) {
  if (!node.metadata) node.metadata = {};
  if (_accessibility) (node.metadata as Record<string, unknown>).accessibility = _accessibility;
  if (_isReadonly) (node.metadata as Record<string, unknown>).readonly = true;
  if (_tsType) (node.metadata as Record<string, unknown>).type = _tsType;
}
this._bufferNode(node);
```

The test file must be updated to match the new field names (`metadata.accessibility` and `metadata.readonly` instead of `metadata.modifier`), and two new test cases added: one for `private readonly` combinations, one verifying `declare` fields produce no VARIABLE nodes.

The overall design (VARIABLE + metadata, HAS_PROPERTY edges, REG-271 pattern) is architecturally sound. The gaps are implementation-level defects in the type model, not architectural issues.
