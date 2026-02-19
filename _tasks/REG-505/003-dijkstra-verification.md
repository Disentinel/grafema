## Dijkstra Plan Verification

**Verdict:** REJECT

**Completeness tables:** 4
**Gaps found:** 3
**Precondition issues:** 2

---

## Critical Finding: `type()` Predicate Is Not An Alias

Don's plan states (Section 2, Step 2):
> Match node(VAR, "TYPE") and type(VAR, "TYPE") predicates — `type()` alias is the same predicate per RFDB docs and CLI help text.

**This is wrong.** Verification of the Rust evaluator:

**File:** `packages/rfdb-server/src/datalog/eval.rs`, line 178–190:

```rust
pub fn eval_atom(&self, atom: &Atom) -> Vec<Bindings> {
    match atom.predicate() {
        "node" => self.eval_node(atom),
        "edge" => self.eval_edge(atom),
        "incoming" => self.eval_incoming(atom),
        "path" => self.eval_path(atom),
        "attr" => self.eval_attr(atom),
        "attr_edge" => self.eval_attr_edge(atom),
        "neq" => self.eval_neq(atom),
        "starts_with" => self.eval_starts_with(atom),
        "not_starts_with" => self.eval_not_starts_with(atom),
        _ => self.eval_derived(atom),  // <-- "type" falls here
    }
}
```

The predicate `"type"` has no branch. It falls through to `eval_derived`, which looks up user-defined rules. Since no rule named `type` is pre-loaded, `type(X, "FUNCTION")` returns an empty result — not because no FUNCTION nodes exist, but because `type` is an unrecognized predicate.

The same is true in `eval_explain.rs`, lines 264–268 — identical dispatch, no `"type"` case.

**The CLI help text** (`packages/cli/src/commands/query.ts`, lines 95–96) says:
```
type(Id, Type)   Find nodes by type or get type of node
node(Id, Type)   Alias for type
```

This documents `type()` as the canonical predicate and `node()` as the alias — but the Rust evaluator only handles `node()`. The CLI documentation is INCORRECT relative to the actual evaluator behavior. Or the CLI documentation describes intended behavior that is not yet implemented.

**Impact on plan:** The `extractQueriedTypes` regex `/\b(?:node|type)\([^,)]+,\s*"([^"]+)"\)/g` will extract type strings from `type()` predicates and generate suggestions — but those suggestions are moot because `type()` predicates silently return 0 results regardless of whether the type exists. The suggestion will correctly say "did you mean FUNCTION?" but the real fix needed is adding `"type" => self.eval_node(atom)` to the Rust dispatch table. The plan treats a symptom (0 results → suggest types) without diagnosing the root cause (`type()` is broken as a predicate).

**Don's plan does not identify or address this architectural gap.** Per the Root Cause Policy: stop, do not patch. Identify the gap and fix from the roots.

---

## Completeness Table 1: Predicates That Take Type Arguments

| Predicate | Type argument position | Handled by regex? | Notes |
|-----------|----------------------|-------------------|-------|
| `node(X, "TYPE")` | 2nd arg | Yes (nodeRegex) | Primary node predicate |
| `type(X, "TYPE")` | 2nd arg | Yes (nodeRegex) | Treated as alias — but it is BROKEN in Rust (returns 0 always via eval_derived) |
| `edge(X, Y, "TYPE")` | 3rd arg | Yes (edgeRegex) | Edge predicate |
| `incoming(X, Y, "TYPE")` | 3rd arg | Yes (edgeRegex) | Reverse edge predicate |
| `path(X, Y)` | No type arg | N/A — no false positive | BFS reachability only |
| `attr(X, "name", V)` | No type arg (2nd arg is attr name, not node type) | N/A — no false positive | `\b(?:edge|incoming)\(` does not match `attr(` |
| `attr_edge(Src, Dst, "ETYPE", "attr", V)` | 3rd arg is edge type | **NOT handled** | `attr_edge` is a 5-arg predicate; the edge regex matches `\b(?:edge|incoming)\(` only. `attr_edge` is excluded. This is acceptable — `attr_edge` already requires a valid edge type or it silently fails. |
| `neq`, `starts_with`, `not_starts_with` | No type arg | N/A | Comparison predicates |

**Gap identified:** `type()` predicate — the plan's assumption that it is an alias is incorrect at the Rust level. This needs investigation before the regex coverage claim is valid.

---

## Completeness Table 2: `extractQueriedTypes` Input Pattern Coverage

