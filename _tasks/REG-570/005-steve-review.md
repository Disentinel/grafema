## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

---

### Vision

The core thesis is "AI should query the graph, not read code." That requires the graph to be
complete and correct. 1330 false ERR_MISSING_ASSIGNMENT warnings from unconnected class
field VARIABLE nodes meant the graph was lying to any agent querying it. This fix directly
serves the vision by closing a structural gap in graph coverage: initialized class fields
now have ASSIGNED_FROM edges, so data-flow queries return accurate results instead of noise.

There is no workaround here. The gap is fixed at its root — in the AST enricher that
builds the graph — not papered over downstream.

### Architecture

The implementation follows the established pattern precisely. ClassVisitor already wires
function-valued properties and class methods into the graph. The missing piece was
non-function field initializers. The fix:

1. Reuses the existing `trackVariableAssignment` callback infrastructure — same callback
   type, same 13-arg signature, same binding pattern already used by VariableVisitor.
2. Does not introduce a new traversal or a new scan over nodes. The call happens inline
   during the existing AST walk, which is the correct place.
3. The `ClassPrivateProperty` handler added to ClassExpression's traverse is a genuine
   gap fix (Dijkstra caught it), not a corner-case patch. Private fields in class
   expressions are a real language construct and coverage must be symmetric.

The DataFlowValidator changes are also correct. Adding ARRAY_LITERAL and OBJECT_LITERAL
to leafTypes is a structural fix — these node types were always valid data-flow terminals,
they were simply missing from the set. The isClassProperty guard for uninitialized fields
reflects the correct semantic: a TypeScript declaration-only field (`name: string;`) is
not an error — it is intentionally uninitialized at the JS level.

### Concerns

One concern worth noting: the `ClassPrivateProperty` handler in ClassExpression (lines
924–1049) is a full copy of the same handler in ClassDeclaration (lines 542–668). This is
~120 LOC of nearly-identical code. The pattern of duplicating handlers between
ClassDeclaration and ClassExpression has already been established in the codebase (the
ClassMethod and ClassProperty handlers are also duplicated). This is a pre-existing
structural issue in ClassVisitor, not introduced by REG-570. Extracting shared handlers
into a private method is the right long-term direction, but that refactoring belongs in a
dedicated cleanup task, not here.

The `as unknown as Node` casts for `propNode.value` are pragmatic. The Babel type
difference between ClassProperty.value and ClassPrivateProperty.value is a Babel API
artifact, not a logic error. The casts are contained and clearly annotated.

### Tests

9 test cases cover all field variants: numeric literal, string literal, array literal,
object literal, uninitialized (no false positive), private field, static field,
ClassExpression public field, ClassExpression private field. Coverage is complete for
the stated scope. Test 5 directly validates the DataFlowValidator integration — not just
graph structure but end-to-end warning suppression. That is the right level of testing.

### Summary

The change is minimal, follows established patterns, fixes the root cause, and serves
the graph-completeness requirement that makes the tool useful. Approve.
