# Evidence Required for Claims

Enforce the "no claim without evidence" discipline for plans, Dijkstra verifications, implementation-summary reports, and any document an implementer or reviewer will trust.

## When to Use

- Writing or reviewing a plan with completeness tables
- Running Dijkstra-style verification on a plan
- Writing an implementation-summary or hand-off doc that will outlive the current session
- Claiming "X is already handled", "Y follows existing pattern", "Z is complete"
- Any row in a table that uses YES / NO / UNCLEAR / DONE / PARTIAL

## The Rule

Every assertion about code / graph / contract / API / coverage carries evidence from one of five forms:

- (a) `file:line` reference in current HEAD, verified by Read/Grep in this session (not recalled).
- (b) Shell command + its actual output, inlined into the doc.
- (c) Passing-test citation: `path/to/test.ts:test_name`, with an assertion covering the claim.
- (d) Live-query result: `mcp__grafema__*`, RFDB Datalog, HTTP `/api/*`, or equivalent — full response inlined.
- (e) Commit SHA where the claim was proven true, with a one-line summary of the proof.

"Likely", "usually", "follows pattern X", "standard convention", "probably works", "should be fine", "obvious from context" — **NOT evidence**.

An assertion without evidence defaults to **UNCLEAR → REJECT** in Dijkstra review.

## Highest-Leverage Targets

The evidence rule matters most for:

1. **Graph-shape claims.** "Edge type X connects node types A → B" — must be validated by a live Datalog query on the target RFDB. Grepping analyzer source is insufficient because analyzers evolve and multiple writers may contribute.
2. **Liftable / placeable / exclude lists.** Every entry must have a live-data count: "N edges of this type, M of them both-endpoints-placeable".
3. **"Already implemented" claims.** Commit SHA + file:line, not "I remember doing this".
4. **Test-coverage claims.** Path to the specific test + the assertion it makes, not "there are tests for this".
5. **Contract / invariant claims.** Link to a `guarantees.yaml` rule or a runtime assertion, not "I think the code does this".

## Anti-Patterns (reject these in review)

- **Grep-only validation of enumerations** ("I grep'd for CALL sites and got N") — misses analyzer evolution.
- **Past session memory cited as current fact** — code changes; re-verify.
- **"The existing pattern" without citation** — pattern drift happens between files.
- **"Tests exist" without file:test-name** — often tests cover a different slice.
- **Aggregated totals without per-category breakdown** — hides the `src = CALL intermediary` class of bug that took DAI-22 three Dijkstra passes to discover.

## Protocol for Plan Authors

Before submitting a plan for review, for each claim in the plan:

1. Mark the claim with a superscript `[1]`, `[2]`, etc.
2. In a footnotes section at the bottom, inline the evidence for each numbered claim.
3. If no evidence can be produced in ≤ 10 minutes, the claim is speculative — rewrite it as an open question to be resolved during implementation.

Plan reviewers reject submissions that have claims without numbered evidence.

## Protocol for Dijkstra Reviewers

For every row in a completeness table, require an evidence cell OR auto-mark as UNCLEAR. Specific commands to run:

- For edge-type enumeration: `datalog_query("pair(St, Dt) :- edge(S, D, \"<TYPE>\"), node(S, St), node(D, Dt).")` and inline the full pair distribution.
- For node-type enumeration: `GET /api/stats` and inline the `nodesByType` object.
- For "already implemented": `git log --oneline | grep <keyword>` or `Grep('<symbol>', 'packages/')` with matched lines.
- For test coverage: `Grep('<assertion>', 'test/')` with specific test names.

## Retrospective Anchor

**DAI-22 (2026-04-24).** Three Dijkstra passes approved a plan whose "liftable edges" list (CALLS, READS_FROM, PASSES_ARGUMENT, RETURNS) looked correct on grep of analyzer source. On live data, 99%+ of those edges routed through CALL / REFERENCE / PROPERTY_ACCESS intermediaries (excluded types), so the loader fed the packer 1,502 mostly-structural edges out of 145,000 claimed liftable. Layout placement was correct (zero collisions, 100% distinct positions) but cohesion signal was silently inert — function-to-function call relationships completely invisible to the packer. Root cause: no Dijkstra row required a live-data pair-distribution count. The Evidence Rule is the concrete mechanism to prevent this failure mode.

See `_tasks/DAI-22-tectonic-collision/008-cohesion-gap-diagnosis.md` for the full retrospective, including the exact Datalog query that would have caught the gap in seconds.

## Integration

- `CLAUDE.md` Plan Mode section — cites this rule at the top level.
- `_ai/agent-personas.md` Dijkstra section — codifies the rule as part of the persona's verdict logic (no evidence → auto-UNCLEAR).
- `MEMORY.md` — feedback entry pointing at this skill as the anchor pattern.
