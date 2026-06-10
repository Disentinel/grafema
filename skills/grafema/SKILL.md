---
name: grafema-code-graph
description: |
  Use the Grafema code knowledge graph effectively: decide when plain grep/read
  is enough and when graph queries pay off. Use when: (1) working in a repository
  that has a .grafema/ directory or a grafema MCP server connected, (2) about to
  explore an unfamiliar codebase, (3) debugging a wrong-value / data-propagation
  bug, (4) planning a refactor and needing impact analysis, (5) grep returned
  0 hits or 20+ hits and you can't narrow it down, (6) about to modify a function
  without knowing its callers.
version: 0.2.0
date: 2026-06-10
---

# Grafema: graph when it pays, grep when it doesn't

Grafema builds a semantic graph of the codebase: nodes are functions, classes,
variables, files, services; edges are calls, imports, data flow, HTTP links.
You query it through MCP tools (`mcp__grafema__*`) instead of reconstructing
structure from raw text. The graph is pre-computed — querying it is cheap;
reading and re-deriving structure from files is expensive.

**The honest rule: the graph is NOT always better.** On simple, textually-unique
lookups grep is faster and cheaper. The graph wins when the answer lives in
*relationships* (who calls this? where does this value come from?) rather than
in *text*. Route by the question, not by habit.

**Scale factor — check this FIRST (it comes free with `get_stats`).** The tier
table assumes a codebase where textual search degrades: large, multi-service,
aliased, indirect. On a small repo (roughly <300 files / <50K graph nodes)
grep+read is competitive at EVERY tier — measured on a 142-file codebase, plain
grep matched graph answers on caller-enumeration at ~1/7th the cost and on
dataflow tracing at ~1/2. There, use the graph only after text search has
actually failed, or when the question crosses 2+ indirection hops (re-exports,
dynamic dispatch, cross-service calls). The graph's edge grows with size: in
200K+-node codebases file-hopping costs explode while graph-query cost stays flat.

## Tier table — route by question type

| Tier | Question looks like | Use | Don't use |
|---|---|---|---|
| 0 — no tools | You already know the file and line | direct Read/Edit | anything else |
| 1 — text | Unique string/symbol, error message, config key, TODO sweep | Grep/Glob | graph (overhead, no gain) |
| 2 — graph lookup | "Where is X defined?" across files/aliases/re-exports; "what's in this module?" in unfamiliar code | `find_nodes`, `get_file_overview`, `describe` | reading whole files to orient |
| 3 — graph relations | "Who calls X?", "what breaks if I change this signature?", "what does this handler touch?" | `find_calls`, `get_context`, `get_neighbors` | grep (misses dynamic dispatch, aliases, re-exports) |
| 4 — flow & architecture | "Why is this value wrong here?", "how does data get from A to B?", cross-service traces, refactor blast radius | `trace_dataflow`, `trace_calls`, `query_graph` (Datalog) | manual file-hopping (you will miss a hop) |

**Start every session in graph-enabled repos with ONE call: `get_stats`.**
- Nodes > 0 and semantic types present (FUNCTION, CALL edges) → graph is live, use the table.
- Empty / structural-only (file nodes but no call edges) → the graph is degraded;
  fall back to Tier 1 for everything and say so. Don't fight a missing graph.

## Escalation signals (move DOWN the table → higher tier)

- Grep returned **0 hits** and you don't know the synonyms → `find_nodes` with partial name.
- Grep returned **20+ hits** across many files → `find_calls`/`get_context` on the real symbol instead of eyeballing matches.
- The symbol is **re-exported, aliased, or dynamically dispatched** → text search lies; use Tier 3.
- **Don't flail on names:** if two `find_nodes` calls miss, stop guessing name variants — `get_file_overview` the most likely file, or grep the literal string to anchor, then return to the graph with the exact name.
- You are about to **edit a function** → `find_calls` on it first. Non-negotiable for shared code.
- The bug is a **wrong value at a distance** (set in one place, wrong in another) → `trace_dataflow` backward from the symptom. This is the single highest-payoff graph call.

## De-escalation signals (move UP the table → cheaper tier)

- The graph query returned the answer → READ the 1-2 files it pointed at; don't keep querying for what's now obvious.
- One-file change, doc edit, rename within a file → Tier 0-1, done.
- Two graph calls in a row returned empty/errors for the same target → stop; the target may be outside graph coverage (generated code, vendored deps). Grep it.

## Workflow patterns

**Bug fix (wrong behavior):**
`get_stats` → `find_nodes` (symptom symbol) → `get_context` (edges in/out) →
if value-propagation: `trace_dataflow` backward → read ONLY the implicated spans →
`find_calls` on the function you'll change → edit.

**Onboarding / "what is this codebase?":**
`get_stats` → `discover_services` → `get_file_overview` on entry points →
`describe` for compact per-file notation (10-20x smaller than source). Read source last.

**Refactor / signature change:**
`find_calls` (all callers) → `get_neighbors` for types/shapes flowing through →
enumerate call sites BEFORE the first edit, fix leaf-to-root.

**Code review of someone else's diff:**
For each changed function: `find_calls` (did they check callers?) +
`trace_effects` if the change touches state/IO.

## Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| `find_nodes` empty | wrong name guess or coverage gap | retry: no type filter → partial name → file name; then grep |
| `get_context` "node not found" | stale ID | re-run `find_nodes`, use fresh ID |
| Structural-only warning at analyze | analyzer binaries missing (restricted network) | graph has files/imports but no semantics; Tier 1 + tell the user |
| Every query slow / connection refused | rfdb-server not running | `grafema analyze` or check MCP server; don't retry blind |

## Cost intuition

A graph call costs ~100-500 tokens and answers a *structural* question exactly.
Reading a file costs 1-10K tokens and answers it *maybe*. But ten graph calls
that you didn't need cost more than the one grep that did. The benchmark
evidence behind this skill: graph-first agents won on architecture-level and
debugging questions (where relationships matter) and merely broke even or paid
overhead on simple lookups. Route accordingly.
