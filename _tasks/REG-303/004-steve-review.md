# REG-303: Steve Jobs Review

## Verdict: APPROVE (with required fixes)

---

## 1. Vision Alignment

**PASS.** This is exactly the kind of feature Grafema needs. Generic type parameters are fundamental to understanding TypeScript code structure. Without them, an agent querying "what constraints does this generic function have?" gets nothing -- it has to read the source. Adding `TYPE_PARAMETER` nodes with `constraint` metadata and `EXTENDS` edges to constraint types moves us directly toward "query the graph, not read code."

The scope is well-bounded: we track the declaration of type parameters, not their usage sites or instantiation. That is correct for a first pass.

---

## 2. Corner-Cutting Check

**PASS with one concern.**

The plan correctly identifies that `typeNodeToString()` drops generic arguments from `TSTypeReference` (`Map<string, V>` becomes `Map`). This is acknowledged as a known limitation, and the EXTENDS edge to `Map` is still semantically correct. Acceptable for this task -- it is a pre-existing limitation of `typeNodeToString`, not something introduced here.

The plan does NOT cut corners on:
- Intersection constraints (`T extends A & B`) -- handled correctly, splitting into multiple EXTENDS edges
- Variance annotations -- included
- Default types -- included
- All declaration contexts (function, arrow, class, method, interface, type alias) -- covered

---

## 3. Architecture Gaps

**One issue to fix (non-blocking).**

### 3a. Dangling EXTENDS edges -- WRONG PATTERN

