# Don's Revised Technical Plan: REG-485

**Task:** Resolve method calls on interface-typed variables (e.g., `graph.addNodes()` where `graph: GraphBackend`)

**Date:** 2026-02-17
**Status:** Revised after Dijkstra rejection

---

## Root Cause Analysis

**The original plan had a fundamental flaw:** Step 4b checked `interfaceImpls.has(object)` where `object` is a VARIABLE NAME (e.g., "graph"), not a type name ("GraphBackend"). This check will always fail.

**Real-world failure case:**
```typescript
const { graph } = context;  // graph is typed as GraphBackend (interface)
await graph.addNodes(...)    // METHOD_CALL: object="graph", method="addNodes"
```

The method call node has `object="graph"` (variable name), but we need to know that "graph" has type "GraphBackend" (interface name), which implements RFDBServerBackend (class name), which has method "addNodes".

**Current state:**
- VariableDeclarationInfo has NO `typeAnnotation` field — variables don't store their declared types
- INSTANCE_OF edges only created for `new ClassName()` — not for type annotations
- INTERFACE nodes exist with `properties` metadata (method signatures)
- IMPLEMENTS edges exist (CLASS → INTERFACE)
- Current step 4 is already imprecise (CHA-like) — iterates ALL variable types, returns first class with matching method

---

## Chosen Approach: Interface-Aware CHA (Class Hierarchy Analysis)

**Rationale:**
1. **Minimal change:** Extends existing step 4 logic without touching VariableVisitor
2. **Immediate impact:** Fixes `graph.addNodes()` without full type inference infrastructure
3. **Follows existing pattern:** Step 4 already does CHA (iterates all variable types), we just add interfaces to the search
4. **Works with existing data:** Uses INTERFACE nodes (properties) and IMPLEMENTS edges that already exist

**Precision tradeoff:**
- Current step 4: ANY variable with ANY class type that has `addNodes()` → resolves to that class
- This plan: ANY call to `addNodes()` → resolves to classes implementing interfaces declaring `addNodes()`
- Neither is perfect, but both are practical CHA
- Proper fix (type annotation extraction) is a separate task for v0.2

**Why not Option B (type annotation extraction)?**
- Requires changes to VariableVisitor, VariableDeclarationInfo schema, GraphBuilder
- Adds complexity to variable declaration phase
- Doesn't eliminate CHA imprecision (still need fallback for untyped code)
- Better as separate task after this quick win

---

## Detailed Algorithm

### Modified MethodCallIndexers.ts

**Step 1: Build method → interfaces index**

New function: `buildInterfaceMethodIndex(graph: GraphBackend): Map<string, Set<string>>`

```
For each INTERFACE node in graph:
  For each property in node.properties:
    If property has a name:
      Add interface.name to methodToInterfaces[property.name]

Return: Map<methodName, Set<interfaceName>>
```

Example result:
```
methodToInterfaces = {
  "addNodes": Set(["GraphBackend"]),
  "getNode": Set(["GraphBackend"]),
  "addEdge": Set(["GraphBackend"]),
  ...
}
```

**Step 2: Build interface → implementing classes index**

New function: `buildInterfaceImplementationIndex(graph: GraphBackend): Map<string, Set<string>>`

```
For each CLASS node in graph:
  For each outgoing IMPLEMENTS edge from that class:
    Get dst interface node
    Add class.name to interfaceImpls[interfaceNode.name]

Return: Map<interfaceName, Set<className>>
```

Example result:
```
interfaceImpls = {
  "GraphBackend": Set(["RFDBServerBackend", "InMemoryBackend"]),
  ...
}
```

**Step 3: Export both indexes**

Modify `buildMethodCallIndexes()`:
```typescript
export async function buildMethodCallIndexes(graph: GraphBackend) {
  const classMethodIndex = await buildClassMethodIndex(graph);
  const variableTypes = await buildVariableTypeIndex(graph);
  const methodToInterfaces = await buildInterfaceMethodIndex(graph);
  const interfaceImpls = await buildInterfaceImplementationIndex(graph);

  return { classMethodIndex, variableTypes, methodToInterfaces, interfaceImpls };
}
```

