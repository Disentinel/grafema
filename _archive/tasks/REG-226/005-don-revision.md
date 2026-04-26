# REG-226: ExternalCallResolver - Don Melton Revision

## Summary

Linus raised four critical issues. I have researched the codebase and made decisions on each. This document provides decisions with evidence and justification.

---

## Issue 1: Node Metadata Strategy - DECISION: Option B

### Linus's Analysis

Linus correctly identified that `graph.updateNode()` does not exist in GraphBackend. The plan assumed we could add `resolutionType` metadata to CALL nodes after creation.

**Evidence from GraphBackend.ts (lines 75-108):**
```typescript
// Node Operations
abstract addNode(node: NodeRecord): Promise<void>;
abstract addNodes(nodes: NodeRecord[]): Promise<void>;
abstract getNode(id: string): Promise<NodeRecord | null>;
abstract nodeExists(id: string): Promise<boolean>;
abstract deleteNode(id: string): Promise<void>;
abstract findByAttr(query: AttrQuery): Promise<string[]>;
// NO updateNode() method
```

### Options Analysis

**Option A: Add metadata at creation time (during JSASTAnalyzer)**
- Requires JSASTAnalyzer to understand external imports at analysis phase
- Would couple analysis phase with enrichment concerns
- JSASTAnalyzer already has 2400+ lines - adding this complexity increases maintenance burden
- Violates separation of concerns: analysis should capture AST structure, enrichment should add semantic meaning

**Option B: Derive resolution type from graph structure (recommended)**
- ExternalCallResolver creates CALLS edges to EXTERNAL_MODULE
- CallResolverValidator derives resolution type from graph structure:
  - Has CALLS edge to FUNCTION -> resolved (internal)
  - Has CALLS edge to EXTERNAL_MODULE -> resolved (external)
  - Has CALLS edge to EXTERNAL_FUNCTION -> resolved (builtin, via NodejsBuiltinsResolver)
  - Call name matches JS_BUILTINS set -> builtin (no edge needed)
  - Otherwise -> unresolved
- Simpler, follows existing patterns

### Decision: Option B

**Justification:**

1. **Existing resolvers don't update nodes** - FunctionCallResolver, MethodCallResolver, NodejsBuiltinsResolver all ONLY create edges. They don't modify existing nodes.

2. **Graph structure IS the metadata** - The presence of a CALLS edge to EXTERNAL_MODULE tells us it's external. This is the Grafema way.

3. **CallResolverValidator already queries graph structure** - It uses Datalog to find CALL nodes without CALLS edges. Extending this to check edge destinations is natural.

4. **Avoids adding updateNode() to GraphBackend** - Adding updateNode() would require changes to RFDB server (Rust), all backends, and could introduce race conditions in parallel analysis.

**What ExternalCallResolver will do:**
- Create CALLS edges from CALL to EXTERNAL_MODULE (for external package calls)
- Create CALLS edges from CALL to builtin marker node (if we want, or just skip - see below)
- NOT create edges for JS builtins - CallResolverValidator will recognize them by name

**What CallResolverValidator will do (in REG-227):**
- Recognize CALL nodes with CALLS to EXTERNAL_MODULE as resolved
- Recognize CALL nodes with CALLS to EXTERNAL_FUNCTION as resolved (Node.js builtins)
- Recognize CALL nodes where name is in JS_BUILTINS as resolved (no edge needed)
- Report remaining as unresolved

---

## Issue 2: Built-ins List Scope - DECISION: Linus is RIGHT

### Linus's Analysis

Linus correctly identified that Joel's JS_BUILTINS list is too broad. It includes constructors (`Array`, `Object`, `Error`, etc.) that:
1. Are not called as functions - they're constructors or objects
2. Have methods (`Array.from()`, `JSON.parse()`) that should be tracked
3. Conflict with MethodCallResolver which handles `object.method()` calls

**Evidence from MethodCallResolver.ts (lines 328-337):**
```typescript
private isExternalMethod(object: string, method: string): boolean {
  const externalObjects = new Set([
    'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
    'Boolean', 'Date', 'RegExp', 'Error', 'Promise', 'Set', 'Map',
    'WeakSet', 'WeakMap', 'Symbol', 'Proxy', 'Reflect', 'Intl',
    'process', 'global', 'window', 'document', 'Buffer',
    'fs', 'path', 'http', 'https', 'crypto', 'os', 'url', 'util'
  ]);
  return externalObjects.has(object);
}
```