The plan proposes (Joel's spec, section 3.11.D):
```typescript
this._bufferEdge({
  type: 'EXTENDS',
  src: tpNode.id,
  dst: part,  // Dangling reference to constraint type name
  metadata: { constraintRef: true }
});
```

Don's plan says: "dangling edges are expected and resolved during enrichment" and claims this "matches existing behavior for interface extends."

**This is incorrect.** I verified the actual `bufferInterfaceNodes` implementation (GraphBuilder.ts lines 1985-2018). When an interface extends another interface not found in the same file, it does NOT create a dangling edge with a raw name string as `dst`. Instead, it creates an **external interface node** with `isExternal: true` and links the EXTENDS edge to that node's ID:

```typescript
// External interface - create a reference node
const externalInterface = NodeFactory.createInterface(
  parentName, iface.file, iface.line, 0,
  { isExternal: true }
);
this._bufferNode(externalInterface as unknown as GraphNode);
this._bufferEdge({
  type: 'EXTENDS',
  src: srcNode.id,
  dst: externalInterface.id  // <-- actual node ID, not raw name
});
```

**Required fix:** The `bufferTypeParameterNodes` method must follow the same pattern. When a constraint type is not resolvable in the same file, create an external reference node (e.g., an external INTERFACE or TYPE node with `isExternal: true`) and point the EXTENDS edge to that node's ID. Using raw type names as edge destinations is a different pattern that will create inconsistency in how graph queries work.

This is not a blocking architectural gap -- the fix is straightforward and stays within the same method. But it MUST be done during implementation, not deferred.

### 3b. `TypeParameterNodeRecord` in `packages/types/src/nodes.ts` -- INCONSISTENT PATTERN

The plan (Joel section 3.1) proposes adding `TypeParameterNodeRecord` to `packages/types/src/nodes.ts` and to the `NodeRecord` union type. However, I verified that `InterfaceNodeRecord`, `TypeNodeRecord`, `EnumNodeRecord`, and `DecoratorNodeRecord` are NOT in `packages/types/src/nodes.ts`. They exist only in their respective files under `packages/core/src/core/nodes/`.

Similarly, the plan proposes adding `TYPE_PARAMETER` to the `NODE_TYPE` const in `packages/types/src/nodes.ts`, but INTERFACE, TYPE, ENUM, and DECORATOR are not there either.

**Required fix:** Do NOT add `TypeParameterNodeRecord` to `packages/types/src/nodes.ts` or to the `NodeRecord` union. Do NOT add `TYPE_PARAMETER` to `packages/types/src/nodes.ts` `NODE_TYPE`. Follow the same pattern as INTERFACE/TYPE/ENUM/DECORATOR: the record type lives only in `packages/core/src/core/nodes/TypeParameterNode.ts`. The string `'TYPE_PARAMETER'` is used directly where needed.

Whether to add to `packages/core/src/core/nodes/NodeKind.ts` is also questionable since INTERFACE/TYPE/ENUM/DECORATOR are not there. But NodeKind.ts and packages/types/src/nodes.ts appear to be identical copies (same content), so the same reasoning applies -- skip both, or add to both. Given the existing pattern, skip both.

---

## 4. Complexity Check (MANDATORY)

**PASS.** No red flags.

- Type parameter extraction: O(k) per declaration where k = number of type params (1-3 typically). Piggybacks on existing AST traversal -- no extra iteration.
- `bufferTypeParameterNodes`: O(n * k) where n = number of declarations with type params in a file (0-20 typically) and k = avg type params per declaration (1-3). This is negligible.
- No iteration over ALL nodes/edges.
- No backward pattern scanning.
- Memory: one `TypeParameterInfo` per type parameter. Trivial.

---

## 5. Plugin Architecture

**PASS.** This is textbook forward registration:

1. **Visitors** extract type parameter data from AST nodes they already traverse (no extra traversal)
2. Data is collected into `TypeParameterInfo[]` collection
3. **GraphBuilder** converts collections into nodes + edges

This matches the existing pattern for interfaces, type aliases, enums, and decorators exactly. No backward scanning, no global iteration.

---

## 6. Extensibility

**PASS.** The `extractTypeParameters()` helper is generic and works with any AST node that has a `typeParameters` field. Adding support for new declaration types (e.g., future TypeScript constructs) means calling this one function from the appropriate visitor handler. Clean.

The parent type parameter (`parentType: 'FUNCTION' | 'CLASS' | 'INTERFACE' | 'TYPE'`) is extensible if new parent types are added later.

---

## 7. "MVP Limitations"

**PASS.** The limitations are genuine scope boundaries, not feature-defeating holes:

- NOT tracking type parameter usage sites -- separate feature, not needed to answer "what type params does X have?"
- NOT tracking type argument instantiation (`foo<string>()`) -- separate feature
- NOT enhancing `typeNodeToString()` for generic arguments -- pre-existing limitation
- `typeNodeToString` returning `'unknown'` for complex types -- edge case, constraint string still stored

None of these defeat the core purpose: "track type parameter constraints on declarations."

---

## 8. EXTENDS Edge Reuse

**PASS with nuance.** Reusing `EXTENDS` for type parameter constraints is semantically correct. `T extends Serializable` IS an extends relationship -- it declares that T is a subtype of Serializable. This is the same semantic relationship as `interface Foo extends Bar`.

The `{ constraintRef: true }` metadata distinguishes constraint-EXTENDS from inheritance-EXTENDS when needed for queries. An agent can query:
- "What does this type parameter extend?" (follow EXTENDS from TYPE_PARAMETER)
- "What interfaces extend this interface?" (follow EXTENDS from INTERFACE)

These are naturally distinguished by the source node type (TYPE_PARAMETER vs INTERFACE), so the metadata is a nice-to-have, not strictly necessary. No confusion risk.

---

## 9. Dangling Edges

**FAIL -- see section 3a above.**

The plan claims to follow the existing pattern but does not. The existing pattern creates external reference nodes, not truly dangling edges. This must be fixed.

However, since `skip_validation=true` is used for edge flushing, truly dangling edges would not crash anything -- they would just create inconsistency in query patterns (some EXTENDS edges point to node IDs, some point to raw names). This inconsistency is what must be avoided.

---

## 10. Test Coverage

**PASS.** The test plan is comprehensive:

- Unit tests for `TypeParameterNode.create()` and `validate()` -- contract tests
- Unit tests for `extractTypeParameters()` helper -- all edge cases (null, variance, intersection, multiple params)
- Integration tests for all declaration contexts (function, arrow, class, method, interface, type alias)
- Edge case tests (variance, primitives, combined constraint+default)
- Tests verify both nodes AND edges (HAS_TYPE_PARAMETER, EXTENDS)

The plan references following `InterfaceNodeMigration.test.js` pattern with `createTestDatabase()` + `createTestOrchestrator()`. I did not find `InterfaceNodeMigration.test.js` in the test directory (only `EnumNodeMigration.test.js` and `DecoratorNodeMigration.test.js`), but the approach is the same.

---

## Summary of Required Fixes

1. **Do NOT create truly dangling EXTENDS edges.** Follow the `bufferInterfaceNodes` pattern: create external reference nodes for constraint types not found in the same file.

2. **Do NOT add `TypeParameterNodeRecord` or `TYPE_PARAMETER` to `packages/types/src/nodes.ts`.** Follow the same pattern as INTERFACE/TYPE/ENUM/DECORATOR. Similarly, reconsider adding to `NodeKind.ts` since other TS-specific node types are not there.

These are implementation-level fixes. The overall architecture, approach, and scope are correct. The plan can proceed to implementation with these adjustments.

---

**Decision: APPROVE** -- proceed to implementation with the two required fixes above. These do not require re-planning, just adjustment during Rob's implementation.
