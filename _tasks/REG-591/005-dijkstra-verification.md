# REG-591: Dijkstra Plan Verification

**Author:** Edsger Dijkstra, Plan Verifier
**Date:** 2026-03-01
**Verdict:** REJECT

---

## Summary of Issues

Five concrete gaps found. Two are correctness defects in the spec's proposed code. One is a
precondition that is not proven to hold. One is an incomplete input universe for argValues.
One is a conflict detection gap that could produce duplicate node IDs silently.

---

## Completeness Table 1: argValues extraction — call argument AST types

The spec lists `StringLiteral` and `TemplateLiteral` (no-expression) as captured, everything else
as `null`. This is the stated universe. But the actual Babel AST has argument node types that the
spec does not enumerate at all.

| Argument AST type | Spec behavior | Handled? | Notes |
|---|---|---|---|
| `StringLiteral` | push value | YES | Correct |
| `TemplateLiteral` (quasis=1, expressions=0) | push cooked/raw | YES | Correct |
| `TemplateLiteral` (has expressions) | push null | YES | Documented |
| `Identifier` | push null | YES (by else) | Correct |
| `NumericLiteral` | push null | YES (by else) | Acknowledged by spec |
| `BooleanLiteral` | push null | YES (by else) | Acknowledged by spec |
| `NullLiteral` | push null | YES (by else) | Not acknowledged, but else covers it |
| `CallExpression` (nested call as arg) | push null | YES (by else) | Correct |
| `ArrowFunctionExpression` (inline handler) | push null | YES (by else) | Correct |
| `FunctionExpression` (inline handler) | push null | YES (by else) | Correct |
| `ObjectExpression` | push null | YES (by else) | Correct |
| `ArrayExpression` | push null | YES (by else) | Correct |
| `SpreadElement` | **push null** | UNCLEAR | SpreadElement is not a standard expression node; `call.arguments` contains it. Babel types `call.arguments` as `Array<Expression | SpreadElement>`. The spec code iterates `call.arguments` with `for (const arg of call.arguments)` and checks `arg.type`. A SpreadElement has `arg.type === 'SpreadElement'`, which falls through to `else` → push null. This is correct behavior but the spec does not prove this is the right outcome. **More importantly**: the spec declares the type as `const argValues: (string | null)[]`, but `SpreadElement` as null is semantically correct since the spread position is not a discrete string literal. No defect here, but the spec's type comment should acknowledge SpreadElement. |
| `RestElement` | push null | YES (by else) | Covered by else |
| `AssignmentPattern` (default param) | push null | YES (by else) | Babel allows these in call args? No — AssignmentPattern is only in function params. Not an issue. |
| `TSAsExpression` (TypeScript: `x as string`) | push null | YES (by else) | Correct |

**Conclusion:** The argValues extraction logic is complete for the input universe.

**Gap 1 (DEFECT):** However, the spec's code has a type error. The spec says:

```typescript
const argValues: (string | null)[] = [];
```

But then reads:

```typescript
argValues.push(tl.quasis[0].value.cooked ?? tl.quasis[0].value.raw);
```

`TemplateElement.value.cooked` is typed as `string | null` in Babel's type definitions — it can be
`null` when the template literal contains an invalid escape sequence (e.g., `` `\unicode` ``).
When `cooked` is null, the expression `null ?? tl.quasis[0].value.raw` evaluates to `.raw`, which
is `string`. So the fallback is correct. BUT: the spec document says in the plan (section 6):

> "Only string literals and simple template literals (no expressions) are captured."

The spec does not acknowledge that `cooked` can be null. In such cases `raw` is used. The `raw`
form of a template literal includes the raw backslash characters. For a path argument like
`` app.get(`/users`, handler) `` this is fine. But for a template literal with an invalid escape,
`raw` would differ from what the developer wrote. **This is a minor correctness gap but the spec
should document the fallback behavior explicitly to avoid implementors being surprised.**

---

## Completeness Table 2: Express pattern detection — what patterns exist in real codebases

