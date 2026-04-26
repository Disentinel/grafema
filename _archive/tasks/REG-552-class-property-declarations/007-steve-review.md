## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

### Vision Alignment

"AI should query the graph, not read code."

Before this change, TypeScript class field declarations — `private graph: GraphBackend`, `protected config: OrchestratorOptions` — were invisible to graph queries. An AI agent asked "what dependencies does this class hold?" could not answer from the graph alone. It had to read code. That is exactly the gap this feature closes.

The three metadata fields chosen are precisely the right ones: `accessibility` answers "can I access this from outside the class?", `readonly` answers "will this field change?", and `tsType` answers "what is this field's contract?". These are the questions an agent asks about class structure. The graph can now answer them.

This is not feature padding. These nodes close a real blindspot in graph coverage. Approve on vision.

### Architecture

The implementation follows the REG-271/REG-401 established pattern exactly:

1. ClassVisitor emits into `variableDeclarations` with extra fields (`accessibility`, `isReadonly`, `tsType`)
2. GraphBuilder strips those extra fields and moves them into `node.metadata`
3. RFDBServerBackend's `_parseNode` flattens `safeMetadata` onto the returned node via spread

This is the same pipeline used for private class properties (REG-271). The duplication between `ClassDeclaration` and `ClassExpression` traversal blocks is structural — both already existed with duplicated method/property handling — and mirrors the existing pattern throughout the file. No new debt introduced.

Two edge cases are handled correctly and explicitly:
- Computed keys (`[Symbol.iterator]`) are skipped — these cannot be represented as named VARIABLE nodes
- `declare`-only fields are skipped — they have no runtime presence

The `HAS_PROPERTY` edge from CLASS to VARIABLE is wired through `TypeSystemBuilder` using the existing `currentClass.properties` array, consistent with REG-271 private field handling.

The test suite is thorough: accessibility modifiers, readonly combinations, type annotations, line/column positions, the HAS_PROPERTY edge, and both skip cases (declare and function-valued). This is the level of coverage the codebase standard demands.

### One Observation (Non-blocking)

The `ClassExpression` block does not handle decorators on class properties (the `ClassDeclaration` block does at lines 264-275, but the `ClassExpression` block omits it). This was a pre-existing gap, not introduced by this PR. Not a reject reason here, but worth a follow-up issue.
