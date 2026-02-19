# Dijkstra Correctness Review — REG-518

**Reviewer:** Edsger W. Dijkstra (Correctness Reviewer)
**Task:** REG-518 — `type()` predicate not implemented in Rust evaluator
**Verdict:** APPROVE with two defect reports

---

## Method

I do not read a program and say "I think it works." I enumerate the input space, identify every execution path, and verify each path terminates in the correct state. For a dispatch table change, this means: enumerate every possible predicate string, trace each through every dispatch table, and verify correctness of routing.

---

## Input Enumeration: What Predicate Strings Reach `eval_atom()`?

The Datalog parser (`parser.rs`) accepts any identifier as a predicate name. It performs no validation against a known list. Therefore `eval_atom()` receives:

1. **Documented builtins**: `"node"`, `"type"`, `"edge"`, `"incoming"`, `"path"`, `"attr"`, `"attr_edge"`, `"neq"`, `"starts_with"`, `"not_starts_with"`
2. **User-defined rule predicates**: any string matching `[a-z_][a-z0-9_]*`
3. **Misspelled predicates**: e.g., `"Node"`, `"TYPE"`, `"nodes"` — fall to `eval_derived`, which returns `vec![]` (correct: fail silently on unknown)

---

## Dispatch Table Completeness — Three Tables, Three Verifications

### Table 1: `eval.rs` line 178–191

```rust
match atom.predicate() {
    "node" | "type" => self.eval_node(atom),   // changed
    "edge" => self.eval_edge(atom),
    "incoming" => self.eval_incoming(atom),
    "path" => self.eval_path(atom),
    "attr" => self.eval_attr(atom),
    "attr_edge" => self.eval_attr_edge(atom),
    "neq" => self.eval_neq(atom),
    "starts_with" => self.eval_starts_with(atom),
    "not_starts_with" => self.eval_not_starts_with(atom),
    _ => self.eval_derived(atom),
}
```

**CORRECT.** The `"type"` arm is added. All 10 documented builtins have explicit routes. Case-sensitivity: Rust string matching is exact. `"Type"` and `"TYPE"` fall to `eval_derived`. This is consistent with how all other predicates behave — the parser emits lowercase predicate names (it calls `parse_identifier()` which does not case-fold), so case-sensitivity is not a user-facing defect.

### Table 2: `eval_explain.rs` line 261–274

```rust
match atom.predicate() {
    "node" | "type" => self.eval_node(atom),   // changed
    "edge" => self.eval_edge(atom),
    "incoming" => self.eval_incoming(atom),
    "path" => self.eval_path(atom),
    "attr" => self.eval_attr(atom),
    "neq" => self.eval_neq(atom),
    "starts_with" => self.eval_starts_with(atom),
    "not_starts_with" => self.eval_not_starts_with(atom),
    _ => self.eval_derived(atom),
}
```

**DEFECT FOUND — PRE-EXISTING, NOT INTRODUCED BY THIS PR.**

This table is missing the `"attr_edge"` arm that exists in `eval.rs`. This means `attr_edge()` queries silently fall through to `eval_derived()` (returning empty results) in explain mode. This asymmetry was noted by Вадим auto in their review and is correctly called out as pre-existing. It is not introduced by REG-518.

However, I must formally record it because the correctness of the `type()` fix is evaluated in context: if I were reviewing whether the dispatch tables are mutually consistent, the answer is no — and this PR does not make them consistent. The PR is correct within its scope but does not eliminate the existing inconsistency.

**`"type"` change in `eval_explain.rs`: CORRECT within scope.**

### Table 3: `utils.rs` line 165–167 (reorder planner)

```rust
match pred {
    "node" | "type" => {     // changed
        let provides = free_vars(args, bound);
        (true, provides)
    }
    "attr" => { ... }
    "attr_edge" => { ... }
    "edge" => { ... }
    "incoming" | "path" => { ... }
    "neq" | "starts_with" | "not_starts_with" => { ... }
    _ => { free_vars, always placeable }
}
```

**CORRECT.** The classification is: `type()` is always placeable, provides all free variables. This is the correct semantics — identical to `node()`. Without this change, a query `type(X, "FUNCTION"), attr(X, "name", N)` would fall to the `_` branch, which coincidentally gives the same result (also always-placeable, also provides free vars). So the pre-PR behavior for `type()` in the planner was accidentally correct, but the explicit arm is now formally correct.

Note: the reorder planner's `_` branch also correctly handles user-defined derived predicates and would have handled `type()` correctly anyway. This makes the utils.rs change correct but technically not necessary for correctness — it is necessary for documentation and future-proofing.

---

## TypeScript Dispatch: `query-handlers.ts` line 56

```typescript
const typeMatch = query.match(/(?:node|type)\([^,]+,\s*"([^"]+)"\)/);
```

**CORRECT.** The regex now matches both `node(X, "TYPE")` and `type(X, "TYPE")` patterns for the "did you mean" hint. The character class `[^,]+` matches the first argument (variable or constant). The `"([^"]+)"` captures the type name from the second argument.

**Edge case analysis:**
- `type(X, "some:type")` — matches, extracts `"some:type"`. Correct.
- `type(_, "some:type")` — matches (underscore is not a comma). Correct.
- `type(X, Y)` — does not match (second arg is not a quoted string). Acceptable: no type to check for misspellings.
- `type("12345", Type)` — does not match (second arg is not a quoted string). The "did you mean" hint is only for the `(Var, Const)` form, which is the most common form users write. This is a pre-existing limitation, not introduced here.