| Input pattern | Expected behavior | Handled by plan? |
|--------------|-------------------|------------------|
| `node(X, "FUNCTON")` | `{ nodeTypes: ["FUNCTON"], edgeTypes: [] }` | Yes |
| `type(X, "FUNCTON")` | `{ nodeTypes: ["FUNCTON"], edgeTypes: [] }` | Yes (regex extracts) — but see critical finding above |
| `node(_, "FUNCTON")` | `{ nodeTypes: ["FUNCTON"], edgeTypes: [] }` | Yes — `[^,)]+` matches `_` |
| `node(X, "FUNCTON"), node(Y, "CALASS")` | `{ nodeTypes: ["FUNCTON", "CALASS"], edgeTypes: [] }` | Yes — global regex with `while` loop |
| `edge(X, Y, "CALS")` | `{ nodeTypes: [], edgeTypes: ["CALS"] }` | Yes |
| `incoming(X, Y, "CALS")` | `{ nodeTypes: [], edgeTypes: ["CALS"] }` | Yes |
| `violation(X) :- node(X, "FUNCTON").` | `{ nodeTypes: ["FUNCTON"], edgeTypes: [] }` | Yes — regex searches whole string |
| `attr(X, "name", "foo")` | `{ nodeTypes: [], edgeTypes: [] }` | Yes — regex won't match `attr(` |
| `node(X, T)` (variable type) | `{ nodeTypes: [], edgeTypes: [] }` | Yes — `"([^"]+)"` requires quotes |
| `node(X, Y), edge(X, Y, Z)` | `{ nodeTypes: [], edgeTypes: [] }` | Yes — no quoted type constants |
| `\+ node(X, "FUNCTON")` | `{ nodeTypes: ["FUNCTON"], edgeTypes: [] }` | Yes — `\b` matches after `+` |
| `node(X,"FUNCTON")` (no space after comma) | `{ nodeTypes: ["FUNCTON"], edgeTypes: [] }` | Yes — `\s*` handles zero spaces |
| `NODE(X, "FUNCTON")` (uppercase predicate) | `{ nodeTypes: [], edgeTypes: [] }` | **NOT handled** — regex is case-sensitive, `\bNODE\(` does not match. This is acceptable: the Datalog parser uses lowercase predicates by convention, and all documented examples use lowercase. |
| `node:type(X, "FUNCTON")` (hypothetical scoped predicate) | N/A | Hypothetical — does not exist in current grammar |
| Empty string `""` | `{ nodeTypes: [], edgeTypes: [] }` | Yes — regex finds no matches |
| No type literals: `neq(X, Y)` | `{ nodeTypes: [], edgeTypes: [] }` | Yes |

**Result: 14 of 14 input patterns accounted for.** The one gap (uppercase predicates) is non-issue since the grammar enforces lowercase predicates.

---

## Completeness Table 3: Suggestion Generation Scenarios

| Scenario | Expected behavior | Handled by plan? |
|----------|-------------------|------------------|
| `node(X, "FUNCTON")` — distance 1 from "FUNCTION" | Suggest "FUNCTION" | Yes |
| `node(X, "NONEXISTENT_TYPE_XYZ123")` — distance > 2 from all types | Show available types (fallback) | Yes (existing behavior generalized) |
| `node(X, "FUNCTION")` — type exists, returns 0 results (empty graph section) | **No suggestion** (type IS in nodeCounts) | Yes — gate is `!nodeCounts[queriedType]` |
| `node(X, "function")` — lowercase, "FUNCTION" exists in graph | Show available types, NOT "FUNCTION" suggestion | **Gap** — `findSimilarTypes` uses `levenshtein("function", "function") = 0` which fails `dist > 0`. No suggestion generated. User sees generic available types list. Not a crash, but misleading. |
| Two typos in same query: `node(X, "FUNCTON"), edge(X, Y, "CALS")` | Suggestions for both | Yes — plan loops over all queried types |
| One correct, one typo: `node(X, "FUNCTION"), edge(X, Y, "CALS")` | Suggestion only for "CALS", not "FUNCTION" | Yes — gated by `!nodeCounts[queriedType]` for nodes; edge equivalent for edges |
| Empty graph (no nodes) | `nodeCounts = {}`, `availableTypes = []`, `findSimilarTypes` returns `[]`, fallback shows empty available types | Partially handled — the fallback text would be "Available types: " with empty list. This is mildly confusing but not a crash. |
| Graph with only one type, user queries a completely different type | `findSimilarTypes` returns `[]` (distance > 2), fallback shows the one available type | Yes |
| Query with no type literals, returns 0 (e.g., pure `attr` query) | `extractQueriedTypes` returns empty arrays, no DB calls made (per optimization), fallback to totalNodes info | Yes — "only if there are queried types to check" gate |
| `type()` predicate used — type exists, returns 0 (broken predicate bug) | Plan suggests correct type, but user still gets 0 results after fix | **Masking underlying bug** — see Critical Finding |

---

## Completeness Table 4: CLI Path — `executeRawQuery` Coverage