MethodCallResolver already handles `Array.from()`, `JSON.parse()`, etc. by recognizing them as external methods and skipping resolution.

### Correct JS_BUILTINS List

```typescript
const JS_BUILTINS = new Set([
  // Global functions (truly called as standalone functions)
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',

  // Timers (global functions in browser & Node.js)
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',

  // CommonJS (special case - global in CJS environments)
  'require'
]);
```

**What is NOT in this list:**
- Constructors: `Array`, `Object`, `Error`, `Date`, `Promise`, etc.
  - If called as `new Array()` - handled as constructor call (CONSTRUCTOR_CALL node)
  - If called as `Array()` - rare, but same handling
- Objects with methods: `Math`, `JSON`, `Reflect`, `Intl`, etc.
  - `Math.abs()` -> METHOD_CALL with object='Math' -> MethodCallResolver skips
- Environment globals: `window`, `document`, `global`, `globalThis`, `process`
  - These are NOT functions, they're objects
  - `window.alert()` -> METHOD_CALL -> handled by MethodCallResolver

**Why `require` is included:**
- `require('./foo')` is a standalone function call, not a method call
- It's a global in CommonJS environments (like `eval`)
- It doesn't need a CALLS edge - it's part of the module system

---

## Issue 3: Priority Order - DECISION: 70 is CORRECT

### Linus's Questions

1. Why before MethodCallResolver (50)?
2. Why before NodejsBuiltinsResolver (45)?
3. Could we run at priority 40 (after methods)?

### Dependency Analysis

**Current enrichment pipeline:**
```
100: InstanceOfResolver         - INSTANCE_OF edges for class instances
 90: MountPointResolver         - Route prefix resolution
 90: ImportExportLinker         - IMPORTS_FROM edges
 80: FunctionCallResolver       - CALLS edges for internal function calls
 80: PrefixEvaluator            - Route prefix evaluation
 70: ExternalCallResolver (NEW) - CALLS edges for external package calls
 60: AliasTracker               - ALIAS_OF edges
 50: MethodCallResolver         - CALLS edges for method calls
 50: HTTPConnectionEnricher     - HTTP connection analysis
 45: NodejsBuiltinsResolver     - CALLS edges for Node.js builtin calls
 45: ArgumentParameterLinker    - PASSES_TO edges
 45: RustFFIEnricher            - Rust FFI connections
```

### Why 70 is correct:

**1. ExternalCallResolver MUST run after FunctionCallResolver (80):**

FunctionCallResolver handles **relative imports** (internal calls):
```typescript
// From FunctionCallResolver.ts lines 75-77
const isRelative = imp.source && (imp.source.startsWith('./') || imp.source.startsWith('../'));
if (!isRelative) continue;
```

ExternalCallResolver handles **non-relative imports** (external packages). These are mutually exclusive. ExternalCallResolver depends on FunctionCallResolver NOT having created CALLS edges for external imports.

**2. ExternalCallResolver SHOULD run before MethodCallResolver (50):**

ExternalCallResolver only processes CALL nodes WITHOUT `object` attribute:
```
CALL without object attribute -> function call -> ExternalCallResolver
CALL with object attribute -> method call -> MethodCallResolver
```

There's no strict dependency here - they handle different node subsets. But running ExternalCallResolver first ensures:
- CALL nodes get processed for external package resolution
- MethodCallResolver can focus purely on method calls
- Clear pipeline: functions resolved first, then methods

**3. ExternalCallResolver SHOULD run before NodejsBuiltinsResolver (45):**

NodejsBuiltinsResolver handles **module-qualified** builtins:
- `fs.readFile()` - method call on imported `fs` module
- `import { readFile } from 'fs'; readFile()` - direct call from imported function

ExternalCallResolver handles **package imports** and **JS builtins**:
- `import { map } from 'lodash'; map()` - external package call
- `parseInt('42')` - JS builtin (no edge needed)

**No overlap:**
- JS builtins (parseInt, setTimeout) - handled by ExternalCallResolver (recognition only)
- Node.js builtins (fs.readFile) - handled by NodejsBuiltinsResolver

The ordering ensures clear separation: ExternalCallResolver handles JS-level primitives, NodejsBuiltinsResolver handles Node.js-level primitives.

**4. Why NOT priority 40 (after methods)?**

Could technically work, but:
- Breaks logical order: functions -> external functions -> methods -> builtin methods
- Creates confusing pipeline: internal functions, then methods, then external functions
- No benefit - ExternalCallResolver doesn't depend on MethodCallResolver

