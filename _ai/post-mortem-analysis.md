# Post-Mortem Analysis: Done Bugs

Analysis of resolved bugs to identify patterns and prevention opportunities via Grafema/skills.

---

## Summary

| Bug | Type | Grafema Could Detect? | Action |
|-----|------|----------------------|--------|
| REG-309 | Semantic error | ⚠️ Partially | Scope-aware edge validation |
| REG-250 | Implementation gap | ❌ No | Unit test coverage |
| REG-248 | Missing data flow | ⚠️ Partially | Cross-service validation |
| REG-233 | False positive | ✅ Yes | Pattern matching rules |
| REG-308 | Performance/correctness | ❌ No | Integration tests |
| REG-251 | Implementation gap | ❌ No | Unit test coverage |
| REG-247 | Data passing bug | ⚠️ Partially | Data flow tracing |
| REG-262 | Missing edges | ✅ Yes | Graph completeness check |
| REG-249 | Feature gap | ❌ No | Feature checklist |
| REG-174 | Config not implemented | ❌ No | Config validation |
| REG-213 | Feature broken | ❌ No | Integration tests |

**Summary:**
- ✅ Grafema could detect: 2 (18%)
- ⚠️ Partially: 4 (36%)
- ❌ Cannot detect: 5 (45%)

---

## Detailed Analysis

### REG-309: Scope-aware variable lookup for mutations

**Type:** Semantic error — wrong scope resolution

**Root Cause:**
Variable reassignment tracking used file-level lookup instead of scope-aware. Shadowed variables in nested scopes incorrectly resolved to outer scope.

```javascript
let x = 1;
function foo() {
  let x = 2;
  x += 3;  // Edge created to OUTER x (wrong)
}
```

**Could Grafema Detect?** ⚠️ Partially

A Datalog rule could detect suspicious patterns:
```datalog
% Find mutations where target variable is declared in different scope
mutation(M, V), declared_in_scope(V, S1), mutation_in_scope(M, S2), S1 != S2
```

But this requires scope tracking which was the bug itself.

**Prevention:**
- Skill: "When implementing variable resolution, always consider scope shadowing"
- Test: Property-based tests with nested scopes
- Grafema: Add SHADOWED_BY edge type for explicit tracking

---

### REG-250: Datalog attr() predicate doesn't return attribute values

**Type:** Implementation gap — predicate not binding variables

**Root Cause:**
Rust Datalog evaluator didn't implement variable binding for attr() predicate's third argument.

**Could Grafema Detect?** ❌ No

This is internal Grafema bug. Can't use Grafema to detect bugs in Grafema's Datalog engine.

**Prevention:**
- Unit tests for each predicate with all binding patterns
- Property-based tests: `attr(X, K, V)` should return same results as manual filtering

---

### REG-248: HTTPConnectionEnricher doesn't account for router mount prefixes

**Type:** Missing data flow — incomplete path resolution

**Root Cause:**
Express router mounted at `/api` registers routes as `/invitations/received`, but frontend calls `/api/invitations/received`. Enricher didn't combine mount prefix + route path.

**Could Grafema Detect?** ⚠️ Partially

After fix, could add validation:
```datalog
% Find http:request nodes with no matching http:route
node(R, "http:request"), NOT edge(R, _, "INTERACTS_WITH")
```

But detecting WHY they don't match (mount prefix) requires domain knowledge.

**Prevention:**
- Skill: "When matching paths across services, always consider mounting/routing layers"
- Grafema: Add `mountPrefix` to http:route metadata, validate completeness

---

### REG-233: FetchAnalyzer incorrectly treats console.log() as network request

**Type:** False positive — overly broad pattern matching

**Root Cause:**
FetchAnalyzer used pattern that matched `console.log()` as network call.

**Could Grafema Detect?** ✅ Yes

```datalog
% Find net:request nodes with suspicious callee names
node(N, "net:request"), attr(N, "callee", C),
  member(C, ["console.log", "console.error", "console.warn"])
```

**Prevention:**
- Grafema guarantee: "net:request nodes must have valid network callee"
- Skill: "When writing pattern matchers, explicitly exclude common false positives"
- Test: Negative test cases with similar-looking non-network calls

**Action:** Create Datalog rule for detecting suspicious net:request nodes

---

### REG-308: Fix server-side file filtering in graph backend

**Type:** Performance/correctness — filter not applied server-side

**Root Cause:**
`queryNodes({ file: path })` returned all nodes, required client-side filtering. Bug in RFDB server query handling.

**Could Grafema Detect?** ❌ No

Performance bug in Grafema itself. Would need external profiling.

**Prevention:**
- Integration test: verify returned nodes match filter
- Performance test: large graph + file filter should be fast

---

### REG-251: Datalog edge() predicate returns no results

**Type:** Implementation gap — predicate completely broken

**Root Cause:**
Rust Datalog evaluator had bug in edge() predicate implementation.

**Could Grafema Detect?** ❌ No