| Condition | Expected behavior | Handled by plan? |
|-----------|-------------------|------------------|
| Zero results, `--json` mode | Suggestions should appear on stderr (not contaminate JSON stdout) | **NOT addressed** — Don's plan says "capture stdout/stderr" in tests but does not specify that suggestions in JSON mode must go to stderr. The current unknown-predicate warning correctly uses `console.error`. The plan must specify the same for new suggestion output. |
| Zero results, plain text mode | Suggestions on stdout | Yes |
| `executeRawQuery` with `explain=true`, zero results | No suggestion (explain mode has separate rendering path) | **NOT addressed** — the explain branch returns early before the zero-results block. This is probably correct behavior, but the plan does not explicitly state it. |
| CLI with `--json` and zero results | JSON output `[]`, then suggestion on stderr | Ambiguous in plan |

---

## Gap Summary

### Gap 1 (CRITICAL): `type()` predicate is not a working alias in the Rust evaluator

**Location:** `packages/rfdb-server/src/datalog/eval.rs`, line 189.

The predicate `type(X, "FUNCTON")` falls through to `eval_derived`. Since no built-in rule for `type` is pre-loaded, it always returns empty results — not because of a typo, but because the predicate is unimplemented. The CLI docs claim `type()` is the primary predicate, but the Rust code only implements `node()`.

**Required action:** Before implementing suggestion logic for `type()` predicates, the team must decide: (a) is `type()` intended to work and the Rust evaluator has a bug? Or (b) is `type()` intentionally excluded and the CLI docs are wrong? This is an architectural question that must be answered before proceeding. Simply adding regex coverage for `type()` in the suggestion logic does not fix the underlying issue and may mislead users.

### Gap 2 (MEDIUM): Case-insensitive suggestion miss

**Location:** `findSimilarTypes` in `packages/mcp/src/utils.ts`, line 111.

`findSimilarTypes` applies `levenshtein(queriedLower, type.toLowerCase())`. The condition is `dist > 0 && dist <= maxDistance`. If `queriedLower == type.toLowerCase()` (e.g., user writes `function` for `FUNCTION`), `dist = 0`, and no suggestion is generated. The fallback then shows "Available types: FUNCTION, ..." which is technically correct but not the UX-ideal "did you mean FUNCTION?" response.

**Required action:** The plan should either document this as acceptable behavior or fix `findSimilarTypes` to handle the case-mismatch scenario (remove `dist > 0` and check `queriedType !== type` using original casing).

### Gap 3 (LOW): CLI suggestion output mode in `--json` flag

**Location:** `executeRawQuery` in `packages/cli/src/commands/query.ts`.

The plan does not specify whether suggestion output in `--json` mode should go to stdout (contaminating the JSON) or stderr (safe). The existing unknown-predicate warning uses `console.error`. The plan says "each site formats output differently" but does not specify the stdout/stderr decision for CLI suggestions in JSON mode. This needs to be explicit to avoid breaking JSON consumers of the CLI.

---

## Precondition Issues

### Precondition 1: `countNodesByType()` returns only types with count > 0

**Verified in:** `packages/rfdb-server/src/graph/engine.rs`, line 1595–1656.

The implementation counts actual nodes — it never inserts a key with count 0. Therefore `Object.keys(nodeCounts)` returns only types that have at least one node in the current graph. This is the correct behavior for the suggestion logic: we cannot suggest a type that exists in "the schema" but has no nodes, since such a concept does not exist in Grafema's graph model.

**Consequence:** The check `!nodeCounts[queriedType]` correctly identifies both (a) types that don't exist in the schema at all, and (b) types that used to exist but now have 0 nodes (which `countNodesByType` would not include). This is correct behavior.

### Precondition 2: Empty graph behavior

**Scenario:** If the graph has 0 nodes, `countNodesByType()` returns `{}`. Then:
- `Object.keys(nodeCounts)` = `[]`
- `findSimilarTypes(queriedType, [])` returns `[]`
- The fallback produces: "Available types: " (empty string)

Don's plan does not explicitly handle this. The output "Available types: " with nothing after is confusing. The plan should add a guard: if `availableTypes.length === 0`, show "Graph has no nodes" rather than "Available types: ".

---

## Summary

The plan's core mechanics are sound: `extractQueriedTypes` regex covers all real predicates, `findSimilarTypes` is the right building block, and the two-path (MCP + CLI) coverage is complete. The `countNodesByType` precondition is verified correct.

However, the plan cannot be approved due to Gap 1: the assumption that `type()` is a working predicate alias is false. Including `type()` in the regex without fixing the Rust evaluator (or documenting that `type()` queries are already broken and this feature only covers `node()` predicates for now) violates the Root Cause Policy. The plan is adding suggestion polish on top of a broken predicate.

**Required before proceeding:**
1. Determine the intended behavior of `type()` predicate (CLI docs say it is primary; Rust says it is undefined). Fix the root cause first.
2. Clarify CLI `--json` + zero results output destination (stdout vs stderr).
3. Consider documenting (or fixing) the case-sensitivity gap in `findSimilarTypes`.