### Modified MethodCallResolver.ts

**Step 4: Pass indexes to enrichment**

Modify `run()`:
```typescript
const { classMethodIndex, variableTypes, methodToInterfaces, interfaceImpls } =
  await buildMethodCallIndexes(this.ctx.graph);

// Pass to resolution logic
```

### Modified MethodCallResolution.ts

**Step 5: Add interface resolution as fallback**

New function: `resolveViaInterfaceCHA()`

```typescript
/**
 * Step 5: Interface-aware CHA fallback (REG-485)
 *
 * When all strategies fail:
 * 1. Look up method name in interface method index
 * 2. For each interface that declares this method:
 *    - Find classes implementing that interface
 *    - Check if class has the method
 * 3. Return first match
 *
 * Imprecision: ANY call to `addNodes()` resolves to RFDBServerBackend.addNodes
 * even if the actual variable type is unknown. This is CHA — acceptable for now.
 */
async function resolveViaInterfaceCHA(
  methodName: string,
  classMethodIndex: Map<string, ClassEntry>,
  methodToInterfaces: Map<string, Set<string>>,
  interfaceImpls: Map<string, Set<string>>
): Promise<BaseNodeRecord | null> {
  // 1. Find interfaces declaring this method
  const candidateInterfaces = methodToInterfaces.get(methodName);
  if (!candidateInterfaces || candidateInterfaces.size === 0) {
    return null;
  }

  // 2. For each interface, find implementing classes
  for (const interfaceName of candidateInterfaces) {
    const implementingClasses = interfaceImpls.get(interfaceName);
    if (!implementingClasses || implementingClasses.size === 0) continue;

    // 3. Check each class for the method
    for (const className of implementingClasses) {
      const classEntry = classMethodIndex.get(className);
      if (classEntry && classEntry.methods.has(methodName)) {
        return classEntry.methods.get(methodName)!;
      }
    }
  }

  return null;
}
```

**Step 6: Modify resolveMethodCall() to add step 5**

```typescript
export async function resolveMethodCall(
  methodCall: MethodCallNode,
  classMethodIndex: Map<string, ClassEntry>,
  variableTypes: Map<string, string>,
  methodToInterfaces: Map<string, Set<string>>,  // NEW
  interfaceImpls: Map<string, Set<string>>,      // NEW
  graph: PluginContext['graph'],
  containingClassCache: Map<string, BaseNodeRecord | null>
): Promise<BaseNodeRecord | null> {
  const { object, method, file } = methodCall;

  if (!object || !method) return null;

  // Steps 1-4 unchanged...

  // NEW: Step 5 - Interface-aware CHA fallback
  const interfaceMatch = await resolveViaInterfaceCHA(
    method,
    classMethodIndex,
    methodToInterfaces,
    interfaceImpls
  );
  if (interfaceMatch) return interfaceMatch;

  return null;
}
```

---

## Step-by-Step Trace: How It Resolves `graph.addNodes()`

**Input:**
```typescript
// In RFDBServerBackend.ts
class RFDBServerBackend implements GraphBackend {
  async addNodes(nodes: BaseNodeRecord[]): Promise<void> { ... }
}

// In some-plugin.ts
const { graph } = context;  // graph: GraphBackend
await graph.addNodes([...]);
```

**Graph state:**
- INTERFACE node: `GraphBackend` with properties `[{name: "addNodes", ...}, ...]`
- CLASS node: `RFDBServerBackend`
- IMPLEMENTS edge: `RFDBServerBackend → GraphBackend`
- METHOD_CALL node: `object="graph"`, `method="addNodes"`

**Resolution trace:**

1. **Step 1** (direct class name): "graph" not in classMethodIndex → fail
2. **Step 2** (local class): file+":graph" not in classMethodIndex → fail
3. **Step 3** ("this"): object is "graph", not "this" → fail
4. **Step 4** (variableTypes): "graph" not in variableTypes (no INSTANCE_OF) → fail
5. **NEW Step 5** (interface CHA):
   - `methodToInterfaces.get("addNodes")` → `Set(["GraphBackend"])`
   - `interfaceImpls.get("GraphBackend")` → `Set(["RFDBServerBackend"])`
   - `classMethodIndex.get("RFDBServerBackend").methods.get("addNodes")` → ✅ METHOD node
   - **Return:** `/path/to/RFDBServerBackend.ts:METHOD:addNodes:X`