Same as REG-250 — internal Grafema bug.

**Prevention:**
- Smoke tests for each Datalog predicate
- Property: `edge(X, Y, T)` count should match `graph.getAllEdges().filter(t)` count

---

### REG-247: WorkspaceDiscovery doesn't pass entrypoints to JSModuleIndexer

**Type:** Data passing bug — value lost in pipeline

**Root Cause:**
`resolveSourceEntrypoint()` found entrypoint, but value wasn't passed through metadata chain to JSModuleIndexer.

**Could Grafema Detect?** ⚠️ Partially

If Grafema analyzed itself:
```datalog
% Find services with entrypoint in metadata but modulesCreated = 0
node(S, "SERVICE"), attr(S, "metadata.entrypoint", E), E != null,
  attr(S, "modulesCreated", 0)
```

**Prevention:**
- Skill: "When passing data through pipeline, verify end-to-end with integration test"
- Test: E2E test from config → discovery → indexing → modules created

**Action:** Created skill `grafema-config-services-indexing`

---

### REG-262: Method calls on objects don't create usage edges

**Type:** Missing edges — incomplete graph

**Root Cause:**
`obj.method()` didn't create edge showing `obj` is used. Caused false positive dead code warnings.

**Could Grafema Detect?** ✅ Yes

```datalog
% Find variables with no outgoing usage edges that have method calls
node(V, "VARIABLE"), NOT edge(V, _, "USED_BY"),
  % but V appears as receiver in some call expression
  call_receiver(C, V)
```

**Prevention:**
- Grafema guarantee: "Every variable used as method receiver must have USED_BY edge"
- Skill: "When analyzing calls, always track receiver object as used"

**Action:** Create graph completeness validation rule

---

### REG-249: `grafema query` doesn't search http:request nodes

**Type:** Feature gap — incomplete search scope

**Root Cause:**
Query command hardcoded list of searchable types, didn't include `http:request`.

**Could Grafema Detect?** ❌ No

Feature completeness issue, not detectable via code analysis.

**Prevention:**
- Checklist: "When adding new node type, update query command search scope"
- Test: Query should find nodes of ALL semantic types

---

### REG-174: CLI analyze: services config field is not implemented

**Type:** Config not implemented — interface missing field

**Root Cause:**
`ProjectConfig` interface didn't have `services` field. Config was silently ignored.

**Could Grafema Detect?** ❌ No

Type system issue — TypeScript should catch this, but interface was just incomplete.

**Prevention:**
- Schema validation: config file vs expected schema
- Test: verify all documented config fields are read

---

### REG-213: grafema query --raw Datalog queries not working

**Type:** Feature broken — flag not implemented

**Root Cause:**
`--raw` flag existed but wasn't wired to Datalog execution.

**Could Grafema Detect?** ❌ No

CLI implementation gap.

**Prevention:**
- Integration test for each CLI flag
- Smoke test: every documented flag should produce expected behavior

---

## Patterns Identified

### 1. Pipeline Data Loss (REG-247, REG-248)
Data enters pipeline but doesn't reach destination.

**Prevention:**
- E2E tests that verify data flows through entire pipeline
- Skill: "Test data flow end-to-end, not just unit"

### 2. Incomplete Pattern Matching (REG-233, REG-249)
Patterns too broad (false positives) or too narrow (missing cases).

**Prevention:**
- Explicit exclusion lists for false positives
- Checklists for new node types

### 3. Missing Graph Edges (REG-262, REG-309)
Graph doesn't capture all semantic relationships.

**Prevention:**
- Grafema guarantees for graph completeness
- Validation rules: "If X happens in code, edge Y must exist"

### 4. Internal Tooling Bugs (REG-250, REG-251, REG-308)
Bugs in Grafema itself.

**Prevention:**
- Property-based testing
- Smoke tests for all predicates/APIs

---

## Conclusions

### What Grafema CAN'T Detect

**45% of bugs are internal/feature gaps:**
- Bugs in Grafema's own Datalog engine (REG-250, REG-251)
- Performance bugs in RFDB server (REG-308)
- Missing CLI features (REG-213, REG-249, REG-174)

These require **tests**, not static analysis.

### What Grafema COULD Detect (with hindsight)

**Only 2 bugs (18%) were truly detectable:**
- REG-233: False positive pattern matching
- REG-262: Missing graph edges

But both require knowing the invariant BEFORE the bug. The bug IS not knowing the invariant.

### Actual Actionable Item

**One concrete skill created:** `analyzer-negative-tests`

When writing pattern-matching analyzers, always include negative test cases for similar-looking non-matches (console.log vs fetch, logger.info vs http.request, etc.).

See: `_ai/skills/analyzer-negative-tests.md`

### Honest Assessment

Most Grafema bugs are prevented by **better test coverage**, not by Grafema analyzing itself:
- Property-based tests for predicates
- Negative tests for pattern matchers
- E2E tests for data pipelines
- Integration tests for CLI flags

---

*Analysis date: 2026-02-03*
