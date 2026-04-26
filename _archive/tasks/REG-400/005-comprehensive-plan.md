# Comprehensive Plan: REG-400 — Callback Function Reference Resolution

## Scope: ALL Resolvable Callback Patterns

### Part 1: Analysis Phase Fix (GraphBuilder.bufferArgumentEdges)

**1a. Identifier arguments → function declarations**

When `targetType === 'VARIABLE'` and variable not found in `variableDeclarations`:
- Also check `functions` array for matching name
- If found: set `targetNodeId = funcNode.id` (PASSES_ARGUMENT → FUNCTION)
- Also create CALLS edge: `{ type: 'CALLS', src: callId, dst: funcNode.id, metadata: { callType: 'callback' } }`

Covers:
- `function fn() {}; forEach(fn)` — function declarations
- `const fn = () => {}; forEach(fn)` — const-bound arrows (named from binding)

**1b. Identifier arguments → CALLS for VARIABLE targets too**

When `targetType === 'VARIABLE'` and variable IS found in `variableDeclarations`:
- PASSES_ARGUMENT already created (existing behavior)
- Additionally: check `functions` array for same-name function
- If found: also create CALLS edge (covers const-bound functions where both VARIABLE and FUNCTION exist)

**1c. MemberExpression arguments → create proper PASSES_ARGUMENT**

Currently MemberExpression arguments (`obj.method`) get `targetType = 'EXPRESSION'` but no PASSES_ARGUMENT edge (no targetId set → falls through silently).

Fix: when `expressionType === 'MemberExpression'` with `objectName` and `propertyName`:
- Try to resolve in `functions` array (for `this.method` where class methods are functions)
- Store `objectName` and `propertyName` in PASSES_ARGUMENT edge metadata for enrichment resolution

### Part 2: Enrichment Phase (CallbackCallResolver)

New plugin: `CallbackCallResolver` (priority 35, after MethodCallResolver at 50)

**Algorithm:**

```
Step 1: Build indices (reuse FunctionCallResolver/MethodCallResolver patterns)
  - functionIndex: Map<file, Map<name, FunctionNode>>
  - importIndex: Map<file:name, ImportNode>
  - exportIndex: Map<file, Map<key, ExportNode>>
  - classMethodIndex: Map<className, Map<methodName, FunctionNode>>

Step 2: Query all CALL nodes (both CALL_SITE and METHOD_CALL)

Step 3: For each CALL node, get PASSES_ARGUMENT edges

Step 4: For each PASSES_ARGUMENT edge, check target node:

  4a. Target is FUNCTION → CALLS already created in analysis, skip

  4b. Target is VARIABLE/CONSTANT:
      - Check if name matches import in same file
      - If import found: follow import chain (IMPORTS_FROM → EXPORT → FUNCTION)
      - Create CALLS from CALL node to resolved FUNCTION

  4c. Target has objectName/propertyName metadata (MemberExpression callback):
      - If objectName === 'this': find containing class, look up method
      - Else: check if objectName resolves to a class instance (INSTANCE_OF edge)
      - If class found: look up propertyName in class methods
      - Create CALLS from CALL node to resolved METHOD/FUNCTION
```

**Complexity:**
- Index building: O(f + i + e + c) — functions, imports, exports, class methods
- Processing: O(p) where p = PASSES_ARGUMENT edges (subset of all edges)
- Per edge: O(1) lookups in indices
- Total: **O(f + i + e + c + p)** — linear, one pass

### Part 3: What's NOT Handled (with clear technical reasons)

| Pattern | Why Not | What's Needed |
|---|---|---|
| `const fn = helper; forEach(fn)` | Need to follow ASSIGNED_FROM chain | Value tracking enricher |
| `forEach(obj.unknownMethod)` where obj type unknown | No type info for obj | Type inference system |
| `forEach(getHandler())` | Return value is callback | Return-type analysis |
| `forEach(console.log)` | External builtin | Skip (no source code) |

These are genuinely different capabilities that require new infrastructure, not deferred bugs.

## Files to Modify

1. `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` — bufferArgumentEdges fix
2. `packages/core/src/plugins/enrichment/CallbackCallResolver.ts` — NEW enricher
3. `packages/core/src/plugins/enrichment/index.ts` or registration — register new enricher
4. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` — register CALLS edge type (already exists)

## Test Plan

1. **Same-file function declaration**: `function fn() {}; arr.forEach(fn)` → CALLS
2. **Const-bound arrow**: `const fn = () => {}; arr.map(fn)` → CALLS
3. **Imported function**: `import {fn} from './m'; arr.filter(fn)` → CALLS
4. **this.method callback**: `class C { handle() {} init() { arr.forEach(this.handle) } }` → CALLS
5. **Instance method callback**: `const p = new Parser(); arr.forEach(p.parse)` → CALLS (if INSTANCE_OF exists)
6. **setTimeout/setInterval**: `setTimeout(fn, 100)` → CALLS
7. **Custom HOF**: `subscribe(handler)` → CALLS
8. **Non-callable args**: `forEach(42)`, `forEach({})` → no CALLS (regression)
9. **Multiple callbacks**: `reduce(fn, initial)` → CALLS only to fn, not initial
10. **Builtin member**: `forEach(console.log)` → skip (external)