**Result:** Creates CALLS edge from METHOD_CALL → METHOD.

---

## Edge Cases Enumeration

| Case | Behavior | Acceptable? |
|------|----------|-------------|
| **Variable typed as interface** | `const g: GraphBackend = ...` → `g.addNodes()` resolves to first implementing class | ✅ Yes (CHA) |
| **Variable typed as class** | `const g: RFDBServerBackend = ...` → steps 1-4 handle it (unchanged) | ✅ Yes |
| **Untyped variable** | `const g = getGraph()` → step 5 still fires if method name matches | ⚠️ Imprecise but acceptable (CHA) |
| **Interface declares method, no class implements it** | `methodToInterfaces` has entry, `interfaceImpls` empty → fail gracefully | ✅ Yes |
| **Class implements interface but doesn't have method** | Checked in step 5 loop (`classEntry.methods.has(methodName)`) → skip to next class | ✅ Yes |
| **Multiple classes implement same interface** | Returns first match (iteration order) | ⚠️ Imprecise but acceptable (CHA) |
| **Method name ambiguous** (e.g., `delete()` on Map vs custom class) | Returns first match across all interfaces | ⚠️ Known CHA limitation |
| **Interface extends another interface** | Step 1 indexes methods from base interface properties, step 2 follows IMPLEMENTS edges | ✅ Yes (graph has EXTENDS edges, interface properties include inherited) |
| **External interface** (e.g., `implements Promise<T>`) | INTERFACE node created with `isExternal: true`, properties might be empty → no matches | ✅ Yes (acceptable gap) |
| **Empty interface** (no properties) | `methodToInterfaces` has no entries for this interface → fail gracefully | ✅ Yes |
| **Nested member access** | `context.graph.addNodes()` → object="context.graph" → steps 1-4 fail → step 5 doesn't help | ❌ Known limitation (requires chained type inference) |

---

## Files to Modify

1. **`packages/core/src/plugins/enrichment/method-call/MethodCallIndexers.ts`** (~84 lines → ~160 lines)
   - Add `buildInterfaceMethodIndex()`
   - Add `buildInterfaceImplementationIndex()`
   - Modify `buildMethodCallIndexes()` to return 4 indexes

2. **`packages/core/src/plugins/enrichment/method-call/MethodCallResolution.ts`** (~182 lines → ~250 lines)
   - Add `resolveViaInterfaceCHA()`
   - Modify `resolveMethodCall()` signature to accept new indexes
   - Add step 5 to resolution pipeline

3. **`packages/core/src/plugins/enrichment/MethodCallResolver.ts`** (~60 lines)
   - Update destructuring to receive 4 indexes
   - Pass new indexes to `resolveMethodCall()`

4. **Tests:**
   - `test/unit/method-call-resolution.test.js` — add interface CHA test cases

---

## Test Plan

### New Test: `test/unit/method-call-resolution.test.js`

**Test 1: Interface-typed variable resolves to implementing class**
```javascript
Input:
  interface GraphBackend { addNodes(...): Promise<void> }
  class RFDBServerBackend implements GraphBackend { addNodes(...) { ... } }
  const graph: GraphBackend = ...;
  graph.addNodes([...]);

Expected:
  METHOD_CALL[graph.addNodes] --CALLS--> METHOD[RFDBServerBackend.addNodes]
```

**Test 2: Multiple classes implement same interface — returns first match**
```javascript
Input:
  interface Storage { save(): void }
  class LocalStorage implements Storage { save() {} }
  class CloudStorage implements Storage { save() {} }
  const s: Storage = ...;
  s.save();

Expected:
  METHOD_CALL[s.save] --CALLS--> METHOD[LocalStorage.save] or METHOD[CloudStorage.save]
  (whichever is first in iteration)
```

