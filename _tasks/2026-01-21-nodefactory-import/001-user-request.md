# User Request

**Source:** Linear REG-98 (subtask)

**Request:** Implement one subtask from REG-98 "Refactor: Migrate all node creation to NodeFactory"

**Selected subtask:** Add `createImport` method to NodeFactory and migrate GraphBuilder to use it.

**Context from REG-98:**
- IMPORT nodes are created as inline literals in GraphBuilder.ts
- ImportNode contract already exists in `packages/core/src/core/nodes/ImportNode.ts`
- Need to add factory method and update all usages

**Acceptance criteria:**
- [ ] NodeFactory has `createImport` method
- [ ] GraphBuilder uses `NodeFactory.createImport()` instead of inline literals
- [ ] All existing tests pass
- [ ] ImportNode added to NodeFactory validator
