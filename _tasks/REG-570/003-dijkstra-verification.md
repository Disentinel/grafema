# Dijkstra Plan Verification — REG-570

**Verdict:** REJECT

---

## Completeness tables

### Table 1: Class member node types in Babel AST

All possible AST node types that can appear in a class body:

| Node type | Has initializer? | Plan handles it? | Verdict |
|-----------|-----------------|-----------------|---------|
| `ClassProperty` (public field) | `value?: Expression \| null` | Yes — `indexClassFieldDeclaration` | COVERED |
| `ClassPrivateProperty` (#field) | `value?: Expression \| null` | Yes — ClassPrivateProperty else-branch | COVERED |
| `ClassMethod` | No (it is the function) | Handled as FUNCTION — no VARIABLE node | NOT APPLICABLE |
| `ClassPrivateMethod` (#method) | No (it is the function) | Handled as FUNCTION — no VARIABLE node | NOT APPLICABLE |
| `StaticBlock` (static { ... }) | No initializer, it is a block | Handled by `analyzeFunctionBody` — produces SCOPE, not VARIABLE | NOT APPLICABLE |
| `ClassAccessorProperty` (accessor keyword, TC39) | `value?: Expression \| null` | **NOT HANDLED — MISSING FROM PLAN** | GAP |
| `TSDeclareProperty` / `TSAbstractPropertyDefinition` | Part of ClassProperty with `declare: true` | Filtered out by `!(propNode as any).declare` guard | COVERED |

### Table 2: `propNode.value` states for an uninitialized field

| JS source | Babel AST value field | Plan's `if (propNode.value)` result |
|-----------|----------------------|-------------------------------------|
| `name: string;` (TS declaration-only) | `undefined` (the `?` in `value?: Expression \| null`) | `false` — skipped correctly |
| `name;` (uninitialized JS field) | `null` | `false` — skipped correctly |
| `name = 0;` (initialized) | `NumericLiteral node` | `true` — tracked correctly |

The plan states that uninitialized fields have `propNode.value === null`. This is **imprecise**: the Babel type definition is `value?: Expression | null`, meaning it can be `undefined` OR `null`. However, the plan's guard `if (propNode.value)` is safe for both values (both are falsy). The imprecision in description is a documentation error, not a code error.

### Table 3: Computed property handling

| Computed field example | `propNode.computed` | Plan behavior |
|------------------------|---------------------|---------------|
| `[Symbol.iterator] = () => {}` | `true` | `indexClassFieldDeclaration` returns early at `if (propNode.computed) return;` |
| `['key'] = 42` | `true` | Returns early — no VARIABLE node, no ASSIGNED_FROM edge |
| `name = 42` | `false` | Proceeds normally |

The plan correctly acknowledges this guard. No VARIABLE node is created for computed fields, so no ASSIGNED_FROM edge is needed. Consistent.

### Table 4: `ClassExpression` handler coverage

`ClassDeclaration` handler's `classPath.traverse()` registers:
- `ClassProperty` — YES
- `ClassMethod` — YES
- `StaticBlock` — YES
- `ClassPrivateProperty` — YES
- `ClassPrivateMethod` — YES

`ClassExpression` handler's `classPath.traverse()` (lines 772–879) registers:
- `ClassProperty` — YES
- `ClassMethod` — YES
- `StaticBlock` — **NO**
- `ClassPrivateProperty` — **NO**
- `ClassPrivateMethod` — **NO**

The plan states at line 154: "ClassExpression at line 827 calls `this.indexClassFieldDeclaration(...)` and thus gets the fix automatically."

This is **partially correct and partially wrong**. For public fields (`ClassProperty`), ClassExpression DOES call `indexClassFieldDeclaration` — so the REG-570 fix to `indexClassFieldDeclaration` propagates there. But for **private fields** (`ClassPrivateProperty`), the ClassExpression handler has NO handler registered at all. Private fields in class expressions are entirely invisible. The REG-570 fix to the `ClassPrivateProperty` else-branch (Change 1e) only runs inside the `ClassDeclaration` handler — it will NOT run for class expressions with private fields.

**This is a correctness gap in the plan**: the plan's Change 1e claims to handle private fields but only does so for `ClassDeclaration`, not for `ClassExpression`.

### Table 5: `trackVariableAssignment` initializer type coverage

Exhaustive table of initializer expression types that class fields can have:

| Expression type | Example | Handled in `trackVariableAssignment`? |
|----------------|---------|--------------------------------------|
| `NumericLiteral` / `StringLiteral` / `BooleanLiteral` / `NullLiteral` | `= 0`, `= 'x'`, `= true`, `= null` | YES — branch 1 (ExpressionEvaluator) |
| `TemplateLiteral` (no expressions) | `` = `hello` `` | YES — ExpressionEvaluator returns cooked string, branch 1 |
| `TemplateLiteral` (with expressions) | `` = `${x}` `` | YES — branch 11 |
| `ArrayExpression` | `= [1, 2]` | YES — branch 0.6 |
| `ObjectExpression` | `= { a: 1 }` | YES — branch 0.5 |
| `ArrowFunctionExpression` / `FunctionExpression` | `= () => {}` | YES — branch 6, BUT ClassVisitor intercepts arrow/function values before calling `indexClassFieldDeclaration`, so `trackVariableAssignment` never sees them |
| `NewExpression` | `= new Map()` | YES — branch 5 |
| `CallExpression` (Identifier callee) | `= foo()` | YES — branch 2 |
| `CallExpression` (MemberExpression callee) | `= obj.foo()` | YES — branch 3 |
| `Identifier` | `= someVar` | YES — branch 4 |
| `ConditionalExpression` | `= a ? b : c` | YES — branch 9 |
| `BinaryExpression` | `= a + b` | YES — branch 8 |
| `MemberExpression` | `= obj.prop` | YES — branch 7 |
| `ClassExpression` | `= class {}` | YES — branch 14 |
| `LogicalExpression` | `= a \|\| b` | YES — branch 10 |
| `UnaryExpression` | `= !flag` | YES — branch 12 |
| `TaggedTemplateExpression` | `` = html`...` `` | YES — branch 13 |
| `SequenceExpression` | `= (a, b)` | YES — branch 17 |
| `AwaitExpression` | `= await foo()` | YES — branch 0 (recursion) |
| `TSAsExpression` / `TSNonNullExpression` etc. | `= x as T` | YES — branch 0.1 (recursion) |
| `OptionalCallExpression` | `= obj?.foo()` | YES — branch 15 |
| `OptionalMemberExpression` | `= obj?.prop` | YES — branch 16 |
| `AssignmentExpression` | `= (a = b)` | YES — branch 19 |
| `YieldExpression` | `= yield x` | YES — branch 18 |
| Unknown / unhandled | — | Fallback: console.warn, no edge created |

All realistic class field initializer types are handled.

### Table 6: `CounterRef` fallback correctness

The plan proposes:
```typescript
(collections.literalCounterRef ?? { value: 0 }) as CounterRef
```

This pattern is **unsafe in isolation**, but safe in context:

| Scenario | What happens |
|----------|-------------|
| `collections.literalCounterRef` is present (always the case when called from JSASTAnalyzer via `allCollections`) | The real shared counter object is used. Counter increments are shared across all calls. Correct. |
| `collections.literalCounterRef` is `undefined` (only possible if ClassVisitor were called independently in a test without full `allCollections`) | A NEW `{ value: 0 }` object is created on each call to `trackVariableAssignment`. Each call gets counter starting at 0. Counter increments are NOT shared. Could generate duplicate literal IDs for multiple literals in the same file. |

Since `allCollections` always provides all counter refs (confirmed at line 1841–1844 of JSASTAnalyzer), the fallback is dead code in production. But it is a latent trap in tests. The VariableVisitor uses the same `?? { value: 0 }` pattern (line 187–195 of VariableVisitor.ts), establishing this as an accepted convention. For test scenarios, the test must supply a real CounterRef or accept potential duplicate IDs.

**This is the same pattern VariableVisitor already uses — so it is an accepted convention, not a new bug introduced by the plan.**

---

## Gaps found

### Gap 1 (BLOCKER): `ClassPrivateProperty` in `ClassExpression` is unhandled

The `ClassExpression` handler in `ClassVisitor.ts` (lines 772–879) does NOT register a `ClassPrivateProperty` visitor. Class expressions with private field initializers will NOT generate `ASSIGNED_FROM` edges even after the plan's Change 1e is applied, because Change 1e only runs inside the `ClassDeclaration` handler.

**Concrete broken case:**
```typescript
const MyClass = class {
  #count = 42;  // No ASSIGNED_FROM edge after fix
};
```

The plan's Test 8 only exercises a public field in a class expression — it would pass even with this gap present.

**Required additional fix:** The `ClassExpression` handler's `classPath.traverse()` must be extended with a `ClassPrivateProperty` handler, identical to the one in `ClassDeclaration`, and the same `trackVariableAssignment` call must be added there.

### Gap 2 (MINOR): `ClassAccessorProperty` not addressed

Babel 7.x supports `ClassAccessorProperty` (the `accessor` keyword from the TC39 decorators proposal, node type `ClassAccessorProperty`). Neither `ClassDeclaration` nor `ClassExpression` handlers in `ClassVisitor.ts` register a `ClassAccessorProperty` visitor. Fields declared with `accessor` keyword have `value?: Expression | null` and would produce no VARIABLE node at all today.

This is a pre-existing gap, not introduced by this PR. However, the plan does not mention it, and Rob should be aware that `accessor count = 0;` will remain unhandled. This should be a separate task.

### Gap 3 (MINOR): Test suite does not cover `ClassExpression` with private fields

The plan's Test 8 only exercises a public field in a class expression. There is no test for:
```typescript
const MyClass = class {
  #count = 42;
};
```
This means Gap 1 above would not be caught by the proposed test suite.

---

## Precondition issues

### Precondition 1 (VERIFIED): `allCollections` contains all required counter refs

Verified at JSASTAnalyzer.ts lines 1841–1844:
```typescript
objectLiteralCounterRef, arrayLiteralCounterRef,
ifScopeCounterRef, scopeCounterRef, varDeclCounterRef,
callSiteCounterRef, functionCounterRef, httpRequestCounterRef,
literalCounterRef, anonymousFunctionCounterRef,
```
All counter refs are present. The `?? { value: 0 }` fallbacks are dead code in production. Precondition met.

### Precondition 2 (VERIFIED): `isClassProperty` is persisted to the graph node

Verified in `GraphBuilder.ts` lines 304–313: the loop over `variableDeclarations` only strips `accessibility`, `isReadonly`, and `tsType` before calling `_bufferNode`. `isClassProperty` remains in `varData` and is persisted to the graph. Therefore, when `DataFlowValidator` reads a VARIABLE node from the graph and tests `(variable as Record<string, unknown>).isClassProperty`, the field will be present for class properties. Precondition met.

### Precondition 3 (VERIFIED): `TrackVariableAssignmentCallback` cast is sufficient

`VariableVisitor.ts` already uses the cast `this.trackVariableAssignment.bind(this) as TrackVariableAssignmentCallback` at line 1799 of JSASTAnalyzer.ts. The callback type accepts `Node` for `initNode`, while `trackVariableAssignment` implementation accepts `t.Expression | null | undefined`. `Node` is a supertype of `t.Expression`, so the cast loses type safety but is runtime-correct. Confirmed acceptable per existing precedent.

### Precondition 4 (VERIFIED): `propNode.value` truthiness check is safe for both `null` and `undefined`

The Babel type definition is `value?: Expression | null`. The `?` makes `undefined` possible, `| null` makes `null` possible. The plan's `if (propNode.value)` check is falsy for both, so uninitialized fields are correctly skipped regardless of which absent-value representation Babel uses.

---

## Summary

The plan is **correct in its core design** — the pattern is sound, the collections are present, the callback is viable. One blocker prevents approval:

**Gap 1 is a blocker.** Private fields in class expressions will not get ASSIGNED_FROM edges. The fix for ClassPrivateProperty must be duplicated into the ClassExpression handler's `classPath.traverse()` block, and a corresponding test must be added. Rob must implement this additional change before the plan is complete.

All other findings are minor notes or pre-existing gaps outside this PR's scope.
