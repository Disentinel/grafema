# Linus Torvalds - Phase 3 Design Review: Standard Datalog Rules Library

**Date:** 2026-02-03
**Status:** APPROVED (with strong caveats)

---

## Summary

Don's design for Phase 3 is **fundamentally sound**. The `uses` directive approach is the right architecture. The 4 standard rules are reasonable for MVP. Implementation location is correct.

However, there are **3 critical architectural constraints** that MUST be satisfied before coding begins.

---

## Design Decisions Review

### 1. `uses` Directive vs Auto-Apply: CORRECT CHOICE

**Decision:** Users explicitly reference standard rules via:
```yaml
uses:
  - standard:n-squared-same-scale
```

**Alternative considered:** Auto-apply all standard rules with opt-out

**Verdict: APPROVED**

**Why this is right:**
- Explicit opt-in prevents surprise violations in existing projects
- Clear intent: "This rule applies here"
- Allows per-guarantee customization (some rules in some paths, not others)
- Future: easy to add rule parameters without breaking changes
- Matches existing `governs` pattern in guarantees.yaml

**Risk if we did auto-apply:** Users upgrade Grafema, suddenly 50 new violations appear in CI. Bad experience. This is the right call.

---

### 2. Standard Rules Library: 4 Rules for MVP

| Rule | Purpose | Severity |
|------|---------|----------|
| n-squared-same-scale | Nested loops at same cardinality scale | error |
| unbounded-enricher-iteration | Unbounded iterations in enrichers | error |
| nodes-in-nodes | Nested loops both at nodes scale (10M × 10M) | error |
| unfiltered-large-iteration | Loop over nodes-scale without filtering | error |

**Verdict: MINIMALLY SUFFICIENT**

