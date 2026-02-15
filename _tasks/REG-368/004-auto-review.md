## Auto-Review

**Verdict:** APPROVE

### Part 1 — Vision & Architecture

**Status:** OK

- **Alignment with project vision:** This change strengthens Grafema's type safety without impacting the graph-first approach. It enforces compile-time guarantees that prevent invalid nodes from entering the graph.

- **brandNodeInternal scoping:** Well-scoped. The function is internal to @grafema/core, documented with legitimate use sites (NodeFactory, GraphBuilder, RFDBServerBackend), and has clear "DO NOT import in plugins" warning. This is the right level of encapsulation.

- **GraphBackend interface change:** Correct. Changing from `InputNode` to `AnyBrandedNode` enforces the contract at the type level. The 31 downstream errors are intentional — they surface places where code bypasses NodeFactory.

- **No architectural shortcuts:** The plan was followed exactly. Each commit is atomic, changes are minimal and focused. The deviation (removing `brandNode()` entirely instead of keeping it unexported) is actually cleaner — avoids dead code and ESLint warnings.

- **RFDBServerBackend local InputNode:** This is NOT a problem. The backend has its own `InputNode` interface (lines 55-65) which is separate from the removed `@grafema/types` version. It's used internally for flexible input parsing before branding. The backend doesn't explicitly implement `GraphBackend`, so there's no type conflict. The `addNode`/`addNodes` methods accept the local `InputNode`, parse it, then brand it before returning or storing. This is correct behavior for a backend that needs to handle wire format.

### Part 2 — Practical Quality

**Status:** OK

- **Does it do what the task requires?** Yes:
  - brandNode() removed from public API (not importable)
  - brandNodeInternal() created in @grafema/core
  - NodeFactory uses internal helper (35 call sites updated)
  - GraphBuilder._flushNodes() brands before flushing
  - RFDBServerBackend._parseNode() returns branded nodes
  - GraphBackend interface requires AnyBrandedNode
  - 31 TypeScript errors blocking inline node creation (as intended)

- **Edge cases:** None missed. The branding is a phantom type (zero runtime cost), so there are no runtime edge cases. The type system handles all validation.

- **Broken assumptions:** None. RFDBServerBackend's local `InputNode` is separate from the removed type and serves a different purpose (wire format parsing).

- **Minimality:** Excellent. Only files that needed changes were touched:
  - 1 new file (brandNodeInternal.ts)
  - 6 modified files (exactly what was planned)
  - No scope creep, no "improvements" nobody asked for

- **Loose ends:** None. No TODOs, no commented-out code, no "will fix later" notes.

### Part 3 — Code Quality

**Status:** OK

- **Readability:** Clear and simple. brandNodeInternal() is a 3-line cast function with excellent JSDoc explaining when to use it.

- **Naming:** Perfect. `brandNodeInternal` clearly signals "internal use only" vs the removed public `brandNode`.

- **Imports:** All correct, including `.js` extensions for TypeScript ESM compatibility:
  - `import { brandNodeInternal } from './brandNodeInternal.js';` (NodeFactory)
  - `import { brandNodeInternal } from '../../../core/brandNodeInternal.js';` (GraphBuilder)
  - `import { brandNodeInternal } from '../../core/brandNodeInternal.js';` (RFDBServerBackend)

- **Code structure:**
  - GraphBuilder: The `.map(node => brandNodeInternal(node as unknown as NodeRecord))` cast is necessary because GraphNode (internal buffer type) is more permissive than NodeRecord. This is safe — builders validate nodes before buffering.
  - RFDBServerBackend: The `_parseNode()` return type change from `BaseNodeRecord` to `AnyBrandedNode` is correct. The function brands the parsed object before returning.

- **No forbidden patterns:** Clean. No TODOs, no commented code, no mocks, no hacks.

### Complexity Check

- **Runtime overhead:** Zero. Branding is a phantom type (exists only in TypeScript's type system). At runtime, `brandNodeInternal()` is a no-op cast — JavaScript sees `return node;`.

- **GraphBuilder .map() overhead:** Negligible. Array.map is fast for small batches (~100-1000 nodes per flush). The type safety benefit far outweighs the microseconds of iteration.

### Commit Quality

Reviewed all 5 commits:

1. **9b0619f** — Create internal helper (clean, self-contained)
2. **b9b218b** — Update NodeFactory (35 call replacements, no behavior change)
3. **2b6cff8** — Add branding in GraphBuilder + RFDBServerBackend (both correct)
4. **d32819d** — Make brandNode internal (BREAKING, as intended)
5. **0a760c5** — Update GraphBackend interface (BREAKING, as intended)

Each commit:
- Atomic (can be cherry-picked independently up to commit 3)
- Clear message (follows conventional commit format)
- Compiles (commits 1-3 are green, 4-5 have expected errors)

### Final Assessment

This is excellent infrastructure work:
- Type safety enforced at compile time
- Zero runtime cost
- Minimal, focused changes
- Clear separation between public API and internal helpers
- All planned outcomes achieved
- 31 errors are intentional, blocking the problem pattern

The downstream tasks (REG-369 through REG-377) can now proceed to fix the 31 call sites by converting them to use NodeFactory.

**No issues found.**