**Conclusion: Priority 70 is architecturally correct.**

---

## Issue 4: Test Coverage - ADDITIONAL CASES NEEDED

Linus identified missing test cases. Here are the decisions:

### 1. Namespace imports

```javascript
import * as _ from 'lodash';
_.map(arr, fn);  // How is this handled?
```

**Analysis:** This is a METHOD_CALL with object='_'. ExternalCallResolver SKIPS it (has `object` attribute). This is CORRECT because:
- It's a method call pattern
- MethodCallResolver handles it
- MethodCallResolver checks `isExternalMethod()` and skips resolution

**Test case:** Verify ExternalCallResolver skips namespace import method calls.

### 2. Aliased imports

```javascript
import { map as lodashMap } from 'lodash';
lodashMap();  // Should create CALLS to EXTERNAL_MODULE:lodash
```

**Analysis:** IMPORT node has:
- `local='lodashMap'` (how it's used in this file)
- `imported='map'` (original name from source module)
- `source='lodash'`

ExternalCallResolver should:
- Match CALL(name='lodashMap') to IMPORT(local='lodashMap')
- Create CALLS edge to EXTERNAL_MODULE:lodash
- Edge metadata: `{ exportedName: 'map' }` (the IMPORTED name, not local name)

**Test case:** Verify aliased imports use `imported` name for edge metadata.

### 3. Mixed resolution in single file

```javascript
import { foo } from './utils';  // Internal
import { bar } from 'lodash';   // External
parseInt('42');                 // Builtin
unknownFunc();                  // Unresolved
```

**Test case:** Full pipeline test with all four resolution types in single file.

### 4. Re-exported external modules

```javascript
// utils.js
export { map } from 'lodash';

// main.js
import { map } from './utils';
map();  // Should this link to EXTERNAL_MODULE:lodash?
```

**Analysis:** This is a DESIGN DECISION.

FunctionCallResolver already follows re-export chains for internal functions. Should ExternalCallResolver do the same for external packages?

**Decision: NO (for now)**

Reason:
- The import in main.js is relative (`./utils`), so FunctionCallResolver handles it
- FunctionCallResolver will try to resolve to a FUNCTION, fail (it's a re-export)
- The call stays unresolved
- This is technically a gap, but:
  - Adding re-export chain following to ExternalCallResolver adds significant complexity
  - FunctionCallResolver already has this logic - we'd duplicate it
  - Better to extend FunctionCallResolver to handle external re-exports (future work)

**Test case:** Document current behavior - re-exported externals are unresolved. Create backlog issue for future improvement.

---

## Summary of Decisions

| Issue | Decision | Impact |
|-------|----------|--------|
| 1. Metadata Strategy | Option B - derive from graph | Simpler plugin, no GraphBackend changes |
| 2. Built-ins List | Narrow to actual functions | Removed constructors and objects |
| 3. Priority | 70 is correct | No change needed |
| 4. Test Coverage | Add 4 test cases | Full coverage for edge cases |

---

## Revised Algorithm for ExternalCallResolver

```
1. Build Import Index: Map<file:localName, ImportInfo>
   - Only external imports (non-relative source)
   - Store: source, importType, imported (original name)

2. Collect Unresolved CALL Nodes:
   - No `object` attribute (not method call)
   - No CALLS edge yet

3. For Each Unresolved CALL:
   a) Check import index for matching local name
      -> If external import found:
         - Get/create EXTERNAL_MODULE node
         - Create CALLS edge with metadata { exportedName: imp.imported }
         - Count as resolved

   b) Check if name is JS builtin
      -> If builtin:
         - Skip (no edge needed)
         - CallResolverValidator will recognize by name
         - Count as builtin

   c) Otherwise:
      - Leave unresolved
      - CallResolverValidator will report

4. Return Summary:
   - edgesCreated (CALLS to EXTERNAL_MODULE)
   - nodesCreated (new EXTERNAL_MODULE if any)
   - builtinCount
   - unresolvedCount
```

---

## Next Steps

1. **Joel:** Revise tech spec with:
   - Updated JS_BUILTINS list
   - Removed metadata update logic
   - Added test cases from this document

2. **When Joel's revision is ready:** Back to Linus for final approval

3. **After approval:** Kent writes tests, Rob implements

---

**Decision Status:** COMPLETE
**Ready for:** Joel revision
