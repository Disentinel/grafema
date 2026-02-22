## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

The fix is correct and honest. `const x = new Foo()` produces a mutable object instance — calling it a CONSTANT was wrong at the semantic level. The graph now tells the truth: this node is a VARIABLE. An AI querying the graph for constants would have received a lie before; now it receives the truth. That is exactly what "AI should query the graph, not read code" demands — the graph must be semantically accurate, not just syntactically faithful.

The change is a single-line removal of `isNewExpr` from the `shouldBeConstant` guard. There is no cleverness, no workaround, no new abstraction. The `isNewExpr` variable is still used correctly below to push `classInstantiations` entries. The two concerns — node classification and instantiation tracking — remain cleanly separated.

The regression test is precise. It exercises the ASTWorker parallel path (module-level `const` declarations), verifies the correct node type in the graph, and includes a message that explains the invariant being enforced. That is the right level of documentation for a regression test.

No corners were cut. No architectural debt was introduced. The graph is more truthful than before.