**Test 3: Interface method not implemented by class — no match**
```javascript
Input:
  interface Complete { method1(): void; method2(): void }
  class Partial implements Complete { method1() {} }  // method2 missing
  const p: Complete = ...;
  p.method2();

Expected:
  No CALLS edge created
```

**Test 4: Method name exists on interface, but no implementing classes exist**
```javascript
Input:
  interface Orphan { orphanMethod(): void }
  (no classes implement Orphan)
  const o: Orphan = ...;
  o.orphanMethod();

Expected:
  No CALLS edge created
```

**Test 5: Fallback to CHA when variable is untyped**
```javascript
Input:
  interface Backend { process(): void }
  class MyBackend implements Backend { process() {} }
  const b = getBackend();  // untyped
  b.process();

Expected:
  METHOD_CALL[b.process] --CALLS--> METHOD[MyBackend.process]
  (imprecise but acceptable)
```

---

## Estimated Scope

- **Lines changed:** ~120 new lines (2 new index builders + 1 new resolver + tests)
- **Complexity:** Low (follows existing CHA pattern)
- **Risk:** Low (additive change, doesn't modify existing steps 1-4)
- **Time:** 3-4 hours (implementation + tests)

---

## Known Limitations (Document in Code)

```typescript
/**
 * LIMITATION (REG-485): Interface-aware CHA is imprecise.
 *
 * Example:
 *   interface Storage { save(): void }
 *   class LocalStorage implements Storage { save() {} }
 *   class CloudStorage implements Storage { save() {} }
 *
 *   const s: Storage = condition ? new LocalStorage() : new CloudStorage();
 *   s.save();  // Resolves to FIRST match (LocalStorage or CloudStorage)
 *
 * This is Class Hierarchy Analysis (CHA) — acceptable for exploration,
 * but not precise enough for advanced static analysis.
 *
 * Proper fix: Extract type annotations from VariableDeclarator (v0.2).
 */
```

---

## Future Work (Separate Tasks)

**Task: REG-XXX — Proper Type Annotation Extraction**
- Modify VariableVisitor to extract `typeAnnotation` from VariableDeclarator
- Store type info in VariableDeclarationInfo
- Create INSTANCE_OF edges for interface-typed variables
- Extend step 4 to use type info from INSTANCE_OF
- Deprecate step 5 CHA fallback (or keep for untyped code)

**Task: REG-XXX — Chained Member Access**
- Handle `context.graph.addNodes()` (nested member expressions)
- Requires chaining type inference across member access chains

---

## Why This Approach Is Right

1. **Fixes the real bug:** `graph.addNodes()` will now resolve
2. **Minimal scope:** Touches 3 files, adds ~120 lines
3. **Low risk:** Additive change, doesn't break existing resolution
4. **Follows existing patterns:** CHA already used in step 4
5. **Uses existing data:** INTERFACE nodes and IMPLEMENTS edges already exist
6. **Pragmatic:** Proper type inference is v0.2 work, this is a v0.1.x quick win
7. **Documented limitations:** Clear path for future improvement

---

## Comparison: Original vs Revised

| Aspect | Original Plan | Revised Plan |
|--------|--------------|--------------|
| **Core flaw** | `interfaceImpls.has(object)` where object is variable name | Fixed: look up method → interfaces → classes |
| **Approach** | Build interface → class map | Build method → interfaces → classes (2-level lookup) |
| **Handles `graph.addNodes()`** | ❌ No (variable name ≠ interface name) | ✅ Yes (method name → GraphBackend → RFDBServerBackend) |
| **Precision** | N/A (didn't work) | CHA (same as current step 4) |
| **Complexity** | Medium (flawed logic) | Low (2 simple indexes + 1 resolver) |

---

**Dijkstra's key insight:** The original plan failed to distinguish between variable names ("graph") and type names ("GraphBackend"). The revised plan fixes this by indexing method names → interface names → class names, completely sidestepping the need for variable type inference.

**Next step:** Present this revised plan to Dijkstra for verification.