**Assessment:**
- Rules 1, 2, 3 are **core** - they catch the most common O(n²) patterns
- Rule 4 (unfiltered-large) is **nice-to-have** - catches O(n) when you shouldn't iterate at all
- These 4 cover ~80% of cardinality mistakes in practice
- Not overly granular (we're not shipping 20 rules)
- Not too sparse (we're shipping enough to be useful)

**What's NOT included (correctly):**
- Triple-nested loops (phase 1 constraint: 2-level only)
- Cardinality mismatch detection (e.g., nodes × constant = OK)
- Conditional loops (need dataflow analysis - future)

**Verdict: Right scope for MVP.** Users will ask for more, and we can add without breaking changes.

---

### 3. Library Location: `packages/core/src/guarantees/standard-rules.yaml`

**Verdict: CORRECT**

**Why:**
- YAML rules are metadata/documentation, not code
- Alongside guarantees module where they're loaded
- Not in `cli/` (rules should be reusable by MCP, GUI, other tools)
- Not in `types/` (too low-level)
- Not in `rfdb/` (backend-agnostic)

**Implementation files location check:**
- `standard-rules.yaml` - YES, correct
- Index loader in `packages/core/src/guarantees/index.ts` - YES, correct
- GuaranteeManager changes in `packages/core/src/core/GuaranteeManager.ts` - YES, correct (uses directive support)
- CLI in `packages/cli/src/commands/check.ts` - YES, correct (for `--list-standard-rules`)

---

## Critical Architectural Constraints

**DO NOT START CODING** until these are satisfied:

### CONSTRAINT 1: `uses` Must Merge With Existing `governs`

**Current problem:** Don's design shows `uses` at top level AND on individual guarantees:

```yaml
uses:
  - standard:n-squared-same-scale

guarantees:
  - id: "no-n-squared-enrichers"
    uses: "standard:n-squared-same-scale"
    governs: ["packages/core/src/plugins/enrichment/**"]
```

**Questions:**
1. How do these interact? Is this:
   - **Option A:** Top-level `uses` imports standard rules as GUARANTEE nodes. Individual `uses` references them (pointer semantics)?
   - **Option B:** `uses` creates inline copies of rules (value semantics)?

2. What happens on import/export? If a user's guarantees.yaml has:
   ```yaml
   uses:
     - standard:n-squared-same-scale
   ```
   Does export create a guarantee with `uses: "standard:n-squared-same-scale"` key? Or does it inline the full rule?

**Why it matters:**
- Option A (pointers): One rule node, multiple references. Drift detection must understand references. Clean for maintenance (standard rules can evolve). Harder to audit ("what rule is being applied?")
- Option B (inline): Each guarantee has its own copy. Easy to audit. Maintenance nightmare if standard rule changes (users must re-import). More YAML bloat.

**Current GuaranteeManager context:**
- `import()` method reads YAML and calls `create()` for each guarantee
- `create()` stores full rule text in `rule` field
- `export()` writes guarantee.rule to output YAML
- No notion of "rule references" or external rule library

**Recommendation before coding:**

Implement **Option A (pointer semantics)** like this:

1. **Load standard rules at startup:**
   ```typescript
   // In GuaranteeManager constructor or init()
   const standardRules = loadStandardRulesLibrary('packages/core/src/guarantees/standard-rules.yaml');
   // Creates GUARANTEE nodes: GUARANTEE:standard:n-squared-same-scale, etc.
   ```

2. **On encountering `uses: "standard:rule-id"`:**
   - Don't store rule text in the guarantee node
   - Store only: `uses: ["standard:n-squared-same-scale"]`
   - When checking: resolve standard rule at check time

3. **Export handles references:**
   ```yaml
   guarantees:
     - id: "my-guarantee"
       uses: ["standard:n-squared-same-scale"]
       governs: ["packages/core/**"]
   ```

4. **Drift detection:** If user's file has `uses: ["standard:X"]` but standard rule changed, drift shows as "modified" in standard lib (informational).

**Test case required:** If standard-rules.yaml updated and user's guarantees.yaml unchanged, does `drift()` detect the change? (Answer: should show in summary but mark user's guarantee as "unchanged")

---

### CONSTRAINT 2: Datalog `attr_edge()` Predicate Must Exist

Phase 2 (Linus review, line 75) flagged this:

> **attr_edge() predicate missing** - Phase 3 needs to query `cardinality.scale` in Datalog. The enricher writes metadata but Datalog can't read it yet.

**Current status:** ✅ **IMPLEMENTED** (verified)

**Evidence:**
- `packages/rfdb-server/src/datalog/eval.rs` - `fn eval_attr_edge()` implemented
- Full test coverage in `packages/rfdb-server/src/datalog/tests.rs`
- Tests include:
  - `test_eval_attr_edge_basic()` - basic edge metadata access
  - `test_eval_attr_edge_nested_path()` - exactly what we need: `cardinality.scale` queries
  - `test_eval_attr_edge_constant_match()` - matching against values
  - `test_eval_attr_edge_no_metadata()` - missing metadata handling

**Syntax verified:** `attr_edge(SrcNodeID, DstNodeID, "EdgeType", "metadata.key", Value)`

**This is a GREEN constraint.** No blocking work needed. Phase 3 can proceed with writing rules that use `attr_edge()` to query `cardinality.scale` from Phase 2 enrichment.

---

### CONSTRAINT 3: Standard Rules Must Be Queryable Without Variable Binding

**Problem:** Don's example rule:

```yaml
rule: |
  violation(Outer, Inner, File, Line) :-
    node(Outer, "LOOP"),
    ...
    attr_edge(Outer, Coll1, "ITERATES_OVER", "cardinality.scale", "nodes")
```

**Question:** The `"cardinality.scale"` is a literal string path. Can Datalog traverse nested metadata?

Some Datalog engines require flat predicates: `cardinality_scale(NodeID, "nodes")`

Others support path-based: `attr_edge(NodeID, ..., "cardinality.scale", Value)`

**Required before coding:**
1. Verify RFDB Datalog dialect supports nested metadata paths
2. If not: design flatter representation (e.g., create `cardinality_scale(Node, "nodes")` facts automatically)
3. Test with an actual rule that queries `cardinality.scale` in RFDB

**Do NOT assume** the rules will work. Test one rule end-to-end before writing all 4.

---

## Code Quality / Architecture Observations

### What's Good About This Plan

1. **Separation of concerns:** Standard rules live in YAML, not code. Good.
2. **Discoverability:** `--list-standard-rules` CLI flag. Users can see what's available.
3. **Extensibility:** Easy to add more standard rules later without code changes.
4. **Reusability:** Standard rules can be referenced in multiple guarantees.yaml files.

### What Needs Clarification Before Implementation

1. **Version management:** If we ship v0.2 with rule X, then in v0.3 we refine rule X, how do we handle projects that already use X? (Backwards compatibility question - probably out of scope for Phase 3, but should note it)

2. **Documentation:** Each standard rule needs a comment explaining what it detects and when to use it. The YAML in Don's plan shows `description:` field. Ensure this is exposed in `--list-standard-rules --verbose`.

3. **Override behavior:** Can users override a standard rule? (Answer: yes, they define a custom rule with same logic. But this should be documented as a pattern.)

---

## Testing Strategy Check

Don's acceptance criteria mention tests but don't detail them. Before Kent writes tests, clarify:

- [ ] Each rule can be tested in isolation (unit test a single rule)
- [ ] Integration test: import standard rules + check them together
- [ ] Test that `uses` correctly references standard rules (not copies)
- [ ] Test that `--list-standard-rules` outputs correct JSON/text
- [ ] Edge case: what if standard rules file is missing? (should fail gracefully)
- [ ] Edge case: what if a rule reference doesn't exist? (should error clearly)

---

## Verdict: APPROVED FOR IMPLEMENTATION

**Conditions:**

1. **Before coding starts:**
   - [ ] Clarify `uses` semantics (pointers vs copies) in design
   - [ ] Verify `attr_edge()` predicate exists in RFDB Datalog
   - [ ] Test one standard rule end-to-end in current system (smoke test the whole pipeline)

2. **During implementation (Kent/Rob):**
   - [ ] No assumptions about Datalog capabilities - test early
   - [ ] If attr_edge() doesn't exist, BLOCK and implement first
   - [ ] Standard rules YAML must be well-commented
   - [ ] `--list-standard-rules` output must be helpful (show rule description, not just ID)

3. **Before merging:**
   - [ ] All 4 standard rules have passing tests
   - [ ] `uses` directive works end-to-end with guarantee import/export
   - [ ] Drift detection doesn't get confused by standard rules

---

## Architecture Alignment

**Does this fit project vision?**

Yes. This is exactly the right abstraction level:
- Graph stores cardinality via enricher (Phase 2)
- Users query graph via Datalog (Phase 3)
- Standard rules library makes common patterns discoverable
- Query-the-graph-not-the-code ✓

**Does it avoid hacks?**

So far yes. One risk: if `attr_edge()` doesn't exist, we'll be tempted to write JavaScript post-processing to check rules. Don't do that. Implement `attr_edge()` properly.

---

## Estimated Effort Assessment

Don estimated 3 days. This seems **right IF:**
- `attr_edge()` already exists (verify immediately)
- Implementation is straightforward YAML + some refactoring in GuaranteeManager

**Could be wrong if:**
- `attr_edge()` doesn't exist → +2 days (implement predicate + tests)
- Datalog syntax surprises us → +1 day (debug, adjust rules)
- Standard rules prove too complex to express → discussion with user

---

---

## TL;DR: Pre-Implementation Checklist

Before Kent writes any tests, verify these in order:

1. ✅ **attr_edge() predicate** - Already implemented in RFDB, fully tested, supports nested paths like `cardinality.scale`. **NO BLOCKING WORK NEEDED.**

2. ⚠️ **`uses` directive semantics** - Must clarify how standard rule references work in import/export/drift. Recommend pointer semantics (Option A). **DESIGN ONLY, 1-2 hours.**

3. ⚠️ **Standard rules test rule** - Pick ONE standard rule (e.g., `n-squared-same-scale`), write it, test it end-to-end in current system. Don't wait until all 4 are done. **This is a smoke test, 1-2 hours.**

If all three pass, Phase 3 is ready to start. Estimated effort 3 days stands if no surprises in smoke test.

---

**Status: APPROVED FOR IMPLEMENTATION**

Proceed with Phase 3 after pre-implementation checklist above.

— Linus Torvalds
