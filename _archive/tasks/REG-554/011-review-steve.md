# REG-554 Vision Review — Steve Jobs

**Verdict: APPROVE**

**Date:** 2026-02-23

---

## 1. Does PROPERTY_ASSIGNMENT as a first-class node align with the graph-first vision?

Yes. Unambiguously.

Before this change, `this.graph = options.graph!` was a dead end in the graph. A FLOWS_INTO edge existed, but the write site had no identity — no node an agent could anchor a query to, no ASSIGNED_FROM edge pointing at a source. You could not ask "what values flow into this class field?" using graph queries alone. You had to read the code.

That is the exact gap this fixes. PROPERTY_ASSIGNMENT gives every write site a node. The chain becomes traversable:

```
CLASS (GraphService)
  → CONTAINS → PROPERTY_ASSIGNMENT (this.graph)
  → ASSIGNED_FROM → PROPERTY_ACCESS (options.graph)
  → READS_FROM → PARAMETER (options)
```

An agent can now answer "what is assigned to GraphService.graph?" without reading a single line of source. That is the vision.

The plan cites Joern and CodeQL as prior art. Both model assignment as a first-class node. This is industry-validated, not invented.

---

## 2. Is CLASS→CONTAINS→PROPERTY_ASSIGNMENT the right edge direction?

Yes, and the deliberate asymmetry with PROPERTY_ACCESS is correct.

PROPERTY_ACCESS uses `parentScopeId` — the syntactic scope (the enclosing function or module). A read is an event at a call site; it belongs to the scope where it executes.

A write to `this.x` is different. The field belongs to the class. The semantically useful question is "what does class Foo own?" not "what does the constructor's scope syntactically contain?" The implementation uses the CLASS node as the CONTAINS source, which is consistent with how MutationBuilder already treats `this` writes via FLOWS_INTO.

The plan documents the asymmetry explicitly. The implementation matches. The reasoning is sound.

One note to carry forward: CONTAINS now carries two distinct semantics — syntactic containment (most nodes) and semantic ownership (PROPERTY_ASSIGNMENT). This is a known tradeoff, not a mistake. It should be documented in the edge catalog before the graph surface grows larger.

---

## 3. Does the implementation genuinely enable data flow tracing, or is it a dead end?

It genuinely enables it for the two most important RHS patterns:

- VARIABLE — resolved via scope chain to the VARIABLE or PARAMETER node. Complete chain.
- MEMBER_EXPRESSION — resolved to the existing PROPERTY_ACCESS node for the RHS read. Complete chain. The key design decision here (reuse the PROPERTY_ACCESS node rather than duplicate data) is the right call.

The TSNonNullExpression unwrapping for `options.graph!` is handled cleanly and correctly. This is not optional — TypeScript codebases use non-null assertions heavily.

What is deferred (LITERAL, CALL, OBJECT_LITERAL, ARRAY_LITERAL) is explicitly documented in the code comments and the plan. The CALL case is the most significant gap: `this.x = someFactory()` will have a PROPERTY_ASSIGNMENT node but no ASSIGNED_FROM edge. Data flow tracing stops there. This is a real limitation. It is correctly labeled V1 and should be on the backlog.

The MEMBER_EXPRESSION lookup uses an in-memory scan of `PropertyAccessInfo[]` by objectName + propertyName + file + line + column. This works. It follows the existing `classDeclarations.find()` pattern. Not a problem at current scale.

---

## 4. Are there architectural shortcuts or hacks that would embarrass us?

No hacks. The implementation is clean.

The `bufferAssignedFromEdge` extraction into its own private method — rather than inlining into the loop — is better structure than the plan specified. Good call.

The class lookup uses basename comparison:

```typescript
const fileBasename = basename(propAssign.file);
const classDecl = classDeclarations.find(c =>
  c.name === propAssign.enclosingClassName && c.file === fileBasename
);
```

This is a pre-existing limitation inherited from `bufferPropertyAccessNodes`. Two classes with the same name in different directories within the same basename (e.g., `service/Controller.ts` and `legacy/Controller.ts`) will collide. The plan documents it explicitly as a known constraint, not introduced here. It is acceptable for V1 but must be resolved before Grafema targets large monorepos. File it as debt.

The silent omission pattern — when a source node is not found, no ASSIGNED_FROM edge is created and no crash occurs — is the correct behavior. Phantom edges are worse than missing edges.

---

## 5. Does the node and edge naming follow Grafema's conventions?

Yes.

- `PROPERTY_ASSIGNMENT` is the correct counterpart to `PROPERTY_ACCESS`. Read/write symmetry. Same naming family. Grouped together in `NODE_TYPE` under "Call graph."
- `ASSIGNED_FROM` was already in the schema. Used correctly: direction is PROPERTY_ASSIGNMENT → source, meaning "this assignment received its value from."
- `CONTAINS` reused correctly. No new edge types invented when existing ones suffice.
- `PropertyAssignmentNodeRecord` follows the established `*NodeRecord` interface pattern.
- `PropertyAssignmentInfo` follows the established `*Info` internal struct pattern.
- `bufferPropertyAssignmentNodes` and `bufferAssignedFromEdge` follow the `buffer*` method naming in `CoreBuilder`.
- Field names `objectName`, `className`, `computed` match `PropertyAccessNodeRecord` where applicable.

The `enclosingClassName` (Info) vs. `className` (NodeRecord) inconsistency is acknowledged in the plan and justified: the NodeRecord field is what lands in the graph and what agents query on — `className` is more natural there. Acceptable.

---

## 6. Scope: did we ship what we should, and only that?

Shipped correctly:
- `this.prop = value` in constructors and instance methods, with ASSIGNED_FROM for VARIABLE and MEMBER_EXPRESSION RHS.
- TSNonNullExpression unwrapping.
- 8 test groups covering the primary paths, edge cases, and regressions on existing FLOWS_INTO behavior.
- Existing MutationBuilder FLOWS_INTO edges untouched.

Correctly deferred and documented:
- `obj.prop = value` (non-`this`) — FLOWS_INTO in MutationBuilder handles this.
- CALL, EXPRESSION, OBJECT_LITERAL, ARRAY_LITERAL RHS — no ASSIGNED_FROM edge in V1.
- Chained member expressions (`a.b.c`) fall through to EXPRESSION.
- Class field initializers (property declaration syntax, not AssignmentExpression) — correctly out of scope.

Nothing shipped outside scope. Nothing critical missing for the stated V1 goal.

---

## Summary

This implementation closes a real gap in Grafema's graph. Class field write sites now have identity in the graph. Data flow tracing through `this.x = options.y` is complete. The design decisions are principled, the scope is disciplined, the naming is consistent, and the known limitations are documented rather than hidden.

Ship it.