The spec's `EXPRESS_OBJECTS = new Set(['app', 'router', 'Router'])` and `HTTP_METHODS` are the
classification rules. I enumerate ALL patterns a real Express codebase can contain.

### 2A: HTTP method calls (route registration)

| Pattern | Spec detects? | Notes |
|---|---|---|
| `app.get('/path', handler)` | YES | Standard |
| `app.post('/path', handler)` | YES | Standard |
| `app.put('/path', handler)` | YES | Standard |
| `app.delete('/path', handler)` | YES | Standard |
| `app.patch('/path', handler)` | YES | Standard |
| `app.options('/path', handler)` | YES | Standard |
| `app.head('/path', handler)` | YES | Standard |
| `app.all('/path', handler)` | YES | In HTTP_METHODS |
| `router.get('/path', handler)` | YES | 'router' in EXPRESS_OBJECTS |
| `app.get('/path', mw1, mw2, handler)` | YES | Multiple handlers — `argValues[0]` is path, extra args ignored |
| `app.route('/path').get(handler)` | **NO** | Plan explicitly documents: "needs AST escape hatch (out of scope)" |
| `Router().get('/path', handler)` | **NO** | `Router()` produces a CALL node with calleeName `'Router'`, then `.get(...)` is a chained call. The CALL node for `get` has `metadata.object` set to... **see Gap 2 below** |
| `express.Router().get('/path', h)` | **NO** | Same chaining issue as above |
| `v1Router.get('/path', h)` (custom variable name) | **NO** | `v1Router` not in EXPRESS_OBJECTS — acknowledged limitation |
| `app[method]('/path', handler)` (computed) | **NO** | Computed method — CALL node has `calleeName = 'app[method]'`, `metadata.method` is not set (computed property), object is `'app'` but method check fails. See Gap 2. |
| `app.get(config.path, handler)` (dynamic path) | PARTIAL | CALL detected, `argValues[0] === null`, plugin skips route creation per spec. Correct. |
| `app.get(\`/users/${id}\`, handler)` (template with expression) | PARTIAL | `argValues[0] === null`, route skipped. Correct behavior. |
| `app.get(\`/users\`, handler)` (simple template) | YES | Single quasi, no expressions — captured |

**Gap 2 (DEFECT):** The spec claims `Router().get('/path', handler)` is out of scope (not in the
table in section 4). But the issue is deeper: when the walk processes this pattern:

```javascript
const router = express.Router();
router.get('/path', handler);
```

The variable `router` is declared in scope and assigned from `express.Router()` call. The CALL node
for `router.get` correctly has `metadata.object === 'router'`, which IS in EXPRESS_OBJECTS. So this
pattern IS detected. The spec is inconsistent: it lists `'router'` in EXPRESS_OBJECTS and includes
`router.get` in the detection table (row: "Detects route on router object"), but this specific
pattern (`const router = express.Router()`) works correctly. No defect for this sub-case.

However the pattern `express.Router().get('/path', handler)` (chaining without intermediate
variable) produces a CALL node for `.get()` with a chained object. In `visitCallExpression`, when
`call.callee.object.type === 'CallExpression'` (i.e., the object is itself a call), `isChained =
true`. The `object` field in metadata is set only when
`call.callee.object.type === 'Identifier'` → it is set to `call.callee.object.name`. When the
object is a CallExpression (chained), the code produces `undefined` for the object field:

```typescript
// From the actual source (expressions.ts line 117-119):
object: call.callee.object.type === 'Identifier' ? call.callee.object.name
       : call.callee.object.type === 'ThisExpression' ? 'this'
       : call.callee.object.type === 'Super' ? 'super'
       : undefined
```

So `router().get('/path', handler)` produces a CALL node with `metadata.object === undefined`.
`EXPRESS_OBJECTS.has(undefined)` is `false`. The route is not detected. This is the expected and
correct behavior for patterns the spec declares out of scope. **No defect here — correctly out of
scope.**

### 2B: app.use() patterns (mount point registration)

