/**
 * MCP Documentation Handlers
 */

import { getOnboardingInstruction } from '@grafema/util';
import {
  textResult,
} from '../utils.js';
import type {
  ToolResult,
  GetDocumentationArgs,
} from '../types.js';

// === DOCUMENTATION ===

export async function handleGetDocumentation(args: GetDocumentationArgs): Promise<ToolResult> {
  const { topic = 'overview' } = args;

  const docs: Record<string, string> = {
    onboarding: getOnboardingInstruction(),
    overview: `
# Grafema Code Analysis

Grafema is a static code analyzer that builds a graph of your codebase.

## Key Tools
- query_graph: Execute Datalog queries
- find_calls: Find function/method calls
- trace_alias: Trace variable aliases
- check_invariant: Verify code invariants

## Quick Start
1. Use get_stats to see graph size
2. Use find_nodes to explore the codebase
3. Use query_graph for complex queries
`,
    queries: `
# Datalog Queries

## Syntax
violation(X) :- node(X, "TYPE"), attr(X, "name", "value").

## Available Predicates
- type(Id, Type) - match nodes (alias: node)
- edge(Src, Dst, Type) - match edges
- attr(Id, Name, Value) - match node attributes (name, file, line, etc.)
- \\+ - negation (not)

## Numeric Comparison Predicates
- gt(Value, Threshold) - greater than
- lt(Value, Threshold) - less than
- gte(Value, Threshold) - greater than or equal
- lte(Value, Threshold) - less than or equal

Values are parsed as floating-point numbers. Non-numeric values produce no matches.
Use with attr() to filter by metadata values (e.g., metrics, line numbers).

## Examples
Find all functions:
  violation(X) :- node(X, "FUNCTION").

Find unresolved calls:
  violation(X) :- node(X, "CALL"), \\+ edge(X, _, "CALLS").

Find files where parsing took > 500ms:
  violation(File, Ms) :- node(M, "METRIC"), attr(M, "name", "parse_ms"), attr(M, "value", Ms), gte(Ms, 500), edge(M, Mod, "OBSERVES"), attr(Mod, "file", File).

Find functions with more than 100 lines:
  violation(X, Lines) :- node(X, "FUNCTION"), attr(X, "line", Start), attr(X, "endLine", End), gt(End, Start).
`,
    types: `
# Node & Edge Types

## Core Node Types
- MODULE, FUNCTION, CLASS, METHOD, VARIABLE
- CALL, PROPERTY_ACCESS, IMPORT, EXPORT, PARAMETER

## Diagnostic Node Types
- METRIC — per-file performance metrics (parse_ms, analyze_ms, file_size_bytes, ast_size_bytes, node_count, edge_count, total_ms). Metadata: value, unit, source. Query: find_nodes(type="METRIC") or Datalog with gte/lte for thresholds.
- ISSUE — analysis problems (oversized files, parse errors, analysis failures). Metadata: category (oversized_source, oversized_ast, parse_error, analysis_error), severity (warning/error), message.

## HTTP/Network
- http:route, http:request, db:query

## Edge Types
- CONTAINS, CALLS, DEPENDS_ON
- ASSIGNED_FROM, INSTANCE_OF, PASSES_ARGUMENT
- OBSERVES (METRIC → MODULE, links performance metric to the file it measured)
`,
    guarantees: `
# Code Guarantees

Guarantees are persistent code invariants.

## Create
Use create_guarantee with a name and Datalog rule.

## Check
Use check_guarantees to verify all guarantees.

## Example
Name: no-eval
Rule: violation(X) :- node(X, "CALL"), attr(X, "name", "eval").
`,
    notation: `
# Grafema DSL — Compact Visual Notation

Grafema DSL renders graph structure as compact, readable notation.
Output-only — Datalog remains the query language.

## Archetypes & Operators

| Archetype  | Op    | Meaning                   | Example edge types                    |
|------------|-------|---------------------------|---------------------------------------|
| contains   | (nest)| structural containment    | CONTAINS, HAS_MEMBER, DECLARES        |
| depends    | o-    | dependency / import       | DEPENDS_ON, IMPORTS_FROM, USES        |
| flow_out   | >     | outward call / data flow  | CALLS, ROUTES_TO, PASSES_ARGUMENT     |
| flow_in    | <     | inward data / type flow   | READS_FROM, ASSIGNED_FROM, EXTENDS    |
| write      | =>    | persistent side effect    | WRITES_TO, LOGS_TO                    |
| exception  | >x    | error / rejection         | THROWS, REJECTS, CATCHES_FROM         |
| publishes  | ~>>   | event / message           | EMITS_EVENT, PUBLISHES_TO, EXPOSED_VIA|
| gates      | ?|    | conditional guard         | HAS_CONDITION, HAS_CASE               |
| governs    | |=    | governance / invariant    | GOVERNS, VIOLATES, MONITORED_BY       |

## LOD Levels (depth)

- **depth=0**: Node names only — minimal overview
- **depth=1** (default): Node + edges — shows all relationships with operators
- **depth=2**: Node + edges + nested children, **folded** — repetitive siblings compressed into exemplar + summary. Ideal for large modules (e.g., 36 handler imports → 1 exemplar + fold summary)
- **depth=3**: Node + edges + nested children, **exact** — every node expanded individually, no folding. Use when you need the precise bijective DSL output

## Perspective Presets

| Preset   | Archetypes shown              | Use case                  |
|----------|-------------------------------|---------------------------|
| security | write, exception              | Audit side effects & errors|
| data     | flow_out, flow_in, write      | Trace data movement       |
| errors   | exception                     | Error handling review      |
| api      | flow_out, publishes, depends  | API surface analysis       |
| events   | publishes                     | Event flow mapping         |

## Special Modifiers

- \`??\` — uncertain/dynamic (unresolved call, dynamic import)
- \`[]\` — inside loop (edge occurs within iteration)

## Budget

Default budget: 7 items per group. When exceeded, remaining items are
summarized as \`+N more\`. Override with budget parameter.

## Usage

**MCP:** \`describe(target="src/app.ts->FUNCTION->main", depth=1, perspective="security")\`
**CLI:** \`grafema describe "src/app.ts->FUNCTION->main" -d 1 --perspective security\`

Target resolution order: semantic ID → file path (MODULE) → node name.
`,
    metrics: `
# Performance Metrics & Analysis Issues

## METRIC Nodes
After analysis, each file gets 7 METRIC nodes stored in the graph:
- parse_ms — time in parser (OXC for JS/TS)
- analyze_ms — time in analyzer daemon
- total_ms — wall-clock time for the file
- file_size_bytes — source file size on disk
- ast_size_bytes — AST JSON size (JS/TS only)
- node_count — graph nodes produced
- edge_count — graph edges produced

Each METRIC node has metadata: value (number), unit (ms/bytes/count), source ("orchestrator").
METRIC → MODULE via OBSERVES edge.

## Querying Metrics
Find all metrics: find_nodes(type="METRIC")
Find metrics for a file: find_nodes(type="METRIC", file="src/app.ts")

Datalog with numeric comparison:
  violation(File, Ms) :- node(M, "METRIC"), attr(M, "name", "parse_ms"), attr(M, "value", Ms), gte(Ms, 500), edge(M, Mod, "OBSERVES"), attr(Mod, "file", File).

## ISSUE Nodes
Files that fail analysis get ISSUE nodes (instead of being silently skipped):
- oversized_source — file larger than maxFileSizeKb config (default: 1MB)
- oversized_ast — AST larger than maxAstSizeKb config (default: 50MB)
- parse_error — parser failed
- analysis_error — analyzer daemon failed
- unresolved_external — call/import target likely outside analyzed root (info)
- unresolved_internal — target file exists in graph but symbol not resolved (warning)

Each ISSUE node has metadata: category, severity (warning/error/info), message.
MODULE → ISSUE via CONTAINS edge. A MODULE stub is created for failed files.

Find issues: find_nodes(type="ISSUE")

## Phase Metrics
Pipeline-level METRIC nodes on synthetic files (__grafema_perf/{phase}):
- analysis duration_ms, total_nodes, total_edges, total_files
- resolve duration_ms
- compact duration_ms

## Profiler
Full profiling guide: _ai/profiling-guide.md
CLI: node scripts/profile-analyze.mjs .grafema/analysis-profile.jsonl
`,
    effects: `
# Side-Effect Taxonomy & Manifests

## Manifests
After analysis, grafema generates manifest.yaml — describes the package's exported API with side-effect annotations.

Contents:
- exports[]: each symbol with name, kind, semanticId, effects[], params[]
- imports[]: dependencies as Package URLs (pkg:npm/@scope/name)
- confidence: 0.0–1.0 (lower when many exports have UNKNOWN effects)

## Effect Types (effects-db/taxonomy.yaml)
- PURE — deterministic, no side effects
- MUTATION — mutates arguments, receiver, or shared state
- IO — filesystem, network, database, device, environment
- THROW — may throw exceptions
- ASYNC — returns Promise, accepts callbacks
- NONDETERMINISTIC — output varies (internal randomness, timestamps)
- UNKNOWN — analysis could not determine (FFI, eval, dynamic require)

Propagation: A calls B → A inherits all of B's effects. UNKNOWN propagates transitively.

## Effects-DB
Pre-built effect databases:
- effects-db/runtimes/node.yaml — Node.js builtins (fs, crypto, process, etc.)
- effects-db/packages/*.yaml — npm packages (commander, graphql, ajv, etc.)

## ManifestResolver (programmatic)
import { ManifestResolver } from '@grafema/util';
const resolver = new ManifestResolver();
await resolver.loadFromNodeModules(projectPath);
const result = resolver.resolve('graphql', 'parse');
// returns: { name: 'parse', effects: ['THROW'], confidence: 1.0, ... }
`,
  };

  const content = docs[topic] || docs.overview;
  return textResult(content.trim());
}