---

## Test Coverage by `eval_node()` Arm

`eval_node()` has four arms based on `(id_term, type_term)`:

| Arm | Pattern | Existing `node()` test | New `type()` test |
|-----|---------|----------------------|-------------------|
| `(Var, Const)` | `type(X, "queue:publish")` — find all nodes of type | `test_eval_node_by_type` | `test_type_alias_returns_same_results_as_node` ✓ |
| `(Const, Var)` | `type("1", Type)` — find type of specific node | `test_eval_node_by_id` | `test_type_alias_by_id` ✓ |
| `(Const, Const)` | `type("1", "queue:publish")` — existence check | None | None |
| `(Var, Var)` | `type(X, Y)` — full enumeration | `test_eval_node_basic` (implicit) | None |
| `_` | degenerate | implicit | None |

**DEFECT FOUND — INCOMPLETE TEST COVERAGE.**

The `(Const, Const)` arm is not tested for `type()`. This arm performs an existence check: it fetches the node by ID, compares its type to the expected type, and returns either `vec![Bindings::new()]` (match) or `vec![]` (no match). While the alias dispatch means `type()` is provably identical to `node()` in behavior (same function, same code), the test suite provides no direct evidence for this arm.

I do not accept "it dispatches to the same function" as a substitute for a test. A future refactor could introduce a conditional or a separate `eval_type()` function. Without a test, that defect would be invisible.

The `(Var, Var)` arm is similarly untested for `type()`, though I note it is also weakly tested for `node()` — `test_eval_node_basic` exercises it implicitly rather than explicitly.

**Assessment of severity:** MEDIUM. The alias dispatch is provably correct at the code level; the test gap is a quality defect in the test suite, not a defect in the implementation. The implementation cannot be wrong for these arms given the current code structure. But the test suite does not lock this invariant against future change.

---

## Complete Dispatch Point Search

I searched the entire codebase for all locations that string-match on predicate names. The exhaustive list is:

1. `eval.rs:180` — main evaluator dispatch. **Fixed.**
2. `eval_explain.rs:265` — explain evaluator dispatch. **Fixed.**
3. `utils.rs:166` — reorder planner classification. **Fixed.**
4. `query-handlers.ts:56` — "did you mean" hint regex. **Fixed.**
5. `cli/src/commands/query.ts:1056` — `BUILTIN_PREDICATES` constant. **Already correct** — this Set was updated to include `"type"` (it contains all 10 predicates including `"type"` with a `BUILTIN_PREDICATES.size === 10` assertion).
6. `GuaranteeManager.ts:355` — `extractRelevantTypes()` node pattern regex matches only `node\(`. Does not match `type\(`. **Pre-existing gap, not introduced by this PR.** Documented by Вадим auto.
7. `documentation-handlers.ts:44` and `definitions.ts:32` — MCP help text lists `node(Id, Type)` but not `type()` as a predicate. This is a documentation gap: the help text shown to AI agents does not mention that `type()` is a valid alias. **This gap is not introduced by this PR** but is worth noting.

**No dispatch points were missed by the implementation.**

---

## Consistency Proof for the Alias

The alias is implemented as a single-level dispatch redirect:

```
eval_atom("type", args) → eval_node(args)
eval_atom("node", args) → eval_node(args)
```

Both predicates call `eval_node()` with identical `atom` arguments. `eval_node()` does not inspect `atom.predicate()` — it only reads `atom.args()`. Therefore the behavior of `type(a, b)` is provably identical to `node(a, b)` for all values of `a` and `b`.

This proof holds for all three dispatch tables independently. The alias is correct.

---

## Summary of Findings

| Finding | Type | Introduced by PR? | Blocks merge? |
|---------|------|------------------|---------------|
| `eval.rs` `type()` dispatch | Correct | N/A (fix) | N/A |
| `eval_explain.rs` `type()` dispatch | Correct | N/A (fix) | N/A |
| `utils.rs` `type()` classification | Correct | N/A (fix) | N/A |
| `query-handlers.ts` regex | Correct | N/A (fix) | N/A |
| `BUILTIN_PREDICATES` already contains `"type"` | Correct (pre-existing) | No | No |
| `eval_explain.rs` missing `attr_edge` arm | Pre-existing defect | No | No |
| `GuaranteeManager.extractRelevantTypes()` misses `type(` | Pre-existing gap | No | No |
| MCP help text does not document `type()` alias | Documentation gap | No | No |
| `(Const, Const)` arm not tested for `type()` | Test coverage gap | Yes (partial — arm existed, not tested for alias) | No |
| `(Var, Var)` arm not tested for `type()` | Test coverage gap | Yes (partial) | No |

---

## Final Verdict

**APPROVE.**

The implementation is provably correct. The alias dispatch is a mathematical identity — both predicates call the same function with the same arguments. No dispatch points were omitted. The three changed files are mutually consistent.

Two test coverage gaps exist for the `(Const, Const)` and `(Var, Var)` arms of `type()`. These are quality defects in the test suite, not implementation defects. Given that the alias proof is trivial (single-level dispatch to shared function), these gaps do not warrant blocking the merge. They should, however, be remedied in the test suite — either in this PR or in an immediate follow-up.

The pre-existing `attr_edge` asymmetry between `eval.rs` and `eval_explain.rs` and the `GuaranteeManager.extractRelevantTypes()` gap are correctly scoped out of this PR.

The unrelated `package.json` change noted by Steve Jobs must be addressed before merging.