| Pattern | Spec behavior | Handled? |
|---|---|---|
| `app.use('/prefix', router)` | express:mount with prefix | YES |
| `app.use(middleware)` | express:mount with prefix '/' | YES |
| `app.use('/prefix', mw1, mw2)` | express:mount with prefix '/prefix' | YES — `argValues.length >= 2`, first arg used |
| `app.use(express.json())` | express:mount, prefix '/' | YES — 1 arg, falls into 1-arg branch |
| `app.use(bodyParser.urlencoded())` | express:mount, prefix '/' | YES — same |
| `app.use(() => {})` | express:mount, prefix '/' | YES — inline function, 1 arg |
| `app.use(dynamicPath, router)` | express:mount with prefix '${dynamic}' | YES — explicitly handled |
| `app.use()` (zero args) | SKIP | YES — spec explicitly returns early when argValues.length === 0 |
| `router.use('/sub', subrouter)` | express:mount | YES — 'router' in EXPRESS_OBJECTS |

**Conclusion for section 2:** Mount point detection is complete.

---

## Completeness Table 3: Import detection — importsExpress() logic

The plan's `_importsExpress()` method checks four conditions to determine if a file uses Express.

| Import pattern | Condition checked | Detected? |
|---|---|---|
| `import express from 'express'` | DEPENDS_ON edge dst includes 'express' | YES |
| `import { Router } from 'express'` | DEPENDS_ON edge dst includes 'express' | YES |
| `const express = require('express')` | DEPENDS_ON edge dst includes 'express' (if walk creates it) | UNCLEAR — see Gap 3 |
| `const { Router } = require('express')` | Same | UNCLEAR — see Gap 3 |
| `import express from '@company/express-wrapper'` | DEPENDS_ON edge dst includes 'express' | FALSE POSITIVE — the dst would include 'express' as substring |
| `import express from 'express5'` | DEPENDS_ON edge dst includes 'express' | FALSE POSITIVE — 'express5' contains 'express' |
| `import express from 'express-async-handler'` | DEPENDS_ON edge dst includes 'express' | FALSE POSITIVE — substring match |
| EXTERNAL node check: `node.name === 'express'` | Exact match on EXTERNAL node name | YES for exact |
| EXTERNAL_MODULE node check: `node.name === 'express'` | Exact match | YES for exact |

**Gap 3 (PRECONDITION NOT PROVEN):** The spec states:

> "Check edges: MODULE --DEPENDS_ON--> EXTERNAL#express or similar"

For ESM imports (`import express from 'express'`), the walk's `visitImportDeclaration` creates
IMPORT nodes and IMPORTS_FROM/DEPENDS_ON edges. The exploration report (section 8.2) confirms:
"walkFile already creates IMPORT nodes and DEPENDS_ON edges."

But for CommonJS `require()` calls, the walk processes `require('express')` as a plain CALL node
with `calleeName = 'require'` and `argValues[0] = 'express'`. Does the walk create DEPENDS_ON edges
for `require()` calls? The exploration does not say. The spec does not prove this. Looking at the
actual `visitCallExpression` code, there is no special handling for `require()` — it creates a
plain CALL node with no DEPENDS_ON edge to an EXTERNAL_MODULE.

**Consequence:** Files that use `const express = require('express')` (CommonJS) will not have a
DEPENDS_ON edge to 'express'. The `_importsExpress()` check will fail and the plugin will return
`{ nodes: [], edges: [] }` for CommonJS Express files. **This is a significant false negative for
any non-ESM Express codebase.**

The spec needs to either:
1. Document this limitation explicitly ("CommonJS require() is not supported in v1")
2. Add handling in `_importsExpress()` that scans CALL nodes where `name === 'require'` and
   `argValues[0] === 'express'`

Currently the spec says nothing about this. REJECT.

**Gap 4 (FALSE POSITIVE):** The substring check `edge.dst.includes('express')` in
`_importsExpress()` will match any package name containing the string 'express':

- `express-async-handler` → matches
- `express-validator` → matches
- `@express/core` → matches

