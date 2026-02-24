## Dijkstra Plan Verification

**Verdict:** APPROVE (with one factual correction noted below)

**Completeness tables:** 2 (sequential path + parallel path)

---

## Sequential Path — createParameterNodes.ts

| Param form | AST node type | Don's proposed column source | Correct? |
|---|---|---|---|
| `function foo(p)` | `Identifier` | `param.loc?.start.column` | YES — `param` IS the Identifier |
| `function foo(p = 1)` | `AssignmentPattern` | `assignmentParam.left.loc?.start.column` | YES — `.left` is the Identifier `p` |
| `function foo(...args)` | `RestElement` | `restParam.argument.loc?.start.column` | YES — `.argument` is the Identifier `args`; column of `args` not `...` is consistent with how `.line` already works |
| `function foo({ x, y })` | `ObjectPattern` (via `extractNamesFromPattern`) | `paramInfo.loc.start.column` | YES — `extractNamesFromPattern` returns `loc: { start: { line, column } }` from `pattern.loc.start` (line 90 of `extractNamesFromPattern.ts`) |
| `function foo([a, b])` | `ArrayPattern` (via `extractNamesFromPattern`) | `paramInfo.loc.start.column` | YES — same extraction path as ObjectPattern |
| `function foo({ x, y } = {})` | `AssignmentPattern` wrapping `ObjectPattern` | `paramInfo.loc.start.column` | YES — `extractNamesFromPattern` is called on `assignmentParam.left` |
| `function foo({ data: { user } })` | Nested `ObjectPattern` (via `extractNamesFromPattern`) | `paramInfo.loc.start.column` | YES — recursive extraction reaches the `user` Identifier's `.loc.start` |
| `function foo(p: string)` | `Identifier` (TypeScript strips type at param node level) | `param.loc?.start.column` | YES — Babel's TypeScript parser keeps the Identifier's loc at the binding name |
| `function foo(p: string = 'x')` | `AssignmentPattern` with typed `.left` | `assignmentParam.left.loc?.start.column` | YES — `.left` is still the Identifier `p` |
| `constructor(private x: number)` | `TSParameterProperty` | NOT IN PLAN | NOT HANDLED — see Gap #1 below |
| `(p) => p` | `Identifier` | `param.loc?.start.column` | YES — arrow params go through same `FunctionVisitor` code path |
| `p => p` | `Identifier` | `param.loc?.start.column` | YES — unparenthesized arrow: Babel still gives Identifier with loc |

---

## Parallel Path — ASTWorker.ts

ASTWorker.ts only handles `param.type === 'Identifier'` (lines 410-421). Don's proposed fix: add `column: getColumn(param)`.

| Question | Finding |
|---|---|
| Is `getColumn` imported in ASTWorker.ts? | YES — line 23: `import { getLine, getColumn } from '../plugins/analysis/ast/utils/location.js'` |
| What is `param` at the push site? | `param` is the raw Babel AST node from `node.params.forEach((param, index) => ...)`. The guard `if (param.type === 'Identifier')` ensures it is a Babel `Identifier` node. |
| Does `getColumn(param)` give the correct column? | YES — `getColumn` returns `node?.loc?.start?.column ?? 0`. For an Identifier param, `.loc.start.column` is the column of the parameter name. Correct. |

---

## Gaps Found

- **Gap #1: `TSParameterProperty` (TypeScript constructor shorthand) is unhandled — by both the plan and the existing code.**
  `constructor(private x: number)` produces a `TSParameterProperty` AST node, NOT an `Identifier`. Neither `createParameterNodes.ts` nor ASTWorker.ts has a case for `TSParameterProperty`. This means constructor shorthand parameters are silently dropped entirely — no PARAMETER node is emitted at all. Don's plan does not address this.

  **Assessment:** This is a pre-existing bug, not introduced by REG-550. The task is specifically to add `column` to PARAMETER nodes. Since `TSParameterProperty` produces no PARAMETER node today, the fix scope is correct to exclude it. However, Rob's implementation must not introduce a regression where `TSParameterProperty` was previously handled (it was not).

- **Gap #2: Don says `getColumn` import "verify before assuming" — it IS already imported.**
  Don correctly hedged this as something to verify. Confirmed: line 23 of `ASTWorker.ts` imports `getColumn`. No risk here.

---

## Precondition Issues

- **Precondition claim: "extractNamesFromPattern already returns `loc.start.column`"**
  VERIFIED CORRECT. Line 90 of `extractNamesFromPattern.ts`:
  ```typescript
  loc: pattern.loc?.start ? { start: pattern.loc.start } : { start: { line: 0, column: 0 } },
  ```
  `pattern.loc.start` is the full Babel `Position` object which contains both `.line` and `.column`. Don's claim is accurate.

- **Precondition claim: "`column?: number` (optional) is correct for the interface"**
  Don proposes `column?: number` (optional). This is the safer choice because:
  1. It preserves backward compatibility — existing code that constructs `ParameterInfo` objects without a `column` field still compiles without modification.
  2. The parallel path (ASTWorker) produces PARAMETER nodes only for `Identifier` params. Non-Identifier params (destructuring) produce no PARAMETER nodes in ASTWorker. Using optional avoids a TypeScript error if ParameterInfo is ever constructed outside these two paths.
  3. `column: number` (required) would break existing `ParameterNode.create()` callers or any test helpers that build ParameterInfo directly.

  **Recommendation:** Keep `column?: number` as proposed by Don.

- **Precondition claim: "GraphBuilder correctly passes through all ParameterInfo fields"**
  Don claims no change needed in GraphBuilder. The mechanism: `const { functionId: _functionId, ...paramData } = param; this._bufferNode(paramData as GraphNode)` — the spread `...paramData` will include `column` once it is present in the `ParameterInfo` object. This is correct. No change to GraphBuilder required.

---

## Snapshot Regeneration Risk

Low risk. Don's approach (run `UPDATE_SNAPSHOTS=true`) is consistent with MEMORY policy ("Never manually predict which snapshot nodes change"). The only observable change in snapshots is that every PARAMETER node gains a `column` field. There is no structural change to node types, edges, or IDs. The regeneration is safe to proceed automatically.

---

## Summary

The plan is complete and correct for all parameter forms that the current codebase handles. The `TSParameterProperty` gap is pre-existing and out of scope. The `extractNamesFromPattern` return structure has been verified to include `column`. The `getColumn` import in ASTWorker.ts is confirmed present. The optional vs required interface decision is correct. Proceed to implementation.
