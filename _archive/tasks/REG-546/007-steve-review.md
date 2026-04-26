## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

---

### Vision Alignment

The fix directly serves "AI should query the graph, not read code." VARIABLE nodes for `new Foo()` initializers are exactly the kind of structural data an AI agent needs to reason about object instantiation patterns without falling back to reading source. Before this fix, `const db = new Database()` produced a CONSTANT node — a node type that semantically means "a fixed value." An AI querying the graph would see `db` classified as a constant and draw the wrong conclusion about its nature. That is a graph lie. This fix makes the graph tell the truth.

The INSTANCE_OF and ASSIGNED_FROM edges being preserved after the move of `classInstantiations.push()` outside the guard means the graph is now richer and more accurate simultaneously. Win on both dimensions.

**Coverage of real-world cases:** `const x = new Foo()` is the dominant pattern for object instantiation in JS/TS codebases. This fix handles it correctly, including TypeScript generics (`new Map<string, number>()`). Edge cases like `new (getDynamicClass())()` (non-Identifier callee) are not handled — but they are not regressed either; they silently fall through without INSTANCE_OF edges, same as before. No new lies introduced.

---

### Architecture

The change is the right minimal intervention. The original `shouldBeConstant` condition had a semantic error baked in: it equated "object reference that cannot be reassigned" with "constant value." Those are different things. A `const` binding holding a class instance is a stable reference to a mutable object — it is a VARIABLE in Grafema's schema, not a CONSTANT. The fix removes exactly the wrong predicate (`isNewExpression`) and nothing else.

**Dual path consistency:** Both `VariableVisitor.ts` (module-level) and `JSASTAnalyzer.ts` `handleVariableDeclaration` (in-function) received identical treatment. The MEMORY.md dual-path trap was navigated correctly.

**Complexity check:** No O(n) iteration introduced. The `classInstantiations.push()` block was already inside a `variables.forEach()` loop — moving it from inside one branch to after the if/else does not change the iteration structure at all.

**Snapshot updates:** 9+ nodes flipping from CONSTANT to VARIABLE is a correctness improvement, not a regression. Snapshot diffs of this kind are healthy evidence that the fix has real impact across the existing fixture corpus.

---

### What Would Embarrass Us

Nothing here would embarrass us. The fix is honest, minimal, and well-tested. Kent's test suite covers both code paths, the TypeScript generic edge case, and explicitly guards the INSTANCE_OF edge preservation. The 2177/0 pass/fail result holds.

The only note worth flagging for the future: member expression callees (`new this.factory.create()`, `new ns.Foo()`) are still not tracked. That is a known gap, not a regression from this change, and should be filed as a separate task when it surfaces as a real need.