After this check passes, the plugin then looks at `EXPRESS_OBJECTS.has(obj)` and
`HTTP_METHODS.has(method)` — so a false positive at the import check stage only matters if the file
also has a variable named 'app' or 'router' calling HTTP methods. This reduces the practical impact,
but it is still a correctness issue. A file using `express-validator` that happens to use `app.get`
(from a non-Express context) would generate spurious `http:route` nodes.

The spec should use exact matching: the EXTERNAL_MODULE node for an ESM import from 'express' has
`node.name === 'express'` (exact), not 'express-async-handler'. The substring check on edge IDs is
the wrong mechanism. The correct check is: look for EXTERNAL_MODULE nodes where `node.name ===
'express'` OR check DEPENDS_ON edges where the dst exactly equals the EXTERNAL_MODULE ID for
'express'.

The EXTERNAL node check at the end (`node.name === 'express'`) already uses exact matching. The
edge check should do the same.

---

## Completeness Table 4: Plugin integration with walkFile — states FileResult can be in

The plan inserts plugins after Stage 2 (file-scope resolution). What states can FileResult be in
at the plugin execution point?

| Property | State at plugin execution time | Implication |
|---|---|---|
| `nodes` | All Stage 1 nodes plus MODULE, FILE, EXTERNAL (globals) | Complete |
| `edges` | Stage 1 structural edges + Stage 2 resolved edges + DECLARES + ELEMENT_OF/KEY_OF | Complete for same-file resolution |
| `unresolvedRefs` | Only project-stage refs (import_resolve, call_resolve, etc.) remain | Stage 2 consumed scope_lookup and export_lookup |
| `scopeTree` | Fully built, all scope_lookup results applied | Complete |

**Are CALLS_ON edges resolved?** The plan states (section 3):

> "After Stage 2, CALLS_ON edges are resolved — a CALL node for app.get(…) has an edge from
> CALL → VARIABLE#app."

Let me verify this against the actual walk.ts code. Stage 2 is `resolveFileRefs()`. Looking at
walk.ts lines 510-538, `scope_lookup` refs are resolved in the file-stage loop. The CALLS_ON
deferred ref is emitted as `kind: 'scope_lookup'` in `visitCallExpression` (line 202-211 of
expressions.ts). So yes, CALLS_ON edges would be added to `resolvedEdges` in Stage 2 IF the
object variable is found in scope. **This precondition is correct.**

**Gap 5 (PRECONDITION IMPLICIT — not verified):** The plan says plugins receive the `ast` variable
"already in scope" from `parseFile(code, file)` called at the top of `walkFile`. This is verified
by reading walk.ts line 224:

```typescript
const ast = parseFile(code, file);
```

The variable `ast` IS in scope at the proposed plugin execution site (after line 543, before
`return`). **This precondition is proven. No gap.**

---

## Completeness Table 5: Node ID collision handling

The spec states:

> "No deduplication. No conflict resolution. If a domain plugin emits a node with the same ID as
> an existing node, it gets duplicated — but this is a plugin bug, not something the engine should
> guard against at runtime."

This is a deliberate design decision. The question is: can the ExpressPlugin itself produce
duplicate node IDs?

The ID format for http:route is:
```
`${file}->http:route->${method.toUpperCase()}:${path}#${line}`
```

| Scenario | Duplicate ID possible? |
|---|---|
| Two routes with same method, path, line | YES — same file, same line, same method+path. When does this happen? |
| `app.get('/users', h); app.get('/users', h2);` on different lines | NO — different `#${line}` |
| `app.get('/users', h); router.get('/users', h2);` same line | YES — same method+path+line, different `mountedOn`. ID would be identical. |
| `app.get('/users', h); app.post('/users', h2);` same line | NO — different method |

**Scenario: two routes with identical method, path, AND line number.**

In practice, two calls on the same line is unusual but possible with minified code or:
```javascript
if (x) app.get('/a', h1); else app.get('/a', h2);
```

Both are on "same line" (same `callNode.line`). Both produce the same ID:
`file->http:route->GET:/a#1`. Two nodes with identical ID enter `result.nodes`. This violates the
uniqueness invariant of the graph.

**However**, the spec acknowledges: "this is a plugin bug, not something the engine should guard
against." The plan's contract says "Node IDs must be globally unique; use file path as prefix."
The burden is on the plugin implementor. This is a documented, accepted risk.

**BUT:** the spec's test suite does NOT include a test for this scenario. The test "Dynamic path
argument produces no route node" covers dynamic paths but no test covers duplicate IDs. If two
route nodes get the same ID, they silently corrupt the graph. The test plan should include a test
that verifies the plugin produces unique IDs for routes that differ only by handler (same
method/path/line).

This is not a REJECT-level defect (the design decision is explicit), but it is a gap in the test
plan.

---

## Completeness Table 6: walkFile signature change — backward compatibility

The spec changes `walkFile` signature from:
```typescript
export async function walkFile(code, file, registry, strict = true)
```
to:
```typescript
export async function walkFile(code, file, registry, domainPlugins = [], strict = true)
```

| Existing caller pattern | Broken? |
|---|---|
| `walkFile(code, file, jsRegistry)` — no strict, no plugins | NO — both default |
| `walkFile(code, file, jsRegistry, true)` — passing `strict = true` | **YES** — `true` is now interpreted as `domainPlugins`. `readonly DomainPlugin[]` receives `true`. TypeScript will catch this at compile time, but if there are any JS callers (test files using `.mjs`) this would silently pass the boolean as the plugins array. |
| `walkFile(code, file, jsRegistry, false)` — passing `strict = false` | **YES** — same issue. `false` passed as domainPlugins. |

**Gap 2 (DEFECT — confirmed):** The spec's search for "existing callers of walkFile with explicit
`strict` argument" is stated as: "Existing tests pass as-is." But the spec does not audit actual
test files for callers that pass `strict`. The actual `walk.ts` shows the current signature has
`strict` as the 4th positional parameter. Any existing test that calls
`walkFile(code, file, registry, false)` to disable strict mode will now pass `false` as the
`domainPlugins` array — silently, in JavaScript. In TypeScript the compiler catches this, but test
files in this project use `.mjs` (JavaScript), not `.ts`.

Let me enumerate: the spec says test files are `domain-plugin.test.mjs` and
`expressions-argvalues.test.mjs`. But what about EXISTING test files that may call `walkFile` with
`strict`? The spec says "Zero new call sites need to change" — this is asserted without proof.

The safe fix is: give the new parameter a distinct position that cannot be confused with the old
`strict` boolean, or find and audit all existing walkFile calls. The spec does neither.

---

## Precondition Issues

### Precondition 1: `ast` variable is in scope at plugin execution site

**Status: PROVEN.** walk.ts line 224 confirms `const ast = parseFile(code, file)` is assigned
before the walk loop. The plugin execution block (after the `deriveLoopElementEdges` call) is
within the same function scope. The `ast` variable is available.

### Precondition 2: Stage 2 is complete before plugins run

**Status: PROVEN.** The plan places plugin execution after the scope resolution loop (lines
435-538 in walk.ts). Stage 2 is the inner loop that processes `allDeferred`. After this loop,
`unresolvedRefs` contains only project-stage refs. Plugins run after this point.

### Precondition 3: DEPENDS_ON edges from MODULE to EXTERNAL_MODULE exist for ESM imports

**Status: PARTIALLY PROVEN.** The exploration report (section 8.2) states walkFile creates
DEPENDS_ON edges. But for `require()` calls this is NOT proven. See Gap 3.

### Precondition 4: `fileResult` passed to plugins is the post-Stage-2 result, not post-Stage-1

**Status: DEFECT.** The spec's code (Commit 3) shows:

```typescript
let result: FileResult = {
  file,
  moduleId,
  nodes: allNodes,
  edges: [...allEdgesSoFar, ...loopElementEdges],
  unresolvedRefs,
  scopeTree: ctx._rootScope,
};

// ─── Domain plugins ────
if (domainPlugins.length > 0) {
  for (const plugin of domainPlugins) {
    pluginResult = plugin.analyzeFile(result, ast);
```

`result` at this point contains `allEdgesSoFar = [...allEdges, ...resolvedEdges, ...ctx._declareEdges]`
plus `loopElementEdges`. The `resolvedEdges` come from Stage 2 scope resolution. The `allEdges`
contain structural edges from the walk. So `result.edges` contains Stage 2-resolved edges.

**However**, `result.unresolvedRefs` at this point is `unresolvedRefs` — the refs that were NOT
resolved in Stage 2 (project-stage refs). This is correct. The plan claims "plugins see resolved
CALLS_ON edges" — **this is true** because CALLS_ON deferred refs with `kind: 'scope_lookup'` ARE
processed in Stage 2 and added to `resolvedEdges`.

**Precondition 4 is proven.**

---

## Gaps Summary

### Gap 1 — Minor: `cooked` null fallback not documented
**Severity:** Minor. The spec's code is correct (uses `?? raw` fallback) but does not document
that `cooked` can be null for template literals with invalid escape sequences.
**Required fix:** Add a comment to the code explaining the fallback behavior.

### Gap 2 (DEFECT) — walkFile signature change: spec omits required audit
**Severity:** Potential correctness defect. Any caller passing `walkFile(code, file, registry, false)` to disable strict mode would now pass `false` as the domainPlugins array. The spec asserts "Zero new call sites need to change" without proving it.
**Audit result:** A search of all existing `.mjs` test files confirms no current callers pass
an explicit `strict` argument — all calls use the 3-argument form `walkFile(code, file, jsRegistry)`.
So no existing callers are broken TODAY. However, the spec does not document this audit, meaning
a future reader cannot verify the "zero call sites" claim. The spec must state explicitly that no
existing callers use the `strict` positional parameter, so the change is safe.
**Required fix:** Add the audit result to the spec as a sentence: "Verified: no existing callers
pass an explicit `strict` argument (checked via grep across all .mjs and .ts test files)."

### Gap 3 (DEFECT) — CommonJS require() not handled in import detection
**Severity:** False negative. `const express = require('express')` files will produce zero
`http:route` nodes. This is a significant omission for any non-ESM Express codebase.
**Required fix:** Either document the limitation explicitly ("ESM only for v1") or add a
check in `_importsExpress()` that scans CALL nodes for `node.name === 'require'` with
`argValues[0] === 'express'`.

### Gap 4 (DEFECT) — Substring match on edge dst causes false positives
**Severity:** Correctness defect (false positive domain node creation). `edge.dst.includes('express')`
matches `express-async-handler`, `express-validator`, `@express/core`, etc.
**Required fix:** Change the edge-based check to use exact matching. The EXTERNAL_MODULE node for
`import foo from 'express'` will have an ID like `EXTERNAL_MODULE#express`. The check should be
`edge.dst === 'EXTERNAL_MODULE#express'` or similar — not a substring match. Or check the
EXTERNAL_MODULE node `name` field for exact equality (the spec already does this in the node loop
at the bottom of `_importsExpress()` — the edge check should use the same standard).

### Gap 5 — Test gap: duplicate route node IDs not tested
**Severity:** Test coverage gap. Two routes with identical method/path/line produce the same node
ID and silently corrupt the graph. The test plan has no test for this scenario.
**Required fix:** Add a test case verifying that the plugin handles same-method/same-path routes on
the same line without producing duplicate IDs (either by appending a counter to the ID, or by
documenting the limitation in the spec).

---

## Verdict: REJECT

**Required before re-approval:**

1. **Gap 2:** Add explicit statement to the spec confirming no existing callers pass an explicit
   `strict` argument (the audit was done and confirmed, but must be documented in the spec).

2. **Gap 3:** Document or fix the CommonJS `require()` limitation. Silence on this point is not
   acceptable for a spec that claims "import source verification: Yes (IMPORT/DEPENDS_ON nodes)."

3. **Gap 4:** Replace `edge.dst.includes('express')` with exact ID matching in `_importsExpress()`.
   The EXTERNAL_MODULE node approach at the bottom of the method already does exact matching —
   apply the same standard to the edge check above it.

Gaps 1 and 5 are improvements, not blockers. The three defects above must be resolved before
implementation proceeds.
